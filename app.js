// ============================================================
// VocalMix Studio – app.js
// ============================================================

'use strict';

// ─── State ──────────────────────────────────────────────────
const state = {
  ctx: null,
  buffers:   { orchestra: null, mainVocal: null, harmony: null },
  offsets:   { mainVocal: 0, harmony: 0 },        // ms
  volumes:   { orchestra: 1.0, mainVocal: 1.0, harmony: 0.8 },
  analysis:  { mainVocal: null, harmony: null },
  isPlaying: false,
  startTime: 0,
  pauseOffset: 0,
  sources:   {},
  gainNodes: {},   // live gain references for real-time volume control
  chains:    { mainVocal: null, harmony: null },
  masterGain: null,
  masterLimiter: null,
  analyserL: null,
  analyserR: null,
  animId: null,
};

const params = {
  eq:   { hpf: 80, low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
  comp: { threshold: -24, knee: 6, ratio: 4, attack: 3, release: 150, makeup: 0 },
  rev:  { size: 2.0, decay: 0.5, predelay: 20, mix: 0.25 },
  de:   { freq: 7000, amount: 0 },
  sat:  { amount: 10 },
  harmLevel: 0.8,
  outGain: 0,
  limiter: { threshold: -1 },
};

// ─── Init ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupDropZones();
  setupSliders();
  setupButtons();
  setupTimeline();
  setStatus('ファイルをロードしてください', false);
});

// ─── Drop Zones ──────────────────────────────────────────────
function setupDropZones() {
  const zones = [
    { id: 'orchestra', dropId: 'drop-orchestra', fileId: 'file-orchestra' },
    { id: 'mainVocal', dropId: 'drop-mainvocal', fileId: 'file-mainvocal' },
    { id: 'harmony',   dropId: 'drop-harmony',   fileId: 'file-harmony'   },
  ];

  zones.forEach(({ id, dropId, fileId }) => {
    const drop = document.getElementById(dropId);
    const input = document.getElementById(fileId);

    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) loadAudioFile(id, file);
    });

    input.addEventListener('change', () => {
      if (input.files[0]) loadAudioFile(id, input.files[0]);
    });
  });
}

// ─── Load Audio File ─────────────────────────────────────────
async function loadAudioFile(trackId, file) {
  setStatus('読み込み中...', true);
  try {
    await ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await state.ctx.decodeAudioData(arrayBuffer);
    state.buffers[trackId] = audioBuffer;

    // Update UI
    const shortName = file.name.length > 24 ? file.name.slice(0, 22) + '…' : file.name;
    const durEl = document.getElementById('dur-' + trackId.toLowerCase().replace('vocal', 'vocal'));
    const nameEl = document.getElementById('name-' + trackId.toLowerCase().replace('vocal', 'vocal'));
    const loadedEl = document.getElementById('loaded-' + trackId.toLowerCase().replace('vocal', 'vocal'));
    const dropEl = document.getElementById('drop-' + trackId.toLowerCase().replace('vocal', 'vocal'));

    const idMap = {
      orchestra: ['dur-orchestra', 'name-orchestra', 'loaded-orchestra', 'drop-orchestra'],
      mainVocal: ['dur-mainvocal', 'name-mainvocal', 'loaded-mainvocal', 'drop-mainvocal'],
      harmony:   ['dur-harmony',   'name-harmony',   'loaded-harmony',   'drop-harmony'],
    };
    const [durId, nameId, loadId, dropId] = idMap[trackId];

    document.getElementById(durId).textContent = formatTime(audioBuffer.duration);
    document.getElementById(nameId).textContent = shortName;
    document.getElementById(loadId).style.display = 'flex';
    document.getElementById(dropId).querySelector('.drop-content').style.display = 'none';
    document.getElementById(dropId).classList.add('loaded');

    updateButtons();
    drawTimeline();
    setStatus('ロード完了', false);
  } catch (err) {
    console.error(err);
    setStatus('エラー: ' + err.message, false);
  }
}

// ─── Audio Context ────────────────────────────────────────────
async function ensureContext() {
  if (state.ctx) {
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    return;
  }
  state.ctx = new (window.AudioContext || window.webkitAudioContext)();

  // Master chain
  state.masterGain    = state.ctx.createGain();
  state.masterLimiter = state.ctx.createDynamicsCompressor();
  state.masterLimiter.threshold.value = params.limiter.threshold;
  state.masterLimiter.knee.value      = 0;
  state.masterLimiter.ratio.value     = 20;
  state.masterLimiter.attack.value    = 0.001;
  state.masterLimiter.release.value   = 0.05;

  // Stereo splitter for level meters
  const splitter = state.ctx.createChannelSplitter(2);
  state.analyserL = state.ctx.createAnalyser(); state.analyserL.fftSize = 256;
  state.analyserR = state.ctx.createAnalyser(); state.analyserR.fftSize = 256;

  state.masterGain.connect(state.masterLimiter);
  state.masterLimiter.connect(splitter);
  splitter.connect(state.analyserL, 0);
  splitter.connect(state.analyserR, 1);
  state.masterLimiter.connect(state.ctx.destination);
}

