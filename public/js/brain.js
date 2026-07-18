// ===== DeckGhost Brain: CUE生成 / 技法選択 / TransitionPlan生成 =====
//
// 仕様の基本原則: 「AIは演奏計画を作る。DSPは決定論的に演奏する。」
// このモジュールは判断のみを行い、音声ノードには一切触れない。
// 出力は TransitionPlan (仕様 §14) — 実行は planner (automix.js) が担う。

import { camelotDistance } from './keyutil.js';
import { TempoMap } from './beat-grid.js';

/** trackのBeatGridからTempoMapを取得。なければnull */
function _tempoMapOf(track) {
  if (!track?.beatGrid) return null;
  try { return new TempoMap(track.beatGrid); } catch { return null; }
}
/** bar番号(1始まり)を秒に変換する汎用ヘルパー */
function barTimeSec(track, bar) {
  const tm = _tempoMapOf(track);
  if (tm) return tm.timeAtBeat(tm.beatAtBar(bar));
  return track.gridOffset + (bar - 1) * (60 / track.bpm) * 4;
}

/* ================= CUE System (仕様 §5) ================= */
// CUEロール: entry / blend / safe / exit / drop / loop / custom

/** Musical State から自動CUE候補を生成する。
 *  現行実装: INTRO MIX-IN / PHRASE START / SAFE OVERLAP / DROP / OUTRO EXIT */
export function generateCues(track) {
  const spb = 60 / track.bpm;
  const barSec = spb * 4;
  const barTime = (bar) => barTimeSec(track, bar); // barは1始まり
  const cues = [];
  let id = 1;
  const push = (bar, role, label, confidence, notes = '') => {
    const time = barTime(bar);
    if (time < 0 || time > track.duration - 2) return;
    cues.push({
      id: `cue_${track.id}_${id++}`,
      time, bar,
      phrase: Math.floor((bar - 1) / 16) + 1,
      role, label,
      source: 'automatic',
      confidence,
      quality: cueQuality(bar, track),
      energy: track.energyCurve?.[bar - 1] ?? null, // その小節のエナジー (技法適性評価用)
      notes,
    });
  };

  // INTRO MIX-IN: 先頭ビート (エントリー)
  push(1, 'entry', 'INTRO MIX-IN', 0.9, '先頭ビート。イントロから重ねる基本エントリー。');

  // セクション解析に基づくCUE生成 (仕様 §2 §6)。
  // 入り: intro/build/chorus/drop/verse(safe)、抜け: chorus末/break/outro。
  const sections = track.sections || [];
  for (let si = 0; si < sections.length; si++) {
    const s = sections[si];
    const startBar = Math.max(1, s.startBar);
    const endBar = s.startBar + s.lengthBars; // 次セクション頭 = このセクションの抜け位置
    const sectionConfidence = s.confidence ?? 0.65;
    switch (s.label) {
      case 'intro':
        if (startBar > 1) push(startBar, 'entry', `INTRO · bar ${startBar}`, 0.75, 'イントロ頭。静かな入り。');
        break;
      case 'build':
        push(startBar, 'blend', `BUILD · bar ${startBar}`, 0.6, '盛り上げ区間。ドロップ直前でFX/エントリー向き。');
        break;
      case 'chorus':
        push(startBar, 'drop', `CHORUS(サビ) · bar ${startBar}`, Math.max(0.55, sectionConfidence),
          `サビ頭。反復性 ${Number(s.repetition || 0).toFixed(2)} / 重心 ${Math.round(s.spectralCentroid || 0)} Hz。`);
        // サビの終わり = 抜けの好位置 (次曲へ)
        push(endBar, 'exit', `CHORUS END · bar ${endBar}`, Math.max(0.52, sectionConfidence * 0.92), 'サビ終わり。抜けの好位置。');
        break;
      case 'drop':
        push(startBar, 'drop', `DROP · bar ${startBar}`, Math.max(0.55, sectionConfidence),
          `ドロップ候補。信頼度 ${sectionConfidence.toFixed(2)} / 打楽器比 ${Number(s.percussiveRatio || 0).toFixed(2)}。`);
        push(endBar, 'exit', `DROP END · bar ${endBar}`, Math.max(0.5, sectionConfidence * 0.9), 'ドロップ終わり。抜けの好位置。');
        break;
      case 'break':
        push(startBar, 'blend', `BREAK · bar ${startBar}`, 0.68, 'ブレイク頭。ロングブレンドの重ね位置。');
        push(startBar, 'exit', `BREAK DROP · bar ${startBar}`, 0.72, 'キックが抜けるブレイク頭。瞬時切替の候補。');
        break;
      case 'outro':
        push(startBar, 'exit', `OUTRO EXIT · bar ${startBar}`, 0.85, 'アウトロ頭。ここからMIXアウト。');
        break;
      case 'verse':
        if (startBar > 1) push(startBar, 'safe', `VERSE · bar ${startBar}`, 0.6, 'ヴァース(安定区間)。重ねても破綻しにくい。');
        break;
    }
  }

  // 変化量ベースで推定した高信頼フレーズ境界。固定16小節境界より先に追加し、
  // セクション変化が実際に観測された位置をBrainの候補へ入れる。
  for (const p of track.phraseBoundaries || []) {
    if (p.bar <= 1 || p.confidence < 0.58) continue;
    if (cues.some((c) => Math.abs(c.bar - p.bar) < 3)) continue;
    const role = ['outro'].includes(p.kind) ? 'exit'
      : ['drop', 'chorus'].includes(p.kind) ? 'drop'
      : ['break', 'build'].includes(p.kind) ? 'blend' : 'safe';
    push(p.bar, role, `PHRASE · bar ${p.bar}`, p.confidence,
      `変化量ベースのフレーズ境界 (${p.kind}, novelty ${p.novelty.toFixed(2)})。`);
  }

  // ドロップ予測をセクション推定とは別系統で追加。重複時は既存CUEの信頼度を上げる。
  for (const d of track.dropCandidates || []) {
    const existing = cues.find((c) => c.role === 'drop' && Math.abs(c.bar - d.bar) < 3);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, d.confidence);
      existing.quality = Math.min(100, existing.quality + Math.round(d.confidence * 10));
    } else if (d.confidence >= 0.55) {
      push(d.bar, 'drop', `DROP PREDICT · bar ${d.bar}`, d.confidence,
        `直前区間からのエネルギー上昇で推定 (energy ${d.energy.toFixed(2)})。`);
    }
  }

  // PHRASE START: 16小節境界 (セクションCUEと重複しないもの)
  for (let bar = 17; bar <= track.nBars - 16; bar += 16) {
    if (!cues.some((c) => Math.abs(c.bar - bar) < 4)) {
      push(bar, 'blend', `PHRASE START · bar ${bar}`, 0.55, '16小節境界。量子化しやすいCUE。');
    }
  }

  // EXIT保険: exitロールが無い場合は終端32小節前に生成
  if (!cues.some((c) => c.role === 'exit')) {
    const bar = Math.max(1, track.nBars - 31);
    push(bar, 'exit', `EXIT · bar ${bar}`, 0.5, '終端32小節前 (フォールバック)。');
  }

  return cues.sort((a, b) => a.time - b.time);
}

/** CUE品質 (仕様 §6): フレーズ/小節境界への整合度 + エナジー適性 */
export function cueQuality(bar, track) {
  let q = 40;
  if ((bar - 1) % 32 === 0) q += 30;       // 32小節境界
  else if ((bar - 1) % 16 === 0) q += 22;  // 16小節境界
  else if ((bar - 1) % 8 === 0) q += 12;
  else if ((bar - 1) % 4 === 0) q += 5;
  const e = track.energyCurve?.[bar - 1];
  if (e != null) q += Math.round((1 - Math.abs(e - 0.6)) * 20); // 中庸エナジーを好む
  return Math.max(0, Math.min(100, q));
}

/* ================= Harmonic / Spectral (仕様 §7, §8) ================= */

export function harmonicRelation(keyA, keyB) {
  const d = camelotDistance(keyA?.camelot, keyB?.camelot);
  const name =
    d === 0 ? 'Perfect Lock'
    : d <= 1 ? (keyA?.camelot?.num === keyB?.camelot?.num ? 'Relative Major/Minor' : 'Energy-safe Adjacent')
    : d <= 2 ? 'Creative Tension'
    : 'Key Clash Risk';
  return { distance: d, name, score: Math.max(0, 1 - d / 4) };
}

