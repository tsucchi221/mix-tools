// ============================================================
// VocalMix Studio v2 – app.js
// ============================================================
'use strict';

// ─── State ──────────────────────────────────────────────────
const state = {
  ctx: null,
  orchestra:    { buffer: null, volume: 1.0, gainNode: null, source: null },
  mainVocal:    { buffer: null, volume: 1.0, offset: 0, source: null, chain: null },
  harmonyTracks: [], // { id, buffer, volume, offset, pan, haasDelay, source, chain }
  nextId: 1,
  isPlaying: false,
  startTime: 0,
  pauseOffset: 0,
  animId: null,
  masterGain: null,
  masterLimiter: null,
  analyserL: null,
  analyserR: null,
  analysis: null,
};

// ─── Params (separate for main / harmony) ───────────────────
const P = {
  main: {
    eq:   { hpf: 80, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
    comp: { threshold: -24, knee: 6, ratio: 4, attack: 3, release: 150, makeup: 0 },
    rev:  { size: 2.0, decay: 0.5, predelay: 20, mix: 0.25 },
    de:   { freq: 7000, amount: 0 },
    sat:  { amount: 10 },
    out:  { gain: 0 },
  },
  harm: {
    eq:   { hpf: 100, low: -2, lowMid: 0, mid: 0, highMid: 1, high: 0 },
    comp: { threshold: -28, knee: 6, ratio: 5, attack: 3, release: 150, makeup: 0 },
    rev:  { size: 2.5, decay: 0.6, predelay: 15, mix: 0.30 },
    de:   { freq: 7000, amount: 3 },
    sat:  { amount: 5 },
    masterVol: 0.8,
  },
  limiter: { threshold: -1 },
  spread:  { width: 40, haas: 10 },
};

// ─── Init ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupStaticDropZones();
  setupSliders();
  setupButtons();
  setupTimeline();
  setupGlobalDrop();
  addHarmonyTrack(); // start with one harmony slot
});