// ─── Vocal Processing Chain ──────────────────────────────────
function buildChain(isHarmony) {
  const ctx = state.ctx;
  const c = {};

  // High-Pass Filter
  c.hpf = ctx.createBiquadFilter();
  c.hpf.type = 'highpass';
  c.hpf.frequency.value = params.eq.hpf;
  c.hpf.Q.value = 0.707;

  // EQ – Low shelf
  c.eqLow = ctx.createBiquadFilter();
  c.eqLow.type = 'lowshelf';
  c.eqLow.frequency.value = 200;
  c.eqLow.gain.value = params.eq.low;

  // EQ – Low-mid peak
  c.eqLowMid = ctx.createBiquadFilter();
  c.eqLowMid.type = 'peaking';
  c.eqLowMid.frequency.value = 500;
  c.eqLowMid.Q.value = 1.0;
  c.eqLowMid.gain.value = params.eq.lowMid;

  // EQ – Mid peak
  c.eqMid = ctx.createBiquadFilter();
  c.eqMid.type = 'peaking';
  c.eqMid.frequency.value = 2000;
  c.eqMid.Q.value = 1.0;
  c.eqMid.gain.value = params.eq.mid;

  // EQ – High-mid peak
  c.eqHighMid = ctx.createBiquadFilter();
  c.eqHighMid.type = 'peaking';
  c.eqHighMid.frequency.value = 4000;
  c.eqHighMid.Q.value = 1.0;
  c.eqHighMid.gain.value = params.eq.highMid;

  // EQ – High shelf
  c.eqHigh = ctx.createBiquadFilter();
  c.eqHigh.type = 'highshelf';
  c.eqHigh.frequency.value = 8000;
  c.eqHigh.gain.value = params.eq.high;

  // Saturation (WaveShaper – soft clip)
  c.sat = ctx.createWaveShaper();
  c.sat.curve = makeSatCurve(params.sat.amount);
  c.sat.oversample = '4x';

  // Compressor
  c.comp = ctx.createDynamicsCompressor();
  c.comp.threshold.value = params.comp.threshold;
  c.comp.knee.value      = params.comp.knee;
  c.comp.ratio.value     = params.comp.ratio;
  c.comp.attack.value    = params.comp.attack / 1000;
  c.comp.release.value   = params.comp.release / 1000;

  // Makeup Gain
  c.makeupGain = ctx.createGain();
  c.makeupGain.gain.value = dBToGain(params.comp.makeup);

  // De-esser (narrow cut)
  c.deEsser = ctx.createBiquadFilter();
  c.deEsser.type = 'peaking';
  c.deEsser.frequency.value = params.de.freq;
  c.deEsser.Q.value = 5;
  c.deEsser.gain.value = -params.de.amount;

  // Pre-delay for reverb
  c.preDelay = ctx.createDelay(0.5);
  c.preDelay.delayTime.value = params.rev.predelay / 1000;

  // Reverb (convolver)
  c.reverb = ctx.createConvolver();
  c.reverb.buffer = getOrBuildReverb(params.rev.size, params.rev.decay);

  c.dryGain = ctx.createGain();
  c.dryGain.gain.value = 1 - params.rev.mix;

  c.wetGain = ctx.createGain();
  c.wetGain.gain.value = params.rev.mix;

  c.mixOut = ctx.createGain();

  // Output gain (volume / harmony level)
  c.outGain = ctx.createGain();
  c.outGain.gain.value = isHarmony ? params.harmLevel : dBToGain(params.outGain);

  // Connect chain: hpf → eq chain → sat → comp → makeup → deesser → dry+wet → out → master
  c.hpf.connect(c.eqLow);
  c.eqLow.connect(c.eqLowMid);
  c.eqLowMid.connect(c.eqMid);
  c.eqMid.connect(c.eqHighMid);
  c.eqHighMid.connect(c.eqHigh);
  c.eqHigh.connect(c.sat);
  c.sat.connect(c.comp);
  c.comp.connect(c.makeupGain);
  c.makeupGain.connect(c.deEsser);
  c.deEsser.connect(c.dryGain);
  c.deEsser.connect(c.preDelay);
  c.preDelay.connect(c.reverb);
  c.reverb.connect(c.wetGain);
  c.dryGain.connect(c.mixOut);
  c.wetGain.connect(c.mixOut);
  c.mixOut.connect(c.outGain);
  c.outGain.connect(state.masterGain);

  c.input = c.hpf;
  return c;
}

// ─── Reverb Impulse ──────────────────────────────────────────
function getOrBuildReverb(duration, decay) {
  return buildImpulse(state.ctx, duration, decay);
}

function buildImpulse(ctx, duration, decay) {
  const sr  = ctx.sampleRate;
  const len = Math.floor(sr * duration);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Exponential decay + random noise (Schroeder-like)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay * 8);
    }
  }
  return buf;
}

// ─── Saturation Curve ────────────────────────────────────────
function makeSatCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    if (amount === 0) { curve[i] = x; continue; }
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

// ─── Helpers ─────────────────────────────────────────────────
function dBToGain(db)   { return Math.pow(10, db / 20); }
function gainToDB(gain) { return 20 * Math.log10(Math.max(gain, 1e-6)); }

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function getTotalDuration() {
  const { orchestra, mainVocal, harmony } = state.buffers;
  const { mainVocal: mvOff, harmony: hmOff } = state.offsets;
  let dur = 0;
  if (orchestra) dur = Math.max(dur, orchestra.duration);
  if (mainVocal) dur = Math.max(dur, mainVocal.duration + Math.max(0, mvOff / 1000));
  if (harmony)   dur = Math.max(dur, harmony.duration   + Math.max(0, hmOff / 1000));
  return dur || 0;
}

// ─── Buttons ─────────────────────────────────────────────────
function updateButtons() {
  const hasAny = Object.values(state.buffers).some(Boolean);
  const hasVocal = state.buffers.mainVocal || state.buffers.harmony;
  document.getElementById('btn-play').disabled   = !hasAny;
  document.getElementById('btn-stop').disabled   = !hasAny;
  document.getElementById('btn-analyze').disabled = !hasVocal;
  document.getElementById('btn-export').disabled  = !hasAny;
}

