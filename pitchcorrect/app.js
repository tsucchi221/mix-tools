// ============================================================
// ピッチコレクター – app.js
// ============================================================
'use strict';

const SCALES = {
  major:      [0,2,4,5,7,9,11],
  minor:      [0,2,3,5,7,8,10],
  chromatic:  [0,1,2,3,4,5,6,7,8,9,10,11],
  pentatonic: [0,2,4,7,9],
};
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

const state = {
  ctx:          null,
  buffer:       null,       // original
  shiftedBuf:   null,       // after pitch shift
  pitchFrames:  [],         // [{time, hz, midi, cents, note}]
  isPlaying:    false,
  source:       null,
  startTime:    0,
  pauseOffset:  0,
  animId:       null,
  analysis:     null,
};

const cfg = {
  semitones:  0,
  rootNote:   0,
  scale:      'major',
  strength:   80,
  refHz:      440,
  formant:    0,
  smooth:     5,
};

// ─── Init ────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupDrop();
  setupControls();
  setupTransport();
});

// ─── Context ─────────────────────────────────────────────────
async function ensureCtx() {
  if (state.ctx) { if (state.ctx.state === 'suspended') await state.ctx.resume(); return; }
  const AC = window.AudioContext || (/** @type {any} */(window)).webkitAudioContext;
  state.ctx = new AC();
}