// ─── Audio Context ────────────────────────────────────────────
async function ensureCtx() {
  if (state.ctx) {
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AC = window.AudioContext || (/** @type {any} */ (window)).webkitAudioContext;
  state.ctx = new AC();
  state.masterGain    = state.ctx.createGain();
  state.masterLimiter = state.ctx.createDynamicsCompressor();
  state.masterLimiter.threshold.value = P.limiter.threshold;
  state.masterLimiter.knee.value = 0;
  state.masterLimiter.ratio.value = 20;
  state.masterLimiter.attack.value = 0.001;
  state.masterLimiter.release.value = 0.05;

  const spl = state.ctx.createChannelSplitter(2);
  state.analyserL = state.ctx.createAnalyser(); state.analyserL.fftSize = 256;
  state.analyserR = state.ctx.createAnalyser(); state.analyserR.fftSize = 256;

  state.masterGain.connect(state.masterLimiter);
  state.masterLimiter.connect(spl);
  spl.connect(state.analyserL, 0);
  spl.connect(state.analyserR, 1);
  state.masterLimiter.connect(state.ctx.destination);
}

// ─── Build Vocal Chain ───────────────────────────────────────
// Returns { input, output, ...all nodes }
function buildChain(p) {
  const ctx = state.ctx;
  const c = {};

  c.hpf = mkFilter('highpass', p.eq.hpf, 0.707, 0);
  c.eqLow    = mkFilter('lowshelf',  200,  0,   p.eq.low);
  c.eqLowMid = mkFilter('peaking',   500,  1.0, p.eq.lowMid);
  c.eqMid    = mkFilter('peaking',  2000,  1.0, p.eq.mid);
  c.eqHighMid= mkFilter('peaking',  4000,  1.0, p.eq.highMid);
  c.eqHigh   = mkFilter('highshelf',8000,  0,   p.eq.high);

  c.sat = ctx.createWaveShaper();
  c.sat.curve = satCurve(p.sat.amount);
  c.sat.oversample = '4x';

  c.comp = ctx.createDynamicsCompressor();
  c.comp.threshold.value = p.comp.threshold;
  c.comp.knee.value      = p.comp.knee;
  c.comp.ratio.value     = p.comp.ratio;
  c.comp.attack.value    = p.comp.attack / 1000;
  c.comp.release.value   = p.comp.release / 1000;

  c.makeup = ctx.createGain();
  c.makeup.gain.value = dB(p.comp.makeup);

  c.deEsser = mkFilter('peaking', p.de.freq, 5, -p.de.amount);

  c.preDly = ctx.createDelay(0.5);
  c.preDly.delayTime.value = p.rev.predelay / 1000;

  c.reverb = ctx.createConvolver();
  c.reverb.buffer = impulse(ctx, p.rev.size, p.rev.decay);

  c.dry = ctx.createGain(); c.dry.gain.value = 1 - p.rev.mix;
  c.wet = ctx.createGain(); c.wet.gain.value = p.rev.mix;
  c.mix = ctx.createGain();

  // Wire
  c.hpf.connect(c.eqLow);
  c.eqLow.connect(c.eqLowMid);
  c.eqLowMid.connect(c.eqMid);
  c.eqMid.connect(c.eqHighMid);
  c.eqHighMid.connect(c.eqHigh);
  c.eqHigh.connect(c.sat);
  c.sat.connect(c.comp);
  c.comp.connect(c.makeup);
  c.makeup.connect(c.deEsser);
  c.deEsser.connect(c.dry);
  c.deEsser.connect(c.preDly);
  c.preDly.connect(c.reverb);
  c.reverb.connect(c.wet);
  c.dry.connect(c.mix);
  c.wet.connect(c.mix);

  c.input  = c.hpf;
  c.output = c.mix;
  return c;
}

function mkFilter(type, freq, Q, gain) {
  const f = state.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (Q !== 0) f.Q.value = Q;
  if (['lowshelf','highshelf','peaking'].includes(type)) f.gain.value = gain;
  return f;
}

// ─── Helpers ─────────────────────────────────────────────────
function dB(v)     { return Math.pow(10, v / 20); }
function satCurve(a) {
  const n = 256, cur = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    cur[i] = a === 0 ? x : ((Math.PI + a) * x) / (Math.PI + a * Math.abs(x));
  }
  return cur;
}
function impulse(ctx, dur, dec) {
  const sr  = ctx.sampleRate;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, dec * 8);
  }
  return buf;
}
function fmtT(s) { return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
function totalDur() {
  const { orchestra: o, mainVocal: m } = state;
  let dur = 0;
  if (o.buffer) dur = Math.max(dur, o.buffer.duration);
  if (m.buffer) dur = Math.max(dur, m.buffer.duration + Math.max(0, m.offset / 1000));
  state.harmonyTracks.forEach(h => {
    if (h.buffer) dur = Math.max(dur, h.buffer.duration + Math.max(0, h.offset / 1000));
  });
  return dur || 0;
}

// ─── File Loading ────────────────────────────────────────────
async function loadFile(target, file) {
  setStatus('読み込み中...', 'busy');
  try {
    await ensureCtx();
    const buf = await state.ctx.decodeAudioData(await file.arrayBuffer());
    const short = file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name;

    if (target === 'orchestra') {
      state.orchestra.buffer = buf;
      setTrackUI('orchestra', short, buf.duration);
    } else if (target === 'mainVocal') {
      state.mainVocal.buffer = buf;
      setTrackUI('mainvocal', short, buf.duration);
    } else if (target === 'harmony') {
      // Add new harmony track
      const ht = addHarmonyTrack();
      ht.buffer = buf;
      setHarmonyTrackUI(ht.id, short, buf.duration);
    } else if (typeof target === 'number') {
      // Load into existing harmony track
      const ht = state.harmonyTracks.find(h => h.id === target);
      if (ht) { ht.buffer = buf; setHarmonyTrackUI(ht.id, short, buf.duration); }
    }

    updateButtons();
    drawTimeline();
    setStatus('ロード完了', 'active');
  } catch (e) {
    console.error(e);
    setStatus('エラー: ' + e.message, '');
  }
}

function setTrackUI(key, name, dur) {
  document.getElementById('dur-' + key).textContent   = fmtT(dur);
  document.getElementById('fname-' + key).textContent = name;
  document.getElementById('dzl-' + key).style.display = 'flex';
  document.getElementById('dzi-' + key).style.display = 'none';
  document.getElementById('drop-' + key).classList.add('loaded');
}

function setHarmonyTrackUI(id, name, dur) {
  const el = d => document.getElementById(d + id);
  el('hdur-').textContent   = fmtT(dur);
  el('hname-').textContent  = name;
  el('hdzl-').style.display = 'flex';
  el('hdzi-').style.display = 'none';
  el('hdrop-').classList.add('loaded');
}

// ─── Harmony Track Management ────────────────────────────────
function addHarmonyTrack() {
  const id  = state.nextId++;
  const ht  = { id, buffer: null, volume: P.harm.masterVol, offset: 0, pan: 0, haasDelay: 0, source: null, chain: null };
  state.harmonyTracks.push(ht);

  const n = state.harmonyTracks.length;
  const card = document.createElement('div');
  card.className = 'track-card harmony-card';
  card.id = 'hcard-' + id;
  card.innerHTML = `
    <button class="harm-remove" onclick="removeHarmonyTrack(${id})" title="削除">×</button>
    <div class="track-head">
      <span class="tbadge tbadge-harm">HARM ${n}</span>
      <span class="tname">ハモリ ${n}</span>
      <span class="tdur" id="hdur-${id}"></span>
    </div>
    <div class="dropzone" id="hdrop-${id}">
      <input type="file" class="finput" id="hfile-${id}" accept="audio/*">
      <div class="dz-inner" id="hdzi-${id}">
        <div class="dz-icon">&#127927;</div>
        <p class="dz-text">クリック・ドロップ</p>
        <p class="dz-hint">MP3 / WAV / OGG</p>
      </div>
      <div class="dz-loaded" id="hdzl-${id}" style="display:none">
        <span class="dz-check">✓</span>
        <span class="dz-fname" id="hname-${id}"></span>
      </div>
    </div>
    <div class="slider-row">
      <label>音量</label>
      <input type="range" class="sl" id="hvol-${id}" min="0" max="150" value="${Math.round(P.harm.masterVol*100)}">
      <span class="slv" id="hvol-${id}-v">${Math.round(P.harm.masterVol*100)}%</span>
    </div>
    <div class="slider-row">
      <label>タイミング</label>
      <input type="range" class="sl" id="hoffset-${id}" min="-5000" max="5000" value="0" step="10">
      <span class="slv" id="hoffset-${id}-v">0 ms</span>
    </div>
    <div class="slider-row">
      <label>パン</label>
      <input type="range" class="sl sc" id="hpan-${id}" min="-100" max="100" value="0">
      <span class="slv" id="hpan-${id}-v">C</span>
    </div>
    <div class="slider-row">
      <label>Haas遅延</label>
      <input type="range" class="sl" id="hhaas-${id}" min="0" max="40" value="0">
      <span class="slv" id="hhaas-${id}-v">0 ms</span>
    </div>`;

  // Insert before the "add harmony" card
  const addBtn = document.getElementById('add-harmony-card');
  addBtn.parentNode.insertBefore(card, addBtn);

  // Bind events
  document.getElementById('hfile-' + id).addEventListener('change', e => {
    if (e.target.files[0]) loadFile(id, e.target.files[0]);
  });
  const drop = document.getElementById('hdrop-' + id);
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadFile(id, e.dataTransfer.files[0]);
  });

  bindHarmSlider(`hvol-${id}`, v => {
    ht.volume = v / 100;
    if (ht.chain && ht.chain._outGain) ht.chain._outGain.gain.value = ht.volume;
  }, v => v + '%');

  bindHarmSlider(`hoffset-${id}`, v => {
    ht.offset = v;
    drawTimeline();
    if (state.isPlaying) restartPlayback();
  }, v => v + ' ms');

  bindHarmSlider(`hpan-${id}`, v => {
    ht.pan = v / 100;
    if (ht.chain && ht.chain._panner) ht.chain._panner.pan.value = ht.pan;
    return v === 0 ? 'C' : (v > 0 ? 'R ' + v : 'L ' + Math.abs(v));
  }, v => v === 0 ? 'C' : (v > 0 ? 'R' + v : 'L' + Math.abs(v)));

  bindHarmSlider(`hhaas-${id}`, v => {
    ht.haasDelay = v;
    if (ht.chain && ht.chain._haas) ht.chain._haas.delayTime.value = v / 1000;
  }, v => v + ' ms');

  // Update timeline
  updateTimelineLabels();
  drawTimeline();
  return ht;
}

