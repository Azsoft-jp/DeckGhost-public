// ===== デモトラック合成: OfflineAudioContext でハウス/テクノ調のループ曲を生成 =====
// 音楽ファイルなしでもアプリと自動MIXを体験できるようにする。
// 高速化のため 8小節パターン(intro/full/outro)を個別にレンダリングし、
// タイル状に加算合成して1曲(56〜64小節)を組み立てる。

import { toCamelot, keyName } from './keyutil.js';

// Camelot互換になるようキーを選定 (8A/8B/9A/9B/7A)
export const DEMO_PRESETS = [
  { name: 'Neon Drive',   artist: 'AIDJ Demo', bpm: 124, root: 9, mode: 'minor', style: 'techno', bars: 64, energy: 0.75 }, // Am 8A
  { name: 'City Lights',  artist: 'AIDJ Demo', bpm: 122, root: 0, mode: 'major', style: 'house',  bars: 64, energy: 0.6 },  // C 8B
  { name: 'Acid Skyline', artist: 'AIDJ Demo', bpm: 128, root: 4, mode: 'minor', style: 'acid',   bars: 64, energy: 0.85 }, // Em 9A
  { name: 'Sunset Loop',  artist: 'AIDJ Demo', bpm: 118, root: 7, mode: 'major', style: 'house',  bars: 56, energy: 0.5 },  // G 9B
  { name: 'Midnight Run', artist: 'AIDJ Demo', bpm: 126, root: 2, mode: 'minor', style: 'techno', bars: 64, energy: 0.8 },  // Dm 7A
];

const SR = 44100;
const PAT_BARS = 8;
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- 8小節パターンのレンダリング ---------- */
async function renderPattern(preset, kind) {
  const spb = 60 / preset.bpm;
  const patDur = PAT_BARS * 4 * spb;
  const ctx = new OfflineAudioContext(2, Math.ceil((patDur + 1.0) * SR), SR);

  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);

  const noiseBuf = ctx.createBuffer(1, SR, SR);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < SR; i++) nd[i] = Math.random() * 2 - 1;

  const rootMidi = 33 + preset.root; // A1=33 基準の低域ルート
  const third = preset.mode === 'major' ? 4 : 3;
  const chordTones = [0, third, 7, 12];

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.3);
  }
  function hat(t, vol, open = false) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 8500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.22 : 0.05));
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.4); s.stop(t + 0.25);
  }
  function clap(t) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 2000; f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.4); s.stop(t + 0.15);
  }
  function bass(t, semitone, len) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = midiToFreq(rootMidi + semitone);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = preset.style === 'acid' ? 900 : 380;
    f.Q.value = preset.style === 'acid' ? 8 : 1;
    if (preset.style === 'acid') {
      f.frequency.setValueAtTime(1400, t);
      f.frequency.exponentialRampToValueAtTime(250, t + len);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.012);
    g.gain.setValueAtTime(0.34, t + len * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + len + 0.02);
  }
  function stab(t) {
    for (const st of chordTones) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(rootMidi + 24 + st);
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.045, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 1600;
        o.connect(f); f.connect(g); g.connect(master);
        o.start(t); o.stop(t + 0.3);
      }
    }
  }
  function arp(t, step) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = midiToFreq(rootMidi + 36 + chordTones[step % chordTones.length]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.035, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 3000;
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.12);
  }
  function sweep(t, len) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(6000, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + len);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.1);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + len + 0.2);
  }

  const sparse = kind !== 'full'; // intro/outro: キック+ハット中心
  const bassPattern = [0, 0, 12, 0, 0, 7, 0, 12]; // 8分刻み
  for (let bar = 0; bar < PAT_BARS; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const t = (bar * 4 + beat) * spb;
      kick(t);
      hat(t + spb / 2, sparse ? 0.12 : 0.2, beat === 3);
      if (!sparse && preset.style !== 'techno') {
        hat(t + spb / 4, 0.07);
        hat(t + (3 * spb) / 4, 0.07);
      }
      if ((!sparse || kind === 'outro') && (beat === 1 || beat === 3)) clap(t);
      if (!sparse) {
        for (let e = 0; e < 2; e++) {
          const st = bassPattern[beat * 2 + e];
          bass(t + e * (spb / 2) + 0.01, st, spb * 0.42);
        }
        if (beat === 1 || beat === 3) stab(t + spb / 2);
        if (preset.style === 'acid' && bar % 2 === 1) {
          for (let e = 0; e < 4; e++) arp(t + e * (spb / 4), beat * 4 + e);
        }
      }
    }
  }
  // full パターン後半に盛り上げスイープ
  if (kind === 'full') sweep((PAT_BARS - 4) * 4 * spb, 4 * 4 * spb);

  return ctx.startRendering();
}

/* ---------- パターンを加算コピーで敷き詰めて1曲を組み立て ---------- */
function addInto(dest, src, offsetSamples) {
  for (let ch = 0; ch < 2; ch++) {
    const d = dest.getChannelData(ch);
    const s = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
    const n = Math.min(s.length, d.length - offsetSamples);
    for (let i = 0; i < n; i++) d[offsetSamples + i] += s[i];
  }
}

export async function renderDemoTrack(preset, onProgress = null) {
  const spb = 60 / preset.bpm;
  const patSamples = Math.round(PAT_BARS * 4 * spb * SR);
  const nFull = Math.max(1, Math.round(preset.bars / PAT_BARS) - 2); // intro + full×n + outro
  const totalBars = (nFull + 2) * PAT_BARS;
  const totalSamples = Math.round(totalBars * 4 * spb * SR) + SR;

  onProgress?.(0.05, 'デモパターンをレンダリング');
  const [intro, full, outro] = await Promise.all([
    renderPattern(preset, 'intro'),
    renderPattern(preset, 'full'),
    renderPattern(preset, 'outro'),
  ]);
  onProgress?.(0.42, 'デモ曲を組み立て');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // ブラウザの通常AudioContextと互換のバッファを組み立て用に生成
  const asm = new OfflineAudioContext(2, totalSamples, SR);
  const buffer = asm.createBuffer(2, totalSamples, SR);
  let offset = 0;
  const patterns = [intro, ...Array.from({ length: nFull }, () => full), outro];
  for (const [index, pattern] of patterns.entries()) {
    addInto(buffer, pattern, offset);
    offset += patSamples;
    onProgress?.(0.42 + ((index + 1) / patterns.length) * 0.53, 'デモ曲を組み立て');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    buffer,
    meta: {
      name: preset.name,
      artist: preset.artist,
      bpm: preset.bpm,
      gridOffset: 0,
      energy: preset.energy,
      key: {
        root: preset.root,
        mode: preset.mode,
        name: keyName(preset.root, preset.mode),
        camelot: toCamelot(preset.root, preset.mode),
      },
    },
  };
}