function setupButtons() {
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-stop').addEventListener('click', stopPlayback);
  document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('modal-overlay').style.display = 'flex';
  });
  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-overlay').style.display = 'none';
  });
  document.getElementById('modal-export-start').addEventListener('click', startExport);
  document.getElementById('btn-apply-analysis').addEventListener('click', applyAnalysis);
}

// ─── Playback ────────────────────────────────────────────────
async function togglePlay() {
  if (state.isPlaying) {
    pausePlayback();
  } else {
    await startPlayback();
  }
}

async function startPlayback() {
  await ensureContext();
  if (state.ctx.state === 'suspended') await state.ctx.resume();

  // Build chains fresh each time
  state.chains.mainVocal = null;
  state.chains.harmony   = null;

  const now = state.ctx.currentTime;
  const pause = state.pauseOffset;
  state.startTime = now - pause;
  state.gainNodes = {};

  // Orchestra (no processing)
  if (state.buffers.orchestra) {
    const src  = state.ctx.createBufferSource();
    src.buffer = state.buffers.orchestra;
    const gain = state.ctx.createGain();
    gain.gain.value = state.volumes.orchestra;
    src.connect(gain);
    gain.connect(state.masterGain);
    src.start(now, pause);
    state.sources.orchestra   = src;
    state.gainNodes.orchestra = gain;
  }

  // Main Vocal (with processing chain)
  if (state.buffers.mainVocal) {
    const chain = buildChain(false);
    state.chains.mainVocal = chain;
    const src = state.ctx.createBufferSource();
    src.buffer = state.buffers.mainVocal;
    src.connect(chain.input);
    const offSec = state.offsets.mainVocal / 1000;
    const startWhen = now + Math.max(0, offSec - pause);
    const bufOff    = Math.max(0, pause - offSec);
    if (bufOff < state.buffers.mainVocal.duration) {
      src.start(startWhen, bufOff);
    }
    state.sources.mainVocal = src;
  }

  // Harmony (with processing chain, shared eq/comp settings)
  if (state.buffers.harmony) {
    const chain = buildChain(true);
    state.chains.harmony = chain;
    const src = state.ctx.createBufferSource();
    src.buffer = state.buffers.harmony;
    src.connect(chain.input);
    const offSec = state.offsets.harmony / 1000;
    const startWhen = now + Math.max(0, offSec - pause);
    const bufOff    = Math.max(0, pause - offSec);
    if (bufOff < state.buffers.harmony.duration) {
      src.start(startWhen, bufOff);
    }
    state.sources.harmony = src;
  }

  state.isPlaying = true;
  document.getElementById('btn-play').innerHTML =
    '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></svg> 一時停止';

  startAnimation();
}

function pausePlayback() {
  state.pauseOffset = state.ctx.currentTime - state.startTime;
  stopSources();
  state.isPlaying = false;
  document.getElementById('btn-play').innerHTML =
    '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4l12 6-12 6V4z"/></svg> 再生';
}

function stopPlayback() {
  state.pauseOffset = 0;
  stopSources();
  state.isPlaying = false;
  document.getElementById('btn-play').innerHTML =
    '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6 4l12 6-12 6V4z"/></svg> 再生';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('time-current').textContent = '0:00';
  document.getElementById('playhead').style.left = '0px';
  cancelAnimationFrame(state.animId);
}

function stopSources() {
  Object.values(state.sources).forEach(src => {
    try { src.stop(); src.disconnect(); } catch(_) {}
  });
  state.sources = {};
  if (state.chains.mainVocal) disconnectChain(state.chains.mainVocal);
  if (state.chains.harmony)   disconnectChain(state.chains.harmony);
  state.chains.mainVocal = null;
  state.chains.harmony   = null;
}

function disconnectChain(c) {
  try {
    Object.values(c).forEach(n => { if (n && n.disconnect) n.disconnect(); });
  } catch(_) {}
}

// ─── Animation Loop ───────────────────────────────────────────
function startAnimation() {
  cancelAnimationFrame(state.animId);

  const loop = () => {
    if (!state.isPlaying) return;
    const elapsed = state.ctx.currentTime - state.startTime;
    const total   = getTotalDuration();
    const pct     = total > 0 ? Math.min(elapsed / total, 1) : 0;

    document.getElementById('progress-fill').style.width = (pct * 100).toFixed(2) + '%';
    document.getElementById('time-current').textContent  = formatTime(elapsed);
    document.getElementById('time-total').textContent    = formatTime(total);

    // Playhead
    const container = document.getElementById('timeline-container');
    const phW = container.clientWidth;
    document.getElementById('playhead').style.left = (pct * phW).toFixed(1) + 'px';

    // Level meters
    updateLevelMeters();

    // EQ curve
    drawEQCurve();

    if (elapsed >= total) { stopPlayback(); return; }
    state.animId = requestAnimationFrame(loop);
  };

  state.animId = requestAnimationFrame(loop);
}

// ─── Level Meters ────────────────────────────────────────────
function updateLevelMeters() {
  ['L', 'R'].forEach((ch, i) => {
    const analyser = i === 0 ? state.analyserL : state.analyserR;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let j = 0; j < data.length; j++) {
      const v = Math.abs(data[j] / 128 - 1);
      if (v > peak) peak = v;
    }
    document.getElementById('meter-fill-' + ch).style.width = (peak * 100).toFixed(1) + '%';
  });
}