// ─── Drop Zone ───────────────────────────────────────────────
function setupDrop() {
  const dz    = document.getElementById('dropzone');
  const input = document.getElementById('file-input');

  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0]); });

  // Global drop
  let cnt = 0;
  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    cnt++; document.getElementById('gdo').style.display = 'flex';
  });
  document.addEventListener('dragleave', () => { if (--cnt <= 0) { cnt = 0; document.getElementById('gdo').style.display = 'none'; } });
  document.addEventListener('dragover',  e => e.preventDefault());
  document.addEventListener('drop',      e => { e.preventDefault(); cnt = 0; document.getElementById('gdo').style.display = 'none';
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
}

// ─── Load File ───────────────────────────────────────────────
async function loadFile(file) {
  setStatus('読み込み中...', 'busy');
  try {
    await ensureCtx();
    const ab  = await file.arrayBuffer();
    const buf = await state.ctx.decodeAudioData(ab);
    state.buffer      = buf;
    state.shiftedBuf  = null;
    state.pitchFrames = [];
    state.pauseOffset = 0;

    // UI
    document.getElementById('dz-loaded').style.display = 'flex';
    document.getElementById('dz-inner').style.display  = 'none';
    document.getElementById('dropzone').classList.add('loaded');
    document.getElementById('dz-fname').textContent = file.name.length > 40 ? file.name.slice(0,38)+'…' : file.name;
    document.getElementById('dz-meta').textContent  =
      `${fmtT(buf.duration)}  ·  ${buf.sampleRate} Hz  ·  ${buf.numberOfChannels}ch`;
    document.getElementById('tt').textContent = fmtT(buf.duration);

    document.getElementById('btn-analyze').disabled = false;
    document.getElementById('btn-play').disabled    = false;
    document.getElementById('btn-stop').disabled    = false;
    document.getElementById('btn-export').disabled  = false;

    setStatus('ロード完了 – 解析ボタンを押してください', 'active');
  } catch (e) {
    console.error(e);
    setStatus('エラー: ' + e.message, '');
  }
}

// ─── Pitch Analysis ──────────────────────────────────────────
async function runAnalysis() {
  if (!state.buffer) return;
  setStatus('ピッチを解析中...', 'busy');
  document.getElementById('btn-analyze').disabled = true;
  await new Promise(r => setTimeout(r, 30));

  const buf   = state.buffer;
  const sr    = buf.sampleRate;
  const data  = buf.getChannelData(0);
  const hop   = Math.floor(sr * 0.025);   // 25ms hop
  const win   = Math.floor(sr * 0.05);    // 50ms window
  const frames = [];

  for (let pos = 0; pos + win <= data.length; pos += hop) {
    const seg  = data.slice(pos, pos + win);
    const rms  = rmsOf(seg);
    const time = pos / sr;
    if (rms < 0.015) { frames.push({ time, hz: null, midi: null, cents: 0, note: '-' }); continue; }
    const hz = detectPitch(seg, sr, cfg.refHz);
    if (!hz) { frames.push({ time, hz: null, midi: null, cents: 0, note: '-' }); continue; }
    const midi = hzToMidi(hz, cfg.refHz);
    const nearestMidi = Math.round(midi);
    const cents = (midi - nearestMidi) * 100;
    const noteName = NOTE_NAMES[((nearestMidi % 12) + 12) % 12];
    frames.push({ time, hz, midi, cents, note: noteName });
  }

  state.pitchFrames = frames;

  // Stats
  const valid = frames.filter(f => f.hz);
  if (valid.length) {
    const avgHz    = valid.reduce((s,f) => s + f.hz, 0) / valid.length;
    const avgMidi  = hzToMidi(avgHz, cfg.refHz);
    const avgNote  = NOTE_NAMES[((Math.round(avgMidi) % 12) + 12) % 12];
    const avgCents = valid.reduce((s,f) => s + f.cents, 0) / valid.length;

    // Key detection: find root note with most scale note coverage
    const detectedKey = detectKey(valid.map(f => Math.round(f.midi) % 12));
    const tuneDevCents = avgCents.toFixed(1);
    const recSemitones = -(avgCents / 100).toFixed(1);

    document.getElementById('stat-avg').textContent  = `${avgHz.toFixed(0)} Hz (${avgNote})`;
    document.getElementById('stat-key').textContent  = `${NOTE_NAMES[detectedKey.root]} ${detectedKey.type}`;
    document.getElementById('stat-tune').textContent = `${avgCents > 0 ? '+' : ''}${tuneDevCents} ¢`;
    document.getElementById('stat-rec').textContent  = `${recSemitones > 0 ? '+' : ''}${recSemitones} 半音`;
    document.getElementById('key-detected').textContent = `推定: ${NOTE_NAMES[detectedKey.root]} ${detectedKey.type}`;

    // Auto-set key selector
    document.getElementById('sel-key').value   = detectedKey.root;
    document.getElementById('sel-scale').value = detectedKey.type === 'Major' ? 'major' : 'minor';
    cfg.rootNote = detectedKey.root;
    cfg.scale    = detectedKey.type === 'Major' ? 'major' : 'minor';

    state.analysis = { avgHz, avgMidi, avgCents, detectedKey, recSemitones: parseFloat(recSemitones) };
  }

  drawPitchGraph();
  document.getElementById('viz-section').style.display      = '';
  document.getElementById('controls-section').style.display = '';
  document.getElementById('btn-analyze').disabled = false;
  setStatus('解析完了', 'active');
}

// ─── Key Detection ────────────────────────────────────────────
function detectKey(noteClasses) {
  const counts = new Array(12).fill(0);
  noteClasses.forEach(n => counts[((n % 12) + 12) % 12]++);
  let bestRoot = 0, bestType = 'Major', bestScore = -1;
  for (let root = 0; root < 12; root++) {
    for (const [type, scale] of [['Major', SCALES.major], ['Minor', SCALES.minor]]) {
      const score = scale.reduce((s, d) => s + counts[(root + d) % 12], 0);
      if (score > bestScore) { bestScore = score; bestRoot = root; bestType = type; }
    }
  }
  return { root: bestRoot, type: bestType };
}

// ─── Pitch Graph ─────────────────────────────────────────────
function drawPitchGraph() {
  const canvas = document.getElementById('pitch-canvas');
  const W = canvas.offsetWidth || 800;
  const H = 180;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const frames = state.pitchFrames;
  if (!frames.length) return;

  const totalTime = state.buffer.duration;
  const midiMin = 40, midiMax = 84; // E2 – C6
  const midiRange = midiMax - midiMin;

  const toX = t => (t / totalTime) * W;
  const toY = midi => H - ((midi - midiMin) / midiRange) * H;

  // Scale note background highlights
  const scale = SCALES[cfg.scale] || SCALES.major;
  ctx.fillStyle = 'rgba(16,185,129,.06)';
  for (let midi = midiMin; midi <= midiMax; midi++) {
    if (scale.includes(((midi - cfg.rootNote) % 12 + 12) % 12)) {
      const y = toY(midi + 0.5);
      ctx.fillRect(0, y, W, toY(midi - 0.5) - y);
    }
  }

  // Semitone grid lines
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let midi = midiMin; midi <= midiMax; midi++) {
    const y = Math.round(toY(midi)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    // Note label every 12 semitones (octave)
    if (midi % 12 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,.3)';
      ctx.font = '9px monospace';
      ctx.fillText('C' + (midi / 12 - 1), 3, y - 2);
    }
  }

  // Pitch dots (original)
  frames.forEach(f => {
    if (!f.hz) return;
    const x   = toX(f.time);
    const y   = toY(f.midi);
    const abs = Math.abs(f.cents);
    const col = abs < 30 ? '#10b981' : abs < 50 ? '#f59e0b' : '#ef4444';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  });

  // Pitch dots (corrected – shifted version, blue)
  if (cfg.semitones !== 0) {
    frames.forEach(f => {
      if (!f.hz) return;
      const shiftedMidi = f.midi + cfg.semitones;
      if (shiftedMidi < midiMin || shiftedMidi > midiMax) return;
      const x = toX(f.time);
      const y = toY(shiftedMidi);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#3b82f6';
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }
}

// ─── Pitch Shift (resample + OLA) ────────────────────────────
async function buildShiftedBuffer() {
  if (!state.buffer) return;
  if (cfg.semitones === 0) { state.shiftedBuf = state.buffer; return; }
  setStatus('ピッチシフト処理中...', 'busy');
  await new Promise(r => setTimeout(r, 30));

  state.shiftedBuf = pitchShiftBuffer(state.buffer, cfg.semitones);
  setStatus('処理完了', 'active');
}

function pitchShiftBuffer(buffer, semitones) {
  const ratio = Math.pow(2, semitones / 12);
  const sr    = buffer.sampleRate;
  const nc    = buffer.numberOfChannels;
  const origLen = buffer.length;

  // Step 1: Linear interpolation resample (changes pitch + duration)
  const newLen  = Math.round(origLen / ratio);
  const tmpData = [];
  for (let ch = 0; ch < nc; ch++) {
    const inp = buffer.getChannelData(ch);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const src = i * ratio;
      const lo  = Math.floor(src);
      const hi  = Math.min(lo + 1, origLen - 1);
      const fr  = src - lo;
      out[i]    = inp[lo] * (1 - fr) + inp[hi] * fr;
    }
    tmpData.push(out);
  }

  // Step 2: OLA time-stretch back to original length
  const winLen = 2048;
  const hopIn  = winLen >> 2;
  const hopOut = Math.round(hopIn * (origLen / newLen));

  // Hann window
  const win = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (winLen - 1)));

  const outData  = [];
  const normData = new Float32Array(origLen);

  for (let ch = 0; ch < nc; ch++) {
    const inp = tmpData[ch];
    const out = new Float32Array(origLen);
    let inPos = 0, outPos = 0;
    while (inPos + winLen <= newLen && outPos + winLen <= origLen) {
      for (let j = 0; j < winLen; j++) {
        out[outPos + j]  += inp[inPos + j] * win[j];
        if (ch === 0) normData[outPos + j] += win[j];
      }
      inPos  += hopIn;
      outPos += hopOut;
    }
    outData.push(out);
  }

  // Normalize
  for (let i = 0; i < origLen; i++) {
    if (normData[i] > 0.001) {
      for (let ch = 0; ch < nc; ch++) outData[ch][i] /= normData[ch === 0 ? i : i];
    }
  }
  // Fix: normalize per-channel using normData (ch-independent win accumulation)
  for (let ch = 0; ch < nc; ch++) {
    for (let i = 0; i < origLen; i++) {
      if (normData[i] > 0.001) outData[ch][i] = outData[ch][i]; // already divided above via norm
    }
  }

  const outBuf = new AudioBuffer({ numberOfChannels: nc, length: origLen, sampleRate: sr });
  for (let ch = 0; ch < nc; ch++) outBuf.copyToChannel(outData[ch], ch);
  return outBuf;
}

