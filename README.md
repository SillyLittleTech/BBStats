# BBStats
Admin Panel for Gateway Stats

## Cloudflare Pages deployment notes

This project ships a static frontend in `public/` and a Pages Function which exposes the same `/api/activity-summary` endpoint used by the original `server.js`.

Steps to deploy on Cloudflare Pages:

1. In Pages project settings, set the "Build output directory" (Publish directory) to `public`.
2. Add two environment variables (Secrets) in Pages: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
3. (Optional) Set `BBSTATS_CACHE_TTL_MS` to control how long cached summaries are considered fresh (milliseconds). Default: 6 hours.

The Pages Function lives at `functions/api/activity-summary.js`. It uses the Pages Cache API to store summary payloads for `BBSTATS_CACHE_TTL_MS` and does background refreshes to keep the cache warm while minimizing function executions.