/** スペクトル衝突度 (0=衝突なし .. 1=最大)。
 *  「EQミックスで消しきれない濁り」を表す指標。
 *  重要: 低域(LOW)の重なりは Bass Swap / LOWキルで必ず処理されるため、
 *  重み付けを抑える。旧実装は low*2.2 で、通常の低音楽曲同士だと即1.0に
 *  振り切れ、全ペアが「衝突大→ブレンド禁止・スラム推奨」に倒れていた
 *  (実音源5曲で20/20ペアがスラムになる原因だった)。
 *  実際に残るのは中域(MID)の混雑 = 2つのボーカル/リード。ここを主役にする。 */
export function spectralConflict(specA, specB) {
  if (!specA || !specB) return 0.4;
  const low = Math.min(specA.low, specB.low);
  const mid = Math.min(specA.mid, specB.mid);
  const high = Math.min(specA.high, specB.high);
  return Math.min(1, low * 0.45 + mid * 1.0 + high * 0.35);
}

/** CUEの小節位置を、現場で補正された最新BPM/グリッドから秒へ変換する。 */
export function cueTimeForTrack(track, cue) {
  if (!track || !cue) return 0;
  if (Number.isFinite(cue.bar) && track.bpm > 0) {
    return barTimeSec(track, cue.bar);
  }
  return Number.isFinite(cue.time) ? cue.time : 0;
}

/** barTimeSecをautomixからも使えるようにエクスポート */
export { barTimeSec };

function transitionChordScore(fromTrack, toTrack, exitCue, entryCue, lengthBars) {
  const from = fromTrack.chordSequence || [];
  const to = toTrack.chordSequence || [];
  if (!from.length || !to.length) return null;
  let weighted = 0, weight = 0;
  const bars = Math.max(1, Math.min(lengthBars, 16));
  for (let offset = 0; offset < bars; offset++) {
    const a = from[(exitCue.bar - 1) + offset];
    const b = to[(entryCue.bar - 1) + offset];
    if (!a?.camelot || !b?.camelot) continue;
    const confidence = Math.min(a.confidence ?? 0.5, b.confidence ?? 0.5);
    const distance = camelotDistance(a.camelot, b.camelot);
    const compatibility = distance === 0 ? 1 : distance <= 1 ? 0.82 : distance <= 2 ? 0.48 : 0.12;
    weighted += compatibility * confidence;
    weight += confidence;
  }
  return weight > 0.4 ? weighted / weight : null;
}

/* ================= DJ Technique Database (仕様 §9, §10) ================= */
// DSP実行可能な技法のサブセット。automationTemplate は planner が解釈する
// 進行度ベースのテンプレート (p: 0..1)。
// サーバの /api/techniques には知識ベースとして67技法のフルDBがある。
//
// beatSync: true  = 拍同期必須 (長い重ねを作るため、拍がロックできないと破綻する)
// beatSync: false = 拍非依存   (重ね時間が極小 or FXで覆うため、拍がずれても成立する)
// 同期品質 (syncQuality) が低いペアでは非依存技法が自動的に選ばれる。

