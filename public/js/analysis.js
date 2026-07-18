// ===== 楽曲解析エンジン: BPM検出 / キー検出 / ビートグリッド / 波形ピーク =====
import { toCamelot, keyName } from './keyutil.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TRUE_PEAK_PHASES = [0.25, 0.5, 0.75];

/* ---------- FFT (radix-2, 実数入力 → 振幅スペクトル) ---------- */
export function fftMag(input) {
  const n = input.length; // 2のべき乗であること
  const re = Float64Array.from(input);
  const im = new Float64Array(n);
  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

/* ---------- モノラルミックス ---------- */
function mixMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  const g = 1 / buffer.numberOfChannels;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/* ---------- スペクトルフラックス・オンセットエンベロープ ----------
   全帯域エネルギー差分より打楽器のアタックを鋭く捉えられ、
   BPM自己相関のピークが立ちやすい。 */
function onsetFlux(mono, sr, win, hop) {
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  // ビン重み: キック帯(低域)を強調しつつ全帯域のアタックも拾う。
  // ダンストラックはキックがテンポを定義するため低域を厚めに重み付けする。
  const binW = new Float32Array(win / 2);
  for (let b = 0; b < win / 2; b++) {
    const f = (b * sr) / win;
    binW[b] = 1 + 3 * Math.exp(-f / 220); // <220Hz を約4倍
  }
  const frames = Math.max(0, Math.floor((mono.length - win) / hop));
  const flux = new Float32Array(frames);
  const frame = new Float32Array(win);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < win; i++) frame[i] = mono[off + i] * hann[i];
    const mag = fftMag(frame);
    if (prev) {
      let s = 0;
      for (let b = 1; b < mag.length; b++) {
        const d = mag[b] - prev[b];
        if (d > 0) s += d * binW[b]; // 立ち上がり成分のみ (half-wave rectify)
      }
      flux[f] = s;
    }
    prev = mag;
  }
  let max = 0;
  for (let i = 0; i < frames; i++) if (flux[i] > max) max = flux[i];
  if (max > 0) for (let i = 0; i < frames; i++) flux[i] /= max;
  return flux;
}

/* ---------- キック専用オンセット包絡線 (時間領域, 低域限定) ----------
   BPM検出には全帯域加重フラックス(FFTフレームホップ5.8ms・窓23ms)を使うが、
   それをそのままグリッド位相に使うとハイハット等も混ざり、
   窓のぼやけでキックのアタックより数ms〜十数ms遅れた位置に吸着してしまう。
   ここでは単純な一次ローパス(<150Hz)でキック帯だけを時間領域で抽出し、
   ホップ1.45msの細かい分解能でアタックの立ち上がりを直接捉える。 */
const KICK_CUTOFF_HZ = 150;
function kickOnsetEnvelope(mono, sr, hop) {
  const rc = 1 / (2 * Math.PI * KICK_CUTOFF_HZ);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  const n = mono.length;
  const lp = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) { y += alpha * (mono[i] - y); lp[i] = y; }

  const frames = Math.floor(n / hop);
  const peak = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let m = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) { const v = Math.abs(lp[off + i]); if (v > m) m = v; }
    peak[f] = m;
  }
  // 立ち上がり成分のみ (半波整流差分) — アタックの先頭に鋭いピークを残す
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, peak[f] - peak[f - 1]);
  let max = 0;
  for (let i = 0; i < frames; i++) if (onset[i] > max) max = onset[i];
  if (max > 0) for (let i = 0; i < frames; i++) onset[i] /= max;
  return { onset, groupDelay: rc }; // 一次LPFの群遅延ぶんは後で補正する
}

// エンベロープの線形補間サンプル (分数ラグ用)
function envAt(env, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  const f = x - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}
// 分数ラグでの自己相関 (平均正規化)
function autocorrFrac(env, lag) {
  let s = 0, c = 0;
  for (let i = 0; i + lag < env.length; i++) { s += env[i] * envAt(env, i + lag); c++; }
  return c ? s / c : 0;
}
// 倍音和を分数ラグで評価 (複数拍の長基線で周期をより正確に固定する)。
// 2L/4Lなど偶数倍は「半テンポ候補にとっての自分自身の周期」と厳密に一致するため
// 使わない (下のコメント参照)。奇数倍 (3L, 5L) だけを使うことで
// オクターブ曖昧性にエイリアスしない多周期検証にする。
function harmFrac(env, L) {
  let s = autocorrFrac(env, L);
  if (3 * L < env.length) s += 0.5 * autocorrFrac(env, 3 * L);
  if (5 * L < env.length) s += 0.33 * autocorrFrac(env, 5 * L);
  return s;
}

