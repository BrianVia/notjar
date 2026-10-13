export type SessionRow = {
  id: string;
  site: string;
  started_at: number;
  last_at: number;
  entry_url: string | null;
  exit_url: string | null;
  referrer: string | null;
  ua: string | null;
  country: string | null;
  viewport: string | null;
  pages: number;
  events: number;
  chunks: number;
  clicks: number;
  rage_clicks: number;
  errors: number;
  bytes: number;
};

type ListArgs = {
  origin: string;
  rows: SessionRow[];
  sites: { site: string; n: number }[];
  summary: { n: number; avg_ms: number; rage: number; errs: number };
  filters: { site: string | null; minSec: number; rage: boolean; errors: boolean };
  next: number | null;
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function device(ua: string | null): { kind: string; browser: string; os: string } {
  const u = ua || "";
  const kind = /iPad|Tablet/i.test(u) ? "tablet" : /Mobi|iPhone|Android/i.test(u) ? "mobile" : "desktop";
  const browser = /Edg\//.test(u) ? "Edge" : /OPR\//.test(u) ? "Opera" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "Other";
  const os = /iPhone|iPad/.test(u) ? "iOS" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows" : /Mac OS/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "";
  return { kind, browser, os };
}

function path(u: string | null): string {
  if (!u) return "—";
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

const ICON = { desktop: "▭", mobile: "▯", tablet: "▢" } as Record<string, string>;

const CSS = `
:root{--bg:#fafaf9;--panel:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#ea580c;--accent-soft:#fff7ed;--red:#dc2626;--red-soft:#fef2f2;--hover:#f5f5f4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--panel:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#fb923c;--accent-soft:#2a1a0e;--red:#f87171;--red-soft:#2a1212;--hover:#231f1d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.logo{font-weight:800;font-size:18px;letter-spacing:-.02em;text-decoration:none}.logo span{color:var(--accent)}
.muted{color:var(--muted)}.mono{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:22px;letter-spacing:-.02em}
form.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
select,input[type=number],button,.btn{font:inherit;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
button,.btn{cursor:pointer;text-decoration:none}button.primary{background:var(--text);color:var(--bg);border-color:var(--text)}
label.chk{display:flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--panel);cursor:pointer}
.table{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.row{display:grid;grid-template-columns:120px 1fr 90px 70px 70px 150px;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--line);text-decoration:none}
.row:first-child{border-top:0}a.row:hover{background:var(--hover)}.row.head{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:var(--bg)}
.url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.site{font-size:11px;color:var(--muted)}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;margin-right:4px}
.b-rage{background:var(--accent-soft);color:var(--accent)}.b-err{background:var(--red-soft);color:var(--red)}
.empty{padding:40px;text-align:center;color:var(--muted)}
details.install{margin-left:auto}details.install summary{cursor:pointer;color:var(--muted)}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.pager{display:flex;justify-content:flex-end;margin-top:12px}
@media (max-width:760px){.cards{grid-template-columns:repeat(2,1fr)}.row{grid-template-columns:1fr auto}.row>:nth-child(n+3):not(:last-child){display:none}.row.head{display:none}}
/* replay */
.replay{display:grid;grid-template-columns:1fr 280px;gap:16px;align-items:start}
#stage{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;min-height:300px;display:flex;justify-content:center}
#stage .rr-player{box-shadow:none;background:transparent}#stage .rr-controller{background:transparent}
.side{display:flex;flex-direction:column;gap:12px}.meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}.meta dt{color:var(--muted)}.meta dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#moments{list-style:none;margin:0;padding:0;max-height:60vh;overflow:auto}#moments li button{width:100%;text-align:left;border:0;border-radius:6px;background:transparent;display:flex;gap:8px;padding:6px 8px}
#moments li button:hover{background:var(--hover)}#moments .t{color:var(--muted);font-variant-numeric:tabular-nums;min-width:42px}
#moments .k-rage{color:var(--accent)}#moments .k-error{color:var(--red)}
@media (max-width:900px){.replay{grid-template-columns:1fr}}
`;

const TIME_SCRIPT = `<script>
(function(){
  var rtf = new Intl.RelativeTimeFormat(undefined,{numeric:"auto"});
  function rel(ts){var s=(ts-Date.now())/1000,a=Math.abs(s);
    if(a<60)return rtf.format(Math.round(s),"second");if(a<3600)return rtf.format(Math.round(s/60),"minute");
    if(a<86400)return rtf.format(Math.round(s/3600),"hour");return rtf.format(Math.round(s/86400),"day");}
  document.querySelectorAll("time[data-ts]").forEach(function(el){var ts=+el.getAttribute("data-ts");
    el.title=new Date(ts).toLocaleString();el.textContent=el.hasAttribute("data-abs")?new Date(ts).toLocaleString():rel(ts);});
})();
</script>`;

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>${CSS}</style>${head}</head>
<body><main>${body}</main>${TIME_SCRIPT}</body></html>`;
}

function snippet(origin: string): string {
  return `<script async src="${origin}/s.js" data-site="your-site"></script>`;
}

export function listPage(a: ListArgs): string {
  const f = a.filters;
  const qs = (extra: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    if (f.site) p.set("site", f.site);
    if (f.minSec) p.set("min", String(f.minSec));
    if (f.rage) p.set("rage", "1");
    if (f.errors) p.set("errors", "1");
    for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, String(v));
    return p.toString();
  };
  const s = a.summary;
  const pct = (x: number) => (s.n ? `${Math.round((x / s.n) * 100)}%` : "—");

  const rows = a.rows
    .map((r) => {
      const d = device(r.ua);
      return `<a class="row" href="/s/${esc(r.id)}">
  <div><time data-ts="${r.started_at}"></time><div class="site">${esc(r.site)}</div></div>
  <div class="url" title="${esc(r.entry_url)}">${esc(path(r.entry_url))}${r.pages > 1 ? ` <span class="muted">+${r.pages - 1} pages</span>` : ""}</div>
  <div>${dur(r.last_at - r.started_at)}</div>
  <div>${r.clicks} <span class="muted">clk</span></div>
  <div>${r.rage_clicks ? `<span class="badge b-rage" title="Rage clicks">${r.rage_clicks}×rage</span>` : ""}${r.errors ? `<span class="badge b-err" title="JS errors">${r.errors}×err</span>` : ""}</div>
  <div class="muted" title="${esc(r.ua)}">${ICON[d.kind]} ${esc(d.browser)}${d.os ? ` · ${esc(d.os)}` : ""}${r.country ? ` · ${esc(r.country)}` : ""}</div>
</a>`;
    })
    .join("");

  return shell(
    "notjar",
    `<header>
  <a class="logo" href="/">not<span>jar</span></a><span class="muted">session replay</span>
  <details class="install"><summary>Install snippet</summary><pre class="mono">${esc(snippet(a.origin))}</pre>
  <p class="muted">Optional: <code>data-sample="0.25"</code> to record a fraction of sessions, <code>data-mask-text="true"</code> to mask all text. Inputs are always masked. Add class <code>nj-block</code> to hide an element entirely.</p></details>
</header>
<section class="cards">
  <div class="card"><span class="muted">Sessions · 7d</span><b>${s.n}</b></div>
  <div class="card"><span class="muted">Avg duration</span><b>${dur(s.avg_ms)}</b></div>
  <div class="card"><span class="muted">With rage clicks</span><b>${pct(s.rage)}</b></div>
  <div class="card"><span class="muted">With JS errors</span><b>${pct(s.errs)}</b></div>
</section>
<form class="filters" method="get">
  <select name="site" onchange="this.form.submit()"><option value="">All sites</option>${a.sites
    .map((x) => `<option value="${esc(x.site)}"${x.site === f.site ? " selected" : ""}>${esc(x.site)} (${x.n})</option>`)
    .join("")}</select>
  <label class="chk">Min <input type="number" name="min" min="0" step="5" value="${f.minSec || ""}" placeholder="0" style="width:64px;padding:2px 6px"> s</label>
  <label class="chk"><input type="checkbox" name="rage" value="1"${f.rage ? " checked" : ""} onchange="this.form.submit()"> Rage clicks</label>
  <label class="chk"><input type="checkbox" name="errors" value="1"${f.errors ? " checked" : ""} onchange="this.form.submit()"> JS errors</label>
  <button class="primary" type="submit">Filter</button>
</form>
<div class="table">
  <div class="row head"><div>Started</div><div>Entry page</div><div>Duration</div><div>Clicks</div><div>Signals</div><div>Device</div></div>
  ${rows || `<div class="empty">No sessions yet. Drop the install snippet on a page and click around.</div>`}
</div>
${a.next ? `<div class="pager"><a class="btn" href="/?${qs({ before: a.next })}">Older →</a></div>` : ""}`
  );
}

export function replayPage(r: SessionRow): string {
  const d = device(r.ua);
  const json = JSON.stringify(r).replace(/</g, "\\u003c");
  return shell(
    `Replay · ${r.site}`,
    `<header>
  <a class="logo" href="/">not<span>jar</span></a><span class="muted">/ ${esc(r.site)} / ${esc(r.id.slice(0, 8))}</span>
  <form method="post" action="/s/${esc(r.id)}/delete" style="margin-left:auto" onsubmit="return confirm('Delete this recording?')"><button type="submit">Delete</button></form>
</header>
<div class="replay">
  <div id="stage"><p class="muted">Loading recording…</p></div>
  <aside class="side">
    <div class="card"><dl class="meta">
      <dt>Started</dt><dd><time data-ts="${r.started_at}" data-abs></time></dd>
      <dt>Duration</dt><dd>${dur(r.last_at - r.started_at)}</dd>
      <dt>Entry</dt><dd title="${esc(r.entry_url)}">${esc(path(r.entry_url))}</dd>
      <dt>Exit</dt><dd title="${esc(r.exit_url)}">${esc(path(r.exit_url))}</dd>
      <dt>Referrer</dt><dd title="${esc(r.referrer)}">${esc(r.referrer || "direct")}</dd>
      <dt>Device</dt><dd>${esc(d.kind)} · ${esc(d.browser)} ${esc(d.os)}</dd>
      <dt>Viewport</dt><dd>${esc(r.viewport || "—")}</dd>
      <dt>Country</dt><dd>${esc(r.country || "—")}</dd>
      <dt>Activity</dt><dd>${r.pages} pages · ${r.clicks} clicks</dd>
      <dt>Size</dt><dd>${bytes(r.bytes)} · ${r.chunks} chunks</dd>
    </dl></div>
    <div class="card"><b style="font-size:13px;margin-bottom:6px">Moments</b><ul id="moments"><li class="muted">—</li></ul></div>
  </aside>
</div>
<script type="application/json" id="nj-session">${json}</script>
<script src="/assets/player.js"></script>
<script src="/assets/replay.js"></script>`,
    `<link rel="stylesheet" href="/assets/player.css">`
  );
}

export function setupPage(origin: string): string {
  return shell(
    "notjar · setup",
    `<header><span class="logo">not<span>jar</span></span></header>
<div class="card"><p><b style="font-size:16px">Dashboard password not set.</b></p>
<pre class="mono">wrangler secret put DASH_PASSWORD</pre>
<p class="muted">Recording already works. Install snippet:</p><pre class="mono">${esc(snippet(origin))}</pre></div>`
  );
}
