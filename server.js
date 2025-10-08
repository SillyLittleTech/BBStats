import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const sanitize = (value) =>
  typeof value === 'string' ? value.trim() : undefined;

const isPlaceholder = (value) =>
  typeof value === 'string' &&
  /^YOUR_[A-Z0-9_]+$/.test(value.trim());

const accountIdCandidates = [
  process.env.CLOUDFLARE_ACCOUNT_ID,
  process.env.CF_ACCOUNT_ID,
  process.env.CF_ACCOUNT,
];
const accountId = sanitize(
  accountIdCandidates.find((candidate) => {
    const trimmed = sanitize(candidate);
    return trimmed && !isPlaceholder(trimmed);
  })
);
const apiTokenCandidates = [
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CF_TOKEN,
  process.env.CF_API_TOKEN,
];
const apiToken = sanitize(
  apiTokenCandidates.find((candidate) => {
    const trimmed = sanitize(candidate);
    return trimmed && !isPlaceholder(trimmed);
  })
);

const rangeOptions = {
  '7d': { key: '7d', label: 'Last 7 days', days: 7 },
  '30d': { key: '30d', label: 'Last 30 days', days: 30 },
  '365d': { key: '365d', label: 'Last 365 days', days: 365 },
  latest: { key: 'latest', label: 'Latest 1000 records', days: null },
  lifetime: { key: 'lifetime', label: 'All available data', days: null },
};

const defaultRangeKey = '7d';
const rangeOrder = ['7d', '30d', '365d', 'lifetime'];
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const rangeCache = new Map();
let backgroundPrefetch = {
  controller: null,
  promise: null,
};

function resolveRange(rangeKey) {
  const normalized = typeof rangeKey === 'string' ? rangeKey.toLowerCase() : '';
  return rangeOptions[normalized] ?? rangeOptions[defaultRangeKey];
}

function determineSegmentSeconds(rangeDescriptor) {
  const days = rangeDescriptor.days;
  if (days === null) {
    return null;
  }
  if (days <= 1) {
    return 6 * 60 * 60;
  }
  if (days <= 3) {
    return 12 * 60 * 60;
  }
  if (days <= 7) {
    return 24 * 60 * 60;
  }
  if (days <= 30) {
    return 3 * 24 * 60 * 60;
  }
  if (days <= 90) {
    return 7 * 24 * 60 * 60;
  }
  return 14 * 24 * 60 * 60;
}

function buildSegments(rangeDescriptor, nowSeconds) {
  const segments = [];

  if (rangeDescriptor.days === null) {
    const segmentSeconds = 30 * 24 * 60 * 60; // 30-day slices for lifetime views
    let segmentEnd = nowSeconds;
    const maxSegments = 360; // roughly 30 years

    while (segments.length < maxSegments) {
      const segmentStart = Math.max(0, segmentEnd - segmentSeconds);
      segments.push({ from: segmentStart, to: segmentEnd });
      if (segmentStart === 0) {
        break;
      }
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
    if (segmentStart === earliestSeconds) {
      break;
    }
    segmentEnd = segmentStart;
  }

  return segments;
}

async function fetchSegmentLogs(segment, headers, baseUrl, signal, depth = 0) {
  const params = new URLSearchParams({ limit: '1000' });
  if (typeof segment.from === 'number') {
    params.set('from', String(segment.from));
  }
  if (typeof segment.to === 'number') {
    params.set('to', String(segment.to));
  }

  const url = `${baseUrl}?${params.toString()}`;
  const response = await fetch(url, { headers, signal });

  const spanSeconds =
    typeof segment.from === 'number' && typeof segment.to === 'number'
      ? Math.max(0, segment.to - segment.from)
      : null;

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errorBody = await response.text();
      errorDetail = errorBody ? ` Body: ${errorBody}` : '';
    } catch (readError) {
      errorDetail = ` (unable to read error body: ${readError.message})`;
    }

    if (
      response.status === 504 &&
      spanSeconds !== null &&
      spanSeconds > 3_600 &&
      depth < 5 &&
      typeof segment.from === 'number' &&
      typeof segment.to === 'number'
    ) {
      const midpoint = segment.from + Math.floor(spanSeconds / 2);
      if (midpoint > segment.from && midpoint < segment.to) {
        const firstLogs = await fetchSegmentLogs(
          { from: segment.from, to: midpoint },
          headers,
          baseUrl,
          signal,
          depth + 1
        );
        const secondLogs = await fetchSegmentLogs(
          { from: midpoint, to: segment.to },
          headers,
          baseUrl,
          signal,
          depth + 1
        );
        return [...firstLogs, ...secondLogs];
      }
    }

    throw new Error(`Cloudflare API responded with status ${response.status}.${errorDetail}`);
  }

  const payload = await response.json();
  const logs = Array.isArray(payload?.result?.logs) ? payload.result.logs : [];

  return logs;
}