function removeHarmonyTrack(id) {
  const idx = state.harmonyTracks.findIndex(h => h.id === id);
  if (idx === -1) return;
  const ht = state.harmonyTracks[idx];
  try { ht.source && ht.source.stop(); } catch (_) {}
  try { ht.chain && disconnectChain(ht.chain); } catch (_) {}
  state.harmonyTracks.splice(idx, 1);
  document.getElementById('hcard-' + id)?.remove();
  updateTimelineLabels();
  drawTimeline();
  updateButtons();
}

function bindHarmSlider(id, onChange, fmtFn) {
  const el  = document.getElementById(id);
  const val = document.getElementById(id + '-v');
  if (!el) return;
  el.addEventListener('input', () => {
    const v  = parseFloat(el.value);
    const lbl = fmtFn(v);
    if (val) val.textContent = lbl;
    onChange(v);
  });
}

function updateTimelineLabels() {
  const wrap = document.getElementById('tl-labels');
  wrap.innerHTML = '<div class="tl-lbl">OKE</div><div class="tl-lbl">MAIN</div>';
  state.harmonyTracks.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'tl-lbl';
    d.textContent = `H${i + 1}`;
    wrap.appendChild(d);
  });
}

// ─── Playback ─────────────────────────────────────────────────
async function startPlayback() {
  await ensureCtx();
  const now   = state.ctx.currentTime;
  const pause = state.pauseOffset;
  state.startTime = now - pause;

  // Orchestra
  if (state.orchestra.buffer) {
    const src = state.ctx.createBufferSource();
    src.buffer = state.orchestra.buffer;
    const g = state.ctx.createGain(); g.gain.value = state.orchestra.volume;
    src.connect(g); g.connect(state.masterGain);
    src.start(now, pause);
    state.orchestra.source = src;
    state.orchestra.gainNode = g;
  }

  // Main Vocal
  if (state.mainVocal.buffer) {
    const chain = buildChain(P.main);
    const outG  = state.ctx.createGain(); outG.gain.value = state.mainVocal.volume;
    chain.output.connect(outG); outG.connect(state.masterGain);
    chain._outGain = outG;

    const src   = state.ctx.createBufferSource(); src.buffer = state.mainVocal.buffer;
    src.connect(chain.input);
    const offS  = state.mainVocal.offset / 1000;
    const when  = now + Math.max(0, offS - pause);
    const bufOff = Math.max(0, pause - offS);
    if (bufOff < state.mainVocal.buffer.duration) src.start(when, bufOff);
    state.mainVocal.source = src;
    state.mainVocal.chain  = chain;
  }

  // Harmony Tracks
  state.harmonyTracks.forEach(ht => {
    if (!ht.buffer) return;
    const chain = buildChain(P.harm);

    // Haas delay + Panner + Volume gain after chain
    const haas   = state.ctx.createDelay(0.1); haas.delayTime.value = ht.haasDelay / 1000;
    const panner = state.ctx.createStereoPanner(); panner.pan.value = ht.pan;
    const outG   = state.ctx.createGain(); outG.gain.value = ht.volume;

    chain.output.connect(haas);
    haas.connect(panner);
    panner.connect(outG);
    outG.connect(state.masterGain);

    chain._haas   = haas;
    chain._panner = panner;
    chain._outGain = outG;

    const src    = state.ctx.createBufferSource(); src.buffer = ht.buffer;
    src.connect(chain.input);
    const offS   = ht.offset / 1000;
    const when   = now + Math.max(0, offS - pause);
    const bufOff = Math.max(0, pause - offS);
    if (bufOff < ht.buffer.duration) src.start(when, bufOff);
    ht.source = src;
    ht.chain  = chain;
  });

  state.isPlaying = true;
  setPlayBtn(true);
  startAnim();
}

function pausePlayback() {
  state.pauseOffset = state.ctx.currentTime - state.startTime;
  stopSources();
  state.isPlaying = false;
  setPlayBtn(false);
}

function stopPlayback() {
  state.pauseOffset = 0;
  stopSources();
  state.isPlaying = false;
  setPlayBtn(false);
  document.getElementById('pb-fill').style.width   = '0%';
  document.getElementById('tc').textContent         = '0:00';
  document.getElementById('playhead').style.left   = '0px';
  cancelAnimationFrame(state.animId);
}

function restartPlayback() {
  stopSources();
  state.isPlaying = false;
  startPlayback();
}

function stopSources() {
  const stop = s => { try { s && s.stop(); s && s.disconnect(); } catch (_) {} };
  stop(state.orchestra.source); state.orchestra.source = null;
  stop(state.mainVocal.source); state.mainVocal.source = null;
  try { disconnectChain(state.mainVocal.chain); } catch (_) {}
  state.mainVocal.chain = null;
  state.harmonyTracks.forEach(ht => {
    stop(ht.source); ht.source = null;
    try { disconnectChain(ht.chain); } catch (_) {}
    ht.chain = null;
  });
}

function disconnectChain(c) {
  if (!c) return;
  Object.values(c).forEach(n => { try { n && n.disconnect && n.disconnect(); } catch (_) {} });
}

// ─── Animation ───────────────────────────────────────────────
function startAnim() {
  cancelAnimationFrame(state.animId);
  const loop = () => {
    if (!state.isPlaying) return;
    const elapsed = state.ctx.currentTime - state.startTime;
    const total   = totalDur();
    const pct     = total > 0 ? Math.min(elapsed / total, 1) : 0;
    document.getElementById('pb-fill').style.width = (pct * 100).toFixed(2) + '%';
    document.getElementById('tc').textContent      = fmtT(elapsed);
    document.getElementById('tt').textContent      = fmtT(total);
    const w = document.getElementById('tl-wrap').clientWidth;
    document.getElementById('playhead').style.left = (pct * w).toFixed(1) + 'px';
    updateMeters();
    drawEQCurves();
    if (elapsed >= total) { stopPlayback(); return; }
    state.animId = requestAnimationFrame(loop);
  };
  state.animId = requestAnimationFrame(loop);
}

// ─── Meters ──────────────────────────────────────────────────
function updateMeters() {
  [['L', state.analyserL], ['R', state.analyserR]].forEach(([ch, an]) => {
    if (!an) return;
    const d = new Uint8Array(an.frequencyBinCount);
    an.getByteTimeDomainData(d);
    let peak = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i] / 128 - 1); if (v > peak) peak = v; }
    document.getElementById('m' + ch).style.width = (peak * 100).toFixed(1) + '%';
  });
}

