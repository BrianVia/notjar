// Replay page logic. Served at /assets/replay.js after the rrweb-player UMD bundle (window.rrwebPlayer).
(function () {
  var meta = JSON.parse(document.getElementById("nj-session").textContent);
  var stage = document.getElementById("stage");
  var momentsEl = document.getElementById("moments");

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function msg(text) {
    stage.innerHTML = "";
    var p = document.createElement("p");
    p.className = "muted";
    p.textContent = text;
    stage.appendChild(p);
  }

  fetch("/api/s/" + encodeURIComponent(meta.id) + "/events")
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (events) {
      events.sort(function (a, b) { return a.timestamp - b.timestamp; });
      // The replayer needs Meta + FullSnapshot first; drop anything recorded before the first page snapshot.
      var firstMeta = events.findIndex(function (e) { return e.type === 4; });
      if (firstMeta > 0) events = events.slice(firstMeta);
      var hasSnapshot = events.some(function (e) { return e.type === 2; });
      if (firstMeta < 0 || !hasSnapshot || events.length < 2) return msg("Not enough data to replay this session (no page snapshot arrived).");

      var Player = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer.Player);
      var start = events[0].timestamp;
      var vw = events[0].data.width || 1280;
      var vh = events[0].data.height || 800;

      function size() {
        var w = stage.clientWidth - 20;
        var h = Math.min(Math.round((w * vh) / vw), window.innerHeight - 240);
        return { width: w, height: Math.max(240, h) };
      }

      stage.innerHTML = "";
      var sz = size();
      var player = new Player({
        target: stage,
        props: {
          events: events,
          width: sz.width,
          height: sz.height,
          autoPlay: true,
          skipInactive: true,
          showController: true,
          speedOption: [1, 2, 4, 8],
          mouseTail: { strokeStyle: "#ea580c", lineWidth: 2 }
        }
      });

      var t;
      window.addEventListener("resize", function () {
        clearTimeout(t);
        t = setTimeout(function () {
          var s = size();
          player.$set({ width: s.width, height: s.height });
          player.triggerResize();
        }, 150);
      });

      renderMoments(buildMoments(events), start, player);
    })
    .catch(function (err) { msg("Failed to load recording: " + err.message); });

  function buildMoments(events) {
    var out = [];
    var recent = [];
    var lastRage = -Infinity;
    events.forEach(function (e) {
      if (e.type === 4 && e.data && e.data.href) {
        var p;
        try { var u = new URL(e.data.href); p = u.pathname + u.search; } catch (x) { p = e.data.href; }
        out.push({ t: e.timestamp, kind: "page", label: "Visited " + p });
      } else if (e.type === 5 && e.data) {
        if (e.data.tag === "error") out.push({ t: e.timestamp, kind: "error", label: (e.data.payload && e.data.payload.message) || "Error" });
        else out.push({ t: e.timestamp, kind: "tag", label: "#" + e.data.tag });
      } else if (e.type === 3 && e.data && e.data.source === 2 && e.data.type === 2) {
        var x = +e.data.x || 0, y = +e.data.y || 0, ts = e.timestamp;
        recent = recent.filter(function (c) { return ts - c.t <= 1000; });
        recent.push({ t: ts, x: x, y: y });
        var near = recent.filter(function (c) { return Math.hypot(c.x - x, c.y - y) <= 40; });
        if (near.length >= 3 && ts - lastRage > 1000) {
          lastRage = ts;
          out.push({ t: near[0].t, kind: "rage", label: "Rage click" });
        }
      }
    });
    return out;
  }

  function renderMoments(list, start, player) {
    momentsEl.innerHTML = "";
    if (!list.length) {
      var li0 = document.createElement("li");
      li0.className = "muted";
      li0.textContent = "Nothing notable";
      momentsEl.appendChild(li0);
      return;
    }
    list.forEach(function (m) {
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      b.className = "k-" + m.kind;
      var tEl = document.createElement("span");
      tEl.className = "t";
      tEl.textContent = fmt(m.t - start);
      var lab = document.createElement("span");
      lab.textContent = m.label;
      lab.title = m.label;
      b.appendChild(tEl);
      b.appendChild(lab);
      // Jump a beat early so you see the lead-up.
      b.onclick = function () { player.goto(Math.max(0, m.t - start - 1500), true); };
      li.appendChild(b);
      momentsEl.appendChild(li);
    });
  }
})();