// ─── Timeline Drawing ─────────────────────────────────────────
function setupTimeline() {
  const container = document.getElementById('timeline-container');
  const canvas    = document.getElementById('timeline-canvas');
  container.addEventListener('click', onTimelineClick);
  window.addEventListener('resize', drawTimeline);
  drawTimeline();
}

function drawTimeline() {
  const canvas    = document.getElementById('timeline-canvas');
  const container = document.getElementById('timeline-container');
  const W = container.clientWidth || 800;
  const H = 120;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const rowH = H / 3;
  const total = getTotalDuration() || 60;

  const tracks = [
    { key: 'orchestra', offset: 0, color: '#1d4ed8' },
    { key: 'mainVocal', offset: state.offsets.mainVocal / 1000, color: '#7c3aed' },
    { key: 'harmony',   offset: state.offsets.harmony   / 1000, color: '#db2777' },
  ];

  tracks.forEach(({ key, offset, color }, row) => {
    const buf = state.buffers[key];
    if (!buf) return;

    const x0 = (Math.max(0, offset) / total) * W;
    const xEnd = x0 + (buf.duration / total) * W;

    ctx.fillStyle = color + '22';
    ctx.fillRect(x0, row * rowH + 2, xEnd - x0, rowH - 4);

    // Draw waveform
    const data = buf.getChannelData(0);
    const numSamples = data.length;
    const pixelsInTrack = Math.max(1, Math.floor(xEnd - x0));
    const samplesPerPixel = Math.floor(numSamples / pixelsInTrack);
    const cy = row * rowH + rowH / 2;
    const amp = (rowH / 2 - 4);

    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    for (let px = 0; px < pixelsInTrack; px++) {
      const start = px * samplesPerPixel;
      const end   = Math.min(start + samplesPerPixel, numSamples);
      let max = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      ctx.lineTo(x0 + px, cy - max * amp);
    }
    for (let px = pixelsInTrack - 1; px >= 0; px--) {
      const start = px * samplesPerPixel;
      const end   = Math.min(start + samplesPerPixel, numSamples);
      let max = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      ctx.lineTo(x0 + px, cy + max * amp);
    }
    ctx.closePath();
    ctx.fillStyle = color + '55';
    ctx.fill();
    ctx.stroke();
  });

  // Grid lines
  ctx.strokeStyle = '#ffffff11';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = i * rowH;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Time ticks
  const tickInterval = total > 120 ? 30 : total > 60 ? 15 : total > 30 ? 10 : 5;
  ctx.fillStyle = '#ffffff33';
  ctx.font = '9px monospace';
  for (let t = 0; t <= total; t += tickInterval) {
    const x = (t / total) * W;
    ctx.fillRect(x, 0, 1, H);
    ctx.fillStyle = '#ffffff66';
    ctx.fillText(formatTime(t), x + 2, 10);
    ctx.fillStyle = '#ffffff33';
  }

  document.getElementById('time-total').textContent = formatTime(total);
}

function onTimelineClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  const total = getTotalDuration();
  if (total <= 0) return;
  state.pauseOffset = pct * total;
  if (state.isPlaying) {
    stopSources();
    state.isPlaying = false;
    startPlayback();
  } else {
    document.getElementById('progress-fill').style.width  = (pct * 100).toFixed(2) + '%';
    document.getElementById('time-current').textContent   = formatTime(pct * total);
    document.getElementById('playhead').style.left        = (pct * e.currentTarget.clientWidth).toFixed(1) + 'px';
  }
}