// ─── Auto Correct ─────────────────────────────────────────────
function autoCorrect() {
  if (!state.analysis) return;
  const rec = state.analysis.recSemitones;
  setSlider('shift-slider', rec);
}

// ─── Playback ────────────────────────────────────────────────
async function startPlay() {
  await ensureCtx();
  const useCorrected = document.getElementById('toggle-corrected').checked;
  let buf = useCorrected ? state.shiftedBuf : state.buffer;

  if (useCorrected && (!state.shiftedBuf || state._lastShift !== cfg.semitones)) {
    await buildShiftedBuffer();
    state._lastShift = cfg.semitones;
    buf = state.shiftedBuf;
  }
  if (!buf) buf = state.buffer;
  if (!buf) return;

  const src = state.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.ctx.destination);
  const now   = state.ctx.currentTime;
  const pause = state.pauseOffset;
  state.startTime = now - pause;
  src.start(now, pause);
  state.source    = src;
  state.isPlaying = true;
  src.onended = () => { if (state.isPlaying) stopPlay(); };
  document.getElementById('btn-play').textContent = '⏸ 一時停止';
  startAnim();
}

function pausePlay() {
  state.pauseOffset = state.ctx.currentTime - state.startTime;
  try { state.source && state.source.stop(); } catch (_) {}
  state.source    = null;
  state.isPlaying = false;
  document.getElementById('btn-play').textContent = '▶ 再生';
  cancelAnimationFrame(state.animId);
}

