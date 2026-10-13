import recordLib from "../vendor/record.min.txt";
import playerLib from "../vendor/player.min.txt";
import playerCss from "../vendor/player.css.txt";
import recorderSrc from "./client/recorder.client.js";
import replaySrc from "./client/replay.client.js";
import { computeStats, validEvents } from "./stats";
import { listPage, replayPage, setupPage, type SessionRow } from "./ui";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  RETENTION_DAYS?: string;
  DASH_USER?: string;
  DASH_PASSWORD?: string;
}

const MAX_BODY = 8 * 1024 * 1024; // compressed or raw request body
const MAX_INFLATED = 64 * 1024 * 1024; // gzip bomb guard
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SITE_RE = /^[a-z0-9.-]{1,64}$/;

// Wrap the UMD bundle so it attaches to a private object instead of window (and ignores any AMD loader on the host page).
const SNIPPET =
  "/*! notjar recorder, rrweb (MIT) */\n(function(){var __njScript=document.currentScript;var __nj={};" +
  "(function(define,exports,module){\n" +
  recordLib +
  "\n}).call(__nj);\n" +
  recorderSrc +
  "\n})();\n";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/s.js") {
      return new Response(SNIPPET, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "access-control-allow-origin": "*",
        },
      });
    }
    if (path === "/ingest") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return ingest(req, env);
    }
    if (path === "/health") return new Response("ok");

    // Everything below is the dashboard.
    if (!env.DASH_PASSWORD) return html(setupPage(url.origin), 503);
    if (!(await authorized(req, env))) {
      return new Response("auth required", { status: 401, headers: { "www-authenticate": 'Basic realm="notjar", charset="UTF-8"' } });
    }

    if (path === "/assets/player.js") return asset(playerLib, "application/javascript");
    if (path === "/assets/player.css") return asset(playerCss, "text/css");
    if (path === "/assets/replay.js") return asset(replaySrc, "application/javascript");

    if (path === "/" && req.method === "GET") return listSessions(url, env);

    const m = path.match(/^\/(api\/)?s\/([A-Za-z0-9_-]{8,64})(\/events|\/delete)?$/);
    if (m) {
      const [, api, sid, action] = m;
      if (api && action === "/events") return streamEvents(sid, env, ctx);
      if (!api && !action && req.method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sid).first<SessionRow>();
        return row ? html(replayPage(row)) : html("<p>Session not found.</p>", 404);
      }
      if (!api && action === "/delete" && req.method === "POST") {
        await deleteSession(sid, env);
        return Response.redirect(url.origin + "/", 303);
      }
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeOld(env));
  },
} satisfies ExportedHandler<Env>;

// ---------- ingest ----------

function cors(req: Request): Record<string, string> {
  return {
    "access-control-allow-origin": req.headers.get("origin") || "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function originAllowed(req: Request, env: Env): boolean {
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  const origin = req.headers.get("origin");
  return !!origin && list.includes(origin);
}

type IngestBody = { sid: string; pid: string; seq: number; site: string; url?: string; ref?: string | null; vw?: string; events: unknown };

async function ingest(req: Request, env: Env): Promise<Response> {
  const h = cors(req);
  if (!originAllowed(req, env)) return new Response("origin not allowed", { status: 403, headers: h });
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return new Response("too large", { status: 413, headers: h });

  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return new Response("too large", { status: 413, headers: h });

  let body: IngestBody;
  try {
    const gz = new URL(req.url).searchParams.get("z") === "1";
    const text = gz ? await inflate(new Blob([raw]).stream(), MAX_INFLATED) : new TextDecoder().decode(raw);
    body = JSON.parse(text);
  } catch {
    return new Response("bad body", { status: 400, headers: h });
  }

  const { sid, pid, seq, site, events } = body;
  if (
    typeof sid !== "string" || !ID_RE.test(sid) ||
    typeof pid !== "string" || !PID_RE.test(pid) ||
    !Number.isInteger(seq) || seq < 0 ||
    typeof site !== "string" || !SITE_RE.test(site) ||
    !validEvents(events)
  ) {
    return new Response("invalid payload", { status: 400, headers: h });
  }

  const stats = computeStats(events);
  const stored = await deflate(JSON.stringify(events));
  const key = `${sid}/${String(stats.first).padStart(14, "0")}-${pid}-${String(seq).padStart(6, "0")}.json.gz`;
  await env.BUCKET.put(key, stored, { httpMetadata: { contentType: "application/gzip" } });

  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  const pageUrl = clip(body.url, 2000);
  await env.DB.prepare(
    `INSERT INTO sessions (id, site, started_at, last_at, entry_url, exit_url, referrer, ua, country, viewport,
                           pages, events, chunks, clicks, rage_clicks, errors, bytes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?14, ?15)
     ON CONFLICT(id) DO UPDATE SET
       entry_url   = CASE WHEN excluded.started_at < started_at THEN excluded.entry_url ELSE entry_url END,
       exit_url    = CASE WHEN excluded.last_at >= last_at THEN excluded.exit_url ELSE exit_url END,
       started_at  = min(started_at, excluded.started_at),
       last_at     = max(last_at, excluded.last_at),
       referrer    = coalesce(referrer, excluded.referrer),
       viewport    = coalesce(excluded.viewport, viewport),
       pages       = pages + excluded.pages,
       events      = events + excluded.events,
       chunks      = chunks + 1,
       clicks      = clicks + excluded.clicks,
       rage_clicks = rage_clicks + excluded.rage_clicks,
       errors      = errors + excluded.errors,
       bytes       = bytes + excluded.bytes`
  )
    .bind(
      sid, site, stats.first, stats.last, pageUrl, clip(body.ref, 2000),
      clip(req.headers.get("user-agent"), 400), cf?.country ?? null, clip(body.vw, 20),
      stats.pages, events.length, stats.clicks, stats.rageClicks, stats.errors, stored.byteLength
    )
    .run();

  return new Response(null, { status: 204, headers: h });
}

function clip(s: unknown, n: number): string | null {
  return typeof s === "string" && s ? s.slice(0, n) : null;
}

// ---------- gzip helpers ----------

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.pipeThrough(new DecompressionStream("gzip")).getReader();
  const dec = new TextDecoder();
  let out = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("inflated body too large");
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

// ---------- R2 ----------

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

/** Streams every chunk of a session as one JSON array, fetching a few chunks ahead in parallel. */
function streamEvents(sid: string, env: Env, ctx: ExecutionContext): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  ctx.waitUntil(
    (async () => {
      try {
        const keys = await listKeys(env, `${sid}/`);
        const read = async (key: string) => {
          const obj = await env.BUCKET.get(key);
          if (!obj) return "";
          const text = (await inflate(obj.body, MAX_INFLATED)).trim();
          return text.startsWith("[") ? text.slice(1, -1).trim() : "";
        };
        await writer.write(enc.encode("["));
        let wrote = false;
        const AHEAD = 6;
        const pending: Promise<string>[] = keys.slice(0, AHEAD).map(read);
        for (let i = 0; i < keys.length; i++) {
          const inner = await pending[i];
          if (i + AHEAD < keys.length) pending.push(read(keys[i + AHEAD]));
          if (!inner) continue;
          await writer.write(enc.encode((wrote ? "," : "") + inner));
          wrote = true;
        }
        await writer.write(enc.encode("]"));
        await writer.close();
      } catch (err) {
        await writer.abort(err);
      }
    })()
  );

  return new Response(readable, { headers: { "content-type": "application/json", "cache-control": "private, max-age=60" } });
}