// ─── Timeline ────────────────────────────────────────────────
function setupTimeline() {
  document.getElementById('tl-wrap').addEventListener('click', onTimelineClick);
  window.addEventListener('resize', drawTimeline);
  drawTimeline();
}

function drawTimeline() {
  const canvas = document.getElementById('tl-canvas');
  const wrap   = document.getElementById('tl-wrap');
  const W = wrap.clientWidth || 800;
  const allTracks = [
    { buf: state.orchestra.buffer,  offset: 0,                        color: '#1d4ed8' },
    { buf: state.mainVocal.buffer,  offset: state.mainVocal.offset/1000, color: '#7c3aed' },
    ...state.harmonyTracks.map(h => ({ buf: h.buffer, offset: h.offset/1000, color: '#db2777' })),
  ];
  const nRows = allTracks.length;
  const H = Math.max(80, nRows * 36);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const total = totalDur() || 60;
  const rowH  = H / nRows;

  allTracks.forEach(({ buf, offset, color }, row) => {
    if (!buf) return;
    const x0   = (Math.max(0, offset) / total) * W;
    const xEnd = x0 + (buf.duration / total) * W;
    const cy   = row * rowH + rowH / 2;
    const amp  = rowH / 2 - 3;
    const data = buf.getChannelData(0);
    const spx  = Math.max(1, Math.floor(xEnd - x0));
    const spp  = Math.max(1, Math.floor(data.length / spx));

    ctx.fillStyle = color + '20';
    ctx.fillRect(x0, row * rowH + 1, xEnd - x0, rowH - 2);

    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.moveTo(x0, cy);
    for (let px = 0; px < spx; px++) {
      let max = 0;
      for (let i = px * spp; i < Math.min((px + 1) * spp, data.length); i++) {
        const v = Math.abs(data[i]); if (v > max) max = v;
      }
      ctx.lineTo(x0 + px, cy - max * amp);
    }
    for (let px = spx - 1; px >= 0; px--) {
      let max = 0;
      for (let i = px * spp; i < Math.min((px + 1) * spp, data.length); i++) {
        const v = Math.abs(data[i]); if (v > max) max = v;
      }
      ctx.lineTo(x0 + px, cy + max * amp);
    }
    ctx.closePath();
    ctx.fillStyle = color + '50'; ctx.fill(); ctx.stroke();
  });

  // Grid
  ctx.strokeStyle = '#ffffff10'; ctx.lineWidth = 1;
  for (let i = 1; i < nRows; i++) {
    ctx.beginPath(); ctx.moveTo(0, i * rowH); ctx.lineTo(W, i * rowH); ctx.stroke();
  }
  const tick = total > 120 ? 30 : total > 60 ? 15 : 5;
  for (let t = 0; t <= total; t += tick) {
    const x = (t / total) * W;
    ctx.fillStyle = '#ffffff20'; ctx.fillRect(x, 0, 1, H);
    ctx.fillStyle = '#ffffff50'; ctx.font = '9px monospace';
    ctx.fillText(fmtT(t), x + 2, 10);
  }
  document.getElementById('tt').textContent = fmtT(total);

  // Sync label container height with canvas
  document.getElementById('tl-wrap').style.height   = H + 'px';
  document.getElementById('tl-labels').style.height = H + 'px';
}

function onTimelineClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  const total = totalDur();
  if (!total) return;
  state.pauseOffset = pct * total;
  if (state.isPlaying) { stopSources(); state.isPlaying = false; startPlayback(); }
  else {
    document.getElementById('pb-fill').style.width = (pct * 100).toFixed(2) + '%';
    document.getElementById('tc').textContent = fmtT(pct * total);
    document.getElementById('playhead').style.left = (pct * e.currentTarget.clientWidth).toFixed(1) + 'px';
  }
}

// ─── EQ Curves ───────────────────────────────────────────────
function drawEQCurves() {
  drawEQCurve('main-eq-curve', P.main.eq);
  drawEQCurve('harm-eq-curve', P.harm.eq);
}

function drawEQCurve(canvasId, eq) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const W = canvas.offsetWidth || 200, H = canvas.offsetHeight || 55;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#ffffff18'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  ctx.beginPath(); ctx.strokeStyle = '#a855f7'; ctx.lineWidth = 2;
  for (let i = 0; i <= 200; i++) {
    const f  = Math.pow(10, Math.log10(20) + (i / 200) * (Math.log10(20000) - Math.log10(20)));
    let db = 0;
    if (f < eq.hpf) db -= 12 * (1 - f / eq.hpf);
    db += eq.low     * Math.exp(-Math.pow(Math.log10(f / 200),  2) * 3);
    db += eq.lowMid  * Math.exp(-Math.pow(Math.log10(f / 500),  2) * 4);
    db += eq.mid     * Math.exp(-Math.pow(Math.log10(f / 2000), 2) * 4);
    db += eq.highMid * Math.exp(-Math.pow(Math.log10(f / 4000), 2) * 4);
    db += eq.high    * Math.exp(-Math.pow(Math.log10(f / 8000), 2) * 3);
    const x = (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * W;
    const y = H / 2 - (db / 12) * (H / 2 - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ─── Global Drag & Drop ──────────────────────────────────────
function setupGlobalDrop() {
  let counter = 0;

  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    counter++;
    document.getElementById('gdo').style.display = 'flex';
  });
  document.addEventListener('dragleave', () => {
    counter--;
    if (counter <= 0) { counter = 0; hideGDO(); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    counter = 0;
    hideGDO();
  });

  // GDO zones
  ['gdo-orchestra', 'gdo-mainvocal', 'gdo-harmony'].forEach(zoneId => {
    const zone = document.getElementById(zoneId);
    zone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      counter = 0;
      zone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) {
        const target = zone.dataset.target; // 'orchestra', 'mainVocal', 'harmony'
        loadFile(target, file);
      }
      hideGDO();
    });
  });

  document.getElementById('gdo-cancel').addEventListener('click', () => { counter = 0; hideGDO(); });
}

function hideGDO() {
  document.getElementById('gdo').style.display = 'none';
  document.querySelectorAll('.gdo-zone').forEach(z => z.classList.remove('dragover'));
}