// ─── EQ Curve Canvas ─────────────────────────────────────────
function drawEQCurve() {
  const canvas = document.getElementById('eq-curve');
  const W = canvas.offsetWidth || 200;
  const H = canvas.offsetHeight || 60;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const freqs   = [20, 50, 100, 200, 500, 1000, 2000, 4000, 8000, 16000, 20000];
  const xScale  = (f) => (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * W;
  const yScale  = (db) => H / 2 - (db / 12) * (H / 2 - 4);

  // Zero line
  ctx.strokeStyle = '#ffffff22';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  // Approximate EQ curve (visual only)
  ctx.beginPath();
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2;

  const sampleFreqs = [];
  for (let i = 0; i <= 200; i++) {
    sampleFreqs.push(Math.pow(10, Math.log10(20) + (i / 200) * (Math.log10(20000) - Math.log10(20))));
  }

  sampleFreqs.forEach((f, i) => {
    let db = 0;
    // HPF (first-order approx)
    if (f < params.eq.hpf) db -= 12 * (1 - f / params.eq.hpf);
    // Low shelf (200Hz)
    db += params.eq.low  * Math.exp(-Math.pow(Math.log10(f / 200), 2) * 3);
    // Low-mid peak (500Hz)
    db += params.eq.lowMid * Math.exp(-Math.pow(Math.log10(f / 500), 2) * 4);
    // Mid peak (2kHz)
    db += params.eq.mid  * Math.exp(-Math.pow(Math.log10(f / 2000), 2) * 4);
    // High-mid peak (4kHz)
    db += params.eq.highMid * Math.exp(-Math.pow(Math.log10(f / 4000), 2) * 4);
    // High shelf (8kHz)
    db += params.eq.high * Math.exp(-Math.pow(Math.log10(f / 8000), 2) * 3);

    const x = xScale(f);
    const y = yScale(db);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ─── Sliders ─────────────────────────────────────────────────
function setupSliders() {
  // Volumes (take effect on next play / update live gain if playing)
  bindSlider('vol-orchestra', v => {
    state.volumes.orchestra = v / 100;
    if (state.gainNodes && state.gainNodes.orchestra) {
      state.gainNodes.orchestra.gain.value = v / 100;
    }
  }, v => v + '%');

  bindSlider('vol-mainvocal', v => {
    state.volumes.mainVocal = v / 100;
    if (state.gainNodes && state.gainNodes.mainVocal) {
      state.gainNodes.mainVocal.gain.value = v / 100;
    }
  }, v => v + '%');

  bindSlider('vol-harmony', v => {
    state.volumes.harmony = v / 100;
    if (state.gainNodes && state.gainNodes.harmony) {
      state.gainNodes.harmony.gain.value = v / 100;
    }
  }, v => v + '%');

  // Timing
  bindSlider('offset-mainvocal', v => {
    state.offsets.mainVocal = v;
    drawTimeline();
    if (state.isPlaying) { stopSources(); state.isPlaying = false; startPlayback(); }
  }, v => v + ' ms');

  bindSlider('offset-harmony', v => {
    state.offsets.harmony = v;
    drawTimeline();
    if (state.isPlaying) { stopSources(); state.isPlaying = false; startPlayback(); }
  }, v => v + ' ms');

  // EQ
  bindSlider('eq-hpf', v => {
    params.eq.hpf = v;
    updateNode('hpf', 'frequency', v);
    drawEQCurve();
  }, v => v + ' Hz');

  bindSlider('eq-low', v => {
    params.eq.low = v;
    updateNode('eqLow', 'gain', v);
    drawEQCurve();
  }, v => v + ' dB');

  bindSlider('eq-lowmid', v => {
    params.eq.lowMid = v;
    updateNode('eqLowMid', 'gain', v);
    drawEQCurve();
  }, v => v + ' dB');

  bindSlider('eq-mid', v => {
    params.eq.mid = v;
    updateNode('eqMid', 'gain', v);
    drawEQCurve();
  }, v => v + ' dB');

  bindSlider('eq-highmid', v => {
    params.eq.highMid = v;
    updateNode('eqHighMid', 'gain', v);
    drawEQCurve();
  }, v => v + ' dB');

  bindSlider('eq-high', v => {
    params.eq.high = v;
    updateNode('eqHigh', 'gain', v);
    drawEQCurve();
  }, v => v + ' dB');

  // Compressor
  bindSlider('comp-threshold', v => {
    params.comp.threshold = v;
    updateCompNode('threshold', v);
  }, v => v + ' dB');

  bindSlider('comp-knee', v => {
    params.comp.knee = v;
    updateCompNode('knee', v);
  }, v => v + ' dB');

  bindSlider('comp-ratio', v => {
    params.comp.ratio = v;
    updateCompNode('ratio', v);
  }, v => v + ' : 1');

  bindSlider('comp-attack', v => {
    params.comp.attack = v;
    updateCompNode('attack', v / 1000);
  }, v => v + ' ms');

  bindSlider('comp-release', v => {
    params.comp.release = v;
    updateCompNode('release', v / 1000);
  }, v => v + ' ms');

  bindSlider('comp-makeup', v => {
    params.comp.makeup = v;
    ['mainVocal', 'harmony'].forEach(k => {
      if (state.chains[k]) state.chains[k].makeupGain.gain.value = dBToGain(v);
    });
  }, v => v + ' dB');

  // Reverb
  bindSlider('rev-size', v => {
    params.rev.size = v;
    rebuildReverb();
  }, v => parseFloat(v).toFixed(1) + ' s');

  bindSlider('rev-decay', v => {
    params.rev.decay = v;
    rebuildReverb();
  }, v => parseFloat(v).toFixed(2));

  bindSlider('rev-predelay', v => {
    params.rev.predelay = v;
    ['mainVocal', 'harmony'].forEach(k => {
      if (state.chains[k]) state.chains[k].preDelay.delayTime.value = v / 1000;
    });
  }, v => v + ' ms');

  bindSlider('rev-mix', v => {
    params.rev.mix = v / 100;
    ['mainVocal', 'harmony'].forEach(k => {
      if (state.chains[k]) {
        state.chains[k].dryGain.gain.value = 1 - v / 100;
        state.chains[k].wetGain.gain.value = v / 100;
      }
    });
  }, v => v + ' %');

  // De-esser
  bindSlider('de-freq', v => {
    params.de.freq = v;
    updateNode('deEsser', 'frequency', v);
  }, v => (v / 1000).toFixed(1) + ' kHz');

  bindSlider('de-amount', v => {
    params.de.amount = v;
    updateNode('deEsser', 'gain', -v);
  }, v => v + ' dB');

  // Saturation
  bindSlider('sat-amount', v => {
    params.sat.amount = v;
    ['mainVocal', 'harmony'].forEach(k => {
      if (state.chains[k]) state.chains[k].sat.curve = makeSatCurve(v);
    });
  }, v => v);

  // Harmony level
  bindSlider('harm-level', v => {
    params.harmLevel = v / 100;
    if (state.chains.harmony) state.chains.harmony.outGain.gain.value = v / 100;
  }, v => v + ' %');

  // Output gain
  bindSlider('out-gain', v => {
    params.outGain = v;
    if (state.chains.mainVocal) state.chains.mainVocal.outGain.gain.value = dBToGain(v);
    if (state.masterGain) state.masterGain.gain.value = dBToGain(v);
  }, v => v + ' dB');

  // Limiter
  bindSlider('limiter-thr', v => {
    params.limiter.threshold = v;
    if (state.masterLimiter) state.masterLimiter.threshold.value = v;
  }, v => parseFloat(v).toFixed(1) + ' dB');
}

function bindSlider(id, onChange, formatFn) {
  const slider = document.getElementById(id);
  const valEl  = document.getElementById(id + '-val');
  if (!slider) return;

  const update = () => {
    const v = parseFloat(slider.value);
    if (valEl) valEl.textContent = formatFn(v);
    onChange(v);
  };

  slider.addEventListener('input', update);
  update(); // init
}

function updateNode(nodeKey, paramKey, value) {
  ['mainVocal', 'harmony'].forEach(k => {
    if (state.chains[k] && state.chains[k][nodeKey]) {
      state.chains[k][nodeKey][paramKey].value = value;
    }
  });
}

function updateCompNode(paramKey, value) {
  ['mainVocal', 'harmony'].forEach(k => {
    if (state.chains[k] && state.chains[k].comp) {
      state.chains[k].comp[paramKey].value = value;
    }
  });
}

function rebuildReverb() {
  ['mainVocal', 'harmony'].forEach(k => {
    if (state.chains[k]) {
      state.chains[k].reverb.buffer = buildImpulse(state.ctx, params.rev.size, params.rev.decay);
    }
  });
}

// ─── Voice Analysis ──────────────────────────────────────────
async function runAnalysis() {
  if (!state.buffers.mainVocal && !state.buffers.harmony) return;
  setStatus('音声を分析中...', true);

  await new Promise(r => setTimeout(r, 50)); // allow UI update

  if (state.buffers.mainVocal) {
    state.analysis.mainVocal = analyzeBuffer(state.buffers.mainVocal);
    displayAnalysis('main', state.analysis.mainVocal);
  }

  if (state.buffers.harmony) {
    state.analysis.harmony = analyzeBuffer(state.buffers.harmony);
    displayAnalysis('harm', state.analysis.harmony);
    document.getElementById('an-harmony-card').style.display = 'block';
  }

  buildRecommendations();

  document.getElementById('analysis-section').style.display = 'block';
  setStatus('分析完了', false);
}

function analyzeBuffer(buffer) {
  const sr   = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const len  = data.length;

  // Sample from multiple positions (avoid silence at start/end)
  const segLen  = Math.min(sr * 2, Math.floor(len / 4)); // 2s segments
  const numSegs = 5;
  const segments = [];
  for (let i = 0; i < numSegs; i++) {
    const start = Math.floor((0.1 + (i / numSegs) * 0.7) * len);
    segments.push(data.slice(start, start + segLen));
  }

  // --- RMS / Peak / Crest factor ---
  let totalSumSq = 0, totalPeak = 0;
  for (let i = 0; i < len; i++) {
    const v = Math.abs(data[i]);
    totalSumSq += data[i] * data[i];
    if (v > totalPeak) totalPeak = v;
  }
  const rms = Math.sqrt(totalSumSq / len);
  const crestDB = 20 * Math.log10(Math.max(totalPeak / Math.max(rms, 1e-9), 1));

  // --- Pitch detection (autocorrelation on active segments) ---
  const pitches = [];
  segments.forEach(seg => {
    const segRMS = Math.sqrt(seg.reduce((a, x) => a + x * x, 0) / seg.length);
    if (segRMS < 0.02) return;
    const p = detectPitch(seg, sr);
    if (p && p > 60 && p < 1200) pitches.push(p);
  });
  const medianPitch = pitches.length > 0 ? median(pitches) : null;

  // --- Spectral brightness via simple IIR ---
  // We compare energy above 4kHz vs total energy on a short segment
  const analysisSeg = segments[Math.floor(numSegs / 2)];
  const totalEnergy = rmsOfArray(analysisSeg);
  const highEnergy  = rmsOfArray(applyHPF(analysisSeg, sr, 4000));
  const sibEnergy   = rmsOfArray(applyHPF(analysisSeg, sr, 6000));
  const brightnessRatio = totalEnergy > 0 ? highEnergy / totalEnergy : 0;
  const sibilanceRatio  = totalEnergy > 0 ? sibEnergy  / totalEnergy : 0;

  return {
    pitch: medianPitch,
    crestDB,
    rms,
    brightnessRatio,
    sibilanceRatio,
  };
}

function detectPitch(data, sr) {
  const windowSize = Math.min(2048, data.length);
  // Compute normalized autocorrelation
  let ac0 = 0;
  for (let i = 0; i < windowSize; i++) ac0 += data[i] * data[i];
  if (ac0 < 1e-6) return null;

  const minLag = Math.floor(sr / 1000); // ~1000Hz max
  const maxLag = Math.floor(sr / 60);   // ~60Hz min

  let bestCorr = -1, bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < windowSize - lag; i++) corr += data[i] * data[i + lag];
    corr /= ac0;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  // Only trust if correlation is strong enough
  return bestCorr > 0.3 ? sr / bestLag : null;
}

function applyHPF(data, sr, cutoff) {
  const rc = 1.0 / (2.0 * Math.PI * cutoff);
  const dt = 1.0 / sr;
  const alpha = rc / (rc + dt);
  const out = new Float32Array(data.length);
  out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = alpha * (out[i - 1] + data[i] - data[i - 1]);
  }
  return out;
}

function rmsOfArray(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(a.length, 1));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pitchLabel(hz) {
  if (!hz) return '不明';
  if (hz < 150) return 'バス / バリトン';
  if (hz < 220) return 'テナー / アルト';
  if (hz < 350) return 'メゾソプラノ';
  return 'ソプラノ / ハイテナー';
}

function brightnessLabel(r) {
  if (r > 0.20) return '明るい';
  if (r > 0.10) return '普通';
  return '暗め';
}

function dynamicsLabel(db) {
  if (db > 20) return '高い (要コンプ)';
  if (db > 13) return '普通';
  return '低い (既にコンプ済み)';
}

function sibilanceLabel(r) {
  if (r > 0.15) return '高い (要ディエッサー)';
  if (r > 0.08) return '普通';
  return '低い';
}

function displayAnalysis(prefix, an) {
  document.getElementById('an-' + prefix + '-pitch').textContent  = pitchLabel(an.pitch);
  document.getElementById('an-' + prefix + '-bright').textContent = brightnessLabel(an.brightnessRatio);
  document.getElementById('an-' + prefix + '-dyn').textContent    = dynamicsLabel(an.crestDB);
  document.getElementById('an-' + prefix + '-sib').textContent    = sibilanceLabel(an.sibilanceRatio);
  document.getElementById('an-' + prefix + '-hz').textContent     = an.pitch ? an.pitch.toFixed(0) + ' Hz' : '不明';
}

function buildRecommendations() {
  const an = state.analysis.mainVocal;
  if (!an) return;

  let eqLabel = '', compLabel = '', deLabel = '', revLabel = '';

  // EQ recommendation
  const p = an.pitch || 220;
  if (p < 150) eqLabel = 'ウォームブースト (低域+2)';
  else if (p < 250) eqLabel = 'フラット / プレゼンス (4kHz+1)';
  else eqLabel = 'エア (+高域) / 低域カット';

  if (an.brightnessRatio > 0.18) eqLabel += ' + 高域カット';
  else if (an.brightnessRatio < 0.08) eqLabel += ' + 高域ブースト';

  // Compressor
  if (an.crestDB > 20) compLabel = '強め (-28dB, 5:1)';
  else if (an.crestDB > 14) compLabel = '標準 (-24dB, 4:1)';
  else compLabel = '軽め (-20dB, 3:1)';

  // De-esser
  if (an.sibilanceRatio > 0.15) deLabel = '強め (7kHz, -8dB)';
  else if (an.sibilanceRatio > 0.08) deLabel = '標準 (7kHz, -4dB)';
  else deLabel = '不要 / 最小限';

  revLabel = '標準 (2s, 25%ウェット)';

  document.getElementById('an-rec-eq').textContent   = eqLabel;
  document.getElementById('an-rec-comp').textContent = compLabel;
  document.getElementById('an-rec-de').textContent   = deLabel;
  document.getElementById('an-rec-rev').textContent  = revLabel;
}

function applyAnalysis() {
  const an = state.analysis.mainVocal;
  if (!an) return;

  // EQ
  const p = an.pitch || 220;
  let low = 0, lowMid = 0, mid = 0, highMid = 0, high = 0, hpf = 80;

  if (p < 150) {
    hpf = 60; low = 2; highMid = 2;
  } else if (p < 250) {
    hpf = 80; lowMid = -1; mid = 1; highMid = 1;
  } else {
    hpf = 100; low = -2; lowMid = -1; mid = 1; highMid = 2;
  }

  if (an.brightnessRatio > 0.18) high -= 2;
  else if (an.brightnessRatio < 0.08) high += 3;

  setSlider('eq-hpf',    hpf);
  setSlider('eq-low',    low);
  setSlider('eq-lowmid', lowMid);
  setSlider('eq-mid',    mid);
  setSlider('eq-highmid',highMid);
  setSlider('eq-high',   high);

  // Compressor
  let threshold = -24, ratio = 4;
  if (an.crestDB > 20)      { threshold = -28; ratio = 5; }
  else if (an.crestDB < 13) { threshold = -20; ratio = 3; }
  setSlider('comp-threshold', threshold);
  setSlider('comp-ratio', ratio);

  // De-esser
  let deAmt = 0;
  if (an.sibilanceRatio > 0.15) deAmt = 8;
  else if (an.sibilanceRatio > 0.08) deAmt = 4;
  setSlider('de-amount', deAmt);

  setStatus('分析結果を適用しました', false);
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

// ─── Status ───────────────────────────────────────────────────
function setStatus(text, loading) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot' + (loading ? ' loading' : (text.includes('完了') ? ' active' : ''));
}

// ─── Export ──────────────────────────────────────────────────
async function startExport() {
  const sr = parseInt(document.getElementById('export-samplerate').value);
  const duration = getTotalDuration();
  if (duration <= 0) return;

  document.getElementById('export-progress-section').style.display = 'block';
  document.getElementById('modal-export-start').disabled = true;
  document.getElementById('export-status').textContent = 'オフラインレンダリング中...';

  try {
    const offCtx = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);

    // Master gain + limiter
    const masterGain = offCtx.createGain();
    masterGain.gain.value = dBToGain(params.outGain);
    const masterLimiter = offCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = params.limiter.threshold;
    masterLimiter.knee.value      = 0;
    masterLimiter.ratio.value     = 20;
    masterLimiter.attack.value    = 0.001;
    masterLimiter.release.value   = 0.05;
    masterGain.connect(masterLimiter);
    masterLimiter.connect(offCtx.destination);

    // Helper: create offline vocal chain
    const makeOfflineChain = (isHarmony) => {
      const c = {};
      c.hpf = offCtx.createBiquadFilter();
      c.hpf.type = 'highpass'; c.hpf.frequency.value = params.eq.hpf; c.hpf.Q.value = 0.707;
      c.eqLow = offCtx.createBiquadFilter();
      c.eqLow.type = 'lowshelf'; c.eqLow.frequency.value = 200; c.eqLow.gain.value = params.eq.low;
      c.eqLowMid = offCtx.createBiquadFilter();
      c.eqLowMid.type = 'peaking'; c.eqLowMid.frequency.value = 500; c.eqLowMid.Q.value = 1; c.eqLowMid.gain.value = params.eq.lowMid;
      c.eqMid = offCtx.createBiquadFilter();
      c.eqMid.type = 'peaking'; c.eqMid.frequency.value = 2000; c.eqMid.Q.value = 1; c.eqMid.gain.value = params.eq.mid;
      c.eqHighMid = offCtx.createBiquadFilter();
      c.eqHighMid.type = 'peaking'; c.eqHighMid.frequency.value = 4000; c.eqHighMid.Q.value = 1; c.eqHighMid.gain.value = params.eq.highMid;
      c.eqHigh = offCtx.createBiquadFilter();
      c.eqHigh.type = 'highshelf'; c.eqHigh.frequency.value = 8000; c.eqHigh.gain.value = params.eq.high;
      c.sat = offCtx.createWaveShaper();
      c.sat.curve = makeSatCurve(params.sat.amount); c.sat.oversample = '4x';
      c.comp = offCtx.createDynamicsCompressor();
      c.comp.threshold.value = params.comp.threshold; c.comp.knee.value = params.comp.knee;
      c.comp.ratio.value = params.comp.ratio; c.comp.attack.value = params.comp.attack / 1000;
      c.comp.release.value = params.comp.release / 1000;
      c.makeupGain = offCtx.createGain(); c.makeupGain.gain.value = dBToGain(params.comp.makeup);
      c.deEsser = offCtx.createBiquadFilter();
      c.deEsser.type = 'peaking'; c.deEsser.frequency.value = params.de.freq;
      c.deEsser.Q.value = 5; c.deEsser.gain.value = -params.de.amount;
      c.preDelay = offCtx.createDelay(0.5); c.preDelay.delayTime.value = params.rev.predelay / 1000;
      c.reverb = offCtx.createConvolver(); c.reverb.buffer = buildImpulse(offCtx, params.rev.size, params.rev.decay);
      c.dryGain = offCtx.createGain(); c.dryGain.gain.value = 1 - params.rev.mix;
      c.wetGain = offCtx.createGain(); c.wetGain.gain.value = params.rev.mix;
      c.mixOut  = offCtx.createGain();
      c.outGain = offCtx.createGain();
      c.outGain.gain.value = isHarmony ? params.harmLevel : 1.0;

      c.hpf.connect(c.eqLow); c.eqLow.connect(c.eqLowMid); c.eqLowMid.connect(c.eqMid);
      c.eqMid.connect(c.eqHighMid); c.eqHighMid.connect(c.eqHigh); c.eqHigh.connect(c.sat);
      c.sat.connect(c.comp); c.comp.connect(c.makeupGain); c.makeupGain.connect(c.deEsser);
      c.deEsser.connect(c.dryGain); c.deEsser.connect(c.preDelay);
      c.preDelay.connect(c.reverb); c.reverb.connect(c.wetGain);
      c.dryGain.connect(c.mixOut); c.wetGain.connect(c.mixOut);
      c.mixOut.connect(c.outGain); c.outGain.connect(masterGain);
      c.input = c.hpf;
      return c;
    };

    // Schedule sources
    if (state.buffers.orchestra) {
      const src = offCtx.createBufferSource();
      src.buffer = state.buffers.orchestra;
      const g = offCtx.createGain(); g.gain.value = state.volumes.orchestra;
      src.connect(g); g.connect(masterGain);
      src.start(0);
    }

    if (state.buffers.mainVocal) {
      const chain = makeOfflineChain(false);
      const src = offCtx.createBufferSource();
      src.buffer = state.buffers.mainVocal;
      src.connect(chain.input);
      src.start(Math.max(0, state.offsets.mainVocal / 1000));
    }

    if (state.buffers.harmony) {
      const chain = makeOfflineChain(true);
      const src = offCtx.createBufferSource();
      src.buffer = state.buffers.harmony;
      src.connect(chain.input);
      src.start(Math.max(0, state.offsets.harmony / 1000));
    }

    // Render
    document.getElementById('export-status').textContent = 'レンダリング中 (しばらくお待ちください)...';
    const rendered = await offCtx.startRendering();

    document.getElementById('export-status').textContent = 'WAVエンコード中...';
    const blob = encodeWAV(rendered);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'vocalmix_output.wav';
    a.click();
    URL.revokeObjectURL(url);

    document.getElementById('export-status').textContent = 'エクスポート完了！';
    setStatus('エクスポート完了', false);
    setTimeout(() => {
      document.getElementById('modal-overlay').style.display = 'none';
      document.getElementById('export-progress-section').style.display = 'none';
      document.getElementById('modal-export-start').disabled = false;
    }, 2000);

  } catch (err) {
    console.error(err);
    document.getElementById('export-status').textContent = 'エラー: ' + err.message;
    document.getElementById('modal-export-start').disabled = false;
  }
}

// ─── WAV Encoder ─────────────────────────────────────────────
function encodeWAV(audioBuffer) {
  const numCh  = audioBuffer.numberOfChannels;
  const sr     = audioBuffer.sampleRate;
  const len    = audioBuffer.length;
  const bitDepth = 16;
  const byteRate = sr * numCh * bitDepth / 8;
  const blockAlign = numCh * bitDepth / 8;
  const dataBytes  = len * numCh * 2;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view   = new DataView(buffer);

  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  str(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleave channels
  let offset = 44;
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));

  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