/* ---------- BPM検出: スペクトルフラックス自己相関 + テンポ事前分布 + 分数ラグ精密化 ---------- */
export function detectBPM(buffer, sharedMono = null) {
  const sr = buffer.sampleRate;
  const win = 1024, hop = 256;
  const envRate = sr / hop; // ≈172Hz でラグ解像度を確保
  const mono = sharedMono || mixMono(buffer);

  // 代表区間を解析 (イントロ/アウトロを避け中盤を最大60秒)
  const startSec = Math.min(buffer.duration * 0.1, 20);
  const lenSec = Math.min(buffer.duration - startSec, 60);
  const s0 = Math.floor(startSec * sr);
  const s1 = Math.min(mono.length, Math.floor((startSec + Math.max(0, lenSec)) * sr));
  const seg = mono.subarray(s0, s1);

  const env = onsetFlux(seg, sr, win, hop);
  // 平均を引いて自己相関のピークを鋭くする
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= env.length || 1;
  for (let i = 0; i < env.length; i++) env[i] = Math.max(0, env[i] - mean);

  const MIN_BPM = 60, MAX_BPM = 200;
  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * envRate));
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / MIN_BPM) * envRate));

  // 整数ラグの自己相関
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < env.length - lag; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }

  // 粗いラグ探索: 奇数倍音和 (L, 3L, 5L) × テンポ事前分布。
  //
  // 以前は「真のラグLは2L/3L/4Lにも自己相関ピークを持つ」という理屈で
  // ac[L]+0.5*ac[2L]+0.33*ac[3L]+0.25*ac[4L] を多周期検証のスコアにしていたが、
  // これは実音源で系統的な倍テンポ誤検出を引き起こしていた: 半テンポの
  // 候補Lにとって「2L」はちょうど真の(遅い)周期の自己相関ピークと厳密に
  // 一致するため、速い(短ラグ)候補が遅い候補の強さを横流しで加算してしまい、
  // 常に「速い側」が有利になっていた (実測: 実際は約96BPMの楽曲が
  // 193BPM=ちょうど2倍として検出される事例で確認)。
  // 一方、多周期検証を完全に捨てて生のac[lag]単体で比較すると、
  // バックビート(2拍・4拍目のスネア)がキック単体より強い周期性を
  // 作るケースで小節単位の周期に飛んでしまい、別の誤検出を招いた。
  //
  // 対策: 2L/4Lなど偶数倍(=オクターブ違いの候補と直接エイリアスする項)を
  // 除外し、3L/5Lなど奇数倍だけで多周期検証する。3Lは「1/3テンポ」という
  // 実質的に競合しない仮説にしか一致しないため、多周期検証の頑健さを
  // 保ちながらオクターブの横流しを避けられる。
  const PREF_BPM = 125, OCT_STD = 0.75;
  const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / PREF_BPM) / OCT_STD, 2));
  const harmSum = (lag) => {
    let s = ac[lag];
    if (3 * lag <= maxLag) s += 0.5 * ac[3 * lag];
    if (5 * lag <= maxLag) s += 0.33 * ac[5 * lag];
    return s;
  };

  // 局所極大 (ピーク) の探索
  const candidates = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const s = harmSum(lag) * prior((60 * envRate) / lag);
    const prevS = harmSum(lag - 1) * prior((60 * envRate) / (lag - 1));
    const nextS = harmSum(lag + 1) * prior((60 * envRate) / (lag + 1));
    if (s > prevS && s > nextS) {
      candidates.push({ lag, score: s });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // 上位3つのピークを精密化
  const topCandidates = candidates.slice(0, 3);
  const refinedCandidates = [];

  for (const cand of topCandidates) {
    let refLag = cand.lag, refVal = -Infinity;
    for (let L = cand.lag - 2; L <= cand.lag + 2; L += 0.01) {
      if (L < 1) continue;
      const v = harmFrac(env, L);
      if (v > refVal) { refVal = v; refLag = L; }
    }
    const d = 0.01;
    const yl = harmFrac(env, refLag - d), yr = harmFrac(env, refLag + d);
    const den = yl - 2 * refVal + yr;
    if (Math.abs(den) > 1e-12) refLag += 0.5 * d * (yl - yr) / den;

    let candBpm = (60 * envRate) / refLag;
    candBpm = Math.round(candBpm * 1000) / 1000;
    refinedCandidates.push({ bpm: candBpm, score: cand.score, refLag });
  }

  if (refinedCandidates.length === 0) {
    refinedCandidates.push({ bpm: 120, score: 0.1, refLag: (60 * envRate) / 120 });
  }

  const primary = refinedCandidates[0];
  let bpm = primary.bpm;
  let refLag = primary.refLag;

  // alternatives と confidence (信頼度) の計算
  const scoreSum = refinedCandidates.reduce((sum, c) => sum + c.score, 0) || 1;
  const gridConfidence = Math.max(0.1, Math.min(0.95, primary.score / scoreSum));
  const alternatives = [];
  for (let i = 1; i < refinedCandidates.length; i++) {
    const cand = refinedCandidates[i];
    const ratio = bpm / cand.bpm;
    let relation;
    if (ratio >= 0.45 && ratio <= 0.55) relation = 'double';
    else if (ratio >= 1.9 && ratio <= 2.1) relation = 'half';
    else if (ratio >= 1.4 && ratio <= 1.6) relation = 'two-thirds';
    else if (ratio >= 0.6 && ratio <= 0.7) relation = 'three-halves';

    alternatives.push({
      bpm: cand.bpm,
      score: cand.score,
      confidence: Math.max(0.05, Math.min(0.8, cand.score / scoreSum)),
      relationToPrimary: relation
    });
  }

  // ビート位相 (グリッドオフセット)
  let periodSec = 60 / bpm;
  const hop2 = 64; // ≈1.45ms分解能
  const { onset: kickEnv, groupDelay } = kickOnsetEnvelope(seg, sr, hop2);
  const periodF2 = (periodSec * sr) / hop2;

  // 粗探索
  let bestOff2 = 0, bestPhase2 = -Infinity, phaseSum2 = 0, phaseCnt2 = 0;
  const coarseStep = Math.max(1, Math.floor(periodF2 / 64));
  for (let o = 0; o < periodF2; o += coarseStep) {
    let s = 0, cnt = 0;
    for (let p = o; p < kickEnv.length; p += periodF2) { s += envAt(kickEnv, p); cnt++; }
    s /= cnt || 1;
    phaseSum2 += s; phaseCnt2++;
    if (s > bestPhase2) { bestPhase2 = s; bestOff2 = o; }
  }
  let phaseRefOff = bestOff2, phaseRefVal = bestPhase2;
  const fineStep = coarseStep / 20;
  for (let o = bestOff2 - coarseStep; o <= bestOff2 + coarseStep; o += fineStep) {
    if (o < 0) continue;
    let s = 0, cnt = 0;
    for (let p = o; p < kickEnv.length; p += periodF2) { s += envAt(kickEnv, p); cnt++; }
    s /= cnt || 1;
    if (s > phaseRefVal) { phaseRefVal = s; phaseRefOff = o; }
  }

  // 最終スナップ
  const snapRadius = periodF2 * 0.15;
  const localPeaks = [];
  for (let k = -4; k <= 4; k++) {
    const r = phaseRefOff + k * periodF2;
    if (r < 0 || r >= kickEnv.length) continue;
    let pOff = r, pVal = envAt(kickEnv, r);
    for (let p = r - snapRadius; p <= r + snapRadius; p += 1) {
      if (p < 0 || p >= kickEnv.length) continue;
      const v = kickEnv[Math.round(p)];
      if (v > pVal) { pVal = v; pOff = Math.round(p); }
    }
    if (pOff > 0 && pOff < kickEnv.length - 1) {
      const y0 = kickEnv[pOff - 1], y1 = kickEnv[pOff], y2 = kickEnv[pOff + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-9) pOff += 0.5 * (y0 - y2) / den;
    }
    localPeaks.push(pOff - r);
  }
  localPeaks.sort((a, b) => a - b);
  const median = localPeaks.length ? localPeaks[Math.floor(localPeaks.length / 2)] : 0;
  const snapOff = phaseRefOff + median;

  // キックアタック同期によるBPM微細化
  let bestBpm = bpm;
  let maxBpmScore = -Infinity;
  const initialOffsetFrame = snapOff;

  for (let testBpm = bpm - 0.5; testBpm <= bpm + 0.5; testBpm += 0.002) {
    const testPeriod = (60 / testBpm) * sr / hop2;
    let score = 0, count = 0;
    for (let k = 0; ; k++) {
      const p = initialOffsetFrame + k * testPeriod;
      if (p >= kickEnv.length) break;
      score += envAt(kickEnv, p);
      count++;
    }
    score = count > 0 ? score / count : 0;
    if (score > maxBpmScore) { maxBpmScore = score; bestBpm = testBpm; }
  }

  // 適応的スナップ
  const nearestHalf = Math.round(bestBpm * 2) / 2;
  if (Math.abs(bestBpm - nearestHalf) < 0.015) {
    bestBpm = nearestHalf;
  } else {
    bestBpm = Math.round(bestBpm * 1000) / 1000;
  }
  bpm = bestBpm;

  periodSec = 60 / bpm;
  const firstBeat = startSec + (snapOff * hop2) / sr - groupDelay;
  const gridOffset = ((firstBeat % periodSec) + periodSec) % periodSec;

  // エネルギー指標
  let rms = 0, cnt = 0;
  const step = Math.max(1, Math.floor(mono.length / 500000));
  for (let i = 0; i < mono.length; i += step) { rms += mono[i] * mono[i]; cnt++; }
  rms = Math.sqrt(rms / (cnt || 1));
  const energy = Math.min(1, rms * 4);

  // 全ビート位置配列の作成 (ダウンビート・拍子推定用)
  const beatTimesSec = [];
  const totalBeats = Math.floor(buffer.duration / periodSec);
  for (let i = 0; i < totalBeats; i++) {
    beatTimesSec.push(gridOffset + i * periodSec);
  }

  // 拍子とダウンビートの自動推定
  const meterResult = estimateMeterAndDownbeat(mono, sr, bpm, gridOffset, beatTimesSec, kickEnv, hop2);

  return {
    bpm,
    gridOffset,
    energy,
    gridConfidence,
    alternatives,
    meter: meterResult,
    beatTimesSec
  };
}

