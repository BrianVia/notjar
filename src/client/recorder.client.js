// Browser recorder. Served at /s.js, appended after the vendored rrweb record bundle,
// which has already put `rrwebRecord` on `__nj` (see buildSnippet in src/index.ts).
// Plain ES2017, no build step. Config comes from the <script> tag's data-* attributes:
//   data-site="meals"        required, groups sessions in the dashboard
//   data-sample="0.25"       optional, fraction of sessions to record (default 1)
//   data-mask-text="true"    optional, masks all text on the page (inputs are always masked)
(function (lib, script) {
  if (!script || !lib || !lib.record) return;
  if (window.__notjar) return;
  window.__notjar = true;

  var record = lib.record;
  var src = new URL(script.src, location.href);
  var endpoint = src.origin + "/ingest";
  var site = (script.getAttribute("data-site") || location.hostname).toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 64);
  var sample = parseFloat(script.getAttribute("data-sample") || "1");
  var maskText = script.getAttribute("data-mask-text") === "true";

  var IDLE_MS = 30 * 60 * 1000;     // new session after 30 min of inactivity
  var MAX_MS = 60 * 60 * 1000;      // stop recording a page after 60 min
  var FLUSH_MS = 10000;
  var FLUSH_EVENTS = 400;
  var MAX_BUFFER = 5000;            // drop oldest if the endpoint is down

  function rid() {
    var a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }

  // Session id survives navigations within a tab; expires after inactivity.
  var now = Date.now();
  var sid = ss("nj_sid");
  var last = parseInt(ss("nj_last") || "0", 10);
  if (!sid || now - last > IDLE_MS) {
    sid = rid();
    ss("nj_sid", sid);
    ss("nj_in", Math.random() < sample ? "1" : "0");
  }
  ss("nj_last", String(now));
  if (ss("nj_in") === "0") return;

  var pid = rid().slice(0, 8);      // page-load id, keeps chunk keys unique across navigations
  var seq = 0;
  var buf = [];
  var sending = false;
  var startedAt = now;

  function payload(events) {
    return JSON.stringify({
      sid: sid, pid: pid, seq: seq++, site: site,
      url: location.href, ref: document.referrer || null,
      vw: innerWidth + "x" + innerHeight,
      events: events
    });
  }

  function gzip(str) {
    if (typeof CompressionStream === "undefined") return Promise.resolve(null);
    var stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).blob();
  }

  function flush() {
    if (sending || !buf.length) return;
    var events = buf;
    buf = [];
    sending = true;
    ss("nj_last", String(Date.now()));
    var body = payload(events);
    gzip(body).then(function (gz) {
      // text/plain keeps this a CORS "simple request": no preflight.
      return fetch(endpoint + (gz ? "?z=1" : ""), {
        method: "POST",
        body: gz ? new Blob([gz], { type: "text/plain" }) : body,
        headers: { "content-type": "text/plain" },
        credentials: "omit",
        keepalive: (gz ? gz.size : body.length) < 60000
      });
    }).then(function (r) {
      if (!r.ok && r.status >= 500) throw new Error("ingest " + r.status);
    }).catch(function () {
      buf = events.concat(buf).slice(-MAX_BUFFER);
    }).then(function () {
      sending = false;
      if (buf.length >= FLUSH_EVENTS) flush();
    });
  }

  // Last-gasp send while the page is going away. Beacons cap at ~64KB, so this only carries the tail.
  function beacon() {
    if (!buf.length) return;
    var body = payload(buf);
    buf = [];
    try { navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" })); } catch (e) { /* gone */ }
  }

  var stop = record({
    emit: function (ev) {
      buf.push(ev);
      // Full snapshots are big: ship them right away so they never ride a beacon.
      if (ev.type === 2 || buf.length >= FLUSH_EVENTS) setTimeout(flush, 0);
      if (Date.now() - startedAt > MAX_MS && stop) { stop(); stop = null; flush(); }
    },
    maskAllInputs: true,
    maskTextSelector: maskText ? "*" : undefined,
    blockClass: "nj-block",
    maskTextClass: "nj-mask",
    ignoreClass: "nj-ignore",
    inlineStylesheet: true,
    sampling: { mousemove: 50, scroll: 150, media: 800, input: "last" },
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaVerification: true, headMetaAuthorship: true }
  });

  function errorEvent(message, source, stack) {
    try {
      record.addCustomEvent("error", {
        message: String(message || "Error").slice(0, 500),
        source: source ? String(source).slice(0, 300) : null,
        stack: stack ? String(stack).slice(0, 2000) : null
      });
    } catch (e) { /* recorder stopped */ }
  }
  addEventListener("error", function (e) {
    if (e && e.message) errorEvent(e.message, (e.filename || "") + ":" + (e.lineno || 0), e.error && e.error.stack);
  });
  addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    errorEvent("Unhandled rejection: " + (r && r.message ? r.message : String(r)), null, r && r.stack);
  });

  setInterval(flush, FLUSH_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
  addEventListener("pagehide", beacon);

  window.notjar = {
    sessionId: sid,
    tag: function (name, data) { try { record.addCustomEvent(String(name).slice(0, 64), data || {}); } catch (e) {} },
    stop: function () { if (stop) { stop(); stop = null; } flush(); }
  };
})(__nj.rrwebRecord, __njScript);