async function deleteSession(sid: string, env: Env): Promise<void> {
  const keys = await listKeys(env, `${sid}/`);
  for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
}

async function purgeOld(env: Env): Promise<void> {
  const days = Number(env.RETENTION_DAYS || "30");
  if (!(days > 0)) return;
  const cutoff = Date.now() - days * 86_400_000;
  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare("SELECT id FROM sessions WHERE last_at < ? LIMIT 100").bind(cutoff).all<{ id: string }>();
    if (!results.length) return;
    for (const r of results) await deleteSession(r.id, env);
  }
}

// ---------- dashboard ----------

async function listSessions(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams;
  const site = q.get("site") || null;
  const minSec = Math.max(0, Number(q.get("min") || 0) || 0);
  const rage = q.get("rage") === "1" ? 1 : 0;
  const errors = q.get("errors") === "1" ? 1 : 0;
  const before = Number(q.get("before")) || Number.MAX_SAFE_INTEGER;
  const PAGE = 50;

  const [rows, sites, summary] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM sessions
       WHERE (?1 IS NULL OR site = ?1) AND (last_at - started_at) >= ?2
         AND (?3 = 0 OR rage_clicks > 0) AND (?4 = 0 OR errors > 0) AND started_at < ?5
       ORDER BY started_at DESC LIMIT ?6`
    ).bind(site, minSec * 1000, rage, errors, before, PAGE + 1).all<SessionRow>(),
    env.DB.prepare("SELECT site, count(*) AS n FROM sessions GROUP BY site ORDER BY n DESC").all<{ site: string; n: number }>(),
    env.DB.prepare(
      `SELECT count(*) AS n, coalesce(avg(last_at - started_at), 0) AS avg_ms,
              coalesce(sum(rage_clicks > 0), 0) AS rage, coalesce(sum(errors > 0), 0) AS errs
       FROM sessions WHERE started_at > ?1 AND (?2 IS NULL OR site = ?2)`
    ).bind(Date.now() - 7 * 86_400_000, site).first<{ n: number; avg_ms: number; rage: number; errs: number }>(),
  ]);

  const list = rows.results;
  const more = list.length > PAGE;
  if (more) list.pop();
  const next = more ? list[list.length - 1].started_at : null;

  return html(
    listPage({
      origin: url.origin,
      rows: list,
      sites: sites.results,
      summary: summary ?? { n: 0, avg_ms: 0, rage: 0, errs: 0 },
      filters: { site, minSec, rage: !!rage, errors: !!errors },
      next,
    })
  );
}

// ---------- auth + responses ----------

async function authorized(req: Request, env: Env): Promise<boolean> {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(h.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const [userOk, passOk] = await Promise.all([
    safeEqual(decoded.slice(0, i), env.DASH_USER || "admin"),
    safeEqual(decoded.slice(i + 1), env.DASH_PASSWORD || ""),
  ]);
  return userOk && passOk;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function asset(body: string, type: string): Response {
  return new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "private, max-age=86400" } });
}