// 拍子・ダウンビート推定ヘルパー関数
function estimateMeterAndDownbeat(mono, sr, bpm, gridOffset, beatTimesSec, kickEnv, hop2) {
  const nBeats = beatTimesSec.length;
  if (nBeats < 16) {
    return { numerator: 4, denominator: 4, beatUnit: 'quarter', barOriginBeatIndex: 0, confidence: 0.5 };
  }
  const beatStrengths = new Float32Array(nBeats);
  for (let i = 0; i < nBeats; i++) {
    const frame = Math.round((beatTimesSec[i] * sr) / hop2);
    if (frame >= 0 && frame < kickEnv.length) beatStrengths[i] = kickEnv[frame];
  }
  let bestMeter = 4, bestOffset = 0, maxContrast = -1;
  const metersToTest = [3, 4];
  const meterScores = {};
  for (const m of metersToTest) {
    const phaseScores = new Float32Array(m), phaseCounts = new Int32Array(m);
    for (let i = 0; i < nBeats; i++) {
      const phase = i % m;
      phaseScores[phase] += beatStrengths[i];
      phaseCounts[phase]++;
    }
    for (let p = 0; p < m; p++) phaseScores[p] /= phaseCounts[p] || 1;
    const avg = phaseScores.reduce((sum, v) => sum + v, 0) / m;
    let maxVal = -Infinity, maxPhase = 0;
    for (let p = 0; p < m; p++) {
      if (phaseScores[p] > maxVal) { maxVal = phaseScores[p]; maxPhase = p; }
    }
    const contrast = maxVal / (avg + 1e-9);
    meterScores[m] = { contrast, maxPhase, avg };
    if (contrast > maxContrast) { maxContrast = contrast; bestMeter = m; bestOffset = maxPhase; }
  }
  let finalNumerator = 4, finalOffset = meterScores[4].maxPhase, meterConfidence = 0.5;
  if (meterScores[3].contrast > meterScores[4].contrast * 1.15) {
    finalNumerator = 3;
    finalOffset = meterScores[3].maxPhase;
    meterConfidence = Math.min(0.9, (meterScores[3].contrast - 1) / 1.5);
  } else {
    finalNumerator = 4;
    meterConfidence = Math.min(0.9, (meterScores[4].contrast - 1) / 1.5);
  }
  let barOriginBeatIndex = 0;
  if (finalOffset > 0) barOriginBeatIndex = finalNumerator - finalOffset;
  return {
    numerator: finalNumerator,
    denominator: 4,
    beatUnit: 'quarter',
    barOriginBeatIndex,
    confidence: Math.max(0.2, meterConfidence)
  };
}

/* ---------- キー検出: クロマグラム + Krumhansl-Schmuckler ---------- */
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}

export function detectKey(buffer, sharedMono = null) {
  const sr = buffer.sampleRate;
  const mono = sharedMono || mixMono(buffer);
  const win = 8192;
  const chroma = new Float64Array(12);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  const start = Math.floor(mono.length * 0.05);
  const end = Math.floor(mono.length * 0.95) - win;
  const nFrames = 48;
  const step = Math.max(win, Math.floor((end - start) / nFrames));
  const frame = new Float32Array(win);

  for (let off = start; off + win < end; off += step) {
    for (let i = 0; i < win; i++) frame[i] = mono[off + i] * hann[i];
    const mags = fftMag(frame);
    for (let bin = 1; bin < mags.length; bin++) {
      const f = (bin * sr) / win;
      if (f < 55 || f > 2000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mags[bin];
    }
  }

  let best = { score: -2, root: 0, mode: 'minor' };
  for (let root = 0; root < 12; root++) {
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + root) % 12];
    const sMaj = correlate(rotated, PROFILE_MAJOR);
    const sMin = correlate(rotated, PROFILE_MINOR);
    if (sMaj > best.score) best = { score: sMaj, root, mode: 'major' };
    if (sMin > best.score) best = { score: sMin, root, mode: 'minor' };
  }
  return {
    root: best.root,
    mode: best.mode,
    name: keyName(best.root, best.mode),
    camelot: toCamelot(best.root, best.mode),
  };
}

/* ---------- スペクトルキャラクタ: LOW/MID/HIGH 比率と分類 ---------- */
export function analyzeSpectrum(buffer, sharedMono = null) {
  const sr = buffer.sampleRate;
  const mono = sharedMono || mixMono(buffer);
  const win = 4096;
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const frame = new Float32Array(win);
  let low = 0, mid = 0, high = 0;

  const start = Math.floor(mono.length * 0.1);
  const end = Math.floor(mono.length * 0.9) - win;
  const step = Math.max(win, Math.floor((end - start) / 32));
  for (let off = start; off + win < end; off += step) {
    for (let i = 0; i < win; i++) frame[i] = mono[off + i] * hann[i];
    const mags = fftMag(frame);
    for (let bin = 1; bin < mags.length; bin++) {
      const f = (bin * sr) / win;
      const e = mags[bin] * mags[bin];
      if (f < 20) continue;
      if (f < 250) low += e;
      else if (f < 4000) mid += e;
      else if (f < 16000) high += e;
    }
  }
  const total = low + mid + high || 1;
  low /= total; mid /= total; high /= total;
  const character =
    low > 0.5 ? 'bass-heavy'
    : mid > 0.55 ? 'vocal/mid-forward'
    : high > 0.3 ? 'bright/percussive'
    : 'balanced';
  return { low, mid, high, character };
}

/* ---------- SSM構造解析 ---------- */

/** 正規化済み特徴量から、対角平滑化SSM → Time-lag列差のNoveltyを求める。
 *  入力を小節単位へ集約しているため、一般的なフレーム単位SSMより大幅に軽い。 */
export function computeSsmNovelty(features, smoothRadius = 2) {
  const n = features.length;
  if (!n) return [];
  const ssm = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dot = 0;
      const a = features[i], b = features[j];
      for (let k = 0; k < Math.min(a.length, b.length); k++) dot += a[k] * b[k];
      ssm[i * n + j] = dot;
      ssm[j * n + i] = dot;
    }
  }

  // SSMの対角線に沿って平均し、同じ進行が時間方向へ続くパスを強調する。
  const smooth = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0, count = 0;
      for (let d = -smoothRadius; d <= smoothRadius; d++) {
        const ii = i + d, jj = j + d;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        sum += ssm[ii * n + jj];
        count++;
      }
      smooth[i * n + j] = count ? sum / count : 0;
    }
  }

  // Time-lag表現の隣接列差。明示的なN×N変換行列は作らず添字で参照する。
  const rawNovelty = new Float32Array(n);
  for (let col = 1; col < n; col++) {
    let sum = 0;
    for (let lag = 0; lag < n; lag++) {
      const curRow = (lag + col) % n;
      const prevRow = (lag + col - 1 + n) % n;
      const diff = smooth[curRow * n + col] - smooth[prevRow * n + col - 1];
      sum += diff * diff;
    }
    rawNovelty[col] = Math.sqrt(sum / n);
  }
  // 実音のクロマは定常区間でも微小に揺れる。局所中央値をノイズ床として引き、
  // 曲全体最大値だけの正規化で全区間が高Noveltyになるのを防ぐ。
  const novelty = new Float32Array(n);
  let max = 1e-9;
  for (let i = 1; i < n; i++) {
    const local = [];
    for (let j = Math.max(1, i - 4); j <= Math.min(n - 1, i + 4); j++) local.push(rawNovelty[j]);
    local.sort((a, b) => a - b);
    const floor = local[Math.floor(local.length / 2)] || 0;
    novelty[i] = Math.max(0, rawNovelty[i] - floor * 0.82);
    max = Math.max(max, novelty[i]);
  }
  for (let i = 0; i < n; i++) novelty[i] /= max;
  return Array.from(novelty);
}

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