const PACK_TECHNIQUES = [
  ['mid_swap', 'Mid Swap', 'Mid Swap', 8, 'midswap', true, 44, ['safe', 'blend', 'entry'], { low: 0.5, mid: 0, high: 0.5 }],
  ['high_swap', 'High Swap', 'High Swap', 4, 'highswap', true, 41, ['entry', 'blend', 'safe'], { low: 0.5, mid: 0.5, high: 0 }],
  ['low_initial_cut', 'Low Initial Cut', 'Low Cut Mix', 8, 'lowinitial', true, 48, ['blend', 'safe', 'entry'], { low: 0, mid: 0.5, high: 0.5 }],
  ['high_initial_cut', 'High Initial Cut', 'High Cut Mix', 8, 'highinitial', true, 40, ['entry', 'blend', 'safe'], { low: 0.5, mid: 0.5, high: 0.35 }],
  ['v_curve_fade', 'V-Curve Fade', 'V-Curve', 8, 'vcurve', true, 39, ['safe', 'blend', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['constant_power_fade', 'Constant Power Fade', 'Constant Power', 16, 'constantpower', true, 43, ['safe', 'blend', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['full_range_crossfade', 'Full-Range Crossfade', 'Linear Crossfade', 4, 'fullrange', true, 38, ['safe', 'entry', 'blend'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['quick_mix', 'Quick Mix', 'Quick Mix', 4, 'quickmix', true, 42, ['drop', 'entry', 'blend'], { low: 0, mid: 0.5, high: 0.5 }],
  ['ghost_drop', 'Ghost Drop', 'Silent Drop', 1, 'ghostdrop', false, 37, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['lpf_dissolve', 'LPF Dissolve', 'LPF Sweep', 4, 'lpfdissolve', false, 39, ['entry', 'safe', 'blend'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['reverb_tail', 'Reverb Tail', 'Reverb Tail', 2, 'reverbtail', false, 40, ['entry', 'drop', 'safe'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['beat_repeat_roll', 'Beat Repeat Roll', 'Beat Roll', 1, 'beatrepeat', true, 38, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['double_downbeat', 'Double Downbeat', 'Double Kick', 1, 'doubledown', true, 35, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['flanger_sweep', 'Flanger Sweep', 'Flanger Rise', 2, 'flangersweep', true, 36, ['drop', 'entry', 'blend'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['noise_sweep', 'Noise Sweep', 'Noise Riser', 4, 'noisesweep', true, 38, ['drop', 'entry', 'blend'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['gate_transition', 'Gate Transition', 'Rhythmic Gate', 2, 'gatetransition', true, 39, ['drop', 'entry', 'blend'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['distortion_fade', 'Distortion Fade', 'Distortion Rise', 2, 'distortionfade', false, 34, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['transformer_cut', 'Transformer Cut', 'Transformer', 1, 'transformercut', true, 37, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['snare_drop', 'Snare Drop', 'Snare Cut', 1, 'snaredrop', true, 36, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['break_drop', 'Break Drop', 'Break Cut', 1, 'breakdrop', false, 39, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['free_run_drop', 'Free Run Drop', 'Unsynced Cut', 1, 'freerun', false, 42, ['drop', 'entry'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['intro_to_outro', 'Intro to Outro', 'Long Phrase Mix', 16, 'smooth', true, 42, ['entry', 'blend'], { low: 0, mid: 0.5, high: 0.42 }],
  ['chorus_to_chorus', 'Chorus to Chorus', 'Chorus Cut', 1, 'choruscut', false, 38, ['drop'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['ambient_interlude', 'Ambient Interlude', 'Ambient Reset', 2, 'ambientreset', false, 36, ['entry', 'safe', 'drop'], { low: 0.5, mid: 0.5, high: 0.5 }],
  ['half_double_bpm', 'Half / Double BPM', 'Ratio Sync', 16, 'smooth', true, 43, ['entry', 'blend', 'safe'], { low: 0, mid: 0.5, high: 0.42 }],
  ['semitone_shift', 'Semitone Shift', 'Energy Boost', 8, 'smooth', true, 38, ['entry', 'blend', 'safe'], { low: 0, mid: 0.5, high: 0.42 }],
].map(([id, name, gesture, durationBars, xfCurve, beatSync, baseScore, entryRoles, initialEq]) => ({
  id, name, gesture, durationBars, entryRoles, baseScore,
  fixedDuration: true,
  risk: beatSync ? 0.24 : 0.3,
  beatSync,
  energyEffect: ['ghostdrop', 'reverbtail', 'lpfdissolve'].includes(xfCurve) ? 'reset' : 'smooth',
  fxTail: xfCurve === 'reverbtail' ? 'reverb' : null,
  prefer: (c) => (beatSync && c.syncQuality >= 0.62 ? 8 : 0)
    + (!beatSync && c.syncQuality < 0.58 ? 7 : 0)
    + (id === 'mid_swap' && c.midHeavy ? 12 : 0)
    + (['low_initial_cut', 'quick_mix'].includes(id) && c.conflict >= 0.42 ? 8 : 0)
    + (['ghost_drop', 'beat_repeat_roll', 'flanger_sweep', 'noise_sweep', 'transformer_cut', 'chorus_to_chorus'].includes(id) && c.entryCue?.role === 'drop' ? 10 : 0)
    + (id === 'snare_drop' && c.entryCue?.role === 'drop' ? 12 : 0)
    + (id === 'break_drop' && c.exitCue?.label?.startsWith('BREAK') ? 50 : 0)
    + (id === 'free_run_drop' && c.bpmGap > 0.16 ? 18 : 0)
    + (id === 'intro_to_outro' && c.exitCue?.label?.startsWith('OUTRO') && c.entryCue?.label?.startsWith('INTRO') ? 22 : 0)
    + (id === 'chorus_to_chorus' && c.exitCue?.label?.startsWith('CHORUS') && c.entryCue?.label?.startsWith('CHORUS') ? 28 : 0)
    + (id === 'ambient_interlude' && c.harmonic.distance > 3 && c.bpmGap > 0.12 ? 22 : 0)
    + (id === 'half_double_bpm' && c.halfDouble ? 26 : 0)
    + (id === 'semitone_shift' && c.semitoneUp ? 18 : 0),
  forbid: (c) => (beatSync && c.bpmGap > 0.16 && id !== 'half_double_bpm' ? -20 : 0)
    + (id === 'full_range_crossfade' && c.conflict > 0.55 ? -18 : 0),
  automation: {
    xfCurve,
    initialEq,
    manualIncomingFader: !['quickmix', 'snaredrop', 'breakdrop', 'freerun', 'choruscut'].includes(xfCurve),
    startBeatOffset: xfCurve === 'snaredrop' ? 1 : 0,
    entryBeatOffset: xfCurve === 'snaredrop' ? 1 : 0,
    forceNoSync: xfCurve === 'freerun',
    keyShift: id === 'semitone_shift' ? 1 : 0,
    bassSwapAt: null,
    filterSweep: xfCurve === 'lpfdissolve',
    midDuck: xfCurve === 'midswap',
  },
}));

export const TECHNIQUES = [
  {
    id: 'phrase_blend',
    name: '32-bar Phrase Blend',
    gesture: 'Long EQ Blend',
    durationBars: 8,          // preset で上書き
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 58,
    risk: 0.15,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null, // フェードで自然に抜けるためテールFX不要 (FX過多を避ける)
    // 好条件 / 禁止条件 (仕様 §10 preferred/forbidden conditions)。
    // クリーンな長ブレンドが映えるのは中域が空いていて調性が近いペア。
    prefer: (c) => (c.harmonic.distance <= 1 ? 12 : 0) + (c.conflict < 0.5 ? 10 : 0),
    // 中域が濁るペアは phrase_blend より bass_swap 向き。BPMがマッチ可能なら
    // (ピッチレンジ自動拡大で±16%まで吸収)ブレンド自体は許容する。
    forbid: (c) => (c.conflict > 0.62 ? -22 : 0) + (c.bpmGap > 0.16 ? -18 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.4, 0.6], filterSweep: false, midDuck: false },
  },
  {
    id: 'bass_swap',
    name: 'Progressive Bass Swap',
    gesture: 'Bass Swap',
    durationBars: 4,
    entryRoles: ['safe', 'blend', 'entry'],
    baseScore: 55,
    risk: 0.25,
    beatSync: true,
    energyEffect: 'sustain',
    fxTail: null,
    // ビートマッチ可能で低〜中域が重なるペアの主力技法。
    // 2曲とも低音が厚い(実音源で最も多い)ケースはここへ誘導する。
    prefer: (c) => (c.conflict >= 0.4 ? 16 : 0) + (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality >= 0.5 ? 6 : 0),
    forbid: (c) => (c.bpmGap > 0.16 ? -18 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.45, 0.55], filterSweep: false, midDuck: false },
  },
  {
    id: 'bass_swap_fade',
    name: 'Bass Swap → Fader Out',
    gesture: 'Bass Swap + Volume Fade',
    durationBars: 8,
    entryRoles: ['blend', 'safe', 'entry'],
    baseScore: 54,
    risk: 0.18,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    // 汎用テク: 入りのLOWをキルで重ね、中央でLOWをスワップし、送り出しを
    // チャンネル音量フェーダーで抜く。拍が合い低域が重なる大半のペアで使える。
    // 中高域を削らず音量で素直に消すので、送り出しが痩せず自然に抜ける。
    prefer: (c) => (c.syncQuality >= 0.5 ? 8 : 0) + (c.conflict >= 0.35 ? 8 : 0) + (c.harmonic.distance <= 2 ? 6 : 0),
    forbid: (c) => (c.bpmGap > 0.16 ? -18 : 0),
    automation: { xfCurve: 'bassfade', bassSwapAt: [0.4, 0.6], filterSweep: false, midDuck: false },
  },
  {
    id: 'echo_out_slam',
    name: 'Echo Out + Slam Entry',
    gesture: 'Echo Out',
    durationBars: 1,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 46,
    risk: 0.5,
    beatSync: false, // ECHOで覆ってハードカットするため拍ロック不要
    energyEffect: 'peak',
    fxTail: 'echo',
    // 「そもそもビートを合わせられない/合わせても破綻する」ペアの脱出技法。
    // 発動条件は (a) BPM差が大きくビートマッチ困難, (b) 拍ロックが信頼できない,
    // (c) 深刻なキークラッシュ に限る。
    // ※ 低域スペクトル衝突は発動条件から外した — それは bass_swap が処理する
    //   通常事象であって、スラムの理由ではない (全曲スラム化の主因だった)。
    prefer: (c) => (c.bpmGap > 0.15 ? 22 : 0) + (c.syncQuality < 0.38 ? 18 : 0) + (c.harmonic.distance > 3 ? 10 : 0),
    forbid: (c) => (c.syncQuality > 0.6 ? -14 : 0), // ちゃんと重ねられるなら重ねる
    automation: { xfCurve: 'slam', bassSwapAt: null, filterSweep: false, midDuck: false, echoOut: true },
  },
  {
    id: 'quick_fade',
    name: 'Quick Fade Cut',
    gesture: 'Fade Cut',
    durationBars: 2,
    entryRoles: ['entry', 'drop', 'blend', 'safe'],
    baseScore: 40,
    risk: 0.1,
    beatSync: false, // 重ね時間が極小のため拍ずれが露呈しない安全策
    energyEffect: 'reset',
    fxTail: null,
    // スラムと並ぶ拍非依存技法。連続スラムを避けるため、拍が合わない
    // ペアではスラムと競れる強さにして交互に選ばれるようにする。
    prefer: (c) => (c.syncQuality < 0.4 ? 15 : 0) + (c.bpmGap > 0.15 ? 14 : 0),
    forbid: (c) => (c.syncQuality > 0.7 ? -12 : 0), // 同期できるなら重ねる技法を優先
    automation: { xfCurve: 'fade', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'filter_echo_blend',
    name: 'Filter Echo Blend',
    gesture: 'Filter Kill + Echo',
    durationBars: 4,
    entryRoles: ['blend', 'safe', 'entry'],
    baseScore: 50,
    risk: 0.35,
    beatSync: true,
    energyEffect: 'build',
    fxTail: 'echo',
    prefer: (c) => (c.harmonic.distance > 1 && c.harmonic.distance <= 3 ? 10 : 0) + (c.conflict >= 0.35 && c.conflict <= 0.6 ? 8 : 0),
    forbid: (c) => (c.bpmGap > 0.08 ? -12 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.5, 0.62], filterSweep: true, midDuck: false },
  },
  {
    id: 'reverb_wash_reset',
    name: 'Reverb Wash Reset',
    gesture: 'Reverb Wash',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 43,
    risk: 0.32,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: 'reverb',
    // 拍ロックが弱い、またはキーが少し遠いペアを空間系で曖昧にして安全に入れ替える。
    // Echo Slamより音楽的に柔らかいリセットとして競らせる。
    prefer: (c) => (c.syncQuality < 0.5 ? 12 : 0) + (c.harmonic.distance >= 2 ? 8 : 0) + (c.conflict < 0.7 ? 4 : 0),
    forbid: (c) => (c.syncQuality > 0.75 ? -10 : 0),
    automation: { xfCurve: 'reverbwash', bassSwapAt: null, filterSweep: true, midDuck: false, releaseFx: 'REVERB' },
  },
  {
    id: 'low_kill_drop',
    name: 'Low Kill Drop',
    gesture: 'Low Kill + Drop',
    durationBars: 2,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 47,
    risk: 0.28,
    beatSync: true,
    energyEffect: 'peak',
    fxTail: null,
    // ドロップ頭へ短く押し込む技法。低域だけを先に明け渡し、キック衝突を避ける。
    prefer: (c) => (c.conflict >= 0.45 ? 12 : 0) + (c.syncQuality >= 0.55 ? 10 : 0) + (c.harmonic.distance <= 2 ? 4 : 0),
    forbid: (c) => (c.syncQuality < 0.45 ? -18 : 0) + (c.bpmGap > 0.16 ? -18 : 0),
    automation: { xfCurve: 'lowkill', bassSwapAt: [0.2, 0.38], filterSweep: false, midDuck: false },
  },
  {
    id: 'drop_swap_cut',
    name: 'Drop Swap Cut',
    gesture: 'Drop Cut',
    durationBars: 1,
    entryRoles: ['drop', 'entry'],
    baseScore: 42,
    risk: 0.42,
    beatSync: false,
    energyEffect: 'peak',
    fxTail: null,
    // Echoを使わず、フレーズ終端で次曲のドロップへ切る。FX過多を避けたいピーク向け。
    prefer: (c) => (c.syncQuality < 0.48 ? 10 : 0) + (c.harmonic.distance <= 2 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.75 ? -8 : 0),
    automation: { xfCurve: 'dropcut', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'energy_dip',
    name: 'Energy Dip Reset',
    gesture: 'Energy Dip',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'drop'],
    baseScore: 41,
    risk: 0.22,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: null,
    // 一瞬だけ音量と低域を沈めてから次曲を出す。キー衝突やBPM差の逃げ道として使う。
    prefer: (c) => (c.bpmGap > 0.12 ? 12 : 0) + (c.harmonic.distance > 2 ? 8 : 0) + (c.syncQuality < 0.55 ? 8 : 0),
    forbid: (c) => (c.syncQuality > 0.75 && c.harmonic.distance <= 1 ? -12 : 0),
    automation: { xfCurve: 'energydip', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'vocal_safe_handoff',
    name: 'Vocal Safe Handoff',
    gesture: 'Mid Duck + Echo Tail',
    durationBars: 4,
    entryRoles: ['safe', 'entry', 'blend'],
    baseScore: 48,
    risk: 0.2,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    prefer: (c) => (c.midHeavy ? 16 : 0) + (c.harmonic.distance <= 1 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.65 ? -10 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.4, 0.55], filterSweep: false, midDuck: true },
  },
  {
    id: 'percussion_bridge',
    name: 'Percussion Bridge',
    gesture: 'Percussion Overlay',
    durationBars: 8,
    entryRoles: ['entry', 'blend', 'safe'],
    baseScore: 52,
    risk: 0.18,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    // 中域が混みすぎず、拍が安定しているペアで、次曲のパーカッシブなイントロを長めに重ねる。
    prefer: (c) => (c.syncQuality >= 0.6 ? 10 : 0) + (c.conflict < 0.52 ? 10 : 0) + (c.harmonic.distance <= 2 ? 5 : 0),
    forbid: (c) => (c.conflict > 0.65 ? -16 : 0) + (c.bpmGap > 0.12 ? -10 : 0),
    automation: { xfCurve: 'percussion', bassSwapAt: [0.55, 0.7], filterSweep: false, midDuck: false },
  },
  {
    id: 'filter_sweep',
    name: 'Filter Sweep Exit',
    gesture: 'Filter Sweep',
    durationBars: 4,
    entryRoles: ['blend', 'safe', 'entry'],
    baseScore: 46,
    risk: 0.24,
    beatSync: true,
    energyEffect: 'build',
    fxTail: null,
    prefer: (c) => (c.syncQuality >= 0.55 ? 8 : 0) + (c.conflict >= 0.32 && c.conflict <= 0.62 ? 8 : 0),
    forbid: (c) => (c.bpmGap > 0.12 ? -12 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.48, 0.62], filterSweep: true, midDuck: false },
  },
  {
    id: 'echo_out',
    name: 'Echo Out',
    gesture: 'Echo Out',
    durationBars: 1,
    entryRoles: ['entry', 'drop', 'blend'],
    baseScore: 41,
    risk: 0.35,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: 'echo',
    prefer: (c) => (c.syncQuality < 0.48 ? 12 : 0) + (c.bpmGap > 0.12 ? 10 : 0),
    forbid: (c) => (c.syncQuality > 0.72 ? -12 : 0),
    automation: { xfCurve: 'slam', bassSwapAt: null, filterSweep: false, midDuck: false, echoOut: true },
  },
  {
    id: 'reverb_wash',
    name: 'Reverb Wash',
    gesture: 'Reverb Wash',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 40,
    risk: 0.28,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: 'reverb',
    prefer: (c) => (c.harmonic.distance >= 2 ? 8 : 0) + (c.conflict < 0.62 ? 5 : 0),
    forbid: (c) => (c.syncQuality > 0.8 && c.harmonic.distance <= 1 ? -12 : 0),
    automation: { xfCurve: 'reverbwash', bassSwapAt: null, filterSweep: true, midDuck: false, releaseFx: 'REVERB' },
  },
  {
    id: 'drop_swap',
    name: 'Drop Swap',
    gesture: 'Drop Cut',
    durationBars: 1,
    entryRoles: ['drop', 'entry'],
    baseScore: 39,
    risk: 0.38,
    beatSync: false,
    energyEffect: 'peak',
    fxTail: null,
    prefer: (c) => (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality < 0.55 ? 8 : 0),
    forbid: (c) => (c.conflict > 0.78 ? -10 : 0),
    automation: { xfCurve: 'dropcut', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'double_drop',
    name: 'Double Drop',
    gesture: 'Drop Alignment',
    durationBars: 1,
    entryRoles: ['drop'],
    baseScore: 37,
    risk: 0.55,
    beatSync: true,
    energyEffect: 'peak',
    fxTail: null,
    prefer: (c) => (c.syncQuality >= 0.65 ? 12 : 0) + (c.harmonic.distance <= 1 ? 8 : 0),
    forbid: (c) => (c.syncQuality < 0.6 ? -20 : 0) + (c.harmonic.distance > 2 ? -14 : 0),
    automation: { xfCurve: 'dropcut', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'drum_band_swap',
    name: 'Drum / Bass Band Swap',
    gesture: 'Low-band Ownership Swap',
    durationBars: 4,
    entryRoles: ['entry', 'blend', 'safe'],
    baseScore: 45,
    risk: 0.22,
    beatSync: true,
    energyEffect: 'sustain',
    fxTail: null,
    prefer: (c) => (c.syncQuality >= 0.58 ? 10 : 0) + (c.conflict >= 0.38 ? 8 : 0),
    forbid: (c) => (c.bpmGap > 0.14 ? -14 : 0),
    automation: { xfCurve: 'bassfade', bassSwapAt: [0.35, 0.5], filterSweep: false, midDuck: false },
  },
  {
    id: 'brake',
    name: 'Vinyl Brake',
    gesture: 'Brake Stop',
    durationBars: 1,
    entryRoles: ['entry', 'drop'],
    baseScore: 36,
    risk: 0.42,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: null,
    prefer: (c) => (c.bpmGap > 0.14 ? 10 : 0) + (c.harmonic.distance > 2 ? 6 : 0),
    forbid: (c) => (c.syncQuality > 0.75 && c.harmonic.distance <= 1 ? -10 : 0),
    automation: { xfCurve: 'brake', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'gate_cut',
    name: 'Gate Cut',
    gesture: 'Rhythmic Gate',
    durationBars: 1,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 38,
    risk: 0.34,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: null,
    prefer: (c) => (c.conflict > 0.5 ? 8 : 0) + (c.syncQuality < 0.58 ? 6 : 0),
    forbid: (c) => (c.syncQuality > 0.78 ? -8 : 0),
    automation: { xfCurve: 'gatecut', bassSwapAt: null, filterSweep: false, midDuck: false, releaseFx: 'ROLL' },
  },
  {
    id: 'trans_cut',
    name: 'Trans Cut',
    gesture: 'Beat-synced Cut',
    durationBars: 1,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 37,
    risk: 0.36,
    beatSync: false,
    energyEffect: 'peak',
    fxTail: null,
    prefer: (c) => (c.syncQuality < 0.55 ? 8 : 0) + (c.harmonic.distance <= 2 ? 4 : 0),
    forbid: (c) => (c.syncQuality > 0.78 ? -8 : 0),
    automation: { xfCurve: 'gatecut', bassSwapAt: null, filterSweep: false, midDuck: false, releaseFx: 'ROLL' },
  },
  {
    id: 'delay_throw',
    name: 'Delay Throw',
    gesture: 'Delay Throw',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 40,
    risk: 0.24,
    beatSync: false,
    energyEffect: 'smooth',
    fxTail: 'delay',
    prefer: (c) => (c.harmonic.distance <= 2 ? 6 : 0) + (c.conflict < 0.62 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.78 ? -10 : 0),
    automation: { xfCurve: 'delaythrow', bassSwapAt: null, filterSweep: false, midDuck: false, releaseFx: 'DELAY' },
  },
  {
    id: 'low_kill',
    name: 'Low Kill Drop',
    gesture: 'Low Kill',
    durationBars: 2,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 43,
    risk: 0.24,
    beatSync: true,
    energyEffect: 'peak',
    fxTail: null,
    prefer: (c) => (c.conflict >= 0.45 ? 10 : 0) + (c.syncQuality >= 0.55 ? 8 : 0),
    forbid: (c) => (c.syncQuality < 0.45 ? -16 : 0),
    automation: { xfCurve: 'lowkill', bassSwapAt: [0.18, 0.35], filterSweep: false, midDuck: false },
  },
  {
    id: 'high_pass_tease',
    name: 'High-pass Tease',
    gesture: 'High-pass Tease',
    durationBars: 4,
    entryRoles: ['entry', 'blend', 'safe'],
    baseScore: 42,
    risk: 0.2,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    prefer: (c) => (c.syncQuality >= 0.55 ? 8 : 0) + (c.conflict < 0.58 ? 6 : 0),
    forbid: (c) => (c.bpmGap > 0.14 ? -12 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.5, 0.65], filterSweep: true, midDuck: false },
  },
  {
    id: 'break_to_break',
    name: 'Break-to-Break Blend',
    gesture: 'Break Blend',
    durationBars: 8,
    entryRoles: ['blend', 'safe', 'entry'],
    baseScore: 43,
    risk: 0.14,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    prefer: (c) => (c.conflict < 0.48 ? 10 : 0) + (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality >= 0.55 ? 6 : 0),
    forbid: (c) => (c.bpmGap > 0.14 ? -12 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.55, 0.7], filterSweep: false, midDuck: false },
  },
  {
    id: 'chorus_cut',
    name: 'Chorus Cut',
    gesture: 'Chorus Resolution Cut',
    durationBars: 1,
    entryRoles: ['drop', 'entry'],
    baseScore: 38,
    risk: 0.28,
    beatSync: false,
    energyEffect: 'peak',
    fxTail: null,
    prefer: (c) => (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality < 0.6 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.75 ? -8 : 0),
    automation: { xfCurve: 'dropcut', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'key_lift',
    name: 'Key Lift Transition',
    gesture: 'Harmonic Lift',
    durationBars: 8,
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 40,
    risk: 0.22,
    beatSync: true,
    energyEffect: 'emotional',
    fxTail: null,
    prefer: (c) => (c.harmonic.distance === 1 ? 14 : 0) + (c.syncQuality >= 0.6 ? 8 : 0),
    forbid: (c) => (c.harmonic.distance > 2 ? -18 : 0) + (c.bpmGap > 0.12 ? -10 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.45, 0.6], filterSweep: false, midDuck: false },
  },
  {
    id: 'energy_dip_reset_plus',
    name: 'Energy Dip Reset Plus',
    gesture: 'Energy Dip',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'drop'],
    baseScore: 39,
    risk: 0.2,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: null,
    prefer: (c) => (c.bpmGap > 0.12 ? 10 : 0) + (c.harmonic.distance > 2 ? 8 : 0),
    forbid: (c) => (c.syncQuality > 0.78 && c.harmonic.distance <= 1 ? -10 : 0),
    automation: { xfCurve: 'energydip', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  {
    id: 'percussion_bridge_plus',
    name: 'Percussion Bridge Plus',
    gesture: 'Percussion Overlay',
    durationBars: 8,
    entryRoles: ['entry', 'blend', 'safe'],
    baseScore: 41,
    risk: 0.18,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    prefer: (c) => (c.syncQuality >= 0.6 ? 8 : 0) + (c.conflict < 0.52 ? 8 : 0),
    forbid: (c) => (c.conflict > 0.65 ? -14 : 0),
    automation: { xfCurve: 'percussion', bassSwapAt: [0.6, 0.72], filterSweep: false, midDuck: false },
  },
  {
    id: 'stutter_gate_exit',
    name: 'Stutter Gate Exit',
    gesture: 'Stutter Gate',
    durationBars: 1,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 36,
    risk: 0.38,
    beatSync: false,
    energyEffect: 'reset',
    fxTail: null,
    prefer: (c) => (c.conflict > 0.5 ? 8 : 0) + (c.syncQuality < 0.58 ? 6 : 0),
    forbid: (c) => (c.syncQuality > 0.78 ? -8 : 0),
    automation: { xfCurve: 'gatecut', bassSwapAt: null, filterSweep: false, midDuck: false, releaseFx: 'ROLL' },
  },
  {
    id: 'dub_delay_bridge',
    name: 'Dub Delay Bridge',
    gesture: 'Delay Bridge',
    durationBars: 2,
    entryRoles: ['entry', 'safe', 'blend'],
    baseScore: 38,
    risk: 0.22,
    beatSync: false,
    energyEffect: 'smooth',
    fxTail: 'delay',
    prefer: (c) => (c.harmonic.distance <= 2 ? 6 : 0) + (c.conflict < 0.58 ? 8 : 0),
    forbid: (c) => (c.conflict > 0.75 ? -10 : 0),
    automation: { xfCurve: 'delaythrow', bassSwapAt: null, filterSweep: false, midDuck: false, releaseFx: 'DELAY' },
  },
  {
    id: 'mid_carve_blend',
    name: 'Mid Carve Blend',
    gesture: 'Mid Carve',
    durationBars: 6,
    entryRoles: ['safe', 'entry', 'blend'],
    baseScore: 42,
    risk: 0.18,
    beatSync: true,
    energyEffect: 'smooth',
    fxTail: null,
    prefer: (c) => (c.midHeavy ? 12 : 0) + (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality >= 0.55 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.7 ? -12 : 0),
    automation: { xfCurve: 'smooth', bassSwapAt: [0.45, 0.6], filterSweep: false, midDuck: true },
  },
  {
    id: 'ambient_break_wash',
    name: 'Ambient Break Wash',
    gesture: 'Ambient Wash',
    durationBars: 4,
    entryRoles: ['blend', 'safe', 'entry'],
    baseScore: 37,
    risk: 0.16,
    beatSync: false,
    energyEffect: 'emotional',
    fxTail: 'reverb',
    prefer: (c) => (c.conflict < 0.48 ? 10 : 0) + (c.harmonic.distance <= 2 ? 6 : 0),
    forbid: (c) => (c.conflict > 0.68 ? -12 : 0),
    automation: { xfCurve: 'reverbwash', bassSwapAt: null, filterSweep: true, midDuck: false, releaseFx: 'REVERB' },
  },
  {
    id: 'hook_tease_handoff',
    name: 'Hook Tease Handoff',
    gesture: 'Hook Tease',
    durationBars: 2,
    entryRoles: ['drop', 'entry', 'blend'],
    baseScore: 35,
    risk: 0.36,
    beatSync: false,
    energyEffect: 'build',
    fxTail: null,
    prefer: (c) => (c.harmonic.distance <= 2 ? 6 : 0) + (c.syncQuality < 0.6 ? 4 : 0),
    forbid: (c) => (c.conflict > 0.72 ? -10 : 0),
    automation: { xfCurve: 'dropcut', bassSwapAt: null, filterSweep: false, midDuck: false },
  },
  ...PACK_TECHNIQUES,
];

/* ================= Performance Presets (仕様 §17) ================= */

export const PRESETS = {
  auto: {
    id: 'auto', name: 'AUTO', description: '曲の解析結果だけで技法を選び、技法本来の長さでMIXします',
    durationBarsScale: 1.0, aggressiveness: 0.5, techniqueBias: {}, analysisOnly: true,
  },
  smooth_house: {
    id: 'smooth_house', name: 'Smooth House Blend', description: '長めで滑らかなブレンドを優先します',
    durationBarsScale: 2.0, aggressiveness: 0.2,
    techniqueBias: { phrase_blend: 12, percussion_bridge: 8, break_to_break: 7, key_lift: 6, bass_swap_fade: 6, filter_echo_blend: 4 },
  },
  festival_slam: {
    id: 'festival_slam', name: 'Festival Slam', description: '短いカットやドロップ系を優先します',
    durationBarsScale: 0.5, aggressiveness: 0.9,
    techniqueBias: { echo_out_slam: 18, drop_swap_cut: 12, drop_swap: 10, low_kill_drop: 10, double_drop: 8, gate_cut: 6, bass_swap: 6 },
  },
  vocal_safe: {
    id: 'vocal_safe', name: 'Vocal Safe Handoff', description: 'ボーカル同士の衝突を避ける技法を優先します',
    durationBarsScale: 1.0, aggressiveness: 0.4,
    techniqueBias: { vocal_safe_handoff: 15, mid_carve_blend: 10, reverb_wash_reset: 6, delay_throw: 5, phrase_blend: 5 },
  },
  bass_surgeon: {
    id: 'bass_surgeon', name: 'Bass Swap Surgeon', description: 'LOWの入れ替えを中心に低域を整理します',
    durationBarsScale: 1.0, aggressiveness: 0.5,
    techniqueBias: { bass_swap: 15, bass_swap_fade: 10, low_kill_drop: 8, low_kill: 7, drum_band_swap: 7, filter_echo_blend: 5 },
  },
};

/* ================= Transition Scoring (仕様 §11, §12) ================= */

/**
 * TransitionPlan を生成する。
 * fromState/toState: Musical State (track), context: {preset, history[], liveEffBpm}
 * 候補空間: exitCue × entryCue × technique を評価しベストを返す。
 */
export function planTransition(fromTrack, toTrack, context = {}) {
  const preset = context.preset || PRESETS.auto;
  const history = context.history || [];
  const techniqueHistory = history.map((item) => typeof item === 'string' ? item : item.technique);
  const recentExitProgress = [...history].reverse()
    .map((item) => typeof item === 'object' ? item.exitProgress : null)
    .find(Number.isFinite);
  // 同じ終盤CUEへ収束しないよう、中後半の狙い位置をセット履歴ごとに循環させる。
  // ランダムではなく履歴長で決めるため、同じセット入力なら計画は再現可能。
  const exitTargets = [0.68, 0.78, 0.60, 0.72];
  const desiredExitProgress = exitTargets[history.length % exitTargets.length];

  const harmonic = harmonicRelation(fromTrack.key, toTrack.key);
  const conflict = spectralConflict(fromTrack.spectrum, toTrack.spectrum);
  const bpmGap = Math.abs(fromTrack.bpm - toTrack.bpm) / fromTrack.bpm;
  const tempoRatio = toTrack.bpm / fromTrack.bpm;
  const halfDouble = (tempoRatio >= 1.9 && tempoRatio <= 2.1) || (tempoRatio >= 0.45 && tempoRatio <= 0.55);
  // 拍同期の成立見込み: BPM差の吸収可否 × BPM/グリッド推定の信頼度。
  // 低いペアで拍同期系ブレンドを使うと「拍がずれた下手なミックス」になるため、
  // beatSync:false の技法 (Echo Out + Slam / Quick Fade) へ誘導する。
  const normalizedBpmGap = Math.min(bpmGap,
    Math.abs(fromTrack.bpm * 2 - toTrack.bpm) / (fromTrack.bpm * 2),
    Math.abs(fromTrack.bpm / 2 - toTrack.bpm) / Math.max(1, fromTrack.bpm / 2));
  const bpmFit = normalizedBpmGap <= 0.08 ? 1 : normalizedBpmGap <= 0.16 ? 0.75 : 0.3;
  const gridConf = Math.min(fromTrack.gridConfidence ?? 0.7, toTrack.gridConfidence ?? 0.7);
  const bpmConf = Math.min(fromTrack.bpmConfidence ?? 0.7, toTrack.bpmConfidence ?? 0.7);
  const tempoStability = Math.min(fromTrack.tempoAnalysis?.stability ?? 1, toTrack.tempoAnalysis?.stability ?? 1);
  // グリッド信頼度の重みは低め。位相ずれは実行時のPLL微補正+マイクロスナップ、
  // 最悪でもセーフフェード退避で吸収できるため、技法選択の段階で
  // gridConfの低さ(実音源では0.1〜0.3が普通)を過度に嫌ってスラムへ倒す必要はない。
  // ビートマッチできるか否かを実質決めるのはBPM差とBPM信頼度。
  const syncQuality = bpmFit * (0.2 * gridConf + 0.6 * bpmConf + 0.2 * tempoStability);
  const cond = {
    harmonic, conflict, bpmGap, normalizedBpmGap, tempoRatio, halfDouble, syncQuality, tempoStability,
    midHeavy: (fromTrack.spectrum?.mid ?? 0) > 0.5 || (toTrack.spectrum?.mid ?? 0) > 0.5,
    semitoneUp: fromTrack.key?.root != null && toTrack.key?.root != null
      && (toTrack.key.root - fromTrack.key.root + 12) % 12 === 1,
  };

  const exitCues = (fromTrack.cues || [])
    .filter((c) => c.role === 'exit')
    .map((c) => ({ ...c, time: cueTimeForTrack(fromTrack, c) }));
  const entryCues = (toTrack.cues || [])
    .filter((c) => ['entry', 'safe', 'blend', 'drop'].includes(c.role))
    .map((c) => ({ ...c, time: cueTimeForTrack(toTrack, c) }));
  if (!exitCues.length) exitCues.push(fallbackExitCue(fromTrack));
  if (!entryCues.length) entryCues.push(fallbackEntryCue(toTrack));
  const toBarSec = (60 / toTrack.bpm) * 4; // 概算用—位置上限のフィルタにのみ使用
  const toSpan = Math.max(1, toTrack.duration - toTrack.gridOffset);
  // IN側の通常候補は前半1/3、かつ最大32小節以内。長尺曲で「前半」と判定した
  // 位置が実質中盤になるのを防ぐ。技法に適合する前方CUEが無い場合のみ後方へ戻す。
  const frontEntryLimit = Math.min(
    toTrack.gridOffset + toSpan / 3,
    barTimeSec(toTrack, 33), // 32小節地点をTempoMap対応で算出
  );
  const frontEntryCues = entryCues.filter((cue) => cue.time <= frontEntryLimit);

  let best = null;
  for (const technique of TECHNIQUES) {
    const compatibleFrontEntries = frontEntryCues.filter((cue) => technique.entryRoles.includes(cue.role));
    const techniqueEntryCues = compatibleFrontEntries.length ? compatibleFrontEntries : entryCues;
    for (const exitCue of exitCues) {
      for (const entryCue of techniqueEntryCues) {
        // TransitionScore (仕様 §12)
        let score = technique.baseScore;
        const reasons = [];
        const add = (n, r) => { if (n) { score += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${r}`); } };

        add(Math.round(harmonic.score * 20), `harmonic: ${harmonic.name}`);
        const plannedBars = technique.fixedDuration ? technique.durationBars
          : Math.max(1, Math.round(technique.durationBars * preset.durationBarsScale));
        const chordScore = transitionChordScore(fromTrack, toTrack, exitCue, entryCue, plannedBars);
        if (chordScore != null) {
          const chordWeight = plannedBars >= 8 ? 18 : plannedBars >= 4 ? 12 : 6;
          add(Math.round((chordScore - 0.5) * chordWeight), `overlap chords ${chordScore.toFixed(2)}`);
        }
        add(Math.round((1 - conflict) * 15), `spectral separation ${(1 - conflict).toFixed(2)}`);
        add(Math.round((exitCue.quality + entryCue.quality) / 10), 'cue quality');
        add(technique.entryRoles.indexOf(entryCue.role) === 0 ? 8 : 0, `entry role ${entryCue.role}`);
        add(technique.entryRoles.includes(entryCue.role) ? 0 : -20, 'entry role mismatch');
        // エントリー小節のエナジー適性: ブレンド系は静かな入り、スラム系は熱い入りを好む
        if (entryCue.energy != null) {
          const e = entryCue.energy;
          add(Math.round((technique.automation.xfCurve === 'slam' ? e : 1 - e) * 8), 'entry energy fit');
        }
        // 次曲はなるべく先頭側から使う。サビ直結など技法固有の適性は残しつつ、
        // 同程度の候補ならINTRO/前半CUEを優先するソフト制約にする。
        {
          const span = Math.max(1, toTrack.duration - toTrack.gridOffset);
          const entryFrac = Math.max(0, Math.min(1, (entryCue.time - toTrack.gridOffset) / span));
          add(Math.round((1 - entryFrac) * 20), 'early incoming position');
          if (entryFrac > 0.5) add(-Math.round((entryFrac - 0.5) * 24), 'entry too deep');
        }
        // 拍同期の成立見込みで技法クラスを振り分ける
        if (technique.beatSync) add(Math.round((syncQuality - 0.5) * 30), `beat-sync feasibility ${syncQuality.toFixed(2)}`);
        else if (syncQuality < 0.45) add(12, 'beat-independent (sync unreliable)');
        if (technique.beatSync && tempoStability < 0.55 && technique.durationBars >= 8) {
          add(-14, `variable tempo ${tempoStability.toFixed(2)}`);
        }
        const cueCond = { ...cond, exitCue, entryCue };
        add(technique.prefer(cueCond), 'preferred conditions');
        add(technique.forbid(cueCond), 'forbidden conditions');
        if (!preset.analysisOnly) add(preset.techniqueBias?.[technique.id] || 0, `preset ${preset.name}`);
        // exit位置の適性: この技法の全長ぶんのランウェイ(+余白1小節)が曲末までに
        // 残っているか。遅すぎるexitは _maybeArm でブレンドが短縮され、
        // 「後ろに寄りすぎてすぐ曲が変わる」原因になるため強めに減点して、
        // より前方のexit CUEを選ばせる。逆に前半すぎるexitも軽く減点。
        {
          const exBarSec = (60 / fromTrack.bpm) * 4; // ランウェイ概算用—絶対位置には使わない
          const techBars = technique.fixedDuration ? technique.durationBars
            : Math.max(1, Math.round(technique.durationBars * preset.durationBarsScale));
          const runwayBars = (fromTrack.duration - exitCue.time) / exBarSec;
          if (runwayBars < techBars + 1) add(-Math.round((techBars + 1 - runwayBars) * 6), 'exit too late (runway short)');
          const span = Math.max(1, fromTrack.duration - fromTrack.gridOffset);
          const exitFrac = (exitCue.time - fromTrack.gridOffset) / span;
          if (exitFrac < 0.42) add(-Math.round((0.42 - exitFrac) * 30), 'exit too early');
          // 必要なMIX尺を確保したうえで、中後半の複数ゾーンを履歴順に使い分ける。
          // 「遅いほど加点」は曲末付近へ固定化するため使わない。
          const latestSafeTime = Math.max(fromTrack.gridOffset,
            fromTrack.duration - (techBars + 1) * exBarSec);
          const latestSafeProgress = Math.max(0, Math.min(1,
            (latestSafeTime - fromTrack.gridOffset) / span));
          const exitTarget = Math.min(desiredExitProgress, latestSafeProgress);
          const targetDistance = Math.abs(exitFrac - exitTarget);
          add(Math.round(Math.max(0, 1 - targetDistance / 0.25) * 22),
            `outgoing position target ${exitTarget.toFixed(2)}`);
          if (targetDistance > 0.3) add(-Math.round((targetDistance - 0.3) * 35), 'outside outgoing zone');
          if (exitFrac > 0.9) add(-10 - Math.round((exitFrac - 0.9) * 100), 'extreme late exit');
          if (Number.isFinite(recentExitProgress) && Math.abs(exitFrac - recentExitProgress) < 0.07) {
            add(-14, 'repeated outgoing zone');
          }
        }
        // 同じ切り替えを連続して使わない (仕様 §12 のNovelty)。
        // 直前と同じ技法は強めに減点し、2回連続はさらに重く。
        // ただし基本技(phrase_blend)の適度な反復まで潰さないよう段階的に。
        if (techniqueHistory.length >= 1 && techniqueHistory.at(-1) === technique.id) add(-22, 'same as previous transition');
        if (techniqueHistory.length >= 2 && techniqueHistory.at(-1) === technique.id && techniqueHistory.at(-2) === technique.id) add(-24, 'technique repeated 3x');
        if (!preset.analysisOnly) {
          add(-Math.round(technique.risk * preset.aggressiveness < 0.3 ? technique.risk * 20 : 0), 'risk penalty');
        }

        if (!best || score > best.score) {
          best = { score, technique, exitCue, entryCue, reasons, harmonic, chordScore, conflict, bpmGap };
        }
      }
    }
  }

  const durationBars = best.technique.fixedDuration ? best.technique.durationBars
    : Math.max(1, Math.round(best.technique.durationBars * preset.durationBarsScale));
  const fromSpan = Math.max(1, fromTrack.duration - fromTrack.gridOffset);
  const exitProgress = Math.max(0, Math.min(1,
    (best.exitCue.time - fromTrack.gridOffset) / fromSpan));
  const plan = {
    id: `plan_${Date.now()}`,
    state: 'generated', // generated → queued → armed → executing → completed (仕様 §15)
    fromTrack: fromTrack.name,
    toTrack: toTrack.name,
    exitCue: best.exitCue,
    entryCue: best.entryCue,
    exitProgress: Number(exitProgress.toFixed(3)),
    exitTarget: desiredExitProgress,
    technique: best.technique.id,
    techniqueName: best.technique.name,
    gesture: best.technique.gesture,
    durationBars,
    automation: best.technique.automation,
    fxTail: best.technique.fxTail,
    beatSync: best.technique.beatSync !== false,
    reason: best.reasons.join(' / '),
    scores: {
      total: best.score,
      harmonic: Number(best.harmonic.score.toFixed(2)),
      overlapChords: best.chordScore == null ? null : Number(best.chordScore.toFixed(2)),
      spectral: Number((1 - best.conflict).toFixed(2)),
      sync: Number(syncQuality.toFixed(2)),
      confidence: Math.max(0, Math.min(1, best.score / 100)),
    },
    timeline: buildTimeline(best, durationBars),
    fallbackPlan: { technique: 'phrase_blend', note: '失敗時は単純EQブレンド → Echo Out → フェードへ縮退 (仕様 §29)' },
  };
  return plan;
}

/** Automation Timeline (仕様 §16): 小節単位イベント表現 (表示用) */
function buildTimeline(best, durationBars) {
  const a = best.technique.automation;
  const ev = [];
  const bar = (p) => Math.round(p * durationBars);
  ev.push({ bar: 0, action: a.forceNoSync
    ? 'Deck B → ヘッドホンCUEで準備 / SYNC OFF / 原速で待機'
    : a.manualIncomingFader
      ? 'Deck B → ヘッドホンCUEで準備 / キック同期 / 技法別EQ / フェーダー0で並走'
      : 'Deck B → ヘッドホンCUEで準備 / キック同期 / 技法別EQ / フェーダーUP' });
  if (a.xfCurve === 'slam') {
    if (a.echoOut) ev.push({ bar: 0, action: 'Deck A → ECHO OUT 開始' });
    ev.push({ bar: durationBars, action: a.echoOut
      ? 'クロスフェーダー SLAM / Deck A Dry停止 / ECHO Wetテイルのみ維持'
      : 'クロスフェーダー SLAM / Deck A 停止' });
  } else if (a.xfCurve === 'fade') {
    ev.push({ bar: 0, action: 'Deck B → 自然テンポで起動 (拍同期なし・重ね極小)' });
    ev.push({ bar: Math.max(1, Math.round(durationBars * 0.3)), action: 'Deck A → LOWカット & フェードアウト' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止' });
  } else if (a.xfCurve === 'bassfade') {
    ev.push({ bar: 0, action: 'クロスフェーダーをセンターへ / 入りは LOW キルで重ねる' });
    ev.push({ bar: Math.floor(durationBars * 0.5), action: 'EQ Swap (LOW/HIを入り↔送り出しで入れ替え)' });
    ev.push({ bar: Math.round(durationBars * 0.62), action: 'Deck A → チャンネル音量フェーダーで抜き始め' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止 / テンポを自然速度へ回帰開始' });
  } else if (a.xfCurve === 'reverbwash') {
    ev.push({ bar: 0, action: 'Deck A → REVERB WASH / LOWを落として空間に逃がす' });
    ev.push({ bar: Math.max(1, bar(0.45)), action: 'Deck B → 中高域からフェードイン' });
    ev.push({ bar: durationBars, action: 'Deck A Dry停止 / REVERB Wetテイルのみ自然減衰' });
  } else if (a.xfCurve === 'lowkill') {
    ev.push({ bar: 0, action: 'Deck A → LOW KILL / Deck B LOWを短く受け渡し' });
    ev.push({ bar: Math.max(1, bar(0.35)), action: 'Deck B → ドロップ主導へクロスフェード' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止' });
  } else if (a.xfCurve === 'dropcut') {
    ev.push({ bar: 0, action: 'Deck B → ドロップCUE待機 / Deck Aを保持' });
    ev.push({ bar: durationBars, action: 'クロスフェーダー CUT / Deck A 停止' });
  } else if (a.xfCurve === 'energydip') {
    ev.push({ bar: 0, action: 'Deck A → LOWと音量を一瞬ディップ' });
    ev.push({ bar: Math.max(1, bar(0.55)), action: 'Deck B → ディップ後にフェードイン' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止' });
  } else if (a.xfCurve === 'brake') {
    ev.push({ bar: 0, action: 'Deck A → Vinyl Brake開始 / LOWを先に抜く' });
    ev.push({ bar: Math.max(1, bar(0.55)), action: 'Deck B → ブレーキ下からフェードイン' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止 / 再生速度を復帰' });
  } else if (a.xfCurve === 'gatecut') {
    ev.push({ bar: 0, action: 'Deck A → ROLL/GATEで短く刻む' });
    ev.push({ bar: Math.max(1, bar(0.6)), action: 'Deck B → 終端カットで前に出す' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止 / FX解除' });
  } else if (a.xfCurve === 'delaythrow') {
    ev.push({ bar: 0, action: 'Deck A → DELAY THROW開始 / LOWを整理' });
    ev.push({ bar: Math.max(1, bar(0.5)), action: 'Deck B → DELAYテール下からフェードイン' });
    ev.push({ bar: durationBars, action: 'Deck A Dry停止 / DELAY Wetテイルのみ自然減衰' });
  } else if (a.xfCurve === 'percussion') {
    ev.push({ bar: 0, action: 'Deck B → LOWキルでパーカッションだけを長めに重ねる' });
    ev.push({ bar: Math.floor(durationBars * 0.6), action: 'Bass Swapを遅めに実行 / グルーヴを維持' });
    ev.push({ bar: bar(0.75), action: 'Deck A → フェーダーで自然に抜ける' });
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止 / テンポを自然速度へ回帰開始' });
  } else {
    ev.push({ bar: 0, action: `Deck B → Entry CUE (bar ${best.entryCue.bar}) からMIX IN` });
    if (a.midDuck) ev.push({ bar: bar(0.3), action: 'Deck A → MID ダック (ボーカル保護)' });
    if (a.bassSwapAt) ev.push({ bar: Math.floor(durationBars / 2), action: 'LOW/HIをゆっくり入れ替える' });
    if (a.filterSweep) ev.push({ bar: bar(0.5), action: 'Deck A → COLOR FILTER スイープ開始' });
    ev.push({ bar: bar(0.7), action: 'Deck A → チャンネルフェーダーを0へ下げる' });
    if (best.technique.fxTail === 'echo') {
      ev.push({ bar: bar(0.85), action: 'Deck A → ECHOテールへSend' });
      ev.push({ bar: durationBars, action: 'Deck A Dry停止 / ECHO Wetテイルのみ維持' });
    }
    ev.push({ bar: durationBars, action: '完了 / Deck A 停止 / テンポを自然速度へ回帰開始' });
  }
  return ev;
}

function fallbackExitCue(track) {
  const barSec = (60 / track.bpm) * 4;
  const bar = Math.max(1, Math.floor((track.duration - track.gridOffset) / barSec) - 31);
  return {
    id: 'exit_fb', time: barTimeSec(track, bar), bar,
    role: 'exit', label: 'EXIT (fallback)', source: 'automatic', confidence: 0.4,
    quality: cueQuality(bar, track),
  };
}
function fallbackEntryCue(track) {
  return {
    id: 'entry_fb', time: track.gridOffset, bar: 1,
    role: 'entry', label: 'INTRO MIX-IN (fallback)', source: 'automatic', confidence: 0.5,
    quality: cueQuality(1, track),
  };
}

/* ================= Mix Critic (仕様 §24) ================= */
// Criticは「正解判定器」ではない — リスクと改善案の提示のみ行う

export function criticReport({ history = [], plans = [], tracks = [] }) {
  const good = [];
  const warnings = [];
  const suggestions = [];

  // 技法の反復
  let streak = 1;
  for (let i = 1; i < history.length; i++) {
    streak = history[i].technique === history[i - 1].technique ? streak + 1 : 1;
    if (streak === 3) {
      warnings.push(`技法「${history[i].techniqueName}」が3回連続で使われています。`);
      suggestions.push('Performance Presetを切り替えるか、キューに性格の違う曲を足すと技法が分散します。');
    }
  }
  if (history.length >= 2 && streak < 3) good.push('技法の使い分けに偏りはありません。');

  // OUT位置の反復。技法が違っても毎回ほぼ同じ進行率ではセット全体が単調になる。
  const recentExitPositions = history.slice(-4)
    .map((item) => item.exitProgress)
    .filter(Number.isFinite);
  if (recentExitPositions.length >= 3) {
    const exitRange = Math.max(...recentExitPositions) - Math.min(...recentExitPositions);
    if (exitRange < 0.08) {
      warnings.push('直近のMIX OUT位置が同じ進行帯に集中しています。');
      suggestions.push('曲の構成を保ちながら、OUT位置を中盤・後半・終盤へ分散するとセットに展開が出ます。');
    } else {
      good.push('MIX OUT位置は複数の進行帯に分散しています。');
    }
  }

  // 調性互換の実績
  const clashes = history.filter((h) => h.harmonicScore != null && h.harmonicScore < 0.4);
  if (clashes.length) {
    warnings.push(`${clashes.length}回のトランジションでキー互換が低め (Creative Tension以下) でした。`);
    suggestions.push('Camelot隣接 (±1 / 同番号A↔B) の曲を優先キューに入れると滑らかになります。');
  } else if (history.length) {
    good.push('すべてのトランジションがハーモニック互換の範囲内でした。');
  }

  // FX過多
  const fxHeavy = history.filter((h) => h.technique === 'echo_out_slam');
  if (fxHeavy.length > history.length * 0.5 && history.length >= 3) {
    warnings.push('Echo Out + Slam の比率が高く、FX過多の傾向があります。');
    suggestions.push('Aggressivenessの低いプリセット (Smooth House Blend) を混ぜてください。');
  }

  // 低信頼プラン
  for (const p of plans) {
    if (p.scores?.confidence < 0.45) {
      warnings.push(`プラン「${p.fromTrack} → ${p.toTrack}」の信頼度が低め (${p.scores.confidence})。`);
      suggestions.push('CUE Workbenchで手動CUEを追加すると候補品質が上がります。');
    }
  }

  // ライブラリ多様性
  const bpms = tracks.map((t) => t.bpm);
  if (bpms.length >= 2 && Math.max(...bpms) - Math.min(...bpms) > 20) {
    suggestions.push('BPM差が20を超える曲が混在しています。中間BPMの曲を挟むとセットが安定します。');
  }

  if (!history.length && !plans.length) {
    suggestions.push('まだ演奏履歴がありません。AUTO MIXを実行するとCriticが評価を返します。');
  }
  if (!warnings.length && history.length) good.push('大きなリスクは検出されませんでした。');
  return { good, warnings, suggestions, generatedAt: new Date().toISOString() };
}