// ─── Static Drop Zones ───────────────────────────────────────
function setupStaticDropZones() {
  [
    ['drop-orchestra',  'file-orchestra',  'orchestra'],
    ['drop-mainvocal',  'file-mainvocal',  'mainVocal'],
  ].forEach(([dropId, fileId, target]) => {
    const drop  = document.getElementById(dropId);
    const input = document.getElementById(fileId);
    drop.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files[0]) loadFile(target, e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => { if (input.files[0]) loadFile(target, input.files[0]); });
  });
}

// ─── Buttons ─────────────────────────────────────────────────
function updateButtons() {
  const hasAny   = state.orchestra.buffer || state.mainVocal.buffer || state.harmonyTracks.some(h => h.buffer);
  const hasVocal = state.mainVocal.buffer;
  document.getElementById('btn-play').disabled    = !hasAny;
  document.getElementById('btn-stop').disabled    = !hasAny;
  document.getElementById('btn-analyze').disabled = !hasVocal;
  document.getElementById('btn-export').disabled  = !hasAny;
}

function setupButtons() {
  document.getElementById('btn-add-harmony').addEventListener('click', addHarmonyTrack);
  document.getElementById('btn-play').addEventListener('click', () => {
    state.isPlaying ? pausePlayback() : startPlayback();
  });
  document.getElementById('btn-stop').addEventListener('click', stopPlayback);
  document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('modal-bg').style.display = 'flex';
  });
  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-bg').style.display = 'none';
  });
  document.getElementById('modal-start').addEventListener('click', startExport);
  document.getElementById('btn-apply-analysis').addEventListener('click', applyAnalysis);
  document.getElementById('btn-auto-spread').addEventListener('click', autoSpread);

  document.getElementById('pb-wrap').addEventListener('click', e => {
    const rect = e.currentTarget.querySelector('.pb-bg').getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const total = totalDur();
    if (!total) return;
    state.pauseOffset = pct * total;
    if (state.isPlaying) { stopSources(); state.isPlaying = false; startPlayback(); }
    else {
      document.getElementById('pb-fill').style.width = (pct * 100).toFixed(2) + '%';
      document.getElementById('tc').textContent = fmtT(pct * total);
    }
  });
}

function setPlayBtn(playing) {
  document.getElementById('btn-play').textContent = playing ? '⏸ 一時停止' : '▶ 再生';
}

// ─── Mix Tabs ────────────────────────────────────────────────
function switchTab(which) {
  document.getElementById('mix-main').style.display  = which === 'main'  ? '' : 'none';
  document.getElementById('mix-harm').style.display  = which === 'harm'  ? '' : 'none';
  document.getElementById('tab-main').classList.toggle('active', which === 'main');
  document.getElementById('tab-harm').classList.toggle('active', which === 'harm');
}

// ─── Auto Spread ─────────────────────────────────────────────
function autoSpread() {
  const ht   = state.harmonyTracks;
  const n    = ht.length;
  if (!n) return;
  const maxPan  = P.spread.width / 100;    // e.g. 0.4
  const baseHaas = P.spread.haas;          // e.g. 10ms

  ht.forEach((h, i) => {
    // Spread pans evenly: -maxPan … +maxPan
    const pan  = n === 1 ? 0 : -maxPan + (i / (n - 1)) * 2 * maxPan;
    // Alternate Haas delay
    const haas = i % 2 === 1 ? baseHaas : 0;

    h.pan      = pan;
    h.haasDelay = haas;

    // Update sliders
    setSlider(`hpan-${h.id}`,  Math.round(pan * 100));
    setSlider(`hhaas-${h.id}`, haas);

    // Update live nodes
    if (h.chain) {
      if (h.chain._panner) h.chain._panner.pan.value = pan;
      if (h.chain._haas)   h.chain._haas.delayTime.value = haas / 1000;
    }
  });
}

