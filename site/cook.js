// Cook mode: one step at a time, with timers that keep running while the
// cook moves on. Timers count to a fixed end time, so they stay right when
// the phone sleeps the page, and the position and timers are kept per
// recipe so a reload carries on where it was.
(function () {
  "use strict";
  var data = JSON.parse(document.getElementById("data").textContent);
  var t = data.t;
  var steps = data.steps;
  var storeKey = "cook:" + data.key;
  var state = { pos: 0, timers: [] };
  try {
    var saved = JSON.parse(localStorage.getItem(storeKey) || "null");
    if (saved && typeof saved.pos === "number") state = saved;
  } catch (e) {}
  if (state.pos > steps.length) state.pos = 0;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };
  function save() {
    try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) {}
  }

  // Keeps the screen on while cooking, where the browser allows it.
  var lock = null;
  function wake() {
    if (!("wakeLock" in navigator) || lock) return;
    navigator.wakeLock.request("screen").then(function (l) {
      lock = l;
      l.addEventListener("release", function () { lock = null; });
    }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { wake(); tick(); }
  });

  // The alarm: a short beep pattern from Web Audio, started from a tap so
  // the browser allows sound, plus vibration where there is any.
  var audio = null;
  function unlockAudio() {
    var A = window.AudioContext || window.webkitAudioContext;
    if (!audio && A) audio = new A();
    if (audio && audio.state === "suspended") audio.resume();
  }
  function beep() {
    if (!audio) return;
    [0, 0.25, 0.5].forEach(function (offset) {
      var o = audio.createOscillator();
      var g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.4, audio.currentTime + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + offset);
      o.stop(audio.currentTime + offset + 0.2);
    });
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  }

  function timerFor(id) {
    return state.timers.filter(function (x) { return x.id === id; })[0];
  }
  function startTimer(step) {
    unlockAudio();
    wake();
    if (timerFor(step.id)) return;
    state.timers.push({ id: step.id, label: step.timer.label, end: Date.now() + step.timer.minutes * 60000, ringing: false });
    save();
  }
  function clock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (r < 10 ? "0" : "") + r;
  }

  var lastBeep = 0;
  function tick() {
    var now = Date.now();
    var ringing = false;
    var rang = false;
    state.timers.forEach(function (x) {
      if (!x.ringing && x.end <= now) { x.ringing = true; rang = true; save(); }
      if (x.ringing) ringing = true;
    });
    if (ringing && now - lastBeep > 2000) { lastBeep = now; beep(); }
    document.title = ringing ? "⏰ " + t.timerDone : data.name;
    renderTimers(now);
    if (rang) renderCard();
    document.querySelectorAll(".waits b[data-id]").forEach(function (b) {
      var x = timerFor(b.dataset.id);
      if (x) b.textContent = clock(x.end - now);
    });
  }

  function renderTimers(now) {
    $("timers").innerHTML = state.timers.map(function (x, i) {
      return '<div class="t' + (x.ringing ? " ringing" : "") + '"><span>' + esc(x.label) + "</span><b>" +
        (x.ringing ? esc(t.timerDone) : clock(x.end - now)) + "</b>" +
        (x.ringing ? "" : '<button data-add="' + i + '">+1</button>') +
        '<button data-stop="' + i + '" aria-label="' + esc(t.done) + '">✓</button></div>';
    }).join("");
  }
  $("timers").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.add) { state.timers[+b.dataset.add].end += 60000; }
    if (b.dataset.stop) { state.timers.splice(+b.dataset.stop, 1); }
    save();
    renderCard();
    tick();
  });

  // Position 0 is the overview; position n is step n.
  function renderCard() {
    var n = steps.length;
    var main = $("card");
    $("count").textContent = state.pos === 0 ? "" : state.pos + " / " + n;
    $("prev").disabled = state.pos === 0;
    $("next").textContent = state.pos === 0 ? t.start : state.pos === n ? t.done : t.next;
    if (state.pos === 0) {
      main.className = "card-area";
      main.innerHTML = "<h1>" + esc(t.beforeStart) + "</h1>" +
        (data.equipment.length ? "<h2>" + esc(t.equipment) + "</h2><p>" + esc(data.equipment.join(", ")) + "</p>" : "") +
        "<h2>" + esc(t.ingredients) + "</h2><ul>" + data.ingredients.map(function (l) { return "<li>" + l + "</li>"; }).join("") + "</ul>";
      return;
    }
    var s = steps[state.pos - 1];
    var running = timerFor(s.id);
    var now = Date.now();
    var waits = s.after.map(timerFor).filter(function (x) { return x && !x.ringing; });
    var html = '<span class="kind">' + s.icon + " " + esc(t.kinds[s.kind]) + "</span>" +
      '<p class="text">' + esc(s.text) + "</p>";
    if (s.uses.length) html += "<ul>" + s.uses.map(function (l) { return "<li>" + l + "</li>"; }).join("") + "</ul>";
    if (s.chips.length) html += '<div class="chips">' + s.chips.map(function (c) { return '<span class="chip">' + esc(c) + "</span>"; }).join("") + "</div>";
    if (waits.length) {
      html += '<p class="waits">' + esc(t.waitsFor) + ": " + waits.map(function (x) { return esc(x.label) + ' <b data-id="' + esc(x.id) + '">' + clock(x.end - now) + "</b>"; }).join(", ") + "</p>";
    }
    if (s.timer) {
      if (s.passive) html += '<p class="hint">' + esc(t.whileRuns) + "</p>";
      html += running
        ? '<button class="button timer-button" disabled>⏱ ' + esc(t.timerRunning) + "</button>"
        : '<button class="button primary timer-button" id="go">⏱ ' + esc(s.passive ? t.timerGoOn : t.timerStart) + " · " + esc(s.timerText) + "</button>";
    }
    var next = steps[state.pos];
    if (next) html += '<p class="next-up">' + esc(t.next) + ": " + esc(next.text) + "</p>";
    main.className = "card-area kind-" + s.kind;
    main.innerHTML = html;
    var go = $("go");
    if (go) go.addEventListener("click", function () {
      startTimer(s);
      if (s.passive && state.pos < n) state.pos++;
      save();
      renderCard();
      tick();
    });
  }

  function move(by) {
    unlockAudio();
    wake();
    var to = state.pos + by;
    if (to > steps.length) { state = { pos: 0, timers: state.timers }; save(); location.href = "../"; return; }
    state.pos = Math.max(0, to);
    save();
    renderCard();
    $("card").scrollTop = 0;
  }
  $("prev").addEventListener("click", function () { move(-1); });
  $("next").addEventListener("click", function () { move(1); });

  // Swiping the step sideways moves between steps.
  var x0 = null;
  $("card").addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  $("card").addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 70) move(dx < 0 ? 1 : -1);
  });

  renderCard();
  tick();
  setInterval(tick, 500);
})();
