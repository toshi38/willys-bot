// Cook mode: one step at a time, with timers that keep running while the
// cook moves on. Timers count to a fixed end time, so they stay right when
// the phone sleeps the page, and the position and timers are kept per
// recipe so a reload carries on where it was.
//
// The logic is plain functions on Cook (state in, HTML or new state out),
// tested in src/recipes/cook.test.ts; boot() wires them to the page.
(function (root) {
  "use strict";
  var Cook = {};

  var esc = (Cook.esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  });

  // "4:05", "12:00", "1:02:03"; never negative.
  Cook.clock = function (ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (r < 10 ? "0" : "") + r;
  };

  Cook.newState = function () {
    return { pos: 0, timers: [] };
  };

  // A saved state, or a fresh one when it is missing, from another version
  // or out of range for this recipe.
  Cook.restore = function (saved, stepCount) {
    if (!saved || typeof saved.pos !== "number" || !Array.isArray(saved.timers)) return Cook.newState();
    if (saved.pos < 0 || saved.pos > stepCount) saved.pos = 0;
    saved.timers = saved.timers.filter(function (t) {
      return t && typeof t.id === "string" && typeof t.end === "number" && typeof t.total === "number";
    });
    return saved;
  };

  Cook.timerFor = function (state, id) {
    for (var i = 0; i < state.timers.length; i++) if (state.timers[i].id === id) return state.timers[i];
    return null;
  };

  // Starts a step's timer unless it is already running. Returns whether it
  // started one.
  Cook.start = function (state, step, now) {
    if (!step.timer || Cook.timerFor(state, step.id)) return false;
    var total = step.timer.minutes * 60000;
    state.timers.push({ id: step.id, label: step.timer.label, end: now + total, total: total, ringing: false });
    return true;
  };

  Cook.addMinute = function (state, id) {
    var t = Cook.timerFor(state, id);
    if (t && !t.ringing) { t.end += 60000; t.total += 60000; }
  };

  Cook.stop = function (state, id) {
    state.timers = state.timers.filter(function (t) { return t.id !== id; });
  };

  // Marks finished timers as ringing. Returns whether any started ringing
  // now, so the page can redraw.
  Cook.tick = function (state, now) {
    var rang = false;
    state.timers.forEach(function (t) {
      if (!t.ringing && t.end <= now) { t.ringing = true; rang = true; }
    });
    return rang;
  };

  Cook.ringing = function (state) {
    return state.timers.some(function (t) { return t.ringing; });
  };

  // What a running timer shows: the time left and how much of it is left.
  Cook.timerView = function (t, now) {
    var left = Math.max(0, t.end - now);
    return { text: t.ringing ? null : Cook.clock(left), left: t.total ? left / t.total : 0 };
  };

  // Moves by one step. Position 0 is the overview, position n is step n.
  // Returns "leave" when moving past the last step.
  Cook.move = function (state, by, stepCount) {
    var to = state.pos + by;
    if (to > stepCount) { state.pos = 0; return "leave"; }
    state.pos = Math.max(0, to);
    return state.pos;
  };

  // The next timer the cook will start: the current step's or a later
  // one's, not already running.
  Cook.nextTimer = function (data, state) {
    for (var i = Math.max(0, state.pos - 1); i < data.steps.length; i++) {
      var s = data.steps[i];
      if (s.timer && !Cook.timerFor(state, s.id)) return s;
    }
    return null;
  };

  Cook.ring = function (left, size) {
    size = size || 34;
    var r = size / 2 - 3;
    var c = 2 * Math.PI * r;
    var mid = size / 2;
    return '<svg width="' + size + '" height="' + size + '" aria-hidden="true"><circle cx="' + mid + '" cy="' + mid + '" r="' + r +
      '" fill="none" stroke="var(--rule)" stroke-width="3"/><circle data-arc data-c="' + c.toFixed(2) + '" cx="' + mid + '" cy="' + mid + '" r="' + r +
      '" fill="none" stroke="var(--k)" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' +
      (c * (1 - left)).toFixed(2) + '" transform="rotate(-90 ' + mid + " " + mid + ')"/></svg>';
  };

  Cook.kindOf = function (data, state) {
    return state.pos === 0 ? "cook" : data.steps[state.pos - 1].kind;
  };

  Cook.timersHtml = function (data, state, now) {
    var t = data.t;
    var html = state.timers.map(function (x) {
      var step = data.steps.filter(function (s) { return s.id === x.id; })[0];
      var v = Cook.timerView(x, now);
      return '<div class="tm k-' + (step ? step.kind : "cook") + (x.ringing ? " ringing" : "") + '">' +
        (x.ringing ? "" : Cook.ring(v.left)) +
        '<div><b data-left="' + esc(x.id) + '">' + (x.ringing ? esc(t.timerDone) : v.text) + "</b><span>" + esc(x.label) + "</span></div>" +
        (x.ringing ? "" : '<button data-act="add" data-id="' + esc(x.id) + '" aria-label="+1 ' + esc(t.min) + '">+1</button>') +
        '<button data-act="stop" data-id="' + esc(x.id) + '" aria-label="' + esc(t.done) + '">✓</button></div>';
    }).join("");
    var next = Cook.nextTimer(data, state);
    if (next) html += '<div class="tm ghost"><div><span>' + esc(t.nextTimer) + '</span><b style="font-size:17px;margin-top:3px">' + esc(next.timer.label) + "</b></div></div>";
    return html;
  };

  Cook.progressHtml = function (data, state) {
    return data.steps.map(function (_, i) {
      var n = i + 1;
      return '<i class="' + (n < state.pos ? "done" : n === state.pos ? "now" : "") + '"></i>';
    }).join("");
  };

  Cook.bodyHtml = function (data, state, now) {
    var t = data.t;
    if (state.pos === 0) {
      return '<div class="main"><span class="pill">' + esc(t.beforeStart) + "</span>" +
        '<div class="big">' + esc(data.name) + "</div>" +
        (data.equipment.length ? "<h4>" + esc(t.equipment) + "</h4><p>" + esc(data.equipment.join(", ")) + "</p>" : "") + "</div>" +
        '<div class="side"><h4>' + esc(t.ingredients) + '</h4><ul class="uses">' + data.ingredients.map(function (l) { return "<li><span>" + l + "</span></li>"; }).join("") + "</ul></div>";
    }
    var s = data.steps[state.pos - 1];
    var html = '<div class="main"><span class="pill">' + esc(t.kinds[s.kind]) + (s.chips.length ? " · " + esc(s.chips.join(" · ")) : "") + "</span>" +
      '<div class="big">' + esc(s.text) + "</div>";
    var waits = s.after.map(function (id) { return Cook.timerFor(state, id); }).filter(function (x) { return x && !x.ringing; });
    if (waits.length) {
      html += '<div class="waits">' + esc(t.waitsFor) + ": " + waits.map(function (x) {
        return esc(x.label) + ' <b data-left="' + esc(x.id) + '">' + Cook.clock(x.end - now) + "</b>";
      }).join(", ") + "</div>";
    }
    if (s.timer && s.passive) html += '<p class="aside">' + esc(t.whileRuns) + "</p>";
    html += '</div><div class="side">';
    if (s.uses.length) html += '<ul class="uses">' + s.uses.map(function (l) { return "<li><span>" + l + "</span></li>"; }).join("") + "</ul>";
    var next = data.steps[state.pos];
    if (next) html += '<p class="next-up"><b>' + esc(t.next) + "</b>" + esc(next.text) + "</p>";
    return html + "</div>";
  };

  Cook.goHtml = function (data, state) {
    if (state.pos === 0) return "";
    var s = data.steps[state.pos - 1];
    if (!s.timer) return "";
    if (Cook.timerFor(state, s.id)) return '<button class="go" disabled>' + esc(data.t.timerRunning) + "</button>";
    return '<button class="go" data-act="go">' + esc(s.startLabel) + " <small>" + esc(s.timerText) + "</small></button>";
  };

  Cook.navLabel = function (data, state) {
    var t = data.t;
    return state.pos === 0 ? t.start : state.pos === data.steps.length ? t.done : t.nextStep;
  };

  Cook.countLabel = function (data, state) {
    return state.pos === 0 ? data.t.beforeStart : data.t.stepOf.replace("{n}", state.pos).replace("{total}", data.steps.length);
  };

  // The alarm: a short beep pattern from Web Audio, unlocked by a tap so the
  // browser allows sound, plus vibration where there is any.
  function alarm(audio) {
    if (audio) {
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
    }
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  }

  function boot() {
    var data = JSON.parse(document.getElementById("data").textContent);
    var key = "cook:" + data.key;
    var state;
    try { state = Cook.restore(JSON.parse(localStorage.getItem(key) || "null"), data.steps.length); } catch (e) { state = Cook.newState(); }
    var $ = function (id) { return document.getElementById(id); };
    var save = function () { try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {} };

    var lock = null;
    function wake() {
      if (!("wakeLock" in navigator) || lock) return;
      navigator.wakeLock.request("screen").then(function (l) {
        lock = l;
        l.addEventListener("release", function () { lock = null; });
      }).catch(function () {});
    }
    var audio = null;
    function unlockAudio() {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!audio && A) audio = new A();
      if (audio && audio.state === "suspended") audio.resume();
    }

    function render() {
      var now = Date.now();
      $("top").className = "cook-top k-" + Cook.kindOf(data, state);
      $("count").textContent = Cook.countLabel(data, state);
      $("progress").innerHTML = Cook.progressHtml(data, state);
      $("timers").innerHTML = Cook.timersHtml(data, state, now);
      $("step").innerHTML = Cook.bodyHtml(data, state, now);
      $("step").className = "wrap" + (state.pos === 0 ? " overview" : "");
      $("body").className = "cook-body k-" + Cook.kindOf(data, state);
      $("go").innerHTML = Cook.goHtml(data, state);
      $("go").className = "k-" + Cook.kindOf(data, state);
      $("prev").disabled = state.pos === 0;
      $("next").textContent = Cook.navLabel(data, state);
    }

    var lastBeep = 0;
    function tick() {
      var now = Date.now();
      if (Cook.tick(state, now)) { save(); render(); }
      if (Cook.ringing(state)) {
        if (now - lastBeep > 2000) { lastBeep = now; alarm(audio); }
        document.title = "⏰ " + data.t.timerDone;
      } else {
        document.title = data.name;
      }
      // Only the numbers change between renders, so buttons stay put.
      state.timers.forEach(function (x) {
        var v = Cook.timerView(x, now);
        document.querySelectorAll('[data-left="' + x.id + '"]').forEach(function (b) { if (v.text) b.textContent = v.text; });
      });
      document.querySelectorAll("#timers .tm").forEach(function (el, i) {
        var x = state.timers[i];
        var arc = el.querySelector("[data-arc]");
        if (x && arc) arc.setAttribute("stroke-dashoffset", (Number(arc.dataset.c) * (1 - Cook.timerView(x, now).left)).toFixed(2));
      });
    }

    function act(name, id) {
      unlockAudio();
      wake();
      var now = Date.now();
      if (name === "go") {
        var s = data.steps[state.pos - 1];
        Cook.start(state, s, now);
        if (s.passive && state.pos < data.steps.length) state.pos++;
      } else if (name === "add") Cook.addMinute(state, id);
      else if (name === "stop") Cook.stop(state, id);
      else if (name === "prev" || name === "next") {
        if (Cook.move(state, name === "next" ? 1 : -1, data.steps.length) === "leave") { save(); location.href = "../"; return; }
        $("body").scrollTop = 0;
      }
      save();
      render();
      tick();
    }
    document.getElementById("app").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (b && !b.disabled) act(b.dataset.act, b.dataset.id);
    });

    // Swiping the step sideways moves between steps.
    var x0 = null;
    $("body").addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    $("body").addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 70) act(dx < 0 ? "next" : "prev");
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { wake(); tick(); }
    });

    render();
    tick();
    setInterval(tick, 500);
  }

  root.Cook = Cook;
  if (typeof document !== "undefined" && document.getElementById("data")) boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