/** 曲中の局所テンポを追跡し、固定グリッドで安全にミックスできるかを評価する。 */
export function analyzeLocalTempo(buffer, referenceBpm, sharedMono = null, referenceOffset = 0, meterHint = null) {
  const sr = buffer.sampleRate;
  // グリッド位相ではなく数秒単位の変動を見るため、FFT負荷を抑えたhopで十分。
  const hop = 512;
  const envRate = sr / hop;
  const env = onsetFlux(sharedMono || mixMono(buffer), sr, 1024, hop);
  const windowSec = 8;
  const stepSec = 4;
  const windowFrames = Math.max(32, Math.round(windowSec * envRate));
  const stepFrames = Math.max(16, Math.round(stepSec * envRate));
  const curve = [];

  for (let start = 0; start < env.length; start += stepFrames) {
    const end = Math.min(env.length, start + windowFrames);
    if (end - start < windowFrames * 0.55) break;
    let mean = 0;
    for (let i = start; i < end; i++) mean += env[i];
    mean /= end - start;

    let bestBpm = referenceBpm;
    let bestScore = -Infinity;
    // 局所ドリフトを追う用途なので、倍/半テンポへ飛ばないよう全体推定値の近傍だけ探索する。
    const minBpm = Math.max(40, referenceBpm * 0.82);
    const maxBpm = Math.min(240, referenceBpm * 1.18);
    for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
      const lag = (60 * envRate) / bpm;
      let dot = 0, aa = 0, bb = 0;
      for (let i = start; i + lag < end; i++) {
        const a = Math.max(0, env[i] - mean);
        const b = Math.max(0, envAt(env, i + lag) - mean);
        dot += a * b; aa += a * a; bb += b * b;
      }
      const correlation = dot / Math.sqrt(aa * bb + 1e-12);
      const prior = Math.exp(-0.5 * Math.pow((bpm - referenceBpm) / Math.max(2, referenceBpm * 0.08), 2));
      const score = correlation * (0.82 + prior * 0.18);
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }
    curve.push({
      time: Math.round(((start + (end - start) * 0.5) / envRate) * 100) / 100,
      bpm: Math.round(bestBpm * 100) / 100,
      confidence: Math.round(clamp01(bestScore) * 100) / 100,
    });
  }

  const reliable = curve.filter((point) => point.confidence >= 0.12);
  const bpms = (reliable.length >= 2 ? reliable : curve).map((point) => point.bpm);
  const median = reliable.length ? medianOf(bpms) || referenceBpm : referenceBpm;
  const deviations = bpms.map((bpm) => Math.abs(bpm - median));
  const mad = medianOf(deviations);
  const range = bpms.length ? Math.max(...bpms) - Math.min(...bpms) : 0;
  const driftBpm = Math.max(mad * 1.4826, range * 0.25);
  const confidence = curve.length
    ? curve.reduce((sum, point) => sum + point.confidence, 0) / curve.length
    : 0;
  const stability = clamp01(1 - driftBpm / Math.max(2.5, referenceBpm * 0.025))
    * clamp01(confidence / 0.35);

  const variableTempo = driftBpm > Math.max(1.5, referenceBpm * 0.012);
  const mode = variableTempo ? 'dynamic' : 'rigid';

  // BeatGrid アンカー列の構築
  const anchors = [];
  if (mode === 'rigid') {
    anchors.push({
      beatIndex: 0,
      timeSec: referenceOffset,
      localBpm: referenceBpm,
      confidence: stability,
      source: 'estimated'
    });
  } else {
    // 最初のアンカー
    anchors.push({
      beatIndex: 0,
      timeSec: referenceOffset,
      localBpm: curve.length > 0 ? curve[0].bpm : referenceBpm,
      confidence: curve.length > 0 ? curve[0].confidence : stability,
      source: 'estimated'
    });
    let currentBeat = 0;
    for (let i = 0; i < curve.length; i++) {
      const pt = curve[i];
      const prevPt = i > 0 ? curve[i - 1] : { time: referenceOffset, bpm: referenceBpm };
      const dt = pt.time - prevPt.time;
      if (dt <= 0) continue;
      const avgBpm = (pt.bpm + prevPt.bpm) * 0.5;
      currentBeat += dt * (avgBpm / 60);
      anchors.push({
        beatIndex: Math.round(currentBeat * 1000) / 1000,
        timeSec: pt.time,
        localBpm: pt.bpm,
        confidence: pt.confidence,
        source: 'estimated'
      });
    }
  }

  // 拍子セグメント
  const meterSegments = [];
  if (meterHint) {
    meterSegments.push({
      startBeat: 0,
      numerator: meterHint.numerator,
      denominator: meterHint.denominator,
      beatUnit: meterHint.beatUnit,
      downbeatBeatIndex: meterHint.barOriginBeatIndex,
      confidence: meterHint.confidence,
      source: 'estimated'
    });
  } else {
    meterSegments.push({
      startBeat: 0,
      numerator: 4,
      denominator: 4,
      beatUnit: 'quarter',
      downbeatBeatIndex: 0,
      confidence: 0.8,
      source: 'estimated'
    });
  }

  const beatGrid = {
    mode,
    anchors,
    meterSegments,
    firstReliableBeatTimeSec: referenceOffset,
    barOriginBeatIndex: meterHint ? meterHint.barOriginBeatIndex : 0,
    barOneBeatIndex: meterHint ? meterHint.barOriginBeatIndex : 0,
    analysisVersion: '2.0',
    locked: false
  };

  // テンポセグメント
  const tempoSegments = [];
  if (mode === 'rigid') {
    tempoSegments.push({
      startSec: 0,
      endSec: buffer.duration,
      bpm: referenceBpm,
      confidence: stability,
      beatOffsetSec: referenceOffset
    });
  } else {
    for (let i = 0; i < anchors.length - 1; i++) {
      const a0 = anchors[i];
      const a1 = anchors[i + 1];
      const db = a1.beatIndex - a0.beatIndex;
      const dt = a1.timeSec - a0.timeSec;
      const bpm = dt > 0 ? (60 * db) / dt : a0.localBpm;
      tempoSegments.push({
        startSec: a0.timeSec,
        endSec: a1.timeSec,
        bpm: Math.round(bpm * 1000) / 1000,
        confidence: (a0.confidence + a1.confidence) * 0.5,
        beatOffsetSec: a0.timeSec
      });
    }
  }

  // stableMixRanges の算出
  const stableMixRanges = [];
  if (mode === 'rigid') {
    stableMixRanges.push({
      startSec: 0,
      endSec: buffer.duration,
      confidence: stability
    });
  } else {
    let rangeStart = null;
    for (let i = 0; i < curve.length; i++) {
      const pt = curve[i];
      const isStable = Math.abs(pt.bpm - referenceBpm) < Math.max(1.0, referenceBpm * 0.008) && pt.confidence > 0.15;
      if (isStable) {
        if (rangeStart === null) rangeStart = pt.time;
      } else {
        if (rangeStart !== null) {
          stableMixRanges.push({ startSec: rangeStart, endSec: pt.time, confidence: stability });
          rangeStart = null;
        }
      }
    }
    if (rangeStart !== null && curve.length > 0) {
      stableMixRanges.push({ startSec: rangeStart, endSec: curve[curve.length - 1].time, confidence: stability });
    }
  }

  return {
    curve,
    medianBpm: Math.round(median * 100) / 100,
    driftBpm: Math.round(driftBpm * 100) / 100,
    stability: Math.round(stability * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    variableTempo,
    beatGrid,
    tempoSegments,
    stableMixRanges
  };
}

/** STFT振幅列へ中央値HPSSマスクを適用する。音声再合成ではなく解析特徴の分離専用。 */
export function computeHpssMasks(spectra, centerIndex = Math.floor(spectra.length / 2), freqRadius = 8) {
  if (!spectra.length) return { harmonicMask: new Float32Array(), percussiveMask: new Float32Array() };
  const bins = spectra[0].length;
  const center = spectra[Math.max(0, Math.min(spectra.length - 1, centerIndex))];
  const harmonicMask = new Float32Array(bins);
  const percussiveMask = new Float32Array(bins);
  const temporal = new Float32Array(spectra.length);
  const frequency = new Float32Array(freqRadius * 2 + 1);

  for (let bin = 0; bin < bins; bin++) {
    for (let frame = 0; frame < spectra.length; frame++) temporal[frame] = spectra[frame][bin];
    temporal.sort();
    const harmonic = temporal[Math.floor(temporal.length / 2)];

    let count = 0;
    for (let near = Math.max(0, bin - freqRadius); near <= Math.min(bins - 1, bin + freqRadius); near++) {
      frequency[count++] = center[near];
    }
    const local = frequency.subarray(0, count);
    local.sort();
    const percussive = local[Math.floor(count / 2)];
    const h2 = harmonic * harmonic;
    const p2 = percussive * percussive;
    const sum = h2 + p2 + 1e-12;
    harmonicMask[bin] = h2 / sum;
    percussiveMask[bin] = p2 / sum;
  }
  return { harmonicMask, percussiveMask };
}

function normalizeVector(values) {
  let norm = 1e-12;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  for (let i = 0; i < values.length; i++) values[i] /= norm;
  return values;
}