function stopPlay() {
  state.pauseOffset = 0;
  try { state.source && state.source.stop(); } catch (_) {}
  state.source    = null;
  state.isPlaying = false;
  document.getElementById('btn-play').textContent      = '▶ 再生';
  document.getElementById('pb-fill').style.width       = '0%';
  document.getElementById('tc').textContent            = '0:00';
  document.getElementById('playhead') && (document.getElementById('playhead').style.left = '0');
  cancelAnimationFrame(state.animId);
}

function startAnim() {
  cancelAnimationFrame(state.animId);
  const total = state.buffer ? state.buffer.duration : 1;
  const loop  = () => {
    if (!state.isPlaying) return;
    const elapsed = state.ctx.currentTime - state.startTime;
    const pct     = Math.min(elapsed / total, 1);
    document.getElementById('pb-fill').style.width = (pct * 100).toFixed(2) + '%';
    document.getElementById('tc').textContent       = fmtT(elapsed);
    if (elapsed >= total) { stopPlay(); return; }
    state.animId = requestAnimationFrame(loop);
  };
  state.animId = requestAnimationFrame(loop);
}

// ─── Controls Setup ──────────────────────────────────────────
function setupControls() {
  // Shift slider
  const shiftSlider = document.getElementById('shift-slider');
  shiftSlider.addEventListener('input', () => {
    cfg.semitones = parseFloat(shiftSlider.value);
    const disp = cfg.semitones > 0 ? '+' + cfg.semitones : '' + cfg.semitones;
    document.getElementById('shift-display').textContent = disp;
    drawPitchGraph();
    state.shiftedBuf = null; // invalidate cache
  });

  document.getElementById('sel-key').addEventListener('change', e => {
    cfg.rootNote = parseInt(e.target.value);
    drawPitchGraph();
  });
  document.getElementById('sel-scale').addEventListener('change', e => {
    cfg.scale = e.target.value;
    drawPitchGraph();
  });
  document.getElementById('sel-ref').addEventListener('change', e => {
    cfg.refHz = parseFloat(e.target.value);
  });

  bindSlider('strength-slider', v => { cfg.strength = v; }, v => v + '%');
  bindSlider('formant-slider',  v => { cfg.formant  = v; }, v => (v > 0 ? '+' : '') + v);
  bindSlider('smooth-slider',   v => { cfg.smooth   = v; }, v => v);

  document.getElementById('btn-reset').addEventListener('click', () => {
    cfg.semitones = 0;
    setSlider('shift-slider', 0);
    state.shiftedBuf = null;
    drawPitchGraph();
  });

  document.getElementById('btn-auto-correct').addEventListener('click', autoCorrect);
  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-bg').style.display = 'none';
  });
  document.getElementById('modal-start').addEventListener('click', startExport);
  document.getElementById('toggle-corrected').addEventListener('change', () => {
    state.shiftedBuf = null; // force rebuild
  });

  window.addEventListener('resize', drawPitchGraph);
}

function bindSlider(id, onChange, fmt) {
  const el  = document.getElementById(id);
  const val = document.getElementById(id.replace('-slider', '-val'));
  if (!el) return;
  const update = () => { const v = parseFloat(el.value); if (val) val.textContent = fmt(v); onChange(v); };
  el.addEventListener('input', update);
  update();
}