// ─── Sliders (Main + Harmony shared) ─────────────────────────
function setupSliders() {

  // Volume / offset (orchestra, mainvocal)
  bind('vol-orchestra', v => {
    state.orchestra.volume = v / 100;
    if (state.orchestra.gainNode) state.orchestra.gainNode.gain.value = v / 100;
  }, v => v + '%');

  bind('vol-mainvocal', v => {
    state.mainVocal.volume = v / 100;
    if (state.mainVocal.chain && state.mainVocal.chain._outGain)
      state.mainVocal.chain._outGain.gain.value = v / 100;
  }, v => v + '%');

  bind('offset-mainvocal', v => {
    state.mainVocal.offset = v;
    drawTimeline();
    if (state.isPlaying) restartPlayback();
  }, v => v + ' ms');

  // ── Main EQ ──
  bindEQ('main', P.main.eq, () => updateAllMainChains());

  // ── Main Comp ──
  bind('main-comp-thr',    v => { P.main.comp.threshold = v; updateMainChains('comp', 'threshold', v); },        v => v + ' dB');
  bind('main-comp-knee',   v => { P.main.comp.knee = v;      updateMainChains('comp', 'knee', v); },             v => v + ' dB');
  bind('main-comp-ratio',  v => { P.main.comp.ratio = v;     updateMainChains('comp', 'ratio', v); },            v => v + ' : 1');
  bind('main-comp-attack', v => { P.main.comp.attack = v;    updateMainChains('comp', 'attack', v / 1000); },    v => v + ' ms');
  bind('main-comp-release',v => { P.main.comp.release = v;   updateMainChains('comp', 'release', v / 1000); },  v => v + ' ms');
  bind('main-comp-makeup', v => { P.main.comp.makeup = v;    updateMainChainsMakeup(v, false); },                v => v + ' dB');

  // ── Main Rev ──
  bind('main-rev-size',  v => { P.main.rev.size = v;                   rebuildReverb(false); }, v => parseFloat(v).toFixed(1) + ' s');
  bind('main-rev-decay', v => { P.main.rev.decay = v;                  rebuildReverb(false); }, v => parseFloat(v).toFixed(2));
  bind('main-rev-pre',   v => { P.main.rev.predelay = v;               updateMainChains('preDly', 'delayTime', v/1000); }, v => v + ' ms');
  bind('main-rev-mix',   v => { P.main.rev.mix = v/100;               updateMainDryWet(v/100, false); }, v => v + ' %');

  // ── Main DeEss / Sat / Out ──
  bind('main-de-freq', v => { P.main.de.freq = v;    updateMainChains('deEsser', 'frequency', v); }, v => (v/1000).toFixed(1) + ' kHz');
  bind('main-de-amt',  v => { P.main.de.amount = v;  updateMainChains('deEsser', 'gain', -v); },     v => v + ' dB');
  bind('main-sat',     v => { P.main.sat.amount = v; if (state.mainVocal.chain) state.mainVocal.chain.sat.curve = satCurve(v); }, v => v);
  bind('main-out-gain',v => { P.main.out.gain = v;   if (state.mainVocal.chain && state.mainVocal.chain._outGain) state.mainVocal.chain._outGain.gain.value = dB(v); }, v => v + ' dB');

  bind('limiter-thr', v => { P.limiter.threshold = v; if (state.masterLimiter) state.masterLimiter.threshold.value = v; }, v => parseFloat(v).toFixed(1) + ' dB');

  // ── Harmony EQ ──
  bindEQ('harm', P.harm.eq, () => updateAllHarmChains());

  // ── Harmony Comp ──
  bind('harm-comp-thr',    v => { P.harm.comp.threshold = v; updateHarmChains('comp', 'threshold', v); },        v => v + ' dB');
  bind('harm-comp-knee',   v => { P.harm.comp.knee = v;      updateHarmChains('comp', 'knee', v); },             v => v + ' dB');
  bind('harm-comp-ratio',  v => { P.harm.comp.ratio = v;     updateHarmChains('comp', 'ratio', v); },            v => v + ' : 1');
  bind('harm-comp-attack', v => { P.harm.comp.attack = v;    updateHarmChains('comp', 'attack', v / 1000); },    v => v + ' ms');
  bind('harm-comp-release',v => { P.harm.comp.release = v;   updateHarmChains('comp', 'release', v / 1000); },  v => v + ' ms');
  bind('harm-comp-makeup', v => { P.harm.comp.makeup = v;    updateMainChainsMakeup(v, true); },                 v => v + ' dB');

  // ── Harmony Rev / DE / Sat ──
  bind('harm-rev-size',  v => { P.harm.rev.size = v;    rebuildReverb(true); },                              v => parseFloat(v).toFixed(1) + ' s');
  bind('harm-rev-decay', v => { P.harm.rev.decay = v;   rebuildReverb(true); },                              v => parseFloat(v).toFixed(2));
  bind('harm-rev-pre',   v => { P.harm.rev.predelay = v; updateHarmChains('preDly', 'delayTime', v/1000); }, v => v + ' ms');
  bind('harm-rev-mix',   v => { P.harm.rev.mix = v/100; updateMainDryWet(v/100, true); },                   v => v + ' %');
  bind('harm-de-amt',    v => { P.harm.de.amount = v;   updateHarmChains('deEsser', 'gain', -v); },          v => v + ' dB');
  bind('harm-sat',       v => { P.harm.sat.amount = v;  state.harmonyTracks.forEach(h => { if (h.chain) h.chain.sat.curve = satCurve(v); }); }, v => v);

  // ── Harmony master vol ──
  bind('harm-master-vol', v => {
    P.harm.masterVol = v / 100;
    state.harmonyTracks.forEach(h => {
      h.volume = v / 100;
      if (h.chain && h.chain._outGain) h.chain._outGain.gain.value = h.volume;
      setSlider(`hvol-${h.id}`, v);
    });
  }, v => v + ' %');

  // ── Spread params ──
  bind('spread-width', v => { P.spread.width = v; }, v => v + ' %');
  bind('haas-base',    v => { P.spread.haas  = v; }, v => v + ' ms');
}

function bind(id, onChange, fmt) {
  const el  = document.getElementById(id);
  const val = document.getElementById(id + '-v');
  if (!el) return;
  const update = () => { const v = parseFloat(el.value); if (val) val.textContent = fmt(v); onChange(v); };
  el.addEventListener('input', update);
  update();
}