function buildStructureFeatures(chromaFeatures, timbreFeatures, percussiveCurve) {
  const n = chromaFeatures.length;
  const dims = timbreFeatures[0]?.length || 0;
  const means = new Float32Array(dims);
  const stds = new Float32Array(dims);
  for (const feature of timbreFeatures) for (let d = 0; d < dims; d++) means[d] += feature[d] / Math.max(1, n);
  for (const feature of timbreFeatures) {
    for (let d = 0; d < dims; d++) stds[d] += (feature[d] - means[d]) ** 2 / Math.max(1, n);
  }
  for (let d = 0; d < dims; d++) stds[d] = Math.sqrt(stds[d] + 1e-8);

  return chromaFeatures.map((chroma, i) => {
    const timbre = new Float32Array(dims);
    for (let d = 0; d < dims; d++) timbre[d] = (timbreFeatures[i][d] - means[d]) / stds[d];
    normalizeVector(timbre);
    const previousPercussive = percussiveCurve[Math.max(0, i - 1)];
    const values = new Float32Array(12 + dims + 2);
    for (let d = 0; d < 12; d++) values[d] = chroma[d] * 0.75;
    for (let d = 0; d < dims; d++) values[12 + d] = timbre[d] * 0.48;
    values[12 + dims] = percussiveCurve[i] * 0.28;
    values[13 + dims] = (percussiveCurve[i] - previousPercussive) * 0.2;
    return normalizeVector(values);
  });
}

export function estimateChordSequence(chromaFeatures, gridOffset = 0, barSec = 1) {
  const templates = [];
  for (const mode of ['major', 'minor']) {
    const third = mode === 'major' ? 4 : 3;
    for (let root = 0; root < 12; root++) {
      const vector = new Float32Array(12);
      vector[root] = 1;
      vector[(root + third) % 12] = 0.82;
      vector[(root + 7) % 12] = 0.9;
      normalizeVector(vector);
      templates.push({ root, mode, vector });
    }
  }

  const raw = chromaFeatures.map((chroma, bar) => {
    let chromaMass = 0;
    for (const value of chroma) chromaMass += value;
    let best = null, second = -Infinity;
    for (const template of templates) {
      let score = 0;
      for (let i = 0; i < 12; i++) score += chroma[i] * template.vector[i];
      if (!best || score > best.score) { second = best?.score ?? second; best = { ...template, score }; }
      else if (score > second) second = score;
    }
    const confidence = best && chromaMass > 1e-6
      ? clamp01((best.score - Math.max(0, second)) / 0.28)
      : 0;
    if (!best || confidence < 0.12) return {
      bar: bar + 1, time: gridOffset + bar * barSec, name: 'N.C.', root: null, mode: null, confidence: 0,
    };
    return {
      bar: bar + 1,
      time: gridOffset + bar * barSec,
      name: keyName(best.root, best.mode),
      root: best.root,
      mode: best.mode,
      camelot: toCamelot(best.root, best.mode),
      confidence: Math.round(confidence * 100) / 100,
    };
  });

  // 前後が同じコードなら、低信頼な1小節だけの揺れを補正する。
  return raw.map((chord, i) => {
    const previous = raw[i - 1], next = raw[i + 1];
    if (previous && next && previous.name === next.name
      && chord.name !== previous.name && chord.confidence < 0.55) {
      return { ...previous, bar: chord.bar, time: chord.time, confidence: Math.min(previous.confidence, next.confidence) };
    }
    return chord;
  });
}

function barSpectralFeatures(mono, sr, gridOffset, barSec, nBars) {
  const win = 4096;
  const temporalFrames = 5;
  const temporalHop = 2048;
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const frame = new Float32Array(win);
  const chromaFeatures = [];
  const timbreFeatures = [];
  const centroidCurve = new Float32Array(nBars);
  const percussiveCurve = new Float32Array(nBars);

  for (let bar = 0; bar < nBars; bar++) {
    const center = gridOffset + (bar + 0.5) * barSec;
    const centerOff = Math.floor(center * sr - win / 2);
    const spectra = [];
    for (let temporal = 0; temporal < temporalFrames; temporal++) {
      const shift = (temporal - Math.floor(temporalFrames / 2)) * temporalHop;
      const off = Math.max(0, Math.min(Math.max(0, mono.length - win), centerOff + shift));
      for (let i = 0; i < win; i++) frame[i] = (mono[off + i] || 0) * hann[i];
      spectra.push(fftMag(frame));
    }
    const mags = spectra[Math.floor(temporalFrames / 2)];
    const { harmonicMask, percussiveMask } = computeHpssMasks(spectra);
    const chroma = new Float32Array(12);
    const logBands = new Float32Array(20);
    let weightedHz = 0, spectralMass = 0, percussiveMass = 0;
    for (let bin = 2; bin < mags.length - 2; bin++) {
      const f = (bin * sr) / win;
      const power = mags[bin] * mags[bin];
      weightedHz += f * power;
      spectralMass += power;
      percussiveMass += power * percussiveMask[bin];
      if (f >= 40) {
        const band = Math.min(logBands.length - 1,
          Math.max(0, Math.floor(Math.log2(f / 40) / Math.log2(Math.max(1.01, sr * 0.5 / 40)) * logBands.length)));
        logBands[band] += power;
      }
      if (f < 55 || f > 4000) continue;
      const tonalPower = power * harmonicMask[bin];
      if (tonalPower <= 0) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += tonalPower;
    }
    chromaFeatures.push(normalizeVector(chroma));
    centroidCurve[bar] = spectralMass > 1e-12 ? weightedHz / spectralMass : 0;
    percussiveCurve[bar] = spectralMass > 1e-12 ? percussiveMass / spectralMass : 0;

    for (let band = 0; band < logBands.length; band++) logBands[band] = Math.log1p(logBands[band]);
    const cepstrum = new Float32Array(6);
    for (let coefficient = 1; coefficient <= cepstrum.length; coefficient++) {
      for (let band = 0; band < logBands.length; band++) {
        cepstrum[coefficient - 1] += logBands[band]
          * Math.cos(Math.PI * coefficient * (band + 0.5) / logBands.length);
      }
    }
    timbreFeatures.push(cepstrum);
  }
  const structureFeatures = buildStructureFeatures(chromaFeatures, timbreFeatures, percussiveCurve);
  return { chromaFeatures, structureFeatures, centroidCurve, percussiveCurve };
}

function sectionRepetition(features, start, end) {
  let total = 0, count = 0;
  for (let i = start; i < end; i++) {
    let best = 0;
    for (let j = 0; j < features.length; j++) {
      if (Math.abs(i - j) < 4) continue;
      let dot = 0;
      for (let k = 0; k < features[i].length; k++) dot += features[i][k] * features[j][k];
      best = Math.max(best, dot);
    }
    total += best; count++;
  }
  return count ? clamp01(total / count) : 0;
}

/** 無音パディングと長い曲中無音を、絶対値と曲内ピークに対する相対値の両方で検出する。 */
export function analyzeSilence(buffer, sharedMono = null) {
  const mono = sharedMono || mixMono(buffer);
  const sr = buffer.sampleRate;
  const frameSamples = Math.max(1, Math.round(sr * 0.05));
  const rms = [];
  let peak = 0;
  for (let start = 0; start < mono.length; start += frameSamples) {
    let sum = 0, count = 0;
    for (let i = start; i < Math.min(mono.length, start + frameSamples); i += 2) {
      sum += mono[i] * mono[i]; count++;
    }
    const value = Math.sqrt(sum / Math.max(1, count));
    rms.push(value); peak = Math.max(peak, value);
  }
  // -54 dBFSを下限にしつつ、最大50ms RMSより36dB以上低い区間だけを無音扱いする。
  const threshold = Math.max(0.002, peak * Math.pow(10, -36 / 20));
  let first = rms.findIndex((value) => value >= threshold);
  let last = rms.length - 1;
  while (last >= 0 && rms[last] < threshold) last--;
  if (first < 0) { first = 0; last = 0; }
  const ranges = [];
  let silentStart = null;
  for (let i = first; i <= last + 1; i++) {
    const silent = i <= last && rms[i] < threshold;
    if (silent && silentStart == null) silentStart = i;
    if (!silent && silentStart != null) {
      const duration = (i - silentStart) * frameSamples / sr;
      if (duration >= 0.35) ranges.push({
        start: Math.round((silentStart * frameSamples / sr) * 1000) / 1000,
        end: Math.round((i * frameSamples / sr) * 1000) / 1000,
      });
      silentStart = null;
    }
  }
  return {
    audibleStart: Math.max(0, Math.round((first * frameSamples / sr - 0.05) * 1000) / 1000),
    audibleEnd: Math.min(buffer.duration, Math.round(((last + 1) * frameSamples / sr + 0.05) * 1000) / 1000),
    silenceRanges: ranges,
    threshold: Math.round(threshold * 100000) / 100000,
  };
}

