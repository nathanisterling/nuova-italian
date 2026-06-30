/* ===========================================================
   Nuova — Italian sentence audio trainer
   Static, no backend. Italian audio via ElevenLabs (premium),
   with graceful fallback to the browser Web Speech API.
   =========================================================== */

(() => {
  "use strict";

  // ---------- Constants ----------
  const STORE_KEY = "nuova.progress.v1";
  const LESSON_URL = "data/lesson-001.json";

  const RATE = { slow: 0.78, normal: 1.0, fast: 1.22 };

  // ----- ElevenLabs config (public keys, embedded intentionally) -----
  const ELEVEN = {
    model: "eleven_multilingual_v2",     // speaks Italian properly
    // Both keys are tried in order; the first with quota is used.
    keys: [
      "9942e9fdaf19a2abe1fd2021501775ea0d1d83f84d0008c5d2aca2906bd680fb",
      "ac961a1b1bfb424e33f9807f3e26f1680f2336d1d0150521f70648e58e7eae0a"
    ],
    // Curated default voices (all verified to speak Italian via multilingual_v2).
    voices: [
      { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella — clear, warm (f)" },
      { id: "ErXwobaYiN019PkySvjV", name: "Antoni — smooth (m)" },
      { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel — calm (f)" },
      { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi — bright (f)" },
      { id: "pNInz6obpgDQGcFmaJgB", name: "Adam — deep (m)" },
      { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh — friendly (m)" },
      { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli — youthful (f)" },
      { id: "VR6AewLTigWG4xSOukaG", name: "Arnold — strong (m)" }
    ],
    defaultVoice: "EXAVITQu4vr4xnSDxMaL"
  };

  // Playback modes.
  const MODES = {
    full:      { label: "Full Learning" },
    italian:   { label: "Italian Only" },
    recall:    { label: "Active Recall" },
    shadowing: { label: "Shadowing" },
    driving:   { label: "Driving" }
  };

  // ---------- State ----------
  let lesson = null;
  let voices = [];            // Web Speech voices
  let idx = 0;
  let mode = "full";
  let isPlaying = false;
  let runToken = 0;

  // ElevenLabs runtime state
  let elevenDisabled = false;     // true once quota is exhausted on all keys
  let keyIndex = 0;               // index of the working key
  const clipCache = new Map();    // `${voiceId}|${text}` -> decoded AudioBuffer

  // ---- Web Audio engine + iOS unlock ----
  // We play the ElevenLabs MP3 via the Web Audio API (decodeAudioData +
  // AudioBufferSourceNode) instead of an <audio> element. This is far more
  // reliable across browsers (some stall HTMLAudio on blob URLs) and is the
  // standard way to get audio working on iOS Safari: create/resume the
  // AudioContext inside the user gesture, then buffers can be played anytime.
  let audioCtx = null;
  let audioUnlocked = false;
  let currentSource = null;       // active AudioBufferSourceNode

  function getCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    return audioCtx;
  }

  // Must be called SYNCHRONOUSLY from within a user-gesture handler (iOS).
  function unlockAudio() {
    try {
      const ctx = getCtx();
      if (ctx) {
        if (ctx.state === "suspended") ctx.resume();
        if (!audioUnlocked) {
          // Play one silent sample to fully unlock the context on iOS.
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf; src.connect(ctx.destination); src.start(0);
        }
      }
      audioUnlocked = true;
    } catch (e) { console.warn("[Nuova] unlockAudio error:", e); }
    // iOS also gates speechSynthesis behind a gesture — prime it too.
    try {
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {}
  }

  let prefs = {
    itSpeed: "normal",
    enSpeed: "normal",
    itVoice: "",                 // browser fallback Italian voice
    enVoice: "",
    itVoiceEleven: ELEVEN.defaultVoice
  };
  let progress = {
    current: 0,
    completedLesson: false,
    completedSentences: [],
    difficult: [],
    repetitions: 0,
    mode: "full",
    prefs: prefs
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const homeScreen = $("home");
  const playerScreen = $("player");

  // ---------- Storage ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        progress = Object.assign(progress, saved);
        if (saved.prefs) prefs = Object.assign(prefs, saved.prefs);
        mode = saved.mode || mode;
        idx = Math.max(0, saved.current || 0);
      }
    } catch (e) {}
  }
  function save() {
    progress.current = idx;
    progress.mode = mode;
    progress.prefs = prefs;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) {}
  }

  // ---------- Web Speech voices ----------
  function refreshVoices() {
    voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    populateVoiceSelectors();
    updateVoiceWarning();
  }
  function italianVoices() { return voices.filter(v => /^it(-|_|$)/i.test(v.lang)); }
  function englishVoices() { return voices.filter(v => /^en(-|_|$)/i.test(v.lang)); }

  function pickVoice(lang) {
    if (lang === "it") {
      if (prefs.itVoice) { const v = voices.find(v => v.voiceURI === prefs.itVoice); if (v) return v; }
      return italianVoices()[0] || null;
    } else {
      if (prefs.enVoice) { const v = voices.find(v => v.voiceURI === prefs.enVoice); if (v) return v; }
      return englishVoices()[0] || null;
    }
  }

  function populateVoiceSelectors() {
    const itSel = $("it-voice"), enSel = $("en-voice");
    if (!itSel || !enSel) return;
    const fill = (sel, list, autoLabel, current) => {
      sel.innerHTML = "";
      const auto = document.createElement("option");
      auto.value = ""; auto.textContent = autoLabel; sel.appendChild(auto);
      list.forEach(v => {
        const o = document.createElement("option");
        o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`; sel.appendChild(o);
      });
      sel.value = current || "";
    };
    fill(itSel, italianVoices(), "Auto (it-IT)", prefs.itVoice);
    fill(enSel, englishVoices(), "Auto (en)", prefs.enVoice);
  }

  function populateElevenSelector() {
    const sel = $("it-voice-eleven");
    if (!sel) return;
    sel.innerHTML = "";
    ELEVEN.voices.forEach(v => {
      const o = document.createElement("option");
      o.value = v.id; o.textContent = v.name; sel.appendChild(o);
    });
    sel.value = prefs.itVoiceEleven || ELEVEN.defaultVoice;
  }

  function updateVoiceWarning() {
    const el = $("voice-warning");
    if (!el) return;
    if (!("speechSynthesis" in window)) {
      el.textContent = "This browser does not support speech synthesis (used as fallback).";
      return;
    }
    if (italianVoices().length === 0) {
      el.textContent = "No browser Italian (it-IT) voice found — only relevant if premium audio falls back.";
    } else { el.textContent = ""; }
  }

  // ---------- Audio source indicator + banner ----------
  function setAudioSource() {
    const el = $("audio-source");
    if (!el) return;
    if (elevenDisabled) {
      el.textContent = "🔊 Browser Italian voice (premium unavailable)";
      el.classList.add("fallback");
    } else {
      el.textContent = "🎙 Premium Italian voice (ElevenLabs)";
      el.classList.remove("fallback");
    }
  }
  function showBanner(msg) {
    const b = $("audio-banner");
    if (!b) return;
    b.textContent = msg;
    b.hidden = false;
  }

  function disableEleven(reason) {
    if (elevenDisabled) return;
    elevenDisabled = true;
    setAudioSource();
    if (reason === "quota") {
      showBanner("⚠ Premium Italian audio is unavailable — the ElevenLabs quota is used up. Falling back to your browser's Italian voice.");
    } else if (reason === "unsupported") {
      showBanner("⚠ Premium Italian audio couldn't start in this browser. Using the browser's Italian voice instead.");
    } else {
      showBanner("⚠ Premium Italian audio is unavailable right now. Using the browser's Italian voice instead.");
    }
  }

  // ---------- ElevenLabs fetch ----------
  function currentElevenVoice() { return prefs.itVoiceEleven || ELEVEN.defaultVoice; }

  async function fetchItalianClip(text) {
    const voice = currentElevenVoice();
    const cacheKey = voice + "|" + text;
    if (clipCache.has(cacheKey)) return clipCache.get(cacheKey);

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`;
    const body = JSON.stringify({
      text,
      model_id: ELEVEN.model,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    });

    let sawQuota = false;
    // Outer loop = one transient-network retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      let networkError = false;
      // Try each key, starting from the last known-good one.
      for (let k = 0; k < ELEVEN.keys.length; k++) {
        const key = ELEVEN.keys[(keyIndex + k) % ELEVEN.keys.length];
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
            body
          });
          const ct = r.headers.get("content-type") || "";
          console.log(`[Nuova] ElevenLabs key#${(keyIndex + k) % ELEVEN.keys.length} → HTTP ${r.status} (${ct})`);
          if (r.ok && ct.includes("audio")) {
            const arr = await r.arrayBuffer();
            const ctx = getCtx();
            if (!ctx) return null; // no Web Audio support → caller falls back
            let buffer;
            try {
              buffer = await ctx.decodeAudioData(arr.slice(0));
            } catch (e) {
              console.warn("[Nuova] decodeAudioData failed:", e && e.message);
              return null; // fall back to web speech for this utterance
            }
            clipCache.set(cacheKey, buffer);
            keyIndex = (keyIndex + k) % ELEVEN.keys.length; // remember working key
            return buffer;
          }
          if (r.status === 401 || r.status === 429) { sawQuota = true; continue; } // try next key
          // other HTTP error: try next key as well
          continue;
        } catch (e) {
          console.warn("[Nuova] ElevenLabs fetch network error:", e && e.message);
          networkError = true; // CORS / offline / DNS
        }
      }
      if (networkError && attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
      break;
    }

    if (sawQuota) disableEleven("quota");
    return null; // signal caller to fall back
  }

  // ---------- Speech engine ----------
  function speakWeb(text, lang, token) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) { resolve(); return; }
      if (token !== runToken || !isPlaying) { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(lang);
      if (v) u.voice = v;
      u.lang = lang === "it" ? (v ? v.lang : "it-IT") : (v ? v.lang : "en-US");
      u.rate = lang === "it" ? RATE[prefs.itSpeed] : RATE[prefs.enSpeed];
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  // Play a decoded AudioBuffer via Web Audio. Resolves true when the clip
  // finishes (or is stopped); false if it could not be started (→ fall back).
  function playClip(buffer, token) {
    return new Promise((resolve) => {
      if (token !== runToken || !isPlaying) { resolve(true); return; }
      const ctx = getCtx();
      if (!ctx) { resolve(false); return; }
      let done = false;
      let watchdog = null;
      const finish = (ok) => {
        if (done) return; done = true;
        if (watchdog) clearTimeout(watchdog);
        if (currentSource === src) currentSource = null;
        resolve(ok !== false);
      };
      let src;
      try {
        if (ctx.state === "suspended") ctx.resume();
        src = ctx.createBufferSource();
        src.buffer = buffer;
        try { src.playbackRate.value = RATE[prefs.itSpeed]; } catch (e) {}
        src.connect(ctx.destination);
        src.onended = () => finish(true);
        currentSource = src;
        src._finish = () => finish(true);
        src.start(0);
        status("🎙 Playing premium Italian…");
        // Safety net: never hang the lesson if onended doesn't fire.
        const ms = (buffer.duration / (RATE[prefs.itSpeed] || 1)) * 1000 + 2000;
        watchdog = setTimeout(() => finish(true), ms);
      } catch (err) {
        console.warn("[Nuova] Web Audio playback failed:", err && err.message);
        finish(false);
      }
    });
  }

  async function speakItalian(text, token) {
    if (elevenDisabled) return speakWeb(text, "it", token);
    status("⏳ Fetching premium audio…");
    const clip = await fetchItalianClip(text);
    if (token !== runToken || !isPlaying) return;
    if (clip) {
      const ok = await playClip(clip, token);
      if (ok) return;
      // Playback was blocked by the browser (e.g. iOS gesture issue) → fall back
      // for this utterance and show the banner so the user understands.
      console.warn("[Nuova] premium playback blocked — falling back to browser voice");
      disableEleven("unsupported");
      return speakWeb(text, "it", token);
    }
    // fetch failed for this utterance → fall back (banner already shown if quota)
    return speakWeb(text, "it", token);
  }

  function speak(text, lang, token) {
    if (lang === "it") return speakItalian(text, token);
    return speakWeb(text, "en", token);
  }

  function wait(ms, token) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (token !== runToken || !isPlaying) { resolve(); return; }
        if (Date.now() - start >= ms) { resolve(); return; }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // ---------- Step sequences per mode ----------
  function buildSteps(s) {
    const it = s.italian, lit = s.literal, nat = s.natural;
    switch (mode) {
      case "full":
        return [ {speak:it,lang:"it"}, {pause:3000}, {speak:it,lang:"it"}, {speak:lit,lang:"en"}, {speak:nat,lang:"en"}, {pause:5000} ];
      case "italian":
        return [ {speak:it,lang:"it"}, {pause:3000}, {speak:it,lang:"it"} ];
      case "recall":
        return [ {speak:nat,lang:"en"}, {pause:5000}, {speak:it,lang:"it"} ];
      case "shadowing":
        return [ {speak:it,lang:"it"}, {pause:1000}, {speak:it,lang:"it"} ];
      case "driving":
        return [ {speak:it,lang:"it"}, {pause:3000}, {speak:it,lang:"it"}, {speak:lit,lang:"en"}, {speak:nat,lang:"en"}, {pause:4000} ];
      default:
        return [ {speak:it,lang:"it"} ];
    }
  }

  async function runSentence(token) {
    const s = lesson.sentences[idx];
    for (const step of buildSteps(s)) {
      if (token !== runToken || !isPlaying) return false;
      if (step.pause) await wait(step.pause, token);
      else await speak(step.speak, step.lang, token);
      if (token !== runToken || !isPlaying) return false;
    }
    return true;
  }

  async function play() {
    if (!lesson || isPlaying) return;
    // CRITICAL (iOS): unlock audio synchronously, inside the user-gesture call
    // stack, BEFORE any await — otherwise iOS Safari blocks the later .play().
    unlockAudio();
    isPlaying = true;
    const token = ++runToken;
    setPlayUI(true);
    progress.repetitions++; save();

    while (isPlaying && token === runToken) {
      const finished = await runSentence(token);
      if (!finished || token !== runToken) break;
      if (mode === "driving") {
        if (idx < lesson.sentences.length - 1) { idx++; render(); save(); continue; }
        status("Driving mode complete — end of lesson."); break;
      }
      break;
    }
    if (token === runToken) { isPlaying = false; setPlayUI(false); }
  }

  function stop() {
    isPlaying = false;
    runToken++;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    // Stop the active Web Audio source (fires its onended → resolves playClip).
    if (currentSource) {
      const s = currentSource; currentSource = null;
      try { s.onended = null; s.stop(); } catch (e) {}
      if (s._finish) s._finish();
    }
    setPlayUI(false);
  }

  // Unlock on the gesture even when togglePlay pauses (covers Repeat etc.).
  function togglePlay() { unlockAudio(); if (isPlaying) { stop(); status("Paused."); } else { play(); } }

  // ---------- Navigation ----------
  function goTo(i) { stop(); idx = Math.min(Math.max(0, i), lesson.sentences.length - 1); render(); save(); }
  function next() { goTo(idx + 1); }
  function prev() { goTo(idx - 1); }
  function repeat() { stop(); progress.repetitions++; save(); play(); }

  function setMode(m) {
    if (!MODES[m]) return;
    stop(); mode = m; save(); renderModeBar(); render();
    status(`Mode: ${MODES[m].label}`);
  }

  function markDifficult() {
    const set = new Set(progress.difficult);
    set.has(idx) ? set.delete(idx) : set.add(idx);
    progress.difficult = [...set]; save(); renderDifficultBtn();
  }

  function completeSentence() {
    const set = new Set(progress.completedSentences);
    set.add(idx); progress.completedSentences = [...set];
    if (progress.completedSentences.length >= lesson.sentences.length) progress.completedLesson = true;
    save(); renderProgress(); status("Sentence marked complete.");
    if (mode !== "driving" && idx < lesson.sentences.length - 1) setTimeout(() => goTo(idx + 1), 350);
  }

  // ---------- Rendering ----------
  function render() {
    const s = lesson.sentences[idx];
    $("section-name").textContent = s.section || "Sentence";
    $("sentence-counter").textContent = `${idx + 1} / ${lesson.sentences.length}`;
    $("italian-text").textContent = s.italian;
    $("literal-text").textContent = s.literal;
    $("natural-text").textContent = s.natural;
    $("grammar-note-text").textContent = s.note || "";
    $("recall-hint").hidden = mode !== "recall";
    renderDifficultBtn(); renderProgress(); setAudioSource();
  }

  function renderDifficultBtn() {
    const btn = $("btn-difficult");
    if (progress.difficult.includes(idx)) { btn.classList.add("marked"); btn.textContent = "★ Difficult"; }
    else { btn.classList.remove("marked"); btn.textContent = "☆ Mark difficult"; }
  }

  function renderProgress() {
    const total = lesson.sentences.length, done = progress.completedSentences.length;
    const pct = Math.round((done / total) * 100);
    $("player-progress-fill").style.width = pct + "%";
    $("player-progress-label").textContent =
      `${done} of ${total} completed` + (progress.difficult.length ? ` · ${progress.difficult.length} marked difficult` : "");
    $("home-progress-fill").style.width = pct + "%";
    $("home-progress-label").textContent = done === 0 ? "Not started"
      : (progress.completedLesson ? "Lesson complete 🎉" : `${done} of ${total} sentences complete`);
  }

  function renderModeBar() {
    const bar = $("mode-bar"); bar.innerHTML = "";
    Object.keys(MODES).forEach(key => {
      const b = document.createElement("button");
      b.className = "mode-btn" + (key === mode ? " active" : "");
      b.textContent = MODES[key].label; b.setAttribute("role", "tab");
      b.addEventListener("click", () => setMode(key));
      bar.appendChild(b);
    });
  }

  function setPlayUI(playing) {
    const btn = $("btn-play");
    btn.textContent = playing ? "❚❚" : "▶";
    btn.classList.toggle("playing", playing);
  }

  function status(msg) { $("status-line").textContent = msg; }

  // ---------- Home content ----------
  function renderHome() {
    $("home-lesson-title").textContent = lesson.title;
    $("home-grammar-focus").textContent = "Grammar focus: " + lesson.grammarFocus;
    const g = lesson.grammarExplanation, gEl = $("home-grammar");
    let html = `<p>${g.intro}</p>`;
    g.comparison.forEach(c => {
      html += `<div class="compare-row"><span class="compare-tag">${c.label}</span><div><b>${c.italian}</b><br><span style="color:var(--muted)">${c.english}</span></div></div>`;
    });
    html += `<p>${g.explanation}</p>`;
    html += `<h3>Common triggers</h3><div>${g.commonTriggers.map(t => `<span class="chip">${t}</span>`).join("")}</div>`;
    html += `<h3>Most useful subjunctive forms</h3><div>${g.usefulForms.map(f => `<span class="form-pill">${f.verb} → <b>${f.form}</b></span>`).join("")}</div>`;
    html += `<p style="margin-top:12px">${g.note}</p>`;
    gEl.innerHTML = html;
    $("home-mastery").innerHTML = `<p>You can move on when you can:</p><ul>${lesson.masteryChecklist.map(i => `<li>${i}</li>`).join("")}</ul>`;
    renderProgress();
  }

  // ---------- Screens ----------
  function showPlayer() { homeScreen.classList.remove("active"); playerScreen.classList.add("active"); render(); renderModeBar(); window.scrollTo(0, 0); }
  function showHome() { stop(); playerScreen.classList.remove("active"); homeScreen.classList.add("active"); renderHome(); window.scrollTo(0, 0); }

  // ---------- Settings ----------
  function syncSettingsUI() {
    $("it-speed").value = prefs.itSpeed;
    $("en-speed").value = prefs.enSpeed;
  }
  function wireSettings() {
    $("it-speed").addEventListener("change", e => { prefs.itSpeed = e.target.value; save(); });
    $("en-speed").addEventListener("change", e => { prefs.enSpeed = e.target.value; save(); });
    $("it-voice").addEventListener("change", e => { prefs.itVoice = e.target.value; save(); });
    $("en-voice").addEventListener("change", e => { prefs.enVoice = e.target.value; save(); });
    $("it-voice-eleven").addEventListener("change", e => { prefs.itVoiceEleven = e.target.value; save(); });
    $("btn-settings-toggle").addEventListener("click", () => { const p = $("settings-panel"); p.hidden = !p.hidden; });
  }
  function wireCollapsibles() {
    document.querySelectorAll(".collapse-toggle").forEach(t => {
      t.addEventListener("click", () => $(t.dataset.target).classList.toggle("open"));
    });
  }
  function wireControls() {
    $("btn-start").addEventListener("click", () => { goTo(0); showPlayer(); });
    $("btn-continue").addEventListener("click", showPlayer);
    $("btn-home").addEventListener("click", showHome);
    $("btn-play").addEventListener("click", togglePlay);
    $("btn-prev").addEventListener("click", prev);
    $("btn-next").addEventListener("click", next);
    $("btn-repeat").addEventListener("click", repeat);
    $("btn-difficult").addEventListener("click", markDifficult);
    $("btn-complete").addEventListener("click", completeSentence);
  }

  // ---------- Boot ----------
  async function init() {
    load();
    wireControls(); wireSettings(); wireCollapsibles();
    populateElevenSelector(); syncSettingsUI();

    if ("speechSynthesis" in window) {
      refreshVoices();
      window.speechSynthesis.onvoiceschanged = refreshVoices;
    } else { updateVoiceWarning(); }

    try {
      const res = await fetch(LESSON_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      lesson = await res.json();
    } catch (e) {
      document.body.innerHTML =
        `<div style="padding:24px;font-family:sans-serif;color:#0b1d3a">
          <h2>Couldn't load the lesson.</h2>
          <p>Open this app through a web server (not by double-clicking the file),
          because browsers block <code>fetch()</code> on <code>file://</code> URLs.</p>
          <p>See the README for the one-line command. (On GitHub Pages this works automatically.)</p>
          <pre>${String(e)}</pre>
        </div>`;
      return;
    }

    $("btn-continue").disabled = progress.completedSentences.length === 0 && progress.current === 0;
    setAudioSource();
    renderHome();
    window.Nuova = {
      get state(){ return { idx, mode, isPlaying, elevenDisabled, audioUnlocked, keyIndex, cacheSize: clipCache.size, total: lesson ? lesson.sentences.length : 0, progress, prefs, voices: voices.length }; },
      MODES, ELEVEN, fetchItalianClip
    };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
