#!/usr/bin/env node
/* Fetch a single-page summary from Cloudflare and write to public/activity-summary.json
   This script is intended to run in CI with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN set as secrets.
*/

import fs from 'fs/promises';
import fetch from 'node-fetch';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN;

if (!accountId || !apiToken) {
  console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

async function isBlocked(log) {
  const actionField = log?.action_name ?? log?.action ?? '';
  if (/\b(block|blocked)\b/i.test(actionField)) return true;
  if (log?.blocked === true) return true;
  if (typeof log?.decision === 'string' && /block/i.test(log.decision)) return true;
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
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    } else {
      allowedCount += 1;
    }
  });

  const topBlocked = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  return { topBlocked, totals: { blocked: blockedCount, allowed: allowedCount } };
}

(async function main() {
  try {
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway-analytics/activities`;
    const url = new URL(baseUrl);
    url.searchParams.set('limit', '1000');

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json',
      },
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`CF API error ${resp.status}: ${t}`);
    }

    const payload = await resp.json();
    const logs = Array.isArray(payload?.result?.logs) ? payload.result.logs : [];
    const summary = summarizeLogs(logs);
    const meta = { fetchedAt: Date.now(), fetchedCount: logs.length };

    const out = { ...summary, meta };
    await fs.writeFile('public/activity-summary.json', JSON.stringify(out, null, 2));
    console.log('Wrote public/activity-summary.json (', logs.length, 'logs )');
  } catch (err) {
    console.error('Failed to fetch summary:', err);
    process.exit(2);
  }
})();
