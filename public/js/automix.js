// ===== Performance Planner / Plan Executor (仕様 §13, §15, §16) =====
//
// Brain (brain.js) が生成した TransitionPlan を Plan Queue で管理し、
// 決定論的に実行する。実行中の判断変更は行わない (AIは計画、DSPは演奏)。
//
// Plan states: generated → queued → armed → executing → completed
// 失敗時: fallback (単純EQブレンド → Echo Out → フェード) へ縮退 (仕様 §29)
//
import { camelotDistance } from './keyutil.js';
import { cueTimeForTrack, planTransition, PRESETS, barTimeSec } from './brain.js';
import { applyComposition, DEFAULT_COMPOSITION, normalizeComposition } from './composer.js';
import { kickAlignedEntry } from './beatmatch.js';

const TEMPO_RECENTER_PER_SEC = 0.001; // トランジション後にテンポを自然速度へ戻す速度 (0.1%/s, 体感不可)
const PLL_GAIN = 0.06;                // ビート位相ロックの比例ゲイン
const PLL_MAX_BEND = 0.004;           // 位相補正の最大レート offset (±0.4%)
const PLL_MAX_BEND_EARLY = 0.01;      // 立ち上げ中(p<0.25)は初期グリッド誤差を早く飲み込むため強め
const BAIL_ERR_BEATS = 0.08;          // この位相誤差(≈37ms@128BPM)が続いたらロック不能と判断
const BAIL_HOLD_SEC = 1.5;            // 判断までの持続時間
const BAIL_FADE_SEC = 1.2;            // セーフフェードの長さ
const PREROLL_BEATS = 8;               // 本番前に移動先をミュートで並走させる長さ (2小節)
const PREROLL_COMMIT_LEAD = 0.08;      // entry CUEへ再アンカーする直前の無音マージン
const AUDIO_PREPARE_LEAD_SEC = 30;      // 次曲PCMは切替直前だけデコードして常駐時間を抑える
const MIN_LIVE_BARS = 16;               // ライブになった曲は最低これだけ再生してから次のMIXをアーム
const TAIL_ONLY_FX = new Set(['ECHO', 'DELAY', 'REVERB']);

export function mixStartPosition(live, exitCue, currentPosition) {
  const cueTime = cueTimeForTrack(live.track, exitCue);
  if (cueTime > currentPosition + 0.1 * live.rate) return cueTime;
  return live.nextBoundaryTime(4, 0.1).pos;
}

export class Planner {
  constructor({ decks, mixer, fx, onEvent, prepareTrack = null }) {
    this.decks = decks;
    this.mixer = mixer;
    this.fx = fx;
    this.onEvent = onEvent || (() => {});
    this.prepareTrack = prepareTrack;

    this.enabled = false;
    this.queue = [];              // 次にかける Track[]
    this.history = [];            // 実行済み {technique, techniqueName, harmonicScore}
    this.completedPlans = [];
    this.preset = PRESETS.auto;
    this.composition = { ...DEFAULT_COMPOSITION };

    this.liveSide = null;         // 'A' | 'B'
    this._liveEntryPos = 0;       // 現ライブ曲が鳴り始めたバッファ位置 (最短再生ガード用)
    this.phase = 'idle';          // idle | planned | armed | executing
    this.plan = null;             // 現在の TransitionPlan
    this.exec = null;             // 実行時パラメータ {startWhen, dur, from, to}
    this.suspended = null;        // 手動Pause中のAutoMIX時計/対象デッキ
    this._pendingStartTrack = null;
    this._preparingTracks = new Set();
    this._failedTracks = new WeakSet();

    // AUTO FX (曲の途中で最適なFXを控えめに入れる)
    this.autoFx = false;
    this._fxState = null;         // {offAt, side} 発動中
    this._lastFxTime = -1e9;
    this._fxHistory = [];         // 直近4件を保持し、そのうち2種を次の候補から外す
    this._lastFxBoundary = null;  // 同じセクション境界での再発動防止
    // パフォーマンスMIX (裏デッキのループを重ねる切り替えないMIX)
    this.autoPerf = false;
    this._perf = null;            // 実行中の状態
    this._lastPerfTime = -1e9;
    this._lastPerfSignature = null;
    this._lastPerfSection = null;
    this._activeTailFx = new Set();     // Dryカット後もマスターへ残す独立Wetテイル
  }

