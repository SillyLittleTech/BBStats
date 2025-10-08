export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  // Configurable cache TTL (ms). Prefer long TTL to reduce function runs.
  const DEFAULT_TTL_MS = Number(env.BBSTATS_CACHE_TTL_MS) || 6 * 60 * 60 * 1000; // 6 hours

  const sanitize = (v) => (typeof v === 'string' ? v.trim() : undefined);
  const isPlaceholder = (v) => typeof v === 'string' && /^YOUR_[A-Z0-9_]+$/.test(v.trim());

  const accountIdCandidates = [env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID, env.CF_ACCOUNT];
  const apiTokenCandidates = [env.CLOUDFLARE_API_TOKEN, env.CF_TOKEN, env.CF_API_TOKEN];

  const accountId = sanitize(accountIdCandidates.find((c) => sanitize(c) && !isPlaceholder(c)));
  const apiToken = sanitize(apiTokenCandidates.find((c) => sanitize(c) && !isPlaceholder(c)));

  if (!accountId || !apiToken) {
    return new Response(JSON.stringify({
      error: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN.',
      topBlocked: [],
      totals: { blocked: 0, allowed: 0 },
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const url = new URL(request.url);
  const requestedRange = (url.searchParams.get('range') || '7d').toLowerCase();
  const forceRefresh = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

  // Create a cache key derived from the range and account
  const cacheKeyPath = `/bbstats/activity-summary/${accountId}/${requestedRange}`;
  const cacheUrl = new URL(cacheKeyPath, request.url);
  const cacheRequest = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  // Helper: decide if a cached entry is fresh
  const isFresh = (entry) => {
    if (!entry || !entry.meta || typeof entry.meta.fetchedAt !== 'number') return false;
    return Date.now() - entry.meta.fetchedAt < DEFAULT_TTL_MS;
  };

  // Helper: basic blocked-detection similar to server.js
  const isBlocked = (log) => {
    const actionField = log?.action_name ?? log?.action ?? '';
    if (/\b(block|blocked)\b/i.test(actionField)) return true;
    if (log?.blocked === true) return true;
    if (typeof log?.decision === 'string' && /block/i.test(log.decision)) return true;
    return false;
  };

  const extractDomain = (log) => {
    const candidate = log?.query ?? log?.hostname ?? log?.sni ?? log?.domain ?? 'unknown';
    return String(candidate).toLowerCase();
  };

  // Summarize logs (top blocked + totals)
  const summarizeLogs = (logs) => {
    const domainCounts = new Map();
    let blockedCount = 0;
    let allowedCount = 0;

    (logs || []).forEach((log) => {
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
  };

  // Fetch from Cloudflare API and cache the structured summary
  const fetchAndCache = async () => {
    try {
      const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway-analytics/activities`;
      const apiUrl = new URL(baseUrl);
      // Keep to a single, reasonably-sized call; this avoids long multi-segment fetches in the edge.
      apiUrl.searchParams.set('limit', '1000');

      const resp = await fetch(apiUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Cloudflare API responded ${resp.status}. ${text}`);
      }

      const payload = await resp.json().catch(() => ({}));
      const logs = Array.isArray(payload?.result?.logs) ? payload.result.logs : [];

      const summary = summarizeLogs(logs);
      const meta = {
        fetchedAt: Date.now(),
        fromCache: false,
        fetchedCount: logs.length,
        requestedRange,
      };

      const body = JSON.stringify({ ...summary, meta, requestedRange });
      const response = new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${Math.floor(DEFAULT_TTL_MS / 1000)}`,
        },
      });

      // Store in edge cache for subsequent requests
      try {
        await cache.put(cacheRequest, response.clone());
      } catch (e) {
        // Cache.put may fail (quota, etc.) — ignore but log
        console.warn('Failed to write to cache:', e);
      }

      return response;
    } catch (err) {
      console.error('Failed to fetch Cloudflare data:', err);
      return new Response(JSON.stringify({
        error: 'Unable to retrieve data from Cloudflare right now.',
        topBlocked: [],
        totals: { blocked: 0, allowed: 0 },
        requestedRange,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  };

  try {
    // Try to read from cache
    const cached = await cache.match(cacheRequest);
    if (cached && !forceRefresh) {
      // Parse cached body to read fetchedAt
      const cachedBodyText = await cached.text().catch(() => null);
      if (cachedBodyText) {
        let cachedJson = null;
        try {
          cachedJson = JSON.parse(cachedBodyText);
        } catch (e) {
          cachedJson = null;
        }

        if (isFresh(cachedJson)) {
          // Fresh: return immediately
          const resp = new Response(JSON.stringify({ ...cachedJson, meta: { ...cachedJson.meta, fromCache: true } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'HIT' },
          });
          return resp;
        }

        // Stale: return stale payload immediately and refresh in background
        const staleResp = new Response(JSON.stringify({ ...cachedJson, meta: { ...cachedJson.meta, fromCache: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'STALE' },
        });

        // Background refresh to update cache, don't block response
        waitUntil((async () => {
          try {
            await fetchAndCache();
          } catch (e) {
            console.warn('Background refresh failed:', e);
          }
        })());

        return staleResp;
      }
    }

    // No cache or forceRefresh: fetch synchronously and return
    const fresh = await fetchAndCache();
    // If caller asked for forceRefresh we still return fresh; otherwise include header
    return fresh;
  } catch (err) {
    console.error('Unhandled error in activity-summary function:', err);
    return new Response(JSON.stringify({
      error: 'Internal error preparing response.',
      topBlocked: [],
      totals: { blocked: 0, allowed: 0 },
      requestedRange,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