export function snapStructureBoundary(index, length, gridBars = 1) {
  if (!(length > 1) || index <= 0) return 0;
  const maxBoundary = Math.floor((length - 1) / gridBars) * gridBars;
  return Math.max(gridBars, Math.min(maxBoundary, Math.round(index / gridBars) * gridBars));
}

function selectStructureBoundaries(novelty, acousticNovelty) {
  const n = novelty.length;
  if (n <= 4) return { selected: [0], candidates: [], score: novelty };
  const score = novelty.map((v, i) => {
    const cycle = i > 0 && i % 16 === 0 ? 0.1 : i > 0 && i % 8 === 0 ? 0.07 : i > 0 && i % 4 === 0 ? 0.05 : 0;
    return clamp01(v * 0.76 + (acousticNovelty[i] || 0) * 0.18 + cycle);
  });
  const mean = score.reduce((a, b) => a + b, 0) / n;
  const variance = score.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const threshold = Math.max(0.2, mean + Math.sqrt(variance) * 0.45);
  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    if (score[i] < threshold && (acousticNovelty[i] || 0) < 0.45) continue;
    if (score[i] < score[i - 1] || score[i] < score[i + 1]) continue;
    const snapped = snapStructureBoundary(i, n);
    if (snapped > 0 && !candidates.includes(snapped)) candidates.push(snapped);
  }
  const boundaryStrength = (i) => Math.max(score[i - 1] || 0, score[i] || 0, score[i + 1] || 0);
  candidates.sort((a, b) => boundaryStrength(b) - boundaryStrength(a));
  
  // Soft Duration Prior による動的境界選択
  // ハード的な minDistance=4 を廃止し、選択済み境界と 1〜3小節の近接候補は、
  // 境界強度（boundaryStrength）が極めて強い場合（> 0.65）のみセクション境界として許可する。
  const selected = [0];
  for (const i of candidates) {
    let minD = Infinity;
    for (const x of selected) {
      const d = Math.abs(x - i);
      if (d < minD) minD = d;
    }
    if (minD >= 4) {
      selected.push(i);
    } else if (minD >= 1 && boundaryStrength(i) > 0.65) {
      selected.push(i);
    }
  }
  selected.sort((a, b) => a - b);

  // 長大区間の補完
  for (let p = 0; p < selected.length; p++) {
    const left = selected[p];
    const right = selected[p + 1] ?? n;
    if (right - left <= 16) continue;
    let best = left + 1;
    for (let i = left + 1; i < right; i++) if (score[i] > score[best]) best = i;
    selected.push(best);
    selected.sort((a, b) => a - b);
    p = -1;
  }
  if (selected.length === 1 && n >= 8) {
    for (let i = 8; i < n; i += 8) selected.push(i);
  }
  return { selected, candidates, score };
}