  /* ---------- 制御 ---------- */
  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      if (this._pendingStartTrack && !this.queue.includes(this._pendingStartTrack)) {
        this.queue.unshift(this._pendingStartTrack);
      }
      this._pendingStartTrack = null;
      this._cancelPreroll();
      this.phase = 'idle';
      this.plan = null;
      this.exec = null;
      this.suspended = null;
      this._endAutoFx();
      this._endPerf();
    }
    this.onEvent({ type: 'state', enabled: on });
  }

  _needsPreparation(track) {
    return !!(this.prepareTrack && track && !track.buffer);
  }

  _requestPreparation(track, purpose) {
    if (!this._needsPreparation(track) || this._failedTracks.has(track)) return false;
    if (this._preparingTracks.has(track)) return true;
    this._preparingTracks.add(track);
    this.onEvent({ type: 'loading', track, purpose });
    Promise.resolve(this.prepareTrack(track, purpose)).then(() => {
      this.onEvent({ type: 'ready', track, purpose });
    }).catch((error) => {
      this._failedTracks.add(track);
      if (this.plan?._toTrackRef === track && this.phase === 'planned') {
        this.plan = null;
        this.phase = 'idle';
        this.onEvent({ type: 'planstate' });
      }
      this.onEvent({ type: 'loaderror', track, purpose, error });
    }).finally(() => {
      this._preparingTracks.delete(track);
    });
    return true;
  }

  setPreset(id) {
    this.preset = PRESETS[id] || PRESETS.auto;
    // 実行前のプランは新プリセットで再生成
    this._discardPlanned();
    this.onEvent({ type: 'preset', preset: this.preset });
  }

  setComposition(value) {
    this.composition = normalizeComposition(value);
    this._discardPlanned();
    this.onEvent({ type: 'composition', composition: this.composition });
  }

  _discardPlanned() {
    if (this.phase !== 'planned') return;
    const track = this.plan?._toTrackRef;
    if (track && !this.queue.includes(track)) this.queue.unshift(track);
    this.phase = 'idle';
    this.plan = null;
    this.onEvent({ type: 'queue' });
  }

  handleGridChange(track) {
    const live = this.liveSide ? this.decks[this.liveSide] : null;
    const next = this.plan?._toTrackRef;
    if (!this.plan || !next || !live?.track || (track !== live.track && track !== next)) return;
    // 実行開始後はbeatPhase/PLLが最新gridOffsetを毎回参照するため、そのまま追従する。
    if (this.phase === 'executing') return;
    if (this.phase === 'armed') this._cancelPreroll();

    this.plan = applyComposition(planTransition(live.track, next, {
      preset: this.preset,
      history: this.history,
    }), this.composition);
    this.plan.state = 'queued';
    this.plan._toTrackRef = next;
    this.exec = null;
    this.phase = 'planned';
    this.onEvent({ type: 'plan', plan: this.plan, reason: 'grid-change' });
  }

  setAutoFx(on) { this.autoFx = on; if (!on) this._endAutoFx(); this.onEvent({ type: 'autofx', on }); }
  setAutoPerf(on) { this.autoPerf = on; if (!on && this._perf) this._endPerf(); this.onEvent({ type: 'autoperf', on }); }

  addToQueue(track) {
    if (!this.queue.includes(track)) this.queue.push(track);
    this.onEvent({ type: 'queue' });
  }

  clearQueue() { this.queue = []; this.onEvent({ type: 'queue' }); }

  handleManualTransport(side, wasPlaying, isPlaying, now = this.fx?.ctx?.currentTime ?? 0) {
    const ex = this.exec;
    if (this.suspended) {
      if (!isPlaying || !this.suspended.sides.includes(side)) return;
      const pausedFor = Math.max(0, now - this.suspended.at);
      if (this.exec) {
        this.exec.startWhen += pausedFor;
        for (const key of ['preRollStartedAt', 'preRollLastPll', 'lastPll', 'badSince']) {
          if (Number.isFinite(this.exec[key])) this.exec[key] += pausedFor;
        }
        if (Number.isFinite(this.exec.bail?.start)) this.exec.bail.start += pausedFor;
      }
      const restartWhen = now + 0.02;
      for (const resumeSide of this.suspended.resumeSides) {
        const deck = this.decks[resumeSide];
        // Pause中のCUE/ジョグ調整は捨てず、現在の停止位置から両側を同時に再開する。
        deck.play(deck.getPosition(now), restartWhen);
      }
      this.suspended = null;
      this.onEvent({ type: 'msg', text: 'AUTO MIXを同じ拍位置から再開' });
      return;
    }

    if (!(wasPlaying && !isPlaying) || !ex || !['armed', 'executing'].includes(this.phase)) return;
    const sides = [ex.from, ex.to];
    if (!sides.includes(side)) return;
    const resumeSides = sides.filter((deckSide) => deckSide === side || this.decks[deckSide].playing);
    for (const deckSide of resumeSides) {
      if (this.decks[deckSide].playing) this.decks[deckSide].pause();
    }
    this.suspended = {
      at: now,
      sides,
      resumeSides,
    };
    this.onEvent({ type: 'msg', text: 'AUTO MIXを一時停止' });
  }

  /* ---------- AI選曲 (仕様 §13: セット文脈を考慮) ---------- */
  pickNext(current) {
    if (this.queue.length === 0) return null;
    if (!current) return this.queue.shift();
    let bestIdx = 0, bestCost = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const c = this.queue[i];
      const bpmDiff = Math.abs(c.bpm - current.bpm) / current.bpm;
      const keyDist = camelotDistance(c.key?.camelot, current.key?.camelot);
      const energyJump = Math.abs((c.energy ?? 0.5) - (current.energy ?? 0.5));
      const cost =
        (bpmDiff > 0.08 ? 40 * bpmDiff : 25 * bpmDiff) +
        2.0 * keyDist +
        3.0 * energyJump +
        0.05 * i;
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    return this.queue.splice(bestIdx, 1)[0];
  }

  /* ---------- メインループ (毎フレーム) ---------- */
  tick(now) {
    if (!this.enabled) return;
    if (this.suspended) return;
    const live = this.liveSide ? this.decks[this.liveSide] : null;

    if (!live || !live.track) {
      if (this.queue.length || this._pendingStartTrack) this._startFirst();
      return;
    }
    const liveActive = live.playing || (live.scratch && live.scratch.active);
    if (!liveActive && this.phase !== 'executing' && this.phase !== 'armed') {
      // 手動Pauseでは計画を保持する。バッファ終端へ実際に到達した時だけ次曲を開始する。
      const naturalEnd = live.duration > 0 && live.getPosition() >= live.duration - 0.05;
      if (!naturalEnd) return;
      if (this.phase === 'planned' && this._startPlannedDirect()) return;
      if (this.queue.length) this._startFirst();
      return;
    }

    try {
      // パフォーマンスMIX実行中はトランジション計画を進めない
      if (this._perf) { this._tickPerf(now); }
      else if (this.phase === 'idle') this._makePlan(live);
      else if (this.phase === 'planned') this._maybeArm(live, now);
      else if (this.phase === 'armed' || this.phase === 'executing') this._tickExec(now);
      // ブレンド中でなければテンポを自然速度へ緩やかに回帰させる
      if ((this.phase === 'idle' || this.phase === 'planned') && !this._perf) this._tempoRecenter(live, now);
      // AUTO FX / パフォーマンスMIX (トランジションが動いていない時だけ)
      if ((this.phase === 'idle' || this.phase === 'planned')) {
        if (this.autoFx) this._tickAutoFx(live, now);
        if (this.autoPerf && !this._perf) this._maybePerf(live, now);
      }
    } catch (e) {
      console.error('Planner error — falling back:', e);
      this._endAutoFx(); this._endPerf();
      this._fallback(live);
    }
    this._lastTick = now;
  }

  /* ================= AUTO FX (曲の途中で最適なFXを控えめに入れる) =================
     セクション境界(ドロップ/サビ/ブレイクの頭)の少し手前で、文脈に合った
     拍同期FXを0.75〜2小節だけ掛けて自動で戻す。クールダウンで「うざくない」頻度に。 */
  _tickAutoFx(live, now) {
    const fx = this.fx;
    if (this._perf) return;                         // レイヤーMIX中は演出を重ねない
    // 発動中: 終了時刻で自動OFF
    if (this._fxState) {
      if (now >= this._fxState.offAt) this._endAutoFx();
      return;
    }
    if (now - this._lastFxTime < 18) return;          // 連続発動は最低18秒空ける
    if (fx.assignTarget !== 'OFF') return;            // 手動FX使用中は触らない
    const sec = this._sectionAround(live);
    if (!sec) return;
    const pos = live.getPosition(now);
    const spb = 60 / live.effBpm;
    const barSec = spb * 4;
    if (!sec.next || !['build', 'drop', 'chorus', 'break', 'outro'].includes(sec.next.label)) return;
    const boundaryKey = `${live.track.id ?? live.track.name}:${sec.next.startBar}`;
    if (this._lastFxBoundary === boundaryKey) return;
    // 次セクション頭までの残り小節数。セクション種別ごとに仕込み尺を変える。
    const barsToNext = (sec.nextStartTime - pos) / barSec;
    const leadBars = { build: 2, drop: 1, chorus: 1, break: 0.75, outro: 1 }[sec.next.label];
    if (barsToNext > leadBars + 0.25 || barsToNext < 0.12) return;

    // 文脈でFX選択 (直近2回と同じFXは避けて多様性を出す)
    const kind = this._pickAutoFxKind(sec.next.label, sec.next.startBar);
    const beatsByKind = { ROLL: 0.25, CRUSH: 0.5, FILTER: 0.5, LPF: 1, HPF: 1, ECHO: 0.75, DELAY: 0.5, REVERB: 1, PHASER: 2, FLANGER: 2, NOISE: 1 };
    fx.setBpm(live.effBpm);
    fx.setType(kind);
    fx.setBeats(beatsByKind[kind] ?? 0.5);
    const variation = ((sec.next.startBar * 7 + this._fxHistory.length * 3) % 25) / 100;
    fx.setParam(0.4 + variation);
    const toneFilter = ['LPF', 'HPF'].includes(kind);
    const replaceSignal = ['FILTER', 'LPF', 'HPF', 'CRUSH'].includes(kind);
    const spatial = ['ECHO', 'DELAY', 'REVERB'].includes(kind);
    fx.setDepth(toneFilter ? 0.68 + variation * 0.3 : replaceSignal ? 1 : spatial ? 0.42 : 0.48);
    // AutoFXのフィルター/CRUSHはセクション直前の変形用途。未処理Dryを並列で漏らさない。
    fx.setWetOnly(replaceSignal);
    fx.assign(this.liveSide);
    fx.setOn(true);
    this._fxState = { offAt: now + barsToNext * barSec + 0.02, side: this.liveSide };
    this._lastFxTime = now;
    this._lastFxBoundary = boundaryKey;
    this.onEvent({ type: 'msg', text: `AUTO FX: ${kind} → ${sec.next.label}直前` });
  }
  /** 次セクションのラベルに応じた拍同期FXを、直前と重複しないように選ぶ */
  _pickAutoFxKind(nextLabel, seed = 0) {
    const pools = {
      build:  ['ROLL', 'HPF', 'FLANGER', 'NOISE'],
      drop:   ['ROLL', 'LPF', 'HPF', 'CRUSH', 'PHASER'],
      chorus: ['FILTER', 'LPF', 'FLANGER', 'PHASER', 'DELAY'],
      break:  ['ECHO', 'REVERB', 'DELAY', 'LPF'],
      outro:  ['ECHO', 'REVERB', 'LPF', 'DELAY'],
    };
    const pool = pools[nextLabel] || ['ECHO', 'FILTER', 'DELAY', 'REVERB'];
    let choices = pool.filter((kind) => !this._fxHistory.slice(-2).includes(kind));
    if (!choices.length) choices = pool;
    const kind = choices[Math.abs(seed + this._fxHistory.length) % choices.length];
    this._fxHistory.push(kind);
    if (this._fxHistory.length > 4) this._fxHistory.shift();
    return kind;
  }
  _endAutoFx() {
    if (!this._fxState) return;
    this.fx.setOn(false);
    this.fx.assign('OFF');
    this._fxState = null;
  }

  /* ================= パフォーマンスMIX (切り替えないMIX) =================
     ブレイク/ヴァース区間で、キュー候補のフックを1〜2小節ループで
     ライブtrackの上に一時的に重ねる(トラックは切り替わらない)。
     多用しないようクールダウンとセクション単位の発動ロックを持つ。 */
  _maybePerf(live, now) {
    if (now - this._lastPerfTime < 75) return;
    if (!this.queue.length || this.phase !== 'idle' || this._fxState) return;
    const otherSide = this.liveSide === 'A' ? 'B' : 'A';
    if (this.decks[otherSide].playing) return;     // 手動で鳴らしている裏デッキを上書きしない
    const sa = this._sectionAround(live);
    // 静かめの区間(ブレイク/ヴァース)の頭付近で重ねるのが音楽的
    if (!sa || !sa.cur || !['break', 'verse'].includes(sa.cur.label) || live.bpm <= 0) return;
    const spb = 60 / live.bpm, barSec = spb * 4;
    const pos = live.getPosition(now);
    const sectionKey = `${live.track.id ?? live.track.name}:${sa.cur.startBar}`;
    if (this._lastPerfSection === sectionKey) return;
    const intoSection = (pos - sa.curStartTime) / barSec;
    const remainingBars = (sa.curEndTime - pos) / barSec;
    if (intoSection < 0.05 || intoSection > 1.0 || remainingBars < 0.8) return;
    const layer = this._pickPerformanceLayer(live, sa.cur.label);
    if (!layer) return;
    if (this._needsPreparation(layer.track)) {
      // 切替用の次曲PCMが既に準備済みなら、別候補の追加デコードで3曲常駐させない。
      if (this.plan?._toTrackRef?.buffer) return;
      this._requestPreparation(layer.track, 'パフォーマンスMIX準備');
      return;
    }
    this._startPerf(live, now, sa, layer, remainingBars);
    this._lastPerfSection = sectionKey;
  }

  _pickPerformanceLayer(live, liveSection) {
    let best = null;
    const candidates = [this.plan?._toTrackRef, ...this.queue].filter((track, index, all) =>
      track && all.indexOf(track) === index).slice(0, 3);
    for (const [queueIndex, track] of candidates.entries()) {
      const bpmGap = Math.abs(track.bpm - live.bpm) / Math.max(1, live.bpm);
      if (bpmGap > 0.12) continue;
      const roles = liveSection === 'break' ? ['drop', 'blend', 'entry'] : ['blend', 'entry', 'safe'];
      const cues = (track.cues || []).filter((cue) => roles.includes(cue.role));
      if (!cues.length) continue;
      const cue = [...cues].sort((a, b) => {
        if (liveSection === 'break') return (b.energy || 0) - (a.energy || 0);
        return Math.abs((a.energy ?? 0.5) - 0.55) - Math.abs((b.energy ?? 0.5) - 0.55);
      })[0];
      const signature = `${track.id ?? track.name}:${cue.bar ?? cue.time}`;
      const keyDistance = camelotDistance(track.key?.camelot, live.track.key?.camelot);
      const roleBonus = cue.role === roles[0] ? 8 : cue.role === roles[1] ? 4 : 0;
      const repeated = signature === this._lastPerfSignature ? 18 : 0;
      const score = (1 - bpmGap / 0.12) * 30 - Math.min(4, keyDistance) * 3
        + roleBonus - queueIndex * 2 - repeated;
      if (!best || score > best.score) best = { track, cue, signature, score };
    }
    return best;
  }

  _startPerf(live, now, section, layer, remainingBars) {
    const otherSide = this.liveSide === 'A' ? 'B' : 'A';
    const other = this.decks[otherSide];
    const peek = layer.track;                      // キューは消費しない(あくまで一時レイヤ)
    other.load(peek);
    other.syncTo(live);
    other.autoPitch = true;
    const loopStart = cueTimeForTrack(peek, layer.cue);
    const spb = 60 / peek.bpm;
    const mode = section.cur.label === 'break' ? 'drop-tease' : 'rhythm-layer';
    const holdBars = remainingBars >= 5.25 ? 4 : remainingBars >= 2.5 ? 2 : 0.5;
    const loopBeats = holdBars < 1 ? 2 : mode === 'drop-tease' ? 8 : 4;
    other.loop = { start: loopStart, end: Math.min(other.duration - 0.01, loopStart + loopBeats * spb), beats: loopBeats };
    const { when } = live.nextBoundaryTime(holdBars < 1 ? 1 : 4, 0.1);
    other.play(loopStart, when);
    const chO = this.mixer.channel(otherSide);
    chO.setEq('low', 0.0);
    chO.setEq('mid', mode === 'drop-tease' ? 0.48 : 0.36);
    chO.setEq('high', mode === 'drop-tease' ? 0.58 : 0.5);
    chO.setFader(0);
    chO.setCue(false);
    const startXf = this.mixer.xf;
    const targetXf = this.liveSide === 'A'
      ? Math.min(0, Math.max(startXf, -0.45))
      : Math.max(0, Math.min(startXf, 0.45));
    this._perf = {
      side: otherSide, live: this.liveSide, startWhen: when, holdBars,
      fadeBars: holdBars >= 4 ? 1 : holdBars >= 2 ? 0.5 : 0.125,
      targetFader: mode === 'drop-tease' ? 0.78 : 0.6,
      startXf, targetXf, mode, done: false,
    };
    this._lastPerfTime = now;
    this._lastPerfSignature = layer.signature;
    this.onEvent({ type: 'msg', text: `パフォーマンスMIX: ${peek.name} / ${mode === 'drop-tease' ? 'ドロップティーズ' : 'リズムレイヤー'}` });
  }

  _tickPerf(now) {
    const p = this._perf;
    if (!p) return;
    if (now < p.startWhen) return;
    const live = this.decks[p.live];
    const spbEff = 60 / live.effBpm;
    const elapsed = now - p.startWhen;
    const holdSec = p.holdBars * 4 * spbEff;
    const fadeSec = p.fadeBars * 4 * spbEff;
    let mix;
    if (elapsed < fadeSec) mix = elapsed / fadeSec;
    else if (elapsed < holdSec - fadeSec) mix = 1;
    else if (elapsed < holdSec) mix = 1 - (elapsed - (holdSec - fadeSec)) / fadeSec;
    else mix = 0;
    mix = smoothstep(mix);
    this.mixer.channel(p.side).setFader(p.targetFader * mix);
    const xf = p.startXf + (p.targetXf - p.startXf) * mix;
    this.mixer.setCrossfader(xf);
    this.onEvent({ type: 'xf', value: this.mixer.xf });
    if (elapsed >= holdSec && !p.done) { p.done = true; this._endPerf(); }
  }

  _endPerf() {
    if (!this._perf) return;
    const p = this._perf;
    const other = this.decks[p.side];
    other.exitLoop();
    other.pause();
    other.autoPitch = false;
    this._resetChannel(p.side);
    this.mixer.setCrossfader(p.startXf);
    this.onEvent({ type: 'xf', value: this.mixer.xf });
    this._perf = null;
    this.onEvent({ type: 'msg', text: 'パフォーマンスMIX終了 — ライブ継続' });
  }

  /** ライブデッキの現在セクションと次セクションを返す */
  _sectionAround(live) {
    const secs = live.track?.sections;
    if (!secs || !secs.length || live.bpm <= 0) return null;
    // trackオブジェクトにbpmが無い場合のフォールバック (deck.bpmゲッターはtrack.bpmを参照)
    const trackWithBpm = live.track.bpm ? live.track : { ...live.track, bpm: live.bpm };
    const startTime = (s) => barTimeSec(trackWithBpm, s.startBar);
    const pos = live.getPosition();
    let cur = null, next = null;
    for (let i = 0; i < secs.length; i++) {
      if (startTime(secs[i]) <= pos + 0.01) { cur = secs[i]; next = secs[i + 1] || null; }
    }
    if (!cur) return null;
    const curStartTime = startTime(cur);
    const curEndTime = next ? startTime(next) : live.duration;
    return { cur, next, curStartTime, curEndTime, nextStartTime: next ? startTime(next) : null };
  }

  /* ---------- テンポ回帰: Plannerが自動で付けたピッチだけを自然速度(±0)へ戻す ----------
     DJがセット中に少しずつテンポを整えるのと同じ。0.1%/sなので体感できない。
     これが無いと自動MIXの延々としたセットで最初の曲のBPMに固定され続けてしまう。
     ただし live.autoPitch (Plannerが最後に自動同期した結果かどうか) を必ず確認する —
     ユーザーが手動でフェーダーを動かす/SYNCボタンを押すと即座に autoPitch=false になり、
     このメソッドは何もしない。手動操作を自動で巻き戻すのは絶対にNG
     (「フェーダーで変えたのに勝手に元に戻る」という不具合の原因だった)。 */
  _tempoRecenter(live, now) {
    if (!live.autoPitch) return;
    if (!live.playing || !live.track || (live.scratch && live.scratch.active)) return;
    const other = this.decks[live.id === 'A' ? 'B' : 'A'];
    if (other.playing) return; // 2曲重なっている間は触らない
    const offset = live.pitch * live.pitchRange;
    if (Math.abs(offset) < 0.0004) {
      if (live.pitch !== 0) { live.synced = false; live.setPitch(0); }
      live.autoPitch = false; // 回帰完了。以後このデッキには触らない
      return;
    }
    // 大きなオフセット(>1.5%)は滑らかに戻すと時間がかかりピッチ感が残る。
    // 4小節(16拍)の区切りで一気に戻せば、区切りが良いため違和感が出ない。
    // 境界に到達するまでは何もせず待ち、境界でスナップする。
    if (Math.abs(offset) > 0.015 && live.bpm > 0) {
      const beats = live.beatAt(live.getPosition(now));
      const boundary = Math.round(beats / 16) * 16;      // 直近の4小節境界
      const boundaryKey = `${live.track.id ?? live.track.name}:${boundary}`;
      if (Math.abs(beats - boundary) < 0.2 && this._lastSnapBoundary !== boundaryKey) {
        this._lastSnapBoundary = boundaryKey;
        live.synced = false;
        live.setPitch(0);
        live.autoPitch = false;
        this.onEvent({ type: 'msg', text: '4小節区切りでテンポを自然速度へ復帰' });
      }
      return; // 境界待ち(グライドしない)
    }
    // 小さなオフセットは体感できない速度(0.1%/s)で滑らかにグライド
    const dt = this._lastTick ? Math.min(0.1, Math.max(0, now - this._lastTick)) : 0.016;
    const step = TEMPO_RECENTER_PER_SEC * dt;
    const next = offset > 0 ? Math.max(0, offset - step) : Math.min(0, offset + step);
    live.synced = false;
    live.setPitch(next / live.pitchRange);
  }

  _startFirst() {
    const track = this._pendingStartTrack || this.pickNext(null);
    if (!track) return;
    this._pendingStartTrack = track;
    if (this._failedTracks.has(track)) {
      this._pendingStartTrack = null;
      this.onEvent({ type: 'queue' });
      return;
    }
    if (this._needsPreparation(track)) {
      this._requestPreparation(track, 'AUTO MIX開始準備');
      return;
    }
    this._pendingStartTrack = null;
    const side = this.liveSide || 'A';
    const deck = this.decks[side];
    deck.load(track);
    deck.play(track.gridOffset || 0);
    this.liveSide = side;
    this._liveEntryPos = track.gridOffset || 0;
    this._resetChannel(side);
    this.mixer.setCrossfader(side === 'A' ? -1 : 1);
    this.phase = 'idle';
    this.onEvent({ type: 'trackstart', side, track });
  }

  _startPlannedDirect() {
    const track = this.plan?._toTrackRef;
    if (!track) return false;
    if (this._needsPreparation(track)) {
      this._requestPreparation(track, 'AUTO MIX次曲準備');
      return true;
    }
    const side = this.liveSide === 'A' ? 'B' : 'A';
    const deck = this.decks[side];
    deck.load(track);
    deck.play(track.gridOffset || 0);
    this.liveSide = side;
    this._liveEntryPos = track.gridOffset || 0;
    this._resetChannel(side);
    this.mixer.setCrossfader(side === 'A' ? -1 : 1);
    this.plan = null;
    this.exec = null;
    this.phase = 'idle';
    this.onEvent({ type: 'trackstart', side, track });
    this.onEvent({ type: 'msg', text: '前曲終端を検知 → 計画済み次曲を先頭から開始' });
    return true;
  }

  /* ---------- 計画: 次曲決定 + TransitionPlan生成 ---------- */
  _makePlan(live) {
    if (!this.queue.length) return;
    const next = this.pickNext(live.track);
    if (!next) return;
    this.plan = applyComposition(planTransition(live.track, next, {
      preset: this.preset,
      history: this.history,
    }), this.composition);
    this.plan.state = 'queued';
    this.plan._toTrackRef = next;
    this.phase = 'planned';
    const targetSide = this.liveSide === 'A' ? 'B' : 'A';
    const staleDeck = this.decks[targetSide];
    // 前トランジションの停止済みPCMを先に外し、次曲デコード時の3曲同居を防ぐ。
    if (staleDeck?.track && staleDeck.track !== next && !staleDeck.playing
      && typeof staleDeck.unload === 'function') {
      staleDeck.unload();
      this.onEvent({ type: 'deckunload', side: targetSide });
    }
    this.onEvent({ type: 'plan', plan: this.plan });
  }

  /* ---------- アーム: exit CUE が近づいたらデッキ準備 & 起動予約 ---------- */
  _maybeArm(live, now) {
    const plan = this.plan;
    if (!plan) return;
    const auto = plan.automation || {};
    const pos = live.getPosition(now);
    const spbEff = 60 / live.effBpm;
    const barBuf = 4 * live.spb(); // バッファ時間軸の1小節

    // 選択済みEXITを最新の手動グリッドで解決する。既に通過している場合だけ
    // 次の小節頭へ退避し、通常時は計画位置を勝手に別フレーズへ動かさない。
    const exitTime = mixStartPosition(live, plan.exitCue, pos);
    // 残り尺に収まるようトランジション長をフィット
    let durBars = Math.max(1, Math.min(
      plan.durationBars,
      Math.floor((live.duration - exitTime - 1) / barBuf)));

    // 2小節プリロール+1小節の準備余白に入った時点で、選択EXITへ予約する。
    const leadBuffer = (PREROLL_BEATS + 4) * live.spb();
    if (this._needsPreparation(plan._toTrackRef)) {
      if (pos >= exitTime - Math.max(AUDIO_PREPARE_LEAD_SEC, leadBuffer + 4)) {
        this._requestPreparation(plan._toTrackRef, 'AUTO MIX次曲準備');
      }
      return;
    }
    if (pos < exitTime - leadBuffer) return;

    // 最短再生ガード: ライブになった直後の曲を即座にMIXアウトしない。
    // 遅い位置でMIXインした曲やEXIT CUEが現在位置より手前に解決した曲では、
    // mixStartPositionが「次の小節」へフォールバックして直後に再MIXが始まって
    // しまう ("MIX後すぐにまたMIX")。ライブ開始位置から最低MIN_LIVE_BARS小節
    // 再生するまではアームしない (曲末に到達する場合は終端処理が引き継ぐ)。
    const barsLive = (pos - this._liveEntryPos) / barBuf;
    if (barsLive < MIN_LIVE_BARS && pos < live.duration - (MIN_LIVE_BARS + 4) * barBuf) return;

    this._endAutoFx(); // トランジションはFXユニットをエコーテールに使うため解放
    const targetSide = this.liveSide === 'A' ? 'B' : 'A';
    const target = this.decks[targetSide];
    target.load(plan._toTrackRef);
    // 拍同期: beatSync技法は必須。非依存技法でも同期品質が十分なら
    // 合わせておく (Slamも拍が合っていた方が締まる)。低品質なら自然テンポで。
    const doSync = !auto.forceNoSync && (plan.beatSync || (plan.scores?.sync ?? 0) >= 0.5);
    if (doSync) target.syncTo(live);
    else target.setPitch(0);
    if (auto.keyShift) Promise.resolve(target.setKeyShift(auto.keyShift)).catch(() => {
      this.onEvent({ type: 'msg', text: 'キーシフトの準備に失敗したため原キーで続行' });
    });
    // Plannerが自動で設定したピッチとしてマーク。テンポ回帰の対象になるのは
    // これだけで、ユーザーの手動フェーダー操作やSYNCボタン押下は対象外。
    target.autoPitch = doSync;

    // 選択したEXIT CUEを本番開始点とし、その2小節前から移動先を
    // チャンネルフェーダー0で並走させる。グリッドだけでなく、両AudioBufferの
    // 拍周辺ピークからキックの実オフセットも推定してentry位置を補正する。
    const startBuf = Math.max(pos, exitTime + (auto.startBeatOffset || 0) * live.spb());
    const when = now + (startBuf - pos) / live.rate;
    const entryCueTime = cueTimeForTrack(target.track, plan.entryCue);
    const kickMatch = doSync
      ? kickAlignedEntry(live.track, startBuf, target.track, entryCueTime, {
        trustFromGrid: !!live.track.gridManual,
        trustToGrid: !!target.track.gridManual,
      })
      : { shift: 0, reliable: false, from: { confidence: 0 }, to: { confidence: 0 } };
    const entryOffset = (auto.entryBeatOffset || 0) * target.spb();
    const entryStart = Math.max(0, Math.min(target.duration - 0.01,
      entryCueTime + entryOffset + kickMatch.shift));

    // 実際の起動位置からの残り尺で最終フィット
    durBars = Math.max(1, Math.min(durBars,
      Math.floor((live.duration - startBuf - 0.5) / barBuf)));
    plan.durationBars = durBars;

    // 入りチャンネル準備: プリロール中は必ずフェーダー0。クロスフェーダー位置に
    // 依存せず無音を保証し、本番境界でだけフェーダーを開く。
    // 音量差はロード時のラウドネス正規化(srcBus normGain)で既に揃っているため、
    // TRIMは基準値に戻すだけでよい(旧実装は飽和したエナジー指標で補正しようとして
    // 実質無効だった)。
    const chT = this.mixer.channel(targetSide);
    chT.setTrim(0.7);
    chT.setEq('low', auto.initialEq?.low ?? 0.0);
    chT.setEq('mid', auto.initialEq?.mid ?? 0.5);
    chT.setEq('high', auto.initialEq?.high ?? 0.42);
    chT.setFader(0);
    chT.setCue(true);
    target.play(entryStart, now + 0.02);

    plan.kickMatch = {
      shiftMs: Math.round(kickMatch.shift * 1000),
      reliable: kickMatch.reliable,
      fromConfidence: kickMatch.from.confidence,
      toConfidence: kickMatch.to.confidence,
      preRollBeats: Math.round(((when - now) / spbEff) * 10) / 10,
    };

    plan.state = 'armed';
    this.exec = {
      startWhen: when,
      fromStart: startBuf,
      durBars,
      dur: durBars * 4 * spbEff,
      from: this.liveSide,
      to: targetSide,
      echoStarted: false,
      done: false,
      lastPll: 0,
      sync: doSync,       // 拍同期して重ねるか
      syncBeatRatio: doSync ? target.effBpm / live.effBpm : 1,
      entryStart,
      kickPhaseShift: doSync ? kickMatch.shift / target.spb() : 0,
      preRollStartedAt: now,
      preRollLastPll: 0,
      preRollSnapped: false,
      preRollCommitted: false,
      entryFaderRaised: false,
      preRollOpened: false,
      snapped: false,     // 開始直後のマイクロスナップ済みか
      badSince: null,     // 位相誤差が閾値超えし続けた開始時刻
      bail: null,         // セーフフェード退避 {start, fromXf}
    };
    this.phase = 'armed';
    this.onEvent({ type: 'transition', plan, side: targetSide });
    this.onEvent({ type: 'preroll', side: targetSide, plan, kickMatch: plan.kickMatch });
  }

  /* ---------- 実行: Automation Timeline を決定論的に演奏 ---------- */
  _tickExec(now) {
    const ex = this.exec;
    const plan = this.plan;
    if (!ex) { this.phase = 'idle'; return; }
    if (now < ex.startWhen) { this._tickPreroll(ex, now); return; }
    if (plan.state !== 'executing') { plan.state = 'executing'; this.phase = 'executing'; this.onEvent({ type: 'planstate', plan }); }

    const p = Math.min(1, (now - ex.startWhen) / ex.dur);
    const fromDeck = this.decks[ex.from];
    const toDeck = this.decks[ex.to];
    const chFrom = this.mixer.channel(ex.from);
    const chTo = this.mixer.channel(ex.to);
    const auto = plan.automation;

    if (!ex.preRollCommitted) {
      toDeck.setBend(1);
      toDeck.play(ex.entryStart, now);
      ex.preRollCommitted = true;
    }
    if (!ex.entryFaderRaised) {
      if (!auto.manualIncomingFader) chTo.setFader(1);
      ex.entryFaderRaised = true;
    }
    if (!ex.preRollOpened) {
      ex.preRollOpened = true;
      chTo.setCue(false);
      this.onEvent({ type: 'preroll-open', side: ex.to, plan });
    }

    if (ex.bail) {
      // ===== セーフフェード退避 (仕様 §29): 拍ロック不能と判断した後の縮退 =====
      // ブレンドを諦め、送り出しをECHOで覆いながら短時間で入れ替える。
      const fp = clamp01((now - ex.bail.start) / BAIL_FADE_SEC);
      const targetXf = ex.to === 'B' ? 1 : -1;
      const xf = ex.bail.fromXf + (targetXf - ex.bail.fromXf) * smoothstep(fp);
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      if (fp >= 1) ex.bailDone = true;
    } else if (auto.xfCurve === 'slam') {
      // Echo Out + Slam Entry: フェーダーは保持し、終端でハードカット
      if (auto.echoOut && !ex.echoStarted) {
        ex.echoStarted = true;
        this._startEchoTail(ex.from, fromDeck.effBpm, 0.7);
      }
    } else if (auto.xfCurve === 'fade') {
      // ===== Quick Fade Cut (拍非依存) =====
      // 重ね時間が極小なので拍がずれていても破綻しない。
      // 低域は早めに送り出しから抜いてキックの濁りを避ける。
      const s = smoothstep(p);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chTo.setEq('high', 0.42 + 0.08 * clamp01(p / 0.3));
      chTo.setEq('low', 0.5); // フェードでは最初からLOWを開けておく
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01((p - 0.2) / 0.3))));
      // 音量フェーダーでも送り出しを抜く (クイックフェードはフェーダー主導が自然)
      chFrom.setFader(1 - 0.8 * smoothstep(clamp01((p - 0.3) / 0.7)));
    } else if (['midswap', 'highswap', 'lowinitial', 'highinitial'].includes(auto.xfCurve)) {
      // 帯域スワップ: 入りをフェーダーで先行合流し、小節頭で指定帯域を交換する。
      const curve = auto.xfCurve;
      const swapAt = curve === 'lowinitial' || curve === 'highinitial' ? 0.5 : 0.48;
      const incomingEnd = curve === 'highswap' ? 0.45 : 0.5;
      const incoming = smoothstep(clamp01(p / incomingEnd));
      chTo.setFader(Math.sqrt(incoming));
      this.mixer.setCrossfader(0);
      this.onEvent({ type: 'xf', value: 0 });
      if (curve === 'midswap') {
        chTo.setEq('mid', p < swapAt ? 0 : 0.5);
        chFrom.setEq('mid', p < swapAt ? 0.5 : 0);
      } else if (curve === 'highswap') {
        chTo.setEq('high', p < swapAt ? 0 : 0.5);
        chFrom.setEq('high', p < swapAt ? 0.5 : 0);
      } else if (curve === 'lowinitial') {
        chTo.setEq('low', p < swapAt ? 0 : 0.5);
        chFrom.setEq('low', p < swapAt ? 0.5 : 0);
      } else {
        const hs = smoothstep(clamp01((p - 0.48) / 0.08));
        chTo.setEq('high', 0.35 + 0.15 * hs);
        chFrom.setEq('high', 0.5 * (1 - hs));
      }
      const fadeStart = curve === 'lowinitial' || curve === 'highinitial' ? 0.625 : 0.55;
      chFrom.setFader(Math.sqrt(1 - smoothstep(clamp01((p - fadeStart) / (1 - fadeStart)))));
      this._pllCorrect(ex, now, p);
    } else if (['vcurve', 'constantpower', 'fullrange'].includes(auto.xfCurve)) {
      // チャンネルフェーダー自体を数式制御するため、XFは中央で固定する。
      this.mixer.setCrossfader(0);
      this.onEvent({ type: 'xf', value: 0 });
      let a;
      let b;
      if (auto.xfCurve === 'constantpower') {
        a = Math.cos(p * Math.PI / 2);
        b = Math.sin(p * Math.PI / 2);
      } else if (auto.xfCurve === 'vcurve') {
        a = p < 0.5 ? 1 - 0.3 * (p / 0.5) : 0.7 * (1 - (p - 0.5) / 0.5);
        b = p < 0.5 ? 0.7 * (p / 0.5) : 0.7 + 0.3 * ((p - 0.5) / 0.5);
      } else {
        a = 1 - p;
        b = p;
      }
      // Channel.setFaderは操作値を二乗するため、平方根を渡して実ゲインをa/bにする。
      chFrom.setFader(Math.sqrt(clamp01(a)));
      chTo.setFader(Math.sqrt(clamp01(b)));
      // フェーダーだけで重ねると中央で両曲の低域が二重になり濁る。フェーダーの
      // 交差に合わせてLOWをスワップし、キックは常にどちらか一方だけが持つようにする
      // (中高域はフルレンジのまま残し、このカーブ本来の音色感は保つ)。
      const swapStart = auto.bassSwapAt?.[0] ?? 0.4;
      const swapEnd = Math.max(swapStart + 0.12, auto.bassSwapAt?.[1] ?? 0.6);
      const swap = smoothstep(clamp01((p - swapStart) / (swapEnd - swapStart)));
      chTo.setEq('low', 0.5 * swap);
      chFrom.setEq('low', 0.5 * (1 - swap));
      chFrom.setEq('mid', 0.5); chFrom.setEq('high', 0.5);
      chTo.setEq('mid', 0.5); chTo.setEq('high', 0.5);
      this._pllCorrect(ex, now, p);
    } else if (auto.xfCurve === 'quickmix') {
      this.mixer.setCrossfader(0);
      this.onEvent({ type: 'xf', value: 0 });
      chTo.setFader(1);
      chTo.setEq('low', 0.5);
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01((p - 0.25) / 0.5))));
      chFrom.setFader(p < 0.94 ? 1 : 0);
      this._pllCorrect(ex, now, p);
    } else if (['snaredrop', 'breakdrop', 'freerun', 'choruscut'].includes(auto.xfCurve)) {
      // 拍/セクション解析で決めた開始点そのものが切替位置。重ねず瞬時に交換する。
      chFrom.setFader(0);
      chTo.setFader(1);
      chTo.setEq('low', 0.5); chTo.setEq('mid', 0.5); chTo.setEq('high', 0.5);
      this.mixer.setCrossfader(ex.to === 'B' ? 1 : -1);
      this.onEvent({ type: 'xf', value: this.mixer.xf });
    } else if (auto.xfCurve === 'ghostdrop') {
      // 1小節の完全無音を作り、次小節頭でBをフルレンジ解放する。
      const silent = p < 0.98;
      chFrom.setFader(0);
      chTo.setFader(p >= 0.98 ? 1 : 0);
      chTo.setEq('low', 0.5); chTo.setEq('mid', 0.5); chTo.setEq('high', 0.5);
      this.mixer.setCrossfader(silent ? 0 : (ex.to === 'B' ? 1 : -1));
      this.onEvent({ type: 'xf', value: this.mixer.xf });
    } else if (auto.xfCurve === 'lpfdissolve') {
      this.mixer.setCrossfader(0);
      this.onEvent({ type: 'xf', value: 0 });
      chTo.setFader(Math.sqrt(smoothstep(p)));
      chTo.setEq('low', 0.5);
      // COLORの負方向はLPF。内部実装は対数周波数なので20kHz→約150Hzを滑らかに掃引する。
      chFrom.setColor(-clamp01(p));
      chFrom.setFader(p < 0.98 ? 1 : 0);
    } else if (['reverbtail', 'beatrepeat', 'flangersweep', 'noisesweep',
      'gatetransition', 'distortionfade', 'transformercut', 'doubledown', 'ambientreset'].includes(auto.xfCurve)) {
      const curve = auto.xfCurve;
      let type = 'REVERB';
      if (curve === 'beatrepeat' || curve === 'doubledown') type = 'ROLL';
      else if (curve === 'flangersweep') type = 'FLANGER';
      else if (curve === 'noisesweep' || curve === 'ambientreset') type = 'NOISE';
      else if (curve === 'gatetransition' || curve === 'transformercut') type = 'GATE';
      else if (curve === 'distortionfade') type = 'DISTORTION';
      const assign = ['noisesweep', 'ambientreset'].includes(curve) ? 'MST' : ex.from;
      const transitionFx = this._automateFx(ex, type, assign, fromDeck.effBpm, curve !== 'doubledown');

      this.mixer.setCrossfader(0);
      this.onEvent({ type: 'xf', value: 0 });
      if (curve === 'reverbtail') {
        transitionFx.setDepth(0.6 * smoothstep(clamp01(p / 0.45)));
        chFrom.setEq('low', p < 0.45 ? 0.5 : 0);
        chFrom.setFader(p < 0.5 ? 1 : 0);
        chTo.setFader(p >= 0.5 ? 1 : 0);
        ex.automationFxTailMs = 8000;
      } else if (curve === 'beatrepeat') {
        const beats = p < 0.25 ? 1 : p < 0.5 ? 0.5 : p < 0.75 ? 0.25 : 0.125;
        transitionFx.setBeats(beats);
        transitionFx.setDepth(0.78);
        // 最初の1拍だけDryでキャプチャし、その後は通常再生を消してループだけを鳴らす。
        transitionFx.setWetOnly(p >= 0.24);
        chFrom.setFader(p < 0.98 ? 1 : 0);
        chTo.setFader(p >= 0.98 ? 1 : 0);
      } else if (curve === 'doubledown') {
        transitionFx.setBeats(0.5);
        if (p > 0.72 && !ex.doubleDownCaptureStarted) {
          ex.doubleDownCaptureStarted = true;
          transitionFx.setOn(true);
        }
        const captured = p > 0.845;
        transitionFx.setDepth(captured ? 0.85 : 0);
        transitionFx.setWetOnly(captured);
        chFrom.setFader(p < 0.98 ? 1 : 0);
        chTo.setFader(p >= 0.98 ? 1 : 0);
      } else if (curve === 'flangersweep') {
        transitionFx.setBeats(p < 0.5 ? 1 : p < 0.75 ? 0.5 : 0.25);
        transitionFx.setParam(clamp01(p));
        transitionFx.setDepth(0.8 * smoothstep(p));
        chFrom.setFader(p < 0.98 ? 1 : 0);
        chTo.setFader(p >= 0.98 ? 1 : 0);
      } else if (curve === 'noisesweep') {
        transitionFx.setParam(clamp01(p));
        transitionFx.setDepth(Math.sin(Math.PI * p) * 0.84);
        chFrom.setFader(Math.sqrt(1 - smoothstep(clamp01((p - 0.45) / 0.55))));
        chTo.setFader(Math.sqrt(smoothstep(clamp01((p - 0.4) / 0.6))));
      } else if (curve === 'ambientreset') {
        transitionFx.setParam(0);
        const bed = p < 0.2 ? smoothstep(p / 0.2) : p < 0.7 ? 1 : 1 - smoothstep((p - 0.7) / 0.3);
        transitionFx.setDepth(0.4 * bed);
        chFrom.setFader(Math.sqrt(1 - smoothstep(clamp01(p / 0.25))));
        chTo.setFader(Math.sqrt(smoothstep(clamp01((p - 0.65) / 0.35))));
      } else if (curve === 'gatetransition') {
        transitionFx.setBeats(0.25);
        transitionFx.setParam(1 - 0.85 * smoothstep(p));
        // Duty比で変化量を作るため、Dryを混ぜずGate処理後の音だけで置換する。
        transitionFx.setDepth(1);
        transitionFx.setWetOnly(true);
        chTo.setFader(Math.sqrt(smoothstep(p)));
        chFrom.setFader(Math.sqrt(1 - smoothstep(clamp01((p - 0.65) / 0.35))));
      } else if (curve === 'distortionfade') {
        // 直列Distortionへ置換し、Wet量ではなくWaveShaperのDriveそのものを上げる。
        transitionFx.setWetOnly(true);
        transitionFx.setDepth(1);
        transitionFx.setParam(0.75 * smoothstep(p));
        chFrom.setFader(p < 0.98 ? 1 : 0);
        chTo.setFader(p >= 0.98 ? 1 : 0);
      } else {
        transitionFx.setBeats(0.0625);
        transitionFx.setParam(0.5);
        transitionFx.setDepth(p > 0.75 ? 1 : 0);
        transitionFx.setWetOnly(p > 0.75);
        chFrom.setFader(p < 0.98 ? 1 : 0);
        chTo.setFader(p >= 0.98 ? 1 : 0);
      }
    } else if (auto.xfCurve === 'composer') {
      const c = auto.composer;
      let s;
      if (p < 0.3) s = smoothstep(p / 0.3) * 0.5;
      else if (p < 0.72) s = 0.5;
      else s = 0.5 + smoothstep((p - 0.72) / 0.28) * 0.5;
      if (c.release === 'cut') s = p < 0.82 ? 0 : smoothstep((p - 0.82) / 0.18);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });

      if (c.intro === 'low_kill') {
        chTo.setEq('low', 0);
        chTo.setEq('high', 0.45 + 0.05 * smoothstep(clamp01(p / 0.3)));
      } else if (c.intro === 'percussion') {
        chTo.setEq('low', 0);
        chTo.setEq('mid', 0.43);
        chTo.setEq('high', 0.54);
      } else {
        chTo.setEq('high', 0.4 + 0.1 * smoothstep(clamp01(p / 0.3)));
      }

      const swap = smoothstep(clamp01((p - 0.42) / 0.16));
      if (c.handoff === 'bass_swap') {
        chTo.setEq('low', swap * 0.5);
        chFrom.setEq('low', 0.5 * (1 - swap));
      } else if (c.handoff === 'filter_sweep') {
        chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.5) / 0.2)));
        chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01((p - 0.42) / 0.2))));
        chFrom.setColor(0.82 * smoothstep(clamp01((p - 0.38) / 0.42)));
      } else {
        const dip = Math.sin(Math.PI * clamp01((p - 0.35) / 0.35));
        chFrom.setFader(1 - 0.55 * dip);
        chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.55) / 0.2)));
      }

      if (p > 0.72 && ['echo', 'reverb', 'delay'].includes(c.release) && !ex.releaseFxStarted) {
        ex.releaseFxStarted = true;
        const type = { echo: 'ECHO', reverb: 'REVERB', delay: 'DELAY' }[c.release];
        this._startReleaseFx(ex.from, fromDeck.effBpm, type, c.release === 'reverb' ? 1 : 0.5, 0.58, 3200);
      }
      if (c.release !== 'cut') chFrom.setFader(1 - 0.9 * smoothstep(clamp01((p - 0.7) / 0.3)));
      this._pllCorrect(ex, now, p);
    } else if (auto.xfCurve === 'bassfade') {
      // ===== Bass Swap → Fader Out (汎用テク) =====
      // ① 入りは LOW キルで重ねる (キック衝突なし。_maybeArm で LOW=0 始まり)
      // ② 中央の小節境界で LOW を入り↔送り出しでスワップ (入り↑ / 送り出し↓)
      // ③ スワップ完了後、送り出しをチャンネル音量フェーダーで 0 まで抜く。
      // クロスフェーダーの帯域カーブに頼らず「低域スワップ + 音量フェード」だけで
      // 抜くため、送り出しの中高域を痩せさせず自然に消える汎用的な手法。
      let s;
      if (p < 0.3) s = smoothstep(p / 0.3) * 0.5;                 // →センター(両曲を鳴らす)
      else if (p < 0.7) s = 0.5;                                  // センター保持でLOWスワップ
      else s = 0.5 + smoothstep((p - 0.7) / 0.3) * 0.5;           // 終盤 入りをフルへ寄せる
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: this.mixer.xf });

      // 入りHIGHを立ち上げ中に暗め→ノーマルへ開く
      chTo.setEq('high', 0.42 + 0.08 * clamp01(p / 0.3));

      // ①②: LOWスワップ (中央の 0.4→0.6 で 1フェーズかけて主導権を移す)
      const swap = smoothstep(clamp01((p - 0.4) / 0.2));
      chTo.setEq('low', swap * 0.5);
      chFrom.setEq('low', 0.5 * (1 - swap));
      chTo.setEq('high', 0.42 + 0.08 * swap);
      chFrom.setEq('high', 0.5 - 0.12 * swap);
      chTo.setFader(1);

      // ③: スワップ後、送り出しを音量フェーダーで抜く (このテクの主役)。
      // 中高域は削らず、フェーダーで素直に音量を落として消す。
      const fo = clamp01((p - 0.62) / 0.38);
      chFrom.setFader(1 - fo);

      // PLL + セーフフェード退避 (拍同期技法のため)
      this._pllCorrect(ex, now, p);
    } else if (auto.xfCurve === 'reverbwash') {
      // ===== Reverb Wash Reset (拍非依存) =====
      // 空間系FXで送り出しの輪郭をぼかし、低域を落としてから次曲を出す。
      if (!ex.releaseFxStarted) {
        ex.releaseFxStarted = true;
        this._startReleaseFx(ex.from, fromDeck.effBpm, 'REVERB', 1, 0.62, 3200);
      }
      const s = smoothstep(p);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01(p / 0.35))));
      chFrom.setEq('mid', 0.5 - 0.18 * smoothstep(clamp01(p / 0.55)));
      chFrom.setColor(0.75 * smoothstep(clamp01(p / 0.75)));
      chFrom.setFader(1 - 0.85 * smoothstep(clamp01((p - 0.2) / 0.75)));
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.35) / 0.45)));
      chTo.setEq('high', 0.38 + 0.12 * smoothstep(clamp01(p / 0.6)));
    } else if (auto.xfCurve === 'lowkill') {
      // ===== Low Kill Drop =====
      // 低域の主導権だけ先に次曲へ渡し、短いクロスでドロップへ接続する。
      const s = smoothstep(p);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01(p / 0.18))));
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.08) / 0.28)));
      chTo.setEq('high', 0.45 + 0.05 * smoothstep(clamp01(p / 0.25)));
      chFrom.setFader(1 - 0.7 * smoothstep(clamp01((p - 0.45) / 0.55)));
      this._pllCorrect(ex, now, p);
    } else if (auto.xfCurve === 'dropcut') {
      // ===== Drop Swap Cut (拍非依存) =====
      // 終端までライブを保持し、最後の瞬間だけ等パワーで切る。FX過多を避けるピーク用。
      const cut = smoothstep(clamp01((p - 0.72) / 0.28));
      const xf = ex.to === 'B' ? -1 + 2 * cut : 1 - 2 * cut;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chTo.setEq('low', 0.5);
      chTo.setEq('high', 0.5);
      chFrom.setFader(1 - 0.2 * cut);
    } else if (auto.xfCurve === 'energydip') {
      // ===== Energy Dip Reset (拍非依存) =====
      // 一度エネルギーを沈めて耳をリセットし、BPM差/キー差を目立たせずに入れ替える。
      const dip = 1 - Math.sin(Math.PI * clamp01(p));
      const s = smoothstep(clamp01((p - 0.25) / 0.75));
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chFrom.setEq('low', 0.5 * clamp01(dip + 0.15));
      chFrom.setFader(1 - 0.9 * smoothstep(clamp01((p - 0.15) / 0.75)));
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.45) / 0.35)));
      chTo.setEq('high', 0.4 + 0.1 * smoothstep(clamp01(p / 0.5)));
    } else if (auto.xfCurve === 'brake') {
      // ===== Vinyl Brake =====
      // 送り出しの再生速度を落としながら、次曲へ短く切り替える。
      const s = smoothstep(p);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      fromDeck.setBend(Math.max(0.06, 1 - smoothstep(clamp01(p / 0.85)) * 0.94));
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01(p / 0.35))));
      chFrom.setFader(1 - 0.85 * smoothstep(clamp01((p - 0.25) / 0.75)));
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.35) / 0.35)));
    } else if (auto.xfCurve === 'gatecut') {
      // ===== Gate / Trans / Stutter Cut =====
      // ROLLを短く掛けて送り出しを刻み、終端で次曲へ切る。
      if (!ex.releaseFxStarted) {
        ex.releaseFxStarted = true;
        this._startReleaseFx(ex.from, fromDeck.effBpm, auto.releaseFx || 'ROLL', 0.25, 0.75, 1400);
      }
      const cut = smoothstep(clamp01((p - 0.55) / 0.45));
      const xf = ex.to === 'B' ? -1 + 2 * cut : 1 - 2 * cut;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01(p / 0.35))));
      chFrom.setFader(1 - 0.65 * cut);
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.35) / 0.35)));
    } else if (auto.xfCurve === 'delaythrow') {
      // ===== Delay Throw / Dub Delay Bridge =====
      // 送り出しの断片をDELAYへ投げ、次曲を下から入れる。
      if (!ex.releaseFxStarted) {
        ex.releaseFxStarted = true;
        this._startReleaseFx(ex.from, fromDeck.effBpm, auto.releaseFx || 'DELAY', 0.5, 0.58, 3200);
      }
      const s = smoothstep(p);
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01(p / 0.4))));
      chFrom.setFader(1 - 0.8 * smoothstep(clamp01((p - 0.25) / 0.75)));
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.45) / 0.35)));
      chTo.setEq('high', 0.42 + 0.08 * smoothstep(clamp01(p / 0.55)));
    } else if (auto.xfCurve === 'percussion') {
      // ===== Percussion Bridge =====
      // 次曲のパーカッシブ成分を先に出し、低域は遅めに渡してグルーヴを維持する。
      let s;
      if (p < 0.32) s = smoothstep(p / 0.32) * 0.45;
      else if (p < 0.72) s = 0.45;
      else s = 0.45 + smoothstep((p - 0.72) / 0.28) * 0.55;
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });
      chTo.setEq('low', 0.5 * smoothstep(clamp01((p - 0.55) / 0.2)));
      chTo.setEq('mid', 0.46);
      chTo.setEq('high', 0.52);
      chFrom.setEq('low', 0.5 * (1 - smoothstep(clamp01((p - 0.55) / 0.2))));
      chFrom.setEq('mid', 0.5 - 0.12 * smoothstep(clamp01((p - 0.55) / 0.35)));
      chFrom.setFader(1 - 0.55 * smoothstep(clamp01((p - 0.75) / 0.25)));
      this._pllCorrect(ex, now, p);
    } else {
      // ===== Standard EQ Mix =====
      // 仕込み順: 次曲LOWキル → HIを少し下げる → 次曲フェーダーUP (プリロール中)
      // 本番順: 次曲を重ねる → LOW/HIをゆっくり交換 → 送り出しフェーダーDOWN。
      // 最後のXF移動は送り出しフェーダーDOWNと同時に行い、中央の音量差を補う。
      const swapStart = auto.bassSwapAt?.[0] ?? 0.38;
      const swapEnd = Math.max(swapStart + 0.18, auto.bassSwapAt?.[1] ?? 0.62);
      const fadeStart = Math.max(0.68, swapEnd);
      let s;
      if (p < 0.22) s = smoothstep(p / 0.22) * 0.5;
      else if (p < fadeStart) s = 0.5;
      else s = 0.5 + smoothstep((p - fadeStart) / Math.max(0.12, 0.92 - fadeStart)) * 0.5;
      const xf = ex.to === 'B' ? -1 + 2 * s : 1 - 2 * s;
      this.mixer.setCrossfader(xf);
      this.onEvent({ type: 'xf', value: xf });

      // LOW/HI交換。技法ごとのbassSwapAtを開始/終了として使い、最低でも全体の
      // 18%を掛ける。片方だけがキックを持つ状態を滑らかに受け渡す。
      const swap = smoothstep(clamp01((p - swapStart) / (swapEnd - swapStart)));
      chTo.setEq('low', swap * 0.5);
      chFrom.setEq('low', 0.5 * (1 - swap));
      chTo.setEq('high', 0.42 + 0.08 * swap);
      chFrom.setEq('high', 0.5 - 0.12 * swap);

      // MIDは通常ほぼ保持し、Vocal Safe系だけ交換中に明確にダックする。
      chFrom.setEq('mid', 0.5 - (auto.midDuck ? 0.32 : 0.06) * swap);

      if (auto.filterSweep) chFrom.setColor(0.85 * clamp01((p - swapEnd) / Math.max(0.1, 0.88 - swapEnd)));

      // EQ交換が終わってから、先に流している曲のチャンネルフェーダーを0へ下げる。
      const fadeOut = smoothstep(clamp01((p - fadeStart) / Math.max(0.12, 0.92 - fadeStart)));
      chFrom.setFader(1 - fadeOut);
      chTo.setFader(1);

      // ビート位相ロック (PLL) + ロック不能時のセーフフェード退避
      this._pllCorrect(ex, now, p);

      // ECHOテール準備 (テールFXを使う技法のみ — 毎回はFX過多)
      if (plan.fxTail === 'echo' && p > 0.85 && !ex.echoStarted) {
        ex.echoStarted = true;
        this._startEchoTail(ex.from, fromDeck.effBpm, 0.55);
      }
    }

    if ((p >= 1 || ex.bailDone) && !ex.done) {
      ex.done = true;
      toDeck.setBend(1); // PLL補正を解除
      this.mixer.setCrossfader(ex.to === 'B' ? 1 : -1);
      this.onEvent({ type: 'xf', value: this.mixer.xf });
      if (auto.xfCurve === 'brake') fromDeck.setBend(1);
      this._finishAutomationFx(ex);
      fromDeck.pause(); // ECHOフィードバックのテールは残る
      chTo.setCue(false);
      this._resetChannel(ex.from);
      this.liveSide = ex.to;
      this._liveEntryPos = ex.entryStart;
      plan.state = 'completed';
      this.history.push({
        technique: plan.technique,
        techniqueName: plan.techniqueName,
        harmonicScore: plan.scores.harmonic,
        exitProgress: plan.exitProgress,
        exitTarget: plan.exitTarget,
        from: plan.fromTrack, to: plan.toTrack,
        at: new Date().toISOString(),
      });
      this.completedPlans.push(plan);
      this.plan = null;
      this.exec = null;
      this.phase = 'idle';
      this.onEvent({ type: 'trackstart', side: this.liveSide, track: this.decks[this.liveSide].track });
      this.onEvent({ type: 'history' });
    }
  }

  /* ---------- サイレント・プリロール ---------- */
  _tickPreroll(ex, now) {
    const fromDeck = this.decks[ex.from];
    const toDeck = this.decks[ex.to];

    // 本番直前にプリロール用ソースを止め、補正済みentry位置からフレーズ境界へ
    // 再スケジュールする。この間もチャンネルフェーダー0なのでクリック音は出ない。
    if (!ex.preRollCommitted && now >= ex.startWhen - PREROLL_COMMIT_LEAD) {
      toDeck.setBend(1);
      toDeck.play(ex.entryStart, ex.startWhen);
      if (!this.plan?.automation?.manualIncomingFader) this.mixer.channel(ex.to).setFader(1);
      ex.entryFaderRaised = true;
      ex.preRollCommitted = true;
      return;
    }
    if (!(ex.sync && fromDeck.playing && toDeck.playing && now - ex.preRollLastPll >= 0.1)) return;
    ex.preRollLastPll = now;

    let err = this._phaseError(ex, fromDeck, toDeck);
    if (!ex.preRollSnapped && now - ex.preRollStartedAt >= 0.08) {
      ex.preRollSnapped = true;
      if (Math.abs(err) > 0.008) {
        toDeck.seek(toDeck.getPosition(now) + err * toDeck.spb());
        err = 0;
      }
    }
    const bend = Math.abs(err) < 0.003 ? 1
      : 1 + Math.max(-PLL_MAX_BEND_EARLY, Math.min(PLL_MAX_BEND_EARLY, err * PLL_GAIN));
    toDeck.setBend(bend);
  }

  _phaseError(ex, fromDeck, toDeck) {
    // kickPhaseShift分だけグリッド位相を意図的にずらすことで、グリッド線ではなく
    // 推定された実キックのピーク同士を一致させる。
    const ratio = ex.syncBeatRatio || 1;
    let toPhase = toDeck.beatPhase();
    let fromPhase = fromDeck.beatPhase();
    if (Math.abs(ratio - 1) > 0.2) {
      const fromBeats = (fromDeck.getPosition() - (fromDeck.track?.gridOffset || 0)) / fromDeck.spb();
      const toBeats = (toDeck.getPosition() - (toDeck.track?.gridOffset || 0)) / toDeck.spb();
      fromPhase = ((fromBeats % 1) + 1) % 1;
      toPhase = (((toBeats / ratio) % 1) + 1) % 1;
    }
    let err = fromPhase + (ex.kickPhaseShift || 0) - toPhase;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    return err;
  }

  /* ---------- ビート位相ロック (PLL) + ロック不能時のセーフフェード退避 ----------
     検出BPMの微小誤差は長いブレンドで数十msのドリフト(フラム)になるため、
     位相誤差を常時微補正する。拍ロック不能が続いたらセーフフェードへ退避。 */
  _pllCorrect(ex, now, p) {
    const fromDeck = this.decks[ex.from];
    const toDeck = this.decks[ex.to];
    if (!(ex.sync && now - ex.lastPll > 0.25 && p < 0.95 && fromDeck.playing && toDeck.playing)) return;
    ex.lastPll = now;
    let err = this._phaseError(ex, fromDeck, toDeck);

    // 開始直後: グリッド誤差が大きければ一度だけマイクロシークで吸収
    // (入りはまだ音量が小さいので聴感上ほぼ気付かれない)
    if (!ex.snapped && p > 0.02) {
      ex.snapped = true;
      if (Math.abs(err) > 0.02) {
        const cur = toDeck.getPosition();
        toDeck.seek(cur + err * toDeck.spb());
        err = 0;
      }
    }

    const maxBend = p < 0.25 ? PLL_MAX_BEND_EARLY : PLL_MAX_BEND;
    const bend = Math.abs(err) < 0.005 ? 1
      : 1 + Math.max(-maxBend, Math.min(maxBend, err * PLL_GAIN));
    toDeck.setBend(bend);

    // ロック不能検知: 位相誤差が閾値を超え続けたらブレンドを諦めて退避
    if (p > 0.1 && p < 0.9) {
      if (Math.abs(err) > BAIL_ERR_BEATS) {
        if (ex.badSince == null) ex.badSince = now;
        if (now - ex.badSince > BAIL_HOLD_SEC && !ex.bail) {
          ex.bail = { start: now, fromXf: this.mixer.xf };
          toDeck.setBend(1);
          this._startEchoTail(ex.from, fromDeck.effBpm, 0.6);
          ex.echoStarted = true;
          this.onEvent({ type: 'msg', text: '拍ロック不能を検知 → セーフフェードに切替 (仕様 §29)' });
        }
      } else {
        ex.badSince = null;
      }
    }
  }

  /* ---------- フォールバック (仕様 §29): 安全側へ縮退 ---------- */
  _fallback(live) {
    this._cancelPreroll();
    this.plan = null;
    this.exec = null;
    this.phase = 'idle';
    try {
      // 最低限: ライブ側のEQを戻しクロスフェーダーをライブ側へ
      this._resetChannel(this.liveSide);
      this.mixer.setCrossfader(this.liveSide === 'A' ? -1 : 1);
      this.onEvent({ type: 'msg', text: 'プラン実行に失敗 — 単純ブレンドへ縮退しました' });
    } catch (e) {
      // 最終手段: フェードアウト
      if (live) live.pause();
    }
  }

  _startEchoTail(side, bpm, depth) {
    this._startReleaseFx(side, bpm, 'ECHO', 0.75, depth, 4000);
  }

  _cancelPreroll() {
    if (!this.exec || this.phase !== 'armed') return;
    const side = this.exec.to;
    const deck = this.decks[side];
    const ch = this.mixer.channel(side);
    ch.setCue(false);
    if (deck?.playing) deck.pause();
    this._resetChannel(side);
  }

  _startReleaseFx(side, bpm, type, beats, depth, holdMs = 4000) {
    if (TAIL_ONLY_FX.has(type) && ['A', 'B'].includes(side)) {
      // チャンネルの通常経路(Dry)とは分離したSend/Return。切替時にXFやフェーダーで
      // 原音を切っても、Delay/Convolver内部へ取り込んだWetテイルだけはMasterへ残る。
      const fx = new this.fx.constructor(this.fx.ctx);
      fx.setBpm(bpm);
      fx.setType(type);
      fx.setBeats(beats);
      fx.setParam(type === 'REVERB' ? 1 : 0.5);
      fx.setDepth(depth);
      const source = this.mixer.channel(side).fader;
      source.connect(fx.input);
      fx.wet.connect(this.mixer.masterSum);
      fx.setOn(true);
      const tail = { fx, source };
      this._activeTailFx.add(tail);
      setTimeout(() => {
        fx.setOn(false);
        // Wetゲインの短いランプを待ってから経路を破棄し、終端クリックを避ける。
        setTimeout(() => {
          try { source.disconnect(fx.input); } catch (e) {}
          try { fx.wet.disconnect(this.mixer.masterSum); } catch (e) {}
          this._activeTailFx.delete(tail);
        }, 120);
      }, holdMs);
      return fx;
    }
    const fx = this.fx;
    fx.setBpm(bpm);
    fx.setType(type);
    fx.setBeats(beats);
    fx.setDepth(depth);
    fx.setWetOnly(false);
    fx.assign(side);
    fx.setOn(true);
    if (type === 'ROLL') {
      // ROLLは1スライスを取り込むまでDryを通し、取り込み後にループ音だけへ切り替える。
      setTimeout(() => { if (fx.on && fx.type === 'ROLL') fx.setWetOnly(true); }, fx.beatTime() * 1000);
    }
    setTimeout(() => { fx.setOn(false); fx.setWetOnly(false); fx.assign('OFF'); }, holdMs);
    return fx;
  }

  _automateFx(ex, type, side, bpm, startOn = true) {
    if (ex.automationFx === type && ex.automationFxSide === side) return ex.automationFxUnit;
    // 長いREVERBテイルは共有BEAT FXを占有しない独立ユニットにする。
    const dedicatedTail = type === 'REVERB' && ['A', 'B'].includes(side);
    const fx = dedicatedTail ? new this.fx.constructor(this.fx.ctx) : this.fx;
    fx.setBpm(bpm);
    fx.setType(type);
    fx.setBeats(1);
    fx.setParam(type === 'REVERB' ? 1 : type === 'DISTORTION' ? 0 : 0.5);
    fx.setDepth(0);
    fx.setWetOnly(false);
    if (dedicatedTail) {
      // 残響だけをXF後のマスターへ送る。Aをフェーダー0/XFカットしても
      // Convolver内のテイルが残り、Bのドライ音にはREVERBが掛からない。
      this.mixer.channel(side).fader.connect(fx.input);
      fx.wet.connect(this.mixer.masterSum);
      ex.automationFxTailSend = true;
    } else {
      fx.assign(side);
    }
    fx.setOn(startOn);
    ex.automationFx = type;
    ex.automationFxSide = side;
    ex.automationFxUnit = fx;
    return fx;
  }

  _finishAutomationFx(ex) {
    if (!ex.automationFx) return;
    const fx = ex.automationFxUnit || this.fx;
    const close = () => {
      fx.setOn(false);
      fx.setWetOnly(false);
      if (ex.automationFxTailSend) {
        try { this.mixer.channel(ex.automationFxSide).fader.disconnect(fx.input); } catch (e) {}
        try { fx.wet.disconnect(this.mixer.masterSum); } catch (e) {}
      }
      if (fx === this.fx) fx.assign('OFF');
    };
    if (ex.automationFxTailMs) setTimeout(close, ex.automationFxTailMs);
    else close();
  }

  _resetChannel(side) {
    const ch = this.mixer.channel(side);
    ch.setTrim(0.7);
    ch.setEq('low', 0.5);
    ch.setEq('mid', 0.5);
    ch.setEq('high', 0.5);
    ch.setColor(0);
    ch.setFader(1);
    this.onEvent({ type: 'chreset', side });
  }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smoothstep(v) { const t = clamp01(v); return t * t * (3 - 2 * t); }