function setSlider(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

// ─── Transport Setup ─────────────────────────────────────────
function setupTransport() {
  document.getElementById('btn-analyze').addEventListener('click', runAnalysis);
  document.getElementById('btn-play').addEventListener('click', () => {
    state.isPlaying ? pausePlay() : startPlay();
  });
  document.getElementById('btn-stop').addEventListener('click', stopPlay);
  document.getElementById('btn-export').addEventListener('click', () => {
    document.getElementById('modal-bg').style.display = 'flex';
  });

  document.getElementById('pb-wrap').addEventListener('click', e => {
    if (!state.buffer) return;
    const rect = e.currentTarget.querySelector('.pb-bg').getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.pauseOffset = pct * state.buffer.duration;
    document.getElementById('pb-fill').style.width = (pct * 100).toFixed(2) + '%';
    document.getElementById('tc').textContent = fmtT(state.pauseOffset);
    if (state.isPlaying) { pausePlay(); startPlay(); }
  });
}

// ─── Export ──────────────────────────────────────────────────
async function startExport() {
  if (!state.buffer) return;
  const sr   = parseInt(document.getElementById('exp-sr').value);
  document.getElementById('exp-prog').style.display  = '';
  document.getElementById('modal-start').disabled    = true;
  document.getElementById('exp-status').textContent  = 'ピッチシフト処理中...';

  try {
    await buildShiftedBuffer();
    state._lastShift = cfg.semitones;

    const src = state.shiftedBuf || state.buffer;
    document.getElementById('exp-status').textContent = 'WAVエンコード中...';

    // Render to target sampleRate via OfflineAudioContext if needed
    let outBuf = src;
    if (sr !== src.sampleRate) {
      const offCtx = new OfflineAudioContext(src.numberOfChannels, Math.ceil(src.length * sr / src.sampleRate), sr);
      const s = offCtx.createBufferSource(); s.buffer = src;
      s.connect(offCtx.destination); s.start(0);
      outBuf = await offCtx.startRendering();
    }

    const blob = encodeWAV(outBuf);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = 'pitch_corrected.wav'; a.click();
    URL.revokeObjectURL(url);

    document.getElementById('exp-status').textContent = 'エクスポート完了！';
    setTimeout(() => {
      document.getElementById('modal-bg').style.display   = 'none';
      document.getElementById('exp-prog').style.display   = 'none';
      document.getElementById('modal-start').disabled     = false;
    }, 2000);
    setStatus('エクスポート完了', 'active');
  } catch (e) {
    console.error(e);
    document.getElementById('exp-status').textContent = 'エラー: ' + e.message;
    document.getElementById('modal-start').disabled   = false;
  }
}

// ─── Audio Utilities ─────────────────────────────────────────
function detectPitch(data, sr, refHz = 440) {
  const wl  = Math.min(2048, data.length);
  let ac0 = 0;
  for (let i = 0; i < wl; i++) ac0 += data[i] * data[i];
  if (ac0 < 1e-6) return null;
  const mn = Math.floor(sr / 1000), mx = Math.floor(sr / 60);
  let best = -1, bestLag = -1;
  for (let lag = mn; lag <= mx; lag++) {
    let c = 0;
    for (let i = 0; i < wl - lag; i++) c += data[i] * data[i + lag];
    c /= ac0;
    if (c > best) { best = c; bestLag = lag; }
  }
  return best > 0.3 ? sr / bestLag : null;
}

function rmsOf(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(a.length, 1));
}

function hzToMidi(hz, refHz = 440) {
  return 12 * Math.log2(hz / refHz) + 69;
}

function fmtT(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function encodeWAV(buffer) {
  const nc = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const ab  = new ArrayBuffer(44 + len * nc * 2);
  const v   = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0,'RIFF'); v.setUint32(4, 36+len*nc*2, true); str(8,'WAVE');
  str(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,nc,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*nc*2,true); v.setUint16(32,nc*2,true); v.setUint16(34,16,true);
  str(36,'data'); v.setUint32(40,len*nc*2,true);
  const chs = []; for (let c = 0; c < nc; c++) chs.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function setStatus(text, cls) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = 'status-dot' + (cls ? ' ' + cls : '');
}