/* ---------- エナジーカーブ + SSMセクション推定 ---------- */
export function analyzeStructure(buffer, bpm, gridOffset, sharedMono = null) {
  const sr = buffer.sampleRate;
  const mono = sharedMono || mixMono(buffer);
  const spb = 60 / bpm;
  const barSec = spb * 4;
  const nBars = Math.max(1, Math.floor((buffer.duration - gridOffset) / barSec));

  // 小節ごとのRMSを求める。明るさは後段でFFTスペクトル重心から算出する。
  const energyCurve = new Float32Array(nBars);
  for (let bar = 0; bar < nBars; bar++) {
    const s0 = Math.max(1, Math.floor((gridOffset + bar * barSec) * sr));
    const s1 = Math.min(mono.length, Math.floor((gridOffset + (bar + 1) * barSec) * sr));
    let sum = 0, cnt = 0;
    for (let i = s0; i < s1; i += 16) {
      const v = mono[i]; sum += v * v;
      cnt++;
    }
    energyCurve[bar] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  const maxE = Math.max(...energyCurve, 1e-6);
  for (let i = 0; i < nBars; i++) energyCurve[i] /= maxE;

  const {
    chromaFeatures, structureFeatures, centroidCurve, percussiveCurve,
  } = barSpectralFeatures(mono, sr, gridOffset, barSec, nBars);
  const chordSequence = estimateChordSequence(chromaFeatures, gridOffset, barSec);
  const brightCurve = new Float32Array(nBars);
  for (let i = 0; i < nBars; i++) {
    brightCurve[i] = centroidCurve[i] > 0
      ? clamp01(Math.log(centroidCurve[i] / 100) / Math.log(12000 / 100))
      : 0;
  }
  const lagNovelty = computeSsmNovelty(structureFeatures, 2);
  const directNovelty = new Float32Array(nBars);
  let maxDirect = 1e-9;
  for (let i = 1; i < nBars; i++) {
    let distance = 0;
    for (let d = 0; d < structureFeatures[i].length; d++) {
      distance += (structureFeatures[i][d] - structureFeatures[i - 1][d]) ** 2;
    }
    directNovelty[i] = Math.sqrt(distance);
    maxDirect = Math.max(maxDirect, directNovelty[i]);
  }
  const structureNovelty = new Float32Array(nBars);
  for (let i = 0; i < nBars; i++) {
    directNovelty[i] /= maxDirect;
    // Time-lag SSMは反復区間を捉えるが境界前後へ副ピークを作るため、隣接差を主アンカーにする。
    structureNovelty[i] = clamp01(directNovelty[i] * 0.72 + (lagNovelty[i] || 0) * 0.42);
  }
  const acousticNovelty = new Float32Array(nBars);
  for (let i = 1; i < nBars; i++) {
    acousticNovelty[i] = clamp01(Math.abs(energyCurve[i] - energyCurve[i - 1]) * 1.8
      + Math.abs(brightCurve[i] - brightCurve[i - 1]) * 0.65
      + Math.abs(percussiveCurve[i] - percussiveCurve[i - 1]) * 0.55
      + directNovelty[i] * 0.5);
  }
  const { selected: boundaryBars, candidates, score: noveltyScore } = selectStructureBoundaries(
    Array.from(structureNovelty), acousticNovelty
  );
  const localBoundaryValue = (curve, index) => Math.max(
    curve[index - 1] || 0, curve[index] || 0, curve[index + 1] || 0,
  );

  const transitionEvents = [];
  // candidates にあるが boundaryBars (selected) に選ばれなかった小節、
  // および selected の中で間隔が 1〜3小節の短い部分を transitionEvent として抽出
  const unselectedCandidates = candidates.filter((c) => !boundaryBars.includes(c));
  
  for (const bar of unselectedCandidates) {
    const time = gridOffset + bar * barSec;
    const prevE = energyCurve[bar - 1] ?? 0;
    const currE = energyCurve[bar] ?? 0;
    let kind = 'fill';
    if (currE < prevE * 0.5) {
      kind = 'stop';
    } else if (acousticNovelty[bar] > 0.4) {
      kind = 'riser';
    }
    transitionEvents.push({
      startBeat: bar * 4,
      endBeat: (bar + 1) * 4,
      time: time,
      kind,
      confidence: Math.round(noveltyScore[bar] * 100) / 100
    });
  }

  const segments = boundaryBars.map((start, i) => {
    const end = boundaryBars[i + 1] ?? nBars;
    let energy = 0, bright = 0, centroid = 0, percussive = 0;
    for (let bar = start; bar < end; bar++) {
      energy += energyCurve[bar]; bright += brightCurve[bar]; centroid += centroidCurve[bar];
      percussive += percussiveCurve[bar];
    }
    const count = Math.max(1, end - start);
    return {
      start, end,
      energy: energy / count,
      bright: bright / count,
      centroid: centroid / count,
      percussive: percussive / count,
      repetition: sectionRepetition(chromaFeatures, start, end),
    };
  });
  const meanE = segments.reduce((a, s) => a + s.energy, 0) / Math.max(1, segments.length);
  const maxBlockE = Math.max(...segments.map((s) => s.energy), 1e-6);
  const meanB = segments.reduce((a, s) => a + s.bright, 0) / Math.max(1, segments.length);
  const rawSections = segments.map((segment, i) => {
    const next = segments[i + 1];
    const nextIsPeak = next && next.energy >= maxBlockE * 0.82;
    let label = 'verse';
    if (i === 0 && segment.energy < meanE * 0.92) label = 'intro';
    else if (i === segments.length - 1 && segment.energy < meanE * 0.9) label = 'outro';
    else if (segment.energy >= maxBlockE * 0.84) {
      label = segment.repetition >= 0.52 && segment.bright >= meanB * 0.92 ? 'chorus' : 'drop';
    }
    else if (segment.energy < meanE * 0.62) label = 'break';
    else if (nextIsPeak && next.energy > segment.energy * 1.08) label = 'build';
    const novelty = Math.max(
      localBoundaryValue(structureNovelty, segment.start),
      localBoundaryValue(acousticNovelty, segment.start),
    );
    const peakScore = clamp01((segment.energy - meanE * 0.72) / Math.max(0.15, maxBlockE * 0.28));
    const labelConfidence = label === 'chorus'
      ? clamp01(peakScore * 0.42 + segment.repetition * 0.35 + segment.bright * 0.13 + novelty * 0.1)
      : label === 'drop'
        ? clamp01(peakScore * 0.42 + novelty * 0.23 + segment.percussive * 0.23
          + (1 - segment.repetition) * 0.08 + segment.bright * 0.04)
        : clamp01(0.4 + novelty * 0.3 + Math.abs(segment.energy - meanE) * 0.2);
    return {
      label,
      startBar: segment.start + 1,
      lengthBars: segment.end - segment.start,
      energy: segment.energy,
      bright: segment.bright,
      spectralCentroid: Math.round(segment.centroid),
      repetition: Math.round(segment.repetition * 100) / 100,
      percussiveRatio: Math.round(segment.percussive * 100) / 100,
      confidence: Math.round(labelConfidence * 100) / 100,
      novelty: Math.round(novelty * 100) / 100,
    };
  });
  const sections = [];
  for (const section of rawSections) {
    const prev = sections[sections.length - 1];
    // 同一ラベルでも、境界に強い Novelty がある場合は結合せず独立させる
    const boundaryScore = noveltyScore[section.startBar - 1] || 0;
    if (prev?.label === section.label && boundaryScore < 0.58) {
      const total = prev.lengthBars + section.lengthBars;
      prev.energy = (prev.energy * prev.lengthBars + section.energy * section.lengthBars) / total;
      prev.bright = (prev.bright * prev.lengthBars + section.bright * section.lengthBars) / total;
      prev.spectralCentroid = Math.round((prev.spectralCentroid * prev.lengthBars
        + section.spectralCentroid * section.lengthBars) / total);
      prev.repetition = Math.round(((prev.repetition * prev.lengthBars
        + section.repetition * section.lengthBars) / total) * 100) / 100;
      prev.percussiveRatio = Math.round(((prev.percussiveRatio * prev.lengthBars
        + section.percussiveRatio * section.lengthBars) / total) * 100) / 100;
      prev.confidence = Math.max(prev.confidence, section.confidence);
      prev.lengthBars = total;
      prev.novelty = Math.max(prev.novelty, section.novelty);
    } else {
      sections.push({ ...section });
    }
  }

  const phraseBoundaries = boundaryBars.map((i) => {
    const section = sections.find((s) => s.startBar === i + 1);
    const novelty = clamp01(localBoundaryValue(structureNovelty, i) * 0.8
      + localBoundaryValue(acousticNovelty, i) * 0.2);
    const cycleBonus = i % 32 === 0 ? 0.14 : i % 16 === 0 ? 0.1 : i % 8 === 0 ? 0.06 : i % 4 === 0 ? 0.03 : 0;
    return {
      bar: i + 1,
      time: gridOffset + i * barSec,
      confidence: Math.round(clamp01(0.38 + novelty * 0.48 + cycleBonus) * 100) / 100,
      novelty: Math.round(novelty * 100) / 100,
      kind: section?.label || 'phrase',
      source: 'multi-ssm',
    };
  });

  // ドロップ候補: 直前4小節に対する急上昇、曲内ピーク、解析済みセクション頭を統合。
  // 推定であり確定ラベルではないため confidence を保持して下流で重み付けする。
  const dropCandidates = [];
  for (const boundary of phraseBoundaries) {
    const i = boundary.bar - 1;
    if (i < 4 || i >= nBars) continue;
    let before = 0;
    for (let j = i - 4; j < i; j++) before += energyCurve[j];
    before /= 4;
    const after = energyCurve[i];
    const rise = clamp01((after - before) / 0.35);
    const peak = clamp01((after - meanE * 0.75) / Math.max(0.15, maxBlockE * 0.25));
    const sectionBoost = boundary.kind === 'drop' || boundary.kind === 'chorus' ? 0.25 : 0;
    const confidence = clamp01(rise * 0.48 + peak * 0.25 + boundary.confidence * 0.18 + sectionBoost);
    if (confidence >= 0.45) {
      dropCandidates.push({
        bar: boundary.bar,
        time: boundary.time,
        confidence: Math.round(confidence * 100) / 100,
        energy: Math.round(after * 100) / 100,
      });
    }
  }
  for (const section of sections) {
    if (!['drop', 'chorus'].includes(section.label)) continue;
    if (dropCandidates.some((d) => Math.abs(d.bar - section.startBar) < 4)) continue;
    dropCandidates.push({
      bar: section.startBar,
      time: gridOffset + (section.startBar - 1) * barSec,
      confidence: Math.max(section.label === 'drop' ? 0.58 : 0.54, section.confidence || 0),
      energy: Math.round(section.energy * 100) / 100,
    });
  }
  dropCandidates.sort((a, b) => a.bar - b.bar);

  return {
    energyCurve: Array.from(energyCurve),
    brightCurve: Array.from(brightCurve),
    centroidCurve: Array.from(centroidCurve),
    percussiveCurve: Array.from(percussiveCurve),
    chordSequence,
    structureNovelty: Array.from(structureNovelty),
    sections,
    phraseBoundaries,
    dropCandidates,
    nBars,
    transitionEvents,
  };
}

/* ---------- 波形ピーク計算 (描画用) ---------- */
export function computePeaks(buffer, perSecond) {
  const sr = buffer.sampleRate;
  const bucketLen = Math.floor(sr / perSecond);
  const nBuckets = Math.ceil(buffer.length / bucketLen);
  const peaks = new Float32Array(nBuckets);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  for (let b = 0; b < nBuckets; b++) {
    let max = 0;
    const off = b * bucketLen;
    const lim = Math.min(bucketLen, buffer.length - off);
    for (let i = 0; i < lim; i += 4) {
      const v = Math.abs(ch0[off + i] + ch1[off + i]) * 0.5;
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

/* ---------- ラウドネス解析 (EBU R128風ゲート付き積分RMS) ----------
   曲ごとの音量差を揃えるための正規化ゲインを算出する。
   旧実装のエナジー指標(RMS×4)は多くの実音源で1.0に飽和し、
   自動ゲインマッチが実質無効だった。ここではK特性は省くが、
   絶対/相対ゲートで無音・フェード部を除外した積分ラウドネスを求め、
   基準 -20 dBFS RMS へ揃える倍率を返す。 */
export function analyzeLoudness(buffer) {
  const sr = buffer.sampleRate;
  const frame = Math.floor(0.4 * sr);      // 400msブロック
  const step = Math.max(1, Math.floor(frame / 4)); // 75%オーバーラップ
  const blocks = [];
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let off = 0; off + frame <= buffer.length; off += step) {
    let s = 0, c = 0;
    for (let i = 0; i < frame; i += 4) {
      for (const channel of channels) { const v = channel[off + i]; s += v * v; c++; }
    }
    blocks.push(c ? s / c : 0);
  }
  if (!blocks.length) return { loudness: -23, loudnessRange: 0, normGain: 1, truePeak: -120, samplePeak: -120 };
  const absGate = Math.pow(10, -60 / 10);  // 絶対ゲート -60dB
  let g1 = blocks.filter((b) => b > absGate);
  if (!g1.length) g1 = blocks;
  const mean1 = g1.reduce((a, c) => a + c, 0) / g1.length;
  const relGate = mean1 * Math.pow(10, -10 / 10); // 相対ゲート -10dB
  let g2 = g1.filter((b) => b >= relGate);
  if (!g2.length) g2 = g1;
  const meanSq = g2.reduce((a, c) => a + c, 0) / g2.length;
  const dB = 10 * Math.log10(meanSq + 1e-12); // ≒ RMS dBFS
  const gatedDb = g2.map((v) => 10 * Math.log10(v + 1e-12)).sort((a, b) => a - b);
  const pct = (p) => gatedDb[Math.min(gatedDb.length - 1, Math.floor((gatedDb.length - 1) * p))];
  const loudnessRange = Math.max(0, pct(0.95) - pct(0.1));

  // 4倍相当のCatmull-Rom補間でインターサンプルピークを近似する。
  // 厳密なITU-R BS.1770オーバーサンプラではないが、sample peakだけより
  // クリップ余裕を保守的に評価できる。
  let samplePeak = 0, truePeak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]));
  }
  const interpolationFloor = samplePeak * 0.8;
  for (const channel of channels) {
    for (let i = 1; i < channel.length - 2; i++) {
      const p0 = channel[i - 1], p1 = channel[i], p2 = channel[i + 1], p3 = channel[i + 2];
      if (Math.max(Math.abs(p0), Math.abs(p1), Math.abs(p2), Math.abs(p3)) < interpolationFloor) continue;
      for (const t of TRUE_PEAK_PHASES) {
        const t2 = t * t, t3 = t2 * t;
        const v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
        truePeak = Math.max(truePeak, Math.abs(v));
      }
    }
  }
  truePeak = Math.max(truePeak, samplePeak);
  const samplePeakDb = 20 * Math.log10(samplePeak + 1e-12);
  const truePeakDb = 20 * Math.log10(truePeak + 1e-12);
  const REF = -20;
  const requestedGain = Math.pow(10, (REF - dB) / 20);
  const peakSafeGain = Math.pow(10, (-1 - truePeakDb) / 20); // 正規化後も-1 dBTP以下
  const normGain = Math.max(0.25, Math.min(4, requestedGain, peakSafeGain));
  return {
    loudness: Math.round(dB * 10) / 10,
    loudnessRange: Math.round(loudnessRange * 10) / 10,
    normGain: Math.round(normGain * 1000) / 1000,
    truePeak: Math.round(truePeakDb * 10) / 10,
    samplePeak: Math.round(samplePeakDb * 10) / 10,
    gainLimited: peakSafeGain < requestedGain,
  };
}