function bindEQ(prefix, eq, onAny) {
  const pfx = prefix + '-eq-';
  const bands = [
    ['hpf',    v => { eq.hpf = v; },     v => v + ' Hz'],
    ['low',    v => { eq.low = v; },     v => v + ' dB'],
    ['lowmid', v => { eq.lowMid = v; },  v => v + ' dB'],
    ['mid',    v => { eq.mid = v; },     v => v + ' dB'],
    ['highmid',v => { eq.highMid = v; }, v => v + ' dB'],
    ['high',   v => { eq.high = v; },    v => v + ' dB'],
  ];
  bands.forEach(([suf, set, fmt]) => {
    bind(pfx + suf, v => { set(v); onAny(); drawEQCurves(); }, fmt);
  });
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

// Chain update helpers
function updateMainChains(nodeKey, paramKey, value) {
  const c = state.mainVocal.chain;
  if (c && c[nodeKey] && c[nodeKey][paramKey] !== undefined) c[nodeKey][paramKey].value = value;
}
function updateHarmChains(nodeKey, paramKey, value) {
  state.harmonyTracks.forEach(h => {
    if (h.chain && h.chain[nodeKey]) h.chain[nodeKey][paramKey].value = value;
  });
}
function updateAllMainChains() {
  const c = state.mainVocal.chain;
  if (!c) return;
  const eq = P.main.eq;
  c.hpf.frequency.value     = eq.hpf;
  c.eqLow.gain.value        = eq.low;
  c.eqLowMid.gain.value     = eq.lowMid;
  c.eqMid.gain.value        = eq.mid;
  c.eqHighMid.gain.value    = eq.highMid;
  c.eqHigh.gain.value       = eq.high;
}
function updateAllHarmChains() {
  state.harmonyTracks.forEach(h => {
    const c = h.chain;
    if (!c) return;
    const eq = P.harm.eq;
    c.hpf.frequency.value  = eq.hpf;
    c.eqLow.gain.value     = eq.low;
    c.eqLowMid.gain.value  = eq.lowMid;
    c.eqMid.gain.value     = eq.mid;
    c.eqHighMid.gain.value = eq.highMid;
    c.eqHigh.gain.value    = eq.high;
  });
}
function updateMainChainsMakeup(v, isHarm) {
  const g = dB(v);
  if (!isHarm && state.mainVocal.chain) state.mainVocal.chain.makeup.gain.value = g;
  if (isHarm) state.harmonyTracks.forEach(h => { if (h.chain) h.chain.makeup.gain.value = g; });
}
function updateMainDryWet(mix, isHarm) {
  const update = c => { if (!c) return; c.dry.gain.value = 1 - mix; c.wet.gain.value = mix; };
  if (!isHarm) update(state.mainVocal.chain);
  if (isHarm)  state.harmonyTracks.forEach(h => update(h.chain));
}
function rebuildReverb(isHarm) {
  if (!state.ctx) return;
  const p = isHarm ? P.harm : P.main;
  const imp = impulse(state.ctx, p.rev.size, p.rev.decay);
  if (!isHarm && state.mainVocal.chain) state.mainVocal.chain.reverb.buffer = imp;
  if (isHarm) state.harmonyTracks.forEach(h => { if (h.chain) h.chain.reverb.buffer = imp; });
}

// ─── Voice Analysis ──────────────────────────────────────────
async function runAnalysis() {
  if (!state.mainVocal.buffer) return;
  setStatus('音声を分析中...', 'busy');
  await new Promise(r => setTimeout(r, 50));
  state.analysis = analyzeBuffer(state.mainVocal.buffer);
  showAnalysis(state.analysis);
  buildRecs(state.analysis);
  document.getElementById('analysis-section').style.display = '';
  setStatus('分析完了', 'active');
}

function analyzeBuffer(buffer) {
  const sr   = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const len  = data.length;
  let ss = 0, pk = 0;
  for (let i = 0; i < len; i++) { ss += data[i]*data[i]; const v = Math.abs(data[i]); if (v > pk) pk = v; }
  const rms = Math.sqrt(ss / len);
  const crestDB = 20 * Math.log10(Math.max(pk / Math.max(rms, 1e-9), 1));

  // Pitch from 5 segments
  const segLen = Math.min(sr * 2, Math.floor(len / 4));
  const pitches = [];
  for (let i = 0; i < 5; i++) {
    const s = data.slice(Math.floor((0.1 + i * 0.15) * len), Math.floor((0.1 + i * 0.15) * len) + segLen);
    if (rmsOf(s) > 0.02) { const p = pitch(s, sr); if (p) pitches.push(p); }
  }
  const medPitch = pitches.length ? median(pitches) : null;

  // Spectral via HPF energy
  const seg  = data.slice(Math.floor(len * 0.3), Math.floor(len * 0.5));
  const tot  = rmsOf(seg);
  const hi   = rmsOf(hpf(seg, sr, 4000));
  const sib  = rmsOf(hpf(seg, sr, 6000));
  return { pitch: medPitch, crestDB, brightR: tot > 0 ? hi / tot : 0, sibR: tot > 0 ? sib / tot : 0 };
}

function pitch(data, sr) {
  const wl = Math.min(2048, data.length);
  let ac0 = 0; for (let i = 0; i < wl; i++) ac0 += data[i]*data[i];
  if (ac0 < 1e-6) return null;
  const mn = Math.floor(sr / 1000), mx = Math.floor(sr / 60);
  let best = -1, bestLag = -1;
  for (let lag = mn; lag <= mx; lag++) {
    let c = 0; for (let i = 0; i < wl - lag; i++) c += data[i] * data[i + lag];
    c /= ac0;
    if (c > best) { best = c; bestLag = lag; }
  }
  return best > 0.3 ? sr / bestLag : null;
}

function hpf(data, sr, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / sr, a = rc / (rc + dt);
  const out = new Float32Array(data.length); out[0] = data[0];
  for (let i = 1; i < data.length; i++) out[i] = a * (out[i-1] + data[i] - data[i-1]);
  return out;
}
function rmsOf(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]*a[i]; return Math.sqrt(s/Math.max(a.length,1)); }
function median(a) { const s = [...a].sort((x,y)=>x-y); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }

function showAnalysis(an) {
  const pLabel = !an.pitch ? '不明' : an.pitch < 150 ? 'バス/バリトン' : an.pitch < 220 ? 'テナー/アルト' : an.pitch < 350 ? 'メゾソプラノ' : 'ソプラノ';
  document.getElementById('an-main-pitch').textContent  = pLabel;
  document.getElementById('an-main-bright').textContent = an.brightR > 0.20 ? '明るい' : an.brightR > 0.10 ? '普通' : '暗め';
  document.getElementById('an-main-dyn').textContent    = an.crestDB > 20 ? '高い' : an.crestDB > 13 ? '普通' : '低い';
  document.getElementById('an-main-sib').textContent    = an.sibR > 0.15 ? '高い' : an.sibR > 0.08 ? '普通' : '低い';
  document.getElementById('an-main-hz').textContent     = an.pitch ? an.pitch.toFixed(0) + ' Hz' : '-';
}

function buildRecs(an) {
  const p = an.pitch || 220;
  let eq = p < 150 ? 'ウォームブースト' : p < 250 ? '標準' : '高域ブースト';
  if (an.brightR > 0.18) eq += ' +高域カット'; else if (an.brightR < 0.08) eq += ' +エア';
  const comp = an.crestDB > 20 ? '強め (-28dB/5:1)' : an.crestDB < 13 ? '軽め (-20dB/3:1)' : '標準 (-24dB/4:1)';
  const de   = an.sibR > 0.15 ? '強め (-8dB)' : an.sibR > 0.08 ? '標準 (-4dB)' : '不要';
  document.getElementById('an-rec-eq').textContent   = eq;
  document.getElementById('an-rec-comp').textContent = comp;
  document.getElementById('an-rec-de').textContent   = de;
  document.getElementById('an-rec-rev').textContent  = '標準 (2s / 25%)';
}

function applyAnalysis() {
  const an = state.analysis;
  if (!an) return;
  const p = an.pitch || 220;
  let hpf = 80, low = 0, lowMid = 0, mid = 0, highMid = 0, high = 0, thr = -24, ratio = 4, deAmt = 0;
  if (p < 150) { hpf = 60; low = 2; highMid = 2; }
  else if (p < 250) { hpf = 80; mid = 1; highMid = 1; }
  else { hpf = 100; low = -2; mid = 1; highMid = 2; }
  if (an.brightR > 0.18) high -= 2; else if (an.brightR < 0.08) high += 3;
  if (an.crestDB > 20)   { thr = -28; ratio = 5; } else if (an.crestDB < 13) { thr = -20; ratio = 3; }
  if (an.sibR > 0.15) deAmt = 8; else if (an.sibR > 0.08) deAmt = 4;

  ['main-eq-hpf', 'main-eq-low', 'main-eq-lowmid', 'main-eq-mid', 'main-eq-highmid', 'main-eq-high',
   'main-comp-thr', 'main-comp-ratio', 'main-de-amt'].forEach((id, i) => {
    setSlider(id, [hpf, low, lowMid, mid, highMid, high, thr, ratio, deAmt][i]);
  });
  setStatus('分析結果を適用しました', 'active');
}