async function fetchGatewayLogs(rangeDescriptor, headers = {}, options = {}) {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway-analytics/activities`;
  const { signal } = options;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const segments = buildSegments(rangeDescriptor, nowSeconds);
  const unlimitedLogs = Number.POSITIVE_INFINITY;
  const maxLogs = rangeDescriptor.days === null ? 200000 : unlimitedLogs;
  const collectedLogs = [];
  const debug = {
    originalRangeKey: rangeDescriptor.key,
    originalRangeLabel: rangeDescriptor.label,
    requestedRangeKey: rangeDescriptor.key,
    requestedRangeLabel: rangeDescriptor.label,
    effectiveRangeKey: rangeDescriptor.key,
    effectiveRangeLabel: rangeDescriptor.label,
    segmentsPlanned: segments.length,
    segmentsAttempted: 0,
    segmentsSucceeded: 0,
    segmentsFailed: 0,
    fallbackUsed: false,
    messages: [],
  };

  const formatSegmentBoundary = (value) =>
    typeof value === 'number' ? new Date(value * 1000).toISOString() : 'latest';

  for (const segment of segments) {
    if (signal?.aborted) {
      debug.messages.push('Fetch aborted before completing all segments.');
      break;
    }

    debug.segmentsAttempted += 1;
    const segmentLabel = `Segment ${debug.segmentsAttempted}/${segments.length} – range ${rangeDescriptor.key} (from=${formatSegmentBoundary(
      segment.from
    )}, to=${formatSegmentBoundary(segment.to)})`;
    debug.messages.push(segmentLabel);
    console.info(`[Cloudflare] ${segmentLabel}`);

    try {
      const logs = await fetchSegmentLogs(segment, headers, baseUrl, signal);
      collectedLogs.push(...logs);
      debug.segmentsSucceeded += 1;
      debug.messages.push(
        `Segment ${debug.segmentsAttempted} returned ${logs.length} logs (accumulated ${collectedLogs.length}).`
      );
      console.info(
        `[Cloudflare] Segment ${debug.segmentsAttempted}/${segments.length} succeeded with ${logs.length} logs (total ${collectedLogs.length}).`
      );

      if (logs.length === 0 && rangeDescriptor.days === null) {
        debug.emptySegmentStreak = (debug.emptySegmentStreak || 0) + 1;
        debug.messages.push(
          `Segment ${debug.segmentsAttempted} returned no logs (empty streak ${debug.emptySegmentStreak}).`
        );
        if (debug.emptySegmentStreak >= 3) {
          debug.messages.push('Encountered three consecutive empty segments; stopping historical fetch.');
          console.info('[Cloudflare] Three consecutive empty segments encountered; stopping historical fetch.');
          break;
        }
      } else if (logs.length > 0 && debug.emptySegmentStreak) {
        debug.messages.push('Resetting empty segment streak due to new data.');
        debug.emptySegmentStreak = 0;
      }
    } catch (error) {
      debug.segmentsFailed += 1;
      const failureMessage = `Segment ${debug.segmentsAttempted} failed: ${error.message ?? error}`;
      debug.messages.push(failureMessage);
      console.warn(
        `[Cloudflare] Segment fetch failed (from=${formatSegmentBoundary(
          segment.from
        )}, to=${formatSegmentBoundary(segment.to)}): ${error.message}`
      );
      continue;
    }

    if (collectedLogs.length >= maxLogs) {
      debug.limitReached = true;
      const limitMessage = `Stopping early after collecting ${collectedLogs.length} logs (limit ${maxLogs}).`;
      debug.messages.push(limitMessage);
      console.info(`[Cloudflare] ${limitMessage}`);
      break;
    }
  }

  if (!collectedLogs.length) {
    debug.fallbackUsed = true;
    debug.effectiveRangeKey = 'latest';
    debug.effectiveRangeLabel = 'Latest 1000 records';
    debug.messages.push('Primary range returned no logs; falling back to latest records.');
    console.info('[Cloudflare] No logs returned for requested range; falling back to latest data.');
    const fallbackLogs = await fetchSegmentLogs(
      { from: null, to: null },
      headers,
      baseUrl,
      signal
    );
    debug.totalLogs = fallbackLogs.length;
    debug.segmentsPlanned += 1;
    debug.segmentsAttempted += 1;
    debug.segmentsSucceeded += 1;
    debug.messages.push(`Fallback segment returned ${fallbackLogs.length} logs.`);
    console.info(
      `[Cloudflare] Fallback latest segment returned ${fallbackLogs.length} logs (segments succeeded ${debug.segmentsSucceeded}/${debug.segmentsAttempted}).`
    );
    return { logs: fallbackLogs, debug };
  }

  debug.totalLogs = collectedLogs.length;
  const completionMessage = `Completed range ${rangeDescriptor.key}: gathered ${collectedLogs.length} logs across ${debug.segmentsSucceeded}/${debug.segmentsAttempted} segments.`;
  debug.messages.push(completionMessage);
  console.info(`[Cloudflare] ${completionMessage}`);

  return { logs: collectedLogs, debug };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

const blockPattern = /(dns|tls)?_?block/i;

function isBlocked(log) {
  const actionField = log?.action_name ?? log?.action ?? '';
  if (blockPattern.test(actionField)) {
    return true;
  }
  if (log?.blocked === true) {
    return true;
  }
  if (typeof log?.decision === 'string' && /block/i.test(log.decision)) {
    return true;
  }
  return false;
}

function extractDomain(log) {
  const candidate = log?.query ?? log?.hostname ?? log?.sni ?? log?.domain ?? 'unknown';
  return String(candidate).toLowerCase();
}

function summarizeLogs(logs) {
  const domainCounts = new Map();
  let blockedCount = 0;
  let allowedCount = 0;

  logs.forEach((log) => {
    if (isBlocked(log)) {
      blockedCount += 1;
      const domain = extractDomain(log);
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    } else {
      allowedCount += 1;
    }
  });

  const topBlocked = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return {
    topBlocked,
    totals: {
      blocked: blockedCount,
      allowed: allowedCount,
    },
  };
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function parseTimestampValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) {
      return value;
    }
    if (value > 1e5) {
      return value * 1000;
    }
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return parseTimestampValue(numeric);
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function extractLogTimestamp(log) {
  if (!log || typeof log !== 'object') {
    return null;
  }

  const candidates = [
    log.datetime,
    log.timestamp,
    log.time,
    log.event_time,
    log.log_time,
    log.ts,
    log.meta?.timestamp,
    log.metadata?.timestamp,
  ];

  for (const candidate of candidates) {
    const parsed = parseTimestampValue(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function formatRecordCount(count) {
  return Number(count).toLocaleString();
}

function describeCoverage(rangeDescriptor, entries, totalCount) {
  const knownTimestamps = entries
    .map((entry) => entry.timestamp)
    .filter((timestamp) => typeof timestamp === 'number' && Number.isFinite(timestamp));

  if (!knownTimestamps.length) {
    if (rangeDescriptor.days === null) {
      return `Latest ${formatRecordCount(totalCount)} records`;
    }
    return `${rangeDescriptor.label} (limited to available records)`;
  }

  const latest = Math.max(...knownTimestamps);
  const earliest = Math.min(...knownTimestamps);
  const spanMs = Math.max(0, latest - earliest);
  const spanDays = spanMs / DAY_IN_MS;

  if (rangeDescriptor.days === null) {
    if (spanDays >= 1) {
      return `Latest ${formatRecordCount(totalCount)} records (~${Math.max(
        1,
        Math.round(spanDays)
      )} days)`;
    }
    return `Latest ${formatRecordCount(totalCount)} records (past few hours)`;
  }

  if (spanDays >= rangeDescriptor.days - 0.5) {
    return rangeDescriptor.label;
  }

  if (spanDays >= 1) {
    return `Last ~${Math.max(1, Math.round(spanDays))} days`;
  }

  return 'Last few hours';
}

function filterLogsByRange(logs, rangeDescriptor) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return {
      logs: [],
      effectiveRange: rangeDescriptor.key,
      effectiveRangeLabel: rangeDescriptor.label,
    };
  }

  const enriched = logs.map((log) => ({
    log,
    timestamp: extractLogTimestamp(log),
  }));

  if (rangeDescriptor.days === null) {
    return {
      logs,
      effectiveRange: rangeDescriptor.key,
      effectiveRangeLabel: describeCoverage(rangeDescriptor, enriched, logs.length),
    };
  }

  const known = enriched.filter((entry) => entry.timestamp !== null);

  if (!known.length) {
    const fallbackLabel = `Latest ${formatRecordCount(logs.length)} records`;
    return {
      logs,
      effectiveRange: 'latest',
      effectiveRangeLabel: fallbackLabel,
    };
  }

  const maxTimestamp = known.reduce(
    (max, entry) => (entry.timestamp > max ? entry.timestamp : max),
    known[0].timestamp
  );
  const cutoff = maxTimestamp - rangeDescriptor.days * DAY_IN_MS;

  const filteredEntries = enriched.filter(
    (entry) => entry.timestamp === null || entry.timestamp >= cutoff
  );
  const filteredLogs = filteredEntries.map((entry) => entry.log);

  return {
    logs: filteredLogs,
    effectiveRange: rangeDescriptor.key,
    effectiveRangeLabel: describeCoverage(rangeDescriptor, filteredEntries, filteredLogs.length),
  };
}

function isCacheValid(entry) {
  return Boolean(entry?.summary) && typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now();
}

function dedupeLogs(logs) {
  return Array.isArray(logs) ? logs : [];
}

function abortBackgroundPrefetch(reason) {
  if (backgroundPrefetch.controller && !backgroundPrefetch.controller.signal.aborted) {
    backgroundPrefetch.controller.abort();
    if (reason) {
      console.info(`[Prefetch] Aborted background prefetch: ${reason}`);
    }
  }
  backgroundPrefetch = { controller: null, promise: null };
}

function buildPrefetchQueue(startKey) {
  const order = rangeOrder.filter((key) => rangeOptions[key]);
  if (!order.length) {
    return [];
  }

  const uniqueOrder = order.filter((key, index) => order.indexOf(key) === index);
  const startIndex = uniqueOrder.indexOf(startKey);

  const queue = [];
  if (startIndex === -1) {
    uniqueOrder.forEach((key) => {
      if (!isCacheValid(rangeCache.get(key))) {
        queue.push(key);
      }
    });
    return queue;
  }

  for (let i = 1; i < uniqueOrder.length; i += 1) {
    const key = uniqueOrder[(startIndex + i) % uniqueOrder.length];
    if (!isCacheValid(rangeCache.get(key))) {
      queue.push(key);
    }
  }

  return queue;
}

function scheduleBackgroundPrefetch(startKey) {
  const queue = buildPrefetchQueue(startKey);
  if (!queue.length) {
    return;
  }

  abortBackgroundPrefetch('rescheduling');

  const controller = new AbortController();
  const signal = controller.signal;

  console.info(`[Prefetch] Starting background prefetch for ranges: ${queue.join(', ')}`);

  const prefetchPromise = (async () => {
    for (const rangeKey of queue) {
      if (signal.aborted) {
        break;
      }
      try {
        await ensureRangeCached(resolveRange(rangeKey), {
          signal,
          background: true,
          reason: 'background-prefetch',
        });
      } catch (error) {
        if (error.name === 'AbortError') {
          console.info(`[Prefetch] Prefetch aborted while processing range ${rangeKey}.`);
          break;
        }
        console.error(`[Prefetch] Failed to prefetch range ${rangeKey}:`, error);
      }
    }
    if (!signal.aborted) {
      console.info('[Prefetch] Background prefetch complete.');
    }
    if (backgroundPrefetch.controller === controller) {
      backgroundPrefetch = { controller: null, promise: null };
    }
  })();

  backgroundPrefetch = {
    controller,
    promise: prefetchPromise,
  };
}

async function ensureRangeCached(rangeDescriptor, options = {}) {
  const {
    forceRefresh = false,
    signal,
    background = false,
    reason = background ? 'background-prefetch' : 'user-request',
  } = options;

  const cacheKey = rangeDescriptor.key;
  const existingEntry = rangeCache.get(cacheKey);

  if (!forceRefresh && isCacheValid(existingEntry)) {
    const meta = existingEntry.meta
      ? {
          ...existingEntry.meta,
          fromCache: true,
          cachedAt: new Date(existingEntry.fetchedAt).toISOString(),
          cacheExpiresAt: new Date(existingEntry.expiresAt).toISOString(),
          messages: [],
          totalLogs: Array.isArray(existingEntry.logs)
            ? existingEntry.logs.length
            : existingEntry.meta.totalLogs,
        }
      : {
          fromCache: true,
          cachedAt: new Date(existingEntry.fetchedAt).toISOString(),
          cacheExpiresAt: new Date(existingEntry.expiresAt).toISOString(),
          messages: [],
          totalLogs: Array.isArray(existingEntry.logs) ? existingEntry.logs.length : 0,
        };
    return {
      summary: existingEntry.summary,
      meta,
    };
  }

  if (existingEntry?.promise) {
    if (!forceRefresh) {
      return existingEntry.promise;
    }
    if (existingEntry.controller && !existingEntry.controller.signal.aborted) {
      existingEntry.controller.abort();
    }
  }

  if (signal?.aborted) {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }

  const controller = new AbortController();
  let abortHandler;
  if (signal) {
    abortHandler = () => controller.abort();
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  const fetchPromise = (async () => {
    try {
      const headers = {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      };

      const { logs: rawLogs, debug } = await fetchGatewayLogs(
        rangeDescriptor,
        headers,
        { signal: controller.signal }
      );

      const mergedRawLogs = dedupeLogs(rawLogs);

      const effectiveDescriptor =
        debug.effectiveRangeKey && debug.effectiveRangeKey !== rangeDescriptor.key
          ? resolveRange(debug.effectiveRangeKey)
          : rangeDescriptor;

      const filtered = filterLogsByRange(mergedRawLogs, effectiveDescriptor);
      const fetchTimestamp = Date.now();
      const fetchedAtIso = new Date(fetchTimestamp).toISOString();
      const expiresAt = fetchTimestamp + CACHE_TTL_MS;
      const summary = summarizeLogs(filtered.logs);
      const meta = {
        ...debug,
        filteredLogCount: filtered.logs.length,
        effectiveRangeKey: filtered.effectiveRange,
        effectiveRangeLabel: filtered.effectiveRangeLabel,
        coverageDescription: filtered.effectiveRangeLabel,
        totalLogs: mergedRawLogs.length,
        fetchedAt: fetchedAtIso,
        cacheExpiresAt: new Date(expiresAt).toISOString(),
        fromCache: false,
        background,
        reason,
      };

      const cacheMeta = {
        ...meta,
        messages: [],
      };

      rangeCache.set(cacheKey, {
        summary,
        meta: cacheMeta,
        fetchedAt: fetchTimestamp,
        expiresAt,
        logs: mergedRawLogs,
      });

      return { summary, meta };
    } catch (error) {
      rangeCache.delete(cacheKey);
      if (error.name === 'AbortError') {
        throw error;
      }
      throw error;
    }
  })();

  rangeCache.set(cacheKey, {
    summary: existingEntry?.summary ?? null,
    meta: existingEntry?.meta ?? null,
    fetchedAt: existingEntry?.fetchedAt ?? 0,
    expiresAt: existingEntry?.expiresAt ?? 0,
    promise: fetchPromise,
    controller,
    logs: existingEntry?.logs ?? [],
  });

  try {
    const result = await fetchPromise;
    return result;
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
    const latestEntry = rangeCache.get(cacheKey);
    if (latestEntry?.promise === fetchPromise) {
      delete latestEntry.promise;
      delete latestEntry.controller;
      rangeCache.set(cacheKey, latestEntry);
    }
  }
}

app.get('/api/activity-summary', async (req, res) => {
  if (!accountId || !apiToken) {
    return res.status(500).json({
      error: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN.',
      topBlocked: [],
      totals: { blocked: 0, allowed: 0 },
    });
  }

  let requestedRange = resolveRange(defaultRangeKey);
  const requestController = new AbortController();
  const handleClose = () => {
    requestController.abort();
  };
  req.on('close', handleClose);

  try {
    const requestedRangeParam =
      typeof req.query.range === 'string' ? req.query.range : defaultRangeKey;
    requestedRange = resolveRange(requestedRangeParam);

    abortBackgroundPrefetch('user request');
    const forceRefresh = req.query.force === '1' || req.query.force === 'true';

    const { summary, meta } = await ensureRangeCached(requestedRange, {
      signal: requestController.signal,
      background: false,
      reason: forceRefresh ? 'user-refresh' : 'user-request',
      forceRefresh,
    });

    if (!res.headersSent) {
      res.json({
        ...summary,
        requestedRange: requestedRange.key,
        range: meta.effectiveRangeKey ?? requestedRange.key,
        rangeLabel: meta.effectiveRangeLabel ?? requestedRange.label,
        meta,
      });
    }

    scheduleBackgroundPrefetch(requestedRange.key);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(
        `[Cloudflare] Request aborted while fetching range ${requestedRange.key}: ${error.message}`
      );
      // Do not send a response; client disconnected.
    } else {
      console.error('[Cloudflare] Failed to load gateway activities:', error);
      if (!res.headersSent) {
        res.status(200).json({
          error: 'Unable to retrieve data from Cloudflare right now.',
          topBlocked: [],
          totals: { blocked: 0, allowed: 0 },
          requestedRange: requestedRange.key,
          range: requestedRange.key,
          rangeLabel: requestedRange.label,
        });
      }
    }
  } finally {
    if (typeof req.off === 'function') {
      req.off('close', handleClose);
    } else if (typeof req.removeListener === 'function') {
      req.removeListener('close', handleClose);
    }
    if (requestController.signal.aborted) {
      abortBackgroundPrefetch('request aborted');
    }
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`BBStats dashboard running on http://localhost:${port}`);
});
