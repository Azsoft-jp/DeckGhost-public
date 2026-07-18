// ===== Kick-aware beat matching: グリッド周辺の低域ピーク位置を推定 =====

import { TempoMap } from './beat-grid.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * 指定位置付近の複数拍を調べ、キックのエネルギーピークがグリッドから
 * 何秒ずれているかを返す。推定不能時は offset=0 / confidence=0。
 */
export function estimateKickOffset(track, anchorTime, sampleBeats = 8) {
  const buffer = track?.buffer;
  const bpm = track?.bpm;
  if (!buffer || !(bpm > 0) || buffer.length < 64) return { offset: 0, confidence: 0, samples: 0 };

  const sr = buffer.sampleRate;
  let tm = null;
  try { if (track.beatGrid) tm = new TempoMap(track.beatGrid); } catch {}
  const spb = tm ? 60 / tm.localBpmAt(anchorTime) : 60 / bpm;
  const grid = track.gridOffset || 0;
  const centerBeat = tm ? Math.round(tm.beatAtTime(anchorTime)) : Math.round((anchorTime - grid) / spb);
  const radiusSec = Math.min(0.14, spb * 0.3);
  const windowSamples = Math.max(16, Math.round(sr * 0.014));
  const stepSamples = Math.max(4, Math.round(sr * 0.002));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const offsets = [], strengths = [];

  for (let b = -Math.floor(sampleBeats / 2); b < Math.ceil(sampleBeats / 2); b++) {
    const expected = tm ? tm.timeAtBeat(centerBeat + b) : grid + (centerBeat + b) * spb;
    if (expected < radiusSec || expected > buffer.duration - radiusSec) continue;
    const start = Math.max(0, Math.floor((expected - radiusSec) * sr));
    const end = Math.min(buffer.length - windowSamples, Math.ceil((expected + radiusSec) * sr));
    let bestEnergy = 0, bestSample = start, sumEnergy = 0, windows = 0;

    for (let off = start; off <= end; off += stepSamples) {
      let energy = 0, count = 0;
      // 14ms RMS。4サンプル間引きでもキックの包絡位置には十分。
      for (let i = 0; i < windowSamples; i += 4) {
        let mono = 0;
        for (const channel of channels) mono += channel[off + i] || 0;
        mono /= channels.length;
        energy += mono * mono;
        count++;
      }
      energy = count ? energy / count : 0;
      sumEnergy += energy; windows++;
      if (energy > bestEnergy) { bestEnergy = energy; bestSample = off + windowSamples / 2; }
    }
    const meanEnergy = windows ? sumEnergy / windows : 0;
    const strength = bestEnergy / Math.max(1e-9, meanEnergy);
    if (strength >= 1.35) {
      offsets.push(bestSample / sr - expected);
      strengths.push(strength);
    }
  }

  if (!offsets.length) return { offset: 0, confidence: 0, samples: 0 };
  const offset = median(offsets);
  const mad = median(offsets.map((v) => Math.abs(v - offset)));
  const consistency = 1 - clamp(mad / 0.035, 0, 1);
  const strength = clamp((median(strengths) - 1.2) / 3, 0, 1);
  const coverage = clamp(offsets.length / Math.max(4, sampleBeats), 0, 1);
  return {
    offset: clamp(offset, -radiusSec, radiusSec),
    confidence: Math.round((consistency * 0.5 + strength * 0.25 + coverage * 0.25) * 100) / 100,
    samples: offsets.length,
  };
}

export function kickAlignedEntry(fromTrack, fromAnchor, toTrack, toAnchor, options = {}) {
  const { trustFromGrid = false, trustToGrid = false } = options;
  // 手動補正済みグリッドはユーザーが定めた絶対基準。キックピーク検出でその位置を
  // 動かさず、グリッド管理(位相はPLLで合わせる)とキック管理を分離する。
  const from = trustFromGrid
    ? { offset: 0, confidence: 1, samples: 0, trusted: true }
    : estimateKickOffset(fromTrack, fromAnchor);
  const to = trustToGrid
    ? { offset: 0, confidence: 1, samples: 0, trusted: true }
    : estimateKickOffset(toTrack, toAnchor);
  // 入り(to)のグリッドが手動なら、entryはグリッド通りに置き、キック検出で一切
  // ずらさない。これが「入りのキックがずれる」の主因だった。
  if (trustToGrid) return { shift: 0, from, to, reliable: true, trusted: true };
  const reliable = from.confidence >= 0.35 && to.confidence >= 0.35;
  const shift = reliable ? clamp(to.offset - from.offset, -0.1, 0.1) : 0;
  return { shift, from, to, reliable };
}