/* ---------- トラック総合解析 → Musical State (仕様 §4 TrackState) ---------- */
function trackAnalysisResult({
  buffer, hints, detected, rhythm, key, spectrum, structure, tempoAnalysis, silence, loud,
  peaksOverview, peaksZoom,
}) {
  return {
    loudness: loud.loudness,
    loudnessRange: loud.loudnessRange,
    normGain: loud.normGain,
    truePeak: loud.truePeak,
    samplePeak: loud.samplePeak,
    gainLimited: loud.gainLimited,
    bpm: rhythm.bpm,
    bpmSource: detected ? 'estimated' : 'known',
    bpmConfidence: detected ? Math.round(tempoAnalysis.confidence * 100) / 100 : 1.0,
    gridConfidence: detected ? (rhythm.gridConfidence ?? 0.6) : 1.0,
    gridOffset: rhythm.gridOffset,
    tempoAnalysis,
    beatGrid: tempoAnalysis.beatGrid,
    tempoCandidates: rhythm.alternatives || [],
    tempoSegments: tempoAnalysis.tempoSegments || [],
    stableMixRanges: tempoAnalysis.stableMixRanges || [],
    transitionEvents: structure.transitionEvents || [],
    energy: rhythm.energy,
    key,
    keySource: hints.key ? 'known' : 'estimated',
    keyConfidence: hints.key ? 1.0 : 0.65,
    spectrum,
    sections: structure.sections,
    energyCurve: structure.energyCurve,
    brightCurve: structure.brightCurve,
    centroidCurve: structure.centroidCurve,
    percussiveCurve: structure.percussiveCurve,
    chordSequence: structure.chordSequence,
    structureNovelty: structure.structureNovelty,
    phraseBoundaries: structure.phraseBoundaries,
    dropCandidates: structure.dropCandidates,
    nBars: structure.nBars,
    audibleStart: silence.audibleStart,
    audibleEnd: silence.audibleEnd,
    silenceRanges: silence.silenceRanges,
    duration: buffer.duration,
    peaksOverview,
    peaksZoom,
  };
}

function peakData(buffer) {
  return {
    peaksOverview: computePeaks(buffer, 1000 / buffer.duration > 20 ? 20 : 1000 / buffer.duration),
    peaksZoom: computePeaks(buffer, 200),
  };
}

export function analyzeTrack(buffer, hints = {}) {
  const mono = mixMono(buffer);
  const detected = hints.bpm == null;
  const rhythm = detected
    ? detectBPM(buffer, mono)
    : { bpm: hints.bpm, gridOffset: hints.gridOffset ?? 0, energy: hints.energy ?? 0.7, alternatives: [] };
  const key = hints.key ?? detectKey(buffer, mono);
  const spectrum = analyzeSpectrum(buffer, mono);
  const structure = analyzeStructure(buffer, rhythm.bpm, rhythm.gridOffset, mono);
  const tempoAnalysis = analyzeLocalTempo(buffer, rhythm.bpm, mono, rhythm.gridOffset, rhythm.meter);
  const silence = analyzeSilence(buffer, mono);
  const loud = analyzeLoudness(buffer);
  return trackAnalysisResult({
    buffer, hints, detected, rhythm, key, spectrum, structure, tempoAnalysis, silence, loud,
    ...peakData(buffer),
  });
}

/** 各解析段階の前に描画へ制御を返し、長尺曲でも進捗UIを更新できる非同期版。 */
export async function analyzeTrackWithProgress(buffer, hints = {}, onProgress = null) {
  const stage = async (progress, label, work) => {
    onProgress?.(progress, label);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return work();
  };

  const mono = await stage(0.02, '解析波形を準備', () => mixMono(buffer));
  const detected = hints.bpm == null;
  const rhythm = detected
    ? await stage(0.1, 'BPM / ビートグリッドを解析', () => detectBPM(buffer, mono))
    : { bpm: hints.bpm, gridOffset: hints.gridOffset ?? 0, energy: hints.energy ?? 0.7, alternatives: [] };
  const key = hints.key
    ?? await stage(0.23, 'キー / Camelotを解析', () => detectKey(buffer, mono));
  const spectrum = await stage(0.32, '周波数バランスを解析', () => analyzeSpectrum(buffer, mono));
  const structure = await stage(0.42, '曲構成 / フレーズを解析', () =>
    analyzeStructure(buffer, rhythm.bpm, rhythm.gridOffset, mono));
  const tempoAnalysis = await stage(0.64, 'テンポ変動を解析', () =>
    analyzeLocalTempo(buffer, rhythm.bpm, mono, rhythm.gridOffset, rhythm.meter));
  const silence = await stage(0.75, '無音区間を検出', () => analyzeSilence(buffer, mono));
  const loud = await stage(0.82, 'ラウドネス / True Peakを解析', () => analyzeLoudness(buffer));
  const peaks = await stage(0.93, '表示用波形を作成', () => peakData(buffer));
  onProgress?.(1, '解析完了');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return trackAnalysisResult({
    buffer, hints, detected, rhythm, key, spectrum, structure, tempoAnalysis, silence, loud,
    ...peaks,
  });
}
