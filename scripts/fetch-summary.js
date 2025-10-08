#!/usr/bin/env node
/*
  fetch-summary.js — clean server.js parity
  Fetches a requested range from Cloudflare Gateway Analytics, summarizes blocked vs allowed,
  and writes two outputs consumed by the frontend:
    - public/activity-summary.json  (topBlocked, totals, blockedSamples, meta)
    - public/activity-raw.json      (sample of blocked events)

  Requires env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
*/

import fs from 'fs/promises';
import fetch from 'node-fetch';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || process.env.CF_ACCOUNT;
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN || process.env.CF_API_TOKEN;

if (!accountId || !apiToken) {
  console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const rangeOptions = {
  '7d': { key: '7d', label: 'Last 7 days', days: 7 },
  '30d': { key: '30d', label: 'Last 30 days', days: 30 },
  '365d': { key: '365d', label: 'Last 365 days', days: 365 },
  latest: { key: 'latest', label: 'Latest 1000 records', days: null },
  lifetime: { key: 'lifetime', label: 'All available data', days: null },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const blockPattern = /(dns|tls)?_?block/i;

function isBlocked(log) {
  const actionField = log?.action_name ?? log?.action ?? '';
  if (blockPattern.test(actionField)) return true;
  if (log?.blocked === true) return true;
  if (typeof log?.decision === 'string' && /block/i.test(log.decision)) return true;
  return false;
}

function extractDomain(log) {
  const candidate = log?.query ?? log?.hostname ?? log?.sni ?? log?.domain ?? 'unknown';
  return String(candidate).toLowerCase();
}

function determineSegmentSeconds(rangeDescriptor) {
  const days = rangeDescriptor.days;
  if (days === null) return null;
  if (days <= 1) return 6 * 60 * 60;
  if (days <= 3) return 12 * 60 * 60;
  if (days <= 7) return 24 * 60 * 60;
  if (days <= 30) return 3 * 24 * 60 * 60;
  if (days <= 90) return 7 * 24 * 60 * 60;
  return 14 * 24 * 60 * 60;
}

function buildSegments(rangeDescriptor, nowSeconds) {
  const segments = [];
  if (rangeDescriptor.days === null) {
    const segmentSeconds = 30 * 24 * 60 * 60; // 30-day slices
    let segmentEnd = nowSeconds;
    const maxSegments = 360;
    while (segments.length < maxSegments) {
      const segmentStart = Math.max(0, segmentEnd - segmentSeconds);
      segments.push({ from: segmentStart, to: segmentEnd });
      if (segmentStart === 0) break;
      segmentEnd = segmentStart;
    }
    return segments;
  }

  const earliestSeconds = Math.max(0, nowSeconds - rangeDescriptor.days * 24 * 60 * 60);
  const segmentSeconds = determineSegmentSeconds(rangeDescriptor);
  let segmentEnd = nowSeconds;
  while (segmentEnd > earliestSeconds) {
    const segmentStart = Math.max(earliestSeconds, segmentEnd - segmentSeconds);
    segments.push({ from: segmentStart, to: segmentEnd });
    if (segmentStart === earliestSeconds) break;
    segmentEnd = segmentStart;
  }
  return segments;
}

async function fetchSegmentLogs(segment, headers, baseUrl, signal, depth = 0) {
  const params = new URLSearchParams({ limit: '1000' });
  if (typeof segment.from === 'number') params.set('from', String(segment.from));
  if (typeof segment.to === 'number') params.set('to', String(segment.to));
  const url = `${baseUrl}?${params.toString()}`;
  const resp = await fetch(url, { headers, signal });

  const spanSeconds = typeof segment.from === 'number' && typeof segment.to === 'number' ? Math.max(0, segment.to - segment.from) : null;
  if (!resp.ok) {
    let errorBody = '';
    try { errorBody = await resp.text(); } catch (e) { /* ignore */ }
    if (resp.status === 504 && spanSeconds !== null && spanSeconds > 3600 && depth < 5 && typeof segment.from === 'number') {
      const midpoint = segment.from + Math.floor(spanSeconds / 2);
      if (midpoint > segment.from && midpoint < segment.to) {
        const a = await fetchSegmentLogs({ from: segment.from, to: midpoint }, headers, baseUrl, signal, depth + 1);
        const b = await fetchSegmentLogs({ from: midpoint, to: segment.to }, headers, baseUrl, signal, depth + 1);
        return [...a, ...b];
      }
    }
    throw new Error(`Cloudflare API ${resp.status} ${errorBody}`);
  }
  const payload = await resp.json().catch(() => ({}));
  return Array.isArray(payload?.result?.logs) ? payload.result.logs : [];
}

async function fetchGatewayLogs(rangeDescriptor, headers = {}, options = {}) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway-analytics/activities`;
  const { signal } = options;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const segments = buildSegments(rangeDescriptor, nowSeconds);
  const maxLogs = rangeDescriptor.days === null ? 200000 : Number.POSITIVE_INFINITY;
  const collected = [];
  const debug = { originalRangeKey: rangeDescriptor.key, originalRangeLabel: rangeDescriptor.label, requestedRangeKey: rangeDescriptor.key, requestedRangeLabel: rangeDescriptor.label, effectiveRangeKey: rangeDescriptor.key, effectiveRangeLabel: rangeDescriptor.label, segmentsPlanned: segments.length, segmentsAttempted: 0, segmentsSucceeded: 0, segmentsFailed: 0, fallbackUsed: false, messages: [] };

  const fmt = (v) => (typeof v === 'number' ? new Date(v * 1000).toISOString() : 'latest');
  for (const segment of segments) {
    if (signal?.aborted) break;
    debug.segmentsAttempted += 1;
    debug.messages.push(`Segment ${debug.segmentsAttempted}/${segments.length} – range ${rangeDescriptor.key} (from=${fmt(segment.from)}, to=${fmt(segment.to)})`);
    try {
      const logs = await fetchSegmentLogs(segment, headers, baseUrl, signal);
      collected.push(...logs);
      debug.segmentsSucceeded += 1;
      debug.messages.push(`Segment ${debug.segmentsAttempted} returned ${logs.length} logs (accumulated ${collected.length}).`);
      if (logs.length === 0 && rangeDescriptor.days === null) {
        debug.emptySegmentStreak = (debug.emptySegmentStreak || 0) + 1;
        if (debug.emptySegmentStreak >= 3) { debug.messages.push('Three consecutive empty segments; stopping.'); break; }
      } else if (logs.length > 0 && debug.emptySegmentStreak) { debug.emptySegmentStreak = 0; }
    } catch (err) {
      debug.segmentsFailed += 1;
      debug.messages.push(`Segment ${debug.segmentsAttempted} failed: ${err.message || err}`);
      continue;
    }
    if (collected.length >= maxLogs) { debug.limitReached = true; debug.messages.push(`Limit reached: ${collected.length}`); break; }
  }

  if (!collected.length) {
    debug.fallbackUsed = true;
    debug.effectiveRangeKey = 'latest';
    debug.effectiveRangeLabel = 'Latest 1000 records';
    debug.messages.push('Primary range returned no logs; falling back to latest records.');
    const fallback = await fetchSegmentLogs({ from: null, to: null }, headers, baseUrl, signal);
    debug.totalLogs = fallback.length; debug.segmentsPlanned += 1; debug.segmentsAttempted += 1; debug.segmentsSucceeded += 1; debug.messages.push(`Fallback returned ${fallback.length}`);
    return { logs: fallback, debug };
  }

  debug.totalLogs = collected.length;
  debug.messages.push(`Completed range ${rangeDescriptor.key}: gathered ${collected.length} logs.`);
  return { logs: collected, debug };
}

function parseTimestampValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value; if (value > 1e5) return value * 1000; return null;
  }
  if (typeof value === 'string') {
    const t = value.trim(); if (!t) return null; const n = Number(t); if (!Number.isNaN(n)) return parseTimestampValue(n); const p = Date.parse(t); return Number.isNaN(p) ? null : p;
  }
  return null;
}

function extractLogTimestamp(log) {
  if (!log || typeof log !== 'object') return null;
  const candidates = [log.datetime, log.timestamp, log.time, log.event_time, log.log_time, log.ts, log.meta?.timestamp, log.metadata?.timestamp];
  for (const c of candidates) { const p = parseTimestampValue(c); if (p !== null) return p; }
  return null;
}

function filterLogsByRange(logs, rangeDescriptor) {
  if (!Array.isArray(logs) || logs.length === 0) return { logs: [], effectiveRange: rangeDescriptor.key, effectiveRangeLabel: rangeDescriptor.label };
  const enriched = logs.map((log) => ({ log, timestamp: extractLogTimestamp(log) }));
  if (rangeDescriptor.days === null) {
    const knownTimestamps = enriched.map((e) => e.timestamp).filter((t) => typeof t === 'number');
    if (!knownTimestamps.length) return { logs, effectiveRange: rangeDescriptor.key, effectiveRangeLabel: `Latest ${logs.length} records` };
    const latest = Math.max(...knownTimestamps); const earliest = Math.min(...knownTimestamps); const spanDays = Math.max(0, latest - earliest) / DAY_MS; const label = spanDays >= 1 ? `Latest ${logs.length} records (~${Math.max(1, Math.round(spanDays))} days)` : `Latest ${logs.length} records (past few hours)`; return { logs, effectiveRange: rangeDescriptor.key, effectiveRangeLabel: label };
  }
  const known = enriched.filter((e) => e.timestamp !== null);
  if (!known.length) return { logs, effectiveRange: 'latest', effectiveRangeLabel: `Latest ${logs.length} records` };
  const maxTimestamp = known.reduce((max, e) => (e.timestamp > max ? e.timestamp : max), known[0].timestamp);
  const cutoff = maxTimestamp - rangeDescriptor.days * DAY_MS;
  const filtered = enriched.filter((e) => e.timestamp === null || e.timestamp >= cutoff);
  const knownTimestamps = filtered.map((e) => e.timestamp).filter((t) => typeof t === 'number');
  let effLabel = 'Last few hours';
  if (knownTimestamps.length) { const latest = Math.max(...knownTimestamps); const earliest = Math.min(...knownTimestamps); const spanDays = Math.max(0, latest - earliest) / DAY_MS; if (spanDays >= rangeDescriptor.days - 0.5) effLabel = rangeDescriptor.label; else if (spanDays >= 1) effLabel = `Last ~${Math.max(1, Math.round(spanDays))} days`; }
  return { logs: filtered.map((e) => e.log), effectiveRange: rangeDescriptor.key, effectiveRangeLabel: effLabel };
}

function dedupeLogs(logs) {
  if (!Array.isArray(logs)) return [];
  const seen = new Set(); const out = [];
  for (const log of logs) {
    const key = `${log?.timestamp ?? ''}|${log?.query ?? log?.hostname ?? ''}|${log?.action_name ?? log?.action ?? ''}`;
    if (!seen.has(key)) { seen.add(key); out.push(log); }
  }
  return out;
}

function normalizeDomain(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const parts = raw.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.') || raw;
  // simple heuristic: return last 2 labels (handles common cases)
  return `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

function summarizeLogs(logs) {
  // Count hits from the provided logs (do NOT dedupe here) so totals reflect real call counts.
  const domainCounts = new Map(); let blocked = 0; let allowed = 0;
  logs.forEach((log) => {
    if (isBlocked(log)) {
      blocked += 1;
      const d = extractDomain(log) || 'unknown';
      domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    } else {
      allowed += 1;
    }
  });
  const topBlocked = Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  // also provide normalized aggregation
  const normalizedCounts = new Map();
  logs.forEach((log) => {
    if (!isBlocked(log)) return;
    const raw = extractDomain(log) || 'unknown';
    const norm = normalizeDomain(raw);
    normalizedCounts.set(norm, (normalizedCounts.get(norm) || 0) + 1);
  });
  const topBlockedNormalized = Array.from(normalizedCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

  return { topBlocked, topBlockedNormalized, totals: { blocked, allowed } };
}

(async function main() {
  try {
    const requestedRangeKey = process.env.RANGE || '7d';
    const rangeDescriptor = rangeOptions[requestedRangeKey] || rangeOptions['7d'];
    console.log(`Fetching range: ${rangeDescriptor.key} (${rangeDescriptor.label})`);
    const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
    const { logs: rawLogs, debug } = await fetchGatewayLogs(rangeDescriptor, headers, {});
    const filtered = filterLogsByRange(rawLogs, rangeDescriptor);
  const deduped = dedupeLogs(filtered.logs);
  // Use non-deduped logs for accurate hit counts
  const summary = summarizeLogs(filtered.logs);
  const blockedOnly = filtered.logs.filter((l) => isBlocked(l));
  const blockedSamples = deduped.filter((l) => isBlocked(l)).slice(0, 50).map((l) => ({ domain: extractDomain(l), timestamp: (() => { const t = extractLogTimestamp(l); return t ? new Date(t).toISOString() : null; })(), decision: l?.decision ?? null, action: l?.action_name ?? l?.action ?? null }));
    const fetchTs = Date.now();
    const meta = { ...debug, fetchedAt: fetchTs, fetchedAtIso: new Date(fetchTs).toISOString(), fetchedCount: deduped.length, fetchedBlocked: blockedOnly.length, effectiveRangeKey: filtered.effectiveRange, effectiveRangeLabel: filtered.effectiveRangeLabel, totalLogs: rawLogs.length };
    await fs.writeFile('public/activity-raw.json', JSON.stringify(blockedOnly.slice(0, 500), null, 2));
    // compute top overall queries (non-deduped counts)
    const overallCounts = new Map();
    filtered.logs.forEach((log) => {
      const d = extractDomain(log) || 'unknown';
      overallCounts.set(d, (overallCounts.get(d) || 0) + 1);
    });
    const topQueries = Array.from(overallCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

    // enrich blocked summary with total hit counts for each blocked domain
    const topBlockedTotals = (summary.topBlocked || []).map(({ name, count }) => ({ name, blockedCount: count, totalCount: overallCounts.get(name) || 0 }));

    // normalized totals: compute total per normalized name
    const normalizedTotalCounts = new Map();
    for (const [name, cnt] of overallCounts.entries()) {
      const norm = normalizeDomain(name);
      normalizedTotalCounts.set(norm, (normalizedTotalCounts.get(norm) || 0) + cnt);
    }
    const topBlockedNormalizedTotals = (summary.topBlockedNormalized || []).map(({ name, count }) => ({ name, blockedCount: count, totalCount: normalizedTotalCounts.get(name) || 0 }));

    const out = { ...summary, topQueries, topBlockedTotals, topBlockedNormalizedTotals, blockedSamples, meta };
    await fs.writeFile('public/activity-summary.json', JSON.stringify(out, null, 2));
    console.log(`Wrote public/activity-summary.json (records=${deduped.length}, blocked=${blockedOnly.length}).`);
  } catch (err) {
    console.error('Error fetching summary:', err.message || err);
    process.exit(2);
  }
})();

