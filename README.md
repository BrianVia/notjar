# notjar

Self-hosted Hotjar-style session replay. One Cloudflare Worker, D1 for the session index, R2 for recordings, [rrweb](https://github.com/rrweb-io/rrweb) for capture and playback.

```
<script async src="https://notjar.<you>.workers.dev/s.js" data-site="meals"></script>
        │  rrweb record → batches every 10s / 400 events, gzipped in-browser
        ▼
POST /ingest ──► R2  {sid}/{firstTs}-{pageId}-{seq}.json.gz   (raw rrweb events)
             └─► D1  sessions (upsert: duration, pages, clicks, rage clicks, JS errors, device, country)

GET /            session list + filters (site, min duration, rage clicks, errors) + 7-day stats
GET /s/:id       replay with rrweb-player, skip-inactivity, "moments" sidebar (pages, rage clicks, errors, custom tags)
cron daily       deletes sessions older than RETENTION_DAYS
```

## Deploy

```bash
npm install                       # also vendors the rrweb bundles into vendor/
npx wrangler d1 create notjar     # paste database_id into wrangler.toml
npx wrangler r2 bucket create notjar-recordings
npm run db:init
npx wrangler secret put DASH_PASSWORD
npm run deploy
```

Then set `ALLOWED_ORIGINS` in `wrangler.toml` to the sites you're recording (comma-separated) and redeploy. Empty means anyone who finds `/ingest` can write to your bucket.

Dashboard: `https://notjar.<you>.workers.dev/`, basic auth, user `admin` (change via `DASH_USER`).

## Local dev

```bash
echo "DASH_PASSWORD=dev" > .dev.vars
npm run db:init:local
npm run dev                       # http://localhost:8787  (admin / dev)
```

Point a local page's snippet at `http://localhost:8787/s.js` and click around.

## Snippet options

| Attribute | Default | |
|---|---|---|
| `data-site` | hostname | Groups sessions in the dashboard. `[a-z0-9.-]` |
| `data-sample` | `1` | Fraction of sessions recorded, decided once per session |
| `data-mask-text` | `false` | `true` masks every text node |

Inputs are always masked. Class hooks: `nj-block` (element replaced by a placeholder), `nj-mask` (text masked), `nj-ignore` (input changes not recorded).

Browser API on `window.notjar`: `sessionId`, `tag(name, data)` to drop a custom marker into the timeline, `stop()`.

## Behavior and limits

- A session survives navigations within a tab (sessionStorage) and expires after 30 min idle. Each page load records its own full snapshot; replay stitches them.
- Recording on a page stops after 60 min, so a forgotten tab with a carousel doesn't stream forever.
- Rage click = 3+ clicks within 1s inside a 40px radius. Counted per chunk, so a burst that straddles a flush can be missed.
- JS errors come from `window.onerror` and `unhandledrejection`, recorded as rrweb custom events.
- Cross-origin stylesheets the browser won't let rrweb read get referenced by URL, so replays of old sessions can drift if that CSS changes.
- No heatmaps, funnels or surveys. That's the "slop" part.