// ─── Status ──────────────────────────────────────────────────
function setStatus(text, cls) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = 'status-dot' + (cls ? ' ' + cls : '');
}

// ─── Export ──────────────────────────────────────────────────
async function startExport() {
  const sr  = parseInt(document.getElementById('exp-sr').value);
  const dur = totalDur();
  if (!dur) return;
  document.getElementById('exp-prog').style.display   = '';
  document.getElementById('modal-start').disabled     = true;
  document.getElementById('exp-status').textContent   = 'オフラインレンダリング中...';

  try {
    const offCtx   = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    const masterG  = offCtx.createGain();
    const masterL  = offCtx.createDynamicsCompressor();
    masterL.threshold.value = P.limiter.threshold; masterL.knee.value = 0;
    masterL.ratio.value = 20; masterL.attack.value = 0.001; masterL.release.value = 0.05;
    masterG.connect(masterL); masterL.connect(offCtx.destination);

    const mkOffChain = (p) => {
      const f = (type, freq, Q, gain) => {
        const n = offCtx.createBiquadFilter();
        n.type = type; n.frequency.value = freq;
        if (Q !== 0) n.Q.value = Q;
        if (['lowshelf','highshelf','peaking'].includes(type)) n.gain.value = gain;
        return n;
      };
      const c = {
        hpf:      f('highpass', p.eq.hpf, 0.707, 0),
        eqLow:    f('lowshelf',  200, 0,   p.eq.low),
        eqLowMid: f('peaking',   500, 1.0, p.eq.lowMid),
        eqMid:    f('peaking',  2000, 1.0, p.eq.mid),
        eqHighMid:f('peaking',  4000, 1.0, p.eq.highMid),
        eqHigh:   f('highshelf',8000, 0,   p.eq.high),
        sat: (() => { const n = offCtx.createWaveShaper(); n.curve = satCurve(p.sat.amount); n.oversample = '4x'; return n; })(),
        comp: (() => { const n = offCtx.createDynamicsCompressor();
          n.threshold.value = p.comp.threshold; n.knee.value = p.comp.knee; n.ratio.value = p.comp.ratio;
          n.attack.value = p.comp.attack/1000; n.release.value = p.comp.release/1000; return n; })(),
        makeup: (() => { const n = offCtx.createGain(); n.gain.value = dB(p.comp.makeup); return n; })(),
        deEsser: f('peaking', p.de.freq, 5, -p.de.amount),
        preDly: (() => { const n = offCtx.createDelay(0.5); n.delayTime.value = p.rev.predelay/1000; return n; })(),
        reverb: (() => { const n = offCtx.createConvolver(); n.buffer = impulse(offCtx, p.rev.size, p.rev.decay); return n; })(),
        dry: (() => { const n = offCtx.createGain(); n.gain.value = 1 - p.rev.mix; return n; })(),
        wet: (() => { const n = offCtx.createGain(); n.gain.value = p.rev.mix; return n; })(),
        mix: offCtx.createGain(),
      };
      c.hpf.connect(c.eqLow); c.eqLow.connect(c.eqLowMid); c.eqLowMid.connect(c.eqMid);
      c.eqMid.connect(c.eqHighMid); c.eqHighMid.connect(c.eqHigh); c.eqHigh.connect(c.sat);
      c.sat.connect(c.comp); c.comp.connect(c.makeup); c.makeup.connect(c.deEsser);
      c.deEsser.connect(c.dry); c.deEsser.connect(c.preDly);
      c.preDly.connect(c.reverb); c.reverb.connect(c.wet);
      c.dry.connect(c.mix); c.wet.connect(c.mix);
      c.input = c.hpf; c.output = c.mix;
      return c;
    };

    const sched = (buf, offSec, dst) => {
      if (!buf) return;
      const src = offCtx.createBufferSource(); src.buffer = buf;
      src.connect(dst); src.start(Math.max(0, offSec));
    };

    if (state.orchestra.buffer) {
      const g = offCtx.createGain(); g.gain.value = state.orchestra.volume;
      g.connect(masterG); sched(state.orchestra.buffer, 0, g);
    }
    if (state.mainVocal.buffer) {
      const ch = mkOffChain(P.main);
      const g  = offCtx.createGain(); g.gain.value = state.mainVocal.volume;
      ch.output.connect(g); g.connect(masterG);
      sched(state.mainVocal.buffer, state.mainVocal.offset / 1000, ch.input);
    }
    state.harmonyTracks.forEach(ht => {
      if (!ht.buffer) return;
      const ch    = mkOffChain(P.harm);
      const haas  = offCtx.createDelay(0.1); haas.delayTime.value = ht.haasDelay / 1000;
      const pan   = offCtx.createStereoPanner(); pan.pan.value = ht.pan;
      const g     = offCtx.createGain(); g.gain.value = ht.volume;
      ch.output.connect(haas); haas.connect(pan); pan.connect(g); g.connect(masterG);
      sched(ht.buffer, ht.offset / 1000, ch.input);
    });

    const rendered = await offCtx.startRendering();
    document.getElementById('exp-status').textContent = 'WAVエンコード中...';
    const blob = encodeWAV(rendered);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = 'vocalmix_output.wav'; a.click();
    URL.revokeObjectURL(url);
    document.getElementById('exp-status').textContent = 'エクスポート完了！';
    setStatus('エクスポート完了', 'active');
    setTimeout(() => {
      document.getElementById('modal-bg').style.display = 'none';
      document.getElementById('exp-prog').style.display = 'none';
      document.getElementById('modal-start').disabled   = false;
    }, 2000);
  } catch (e) {
    console.error(e);
    document.getElementById('exp-status').textContent = 'エラー: ' + e.message;
    document.getElementById('modal-start').disabled = false;
  }
}

function encodeWAV(buffer) {
  const nc = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const ab  = new ArrayBuffer(44 + len * nc * 2);
  const v   = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len * nc * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nc * 2, true);
  const chs = [];
  for (let c = 0; c < nc; c++) chs.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
