// ===== Deck: CDJ相当のプレイヤー (再生/CUE/HOT CUE/LOOP/TEMPO/SYNC/ジョグ) =====
import { toCamelot, keyName } from './keyutil.js';
import { TempoMap, beatAlignedSeekPosition } from './beat-grid.js';

export function scratchWindowBounds(duration, position, radius = 8) {
  const center = Math.max(0, Math.min(duration, position));
  return {
    start: Math.max(0, center - radius),
    end: Math.min(duration, center + radius),
  };
}

export class Deck {
  constructor(ctx, id) {
    this.ctx = ctx;
    this.id = id;                 // 'A' | 'B'
    this.out = ctx.createGain();  // → Mixer チャンネルへ (最終出力。app.jsが接続する)
    // 全ソース(通常再生/スクラッチ)の集約点。ラウドネス正規化ゲインも兼ねる。
    // srcBus → (keylock挿入 or 直結) → out という経路にすることで、
    // app.js側の out→mixer 接続を変えずにキーロックを挿入できる。
    this.srcBus = ctx.createGain();
    this.srcBus.connect(this.out);
    this.keylock = false;
    this.keyShift = 0;            // 音程の半音シフト (テンポ不変。ハーモニックミックス用)
    this.keylockNode = null;
    this._ratioParam = null;

    this.buffer = null;
    this.track = null;            // {name,bpm,key,gridOffset,...}
    this.source = null;

    this.playing = false;
    this.startCtxTime = 0;        // 再生開始時の AudioContext 時刻
    this.startOffset = 0;         // 再生開始時のバッファ位置(秒)

    this.pitch = 0;               // -1..+1 (フェーダー位置)
    this.pitchRange = 0.08;       // ±8% (切替: 8/16/50)
    this.bend = 1;                // ジョグによる一時的レート補正
    this.synced = false;
    // true = Planner (automix.js) がAUTO MIXの自動トランジションで設定したピッチ。
    // ユーザーがフェーダーに触れる/SYNCボタンを押すと必ず false に戻る。
    // Planner の自動テンポ回帰 (_tempoRecenter) は autoPitch=true の間だけ働き、
    // 手動操作を絶対に上書きしない。
    this.autoPitch = false;

    this.cuePoint = 0;
    this.hotcues = new Array(8).fill(null);
    this.loop = null;             // {start, end, beats}
    this.onchange = null;         // UI更新コールバック

    // アナログスクラッチ (AudioWorklet 可変速プレイヤー)
    this.scratch = {
      node: null, active: false, wasPlaying: false,
      winStart: 0, winEnd: 0, pos: 0, velocity: 0, generation: 0, endTimer: null,
    };
  }

  /* ---------- 基本情報 ---------- */
  get rate() { return (1 + this.pitch * this.pitchRange) * this.bend; }
  get bpm() { return this.track ? this.track.bpm : 0; }
  get effBpm() { return this.bpm * (1 + this.pitch * this.pitchRange); }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  spb() {
    if (!this.tempoMap) return this.track && this.track.bpm > 0 ? 60 / this.track.bpm : 0.5;
    return 60 / this.tempoMap.localBpmAt(this.getPosition());
  } // バッファ時間軸での1拍(秒)

  /* ---------- ロード ---------- */
  load(track) {
    if (!track?.buffer) throw new Error(`Track audio is not prepared: ${track?.name || 'unknown'}`);
    // スクラッチセッションが残っていれば強制終了
    clearTimeout(this.scratch.endTimer);
    if (this.scratch.active) {
      this.scratch.active = false;
      try { this.scratch.node.port.postMessage({ type: 'stop' }); } catch (e) {}
      try { this.scratch.node.disconnect(); } catch (e) {}
    }
    this.stopSource();
    this.playing = false;
    this.track = track;
    this.buffer = track.buffer;
    this.tempoMap = new TempoMap(track.beatGrid || {
      mode: 'rigid',
      anchors: [{ beatIndex: 0, timeSec: track.gridOffset || 0, localBpm: track.bpm || 120 }],
      meterSegments: [{ startBeat: 0, numerator: 4, denominator: 4, beatUnit: 'quarter' }]
    });
    // ラウドネス正規化: 曲ごとの音量差を srcBus のゲインで吸収する
    // (解析時に算出した -20dBFS RMS へ揃える倍率)。これで自動ゲインマッチが機能する。
    this.srcBus.gain.value = track.normGain ?? 1;
    this.pitch = 0;
    this.bend = 1;
    this.loop = null;
    this.synced = false;
    this.autoPitch = false;
    this.cuePoint = 0;
    this.hotcues = new Array(8).fill(null);
    this.startOffset = 0;
    this._notify();
  }

  /* ---------- アンロード (デッキから曲を取り出す) ---------- */
  unload() {
    clearTimeout(this.scratch.endTimer);
    if (this.scratch.active) {
      this.scratch.active = false;
      try { this.scratch.node.port.postMessage({ type: 'stop' }); } catch (e) {}
      try { this.scratch.node.disconnect(); } catch (e) {}
    }
    this.stopSource();
    this.playing = false;
    this.track = null;
    this.buffer = null;
    this.tempoMap = null;
    this.loop = null;
    this.synced = false;
    this.autoPitch = false;
    this.pitch = 0;
    this.bend = 1;
    this.hotcues = new Array(8).fill(null);
    this.startOffset = 0;
    this.cuePoint = 0;
    this.srcBus.gain.value = 1;
    this._notify();
  }

  /* ---------- 再生位置 ---------- */
  getPosition(now = this.ctx.currentTime) {
    if (!this.buffer) return 0;
    if (this.scratch.active) return this.scratch.winStart + this.scratch.pos / this.buffer.sampleRate;
    if (!this.playing) return this.startOffset;
    let pos = this.startOffset + (now - this.startCtxTime) * this.rate;
    if (this.loop && pos > this.loop.end) {
      const len = this.loop.end - this.loop.start;
      pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.min(pos, this.duration);
  }

  /** 現在位置を基準点として再アンカー(レート変更・ループ解除時に必要) */
  _reanchor() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.startOffset = this.getPosition(now);
    this.startCtxTime = now;
  }

  /* ---------- ソース管理 ---------- */
  _makeSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    if (this.loop) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(this.srcBus);
    return src;
  }

  stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) { /* already stopped */ }
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
  }

  /* ---------- トランスポート ---------- */
  /** pos(秒)から when(ctx時刻)に再生開始。省略時は現在位置・即時 */
  play(pos = this.startOffset, when = this.ctx.currentTime) {
    if (!this.buffer) return;
    if (this.scratch.active) return; // スクラッチセッション終了後に再開される
    this.stopSource();
    pos = Math.max(0, Math.min(pos, this.duration - 0.01));

    // SYNC中かつ相手が再生中の場合、再生開始位置(pos)を相手のビート位相にアラインする
    if (this.synced && this.otherDeck && this.otherDeck.playing && this.otherDeck.track) {
      const mPhase = this.otherDeck.beatPhase();
      const localBpm = this.tempoMap ? this.tempoMap.localBpmAt(pos) : this.bpm;
      pos = beatAlignedSeekPosition(pos, this.duration, localBpm, this.track.gridOffset || 0, mPhase);
    }

    this.source = this._makeSource();
    this.source.start(when, pos);
    this.source.onended = () => { if (this.playing && !this.loop) this._onEnded(); };
    this.playing = true;
    this.startCtxTime = when;
    this.startOffset = pos;
    this._notify();
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.getPosition();
    this.stopSource();
    this.playing = false;
    this._notify();
  }

  togglePlay() { this.playing ? this.pause() : this.play(); }

  _onEnded() {
    this.playing = false;
    this.startOffset = this.duration;
    this.stopSource();
    this._notify();
  }

  /** モバイル等で AudioContext が中断→復帰した後、OSに停止された
   *  AudioBufferSourceNode を現在の論理位置から張り直す。
   *  (ctx.currentTime は中断中フリーズするため getPosition() は中断直前の
   *   位置を返し、そこから再生を再開すれば音がズレない) */
  restartPlayback() {
    if (!this.buffer || !this.playing || this.scratch.active) return;
    const pos = this.getPosition();
    this.play(pos); // 新しいソースを生成して即時再生
  }

  seek(pos) {
    if (!this.buffer || this.scratch.active) return;
    pos = Math.max(0, Math.min(pos, this.duration - 0.01));
    if (this.playing) this.play(pos);
    else { this.startOffset = pos; this._notify(); }
  }

  /** 波形ジャンプ用。クリック位置へ移動しても現在のキック周期をリセットしない。 */
  seekBeatAligned(pos, referencePhase = null) {
    if (!this.buffer || !this.track || this.scratch.active) return;
    const phase = Number.isFinite(referencePhase)
      ? referencePhase
      : this.playing ? this.beatPhase() : 0;
    const localBpm = this.tempoMap ? this.tempoMap.localBpmAt(pos) : this.bpm;
    this.seek(beatAlignedSeekPosition(
      pos, this.duration, localBpm, this.track.gridOffset || 0, phase,
    ));
  }

  /* ---------- CUE (CDJスタイル: 停止中に押すとCUE設定、再生中は戻って停止) ---------- */
  pressCue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      if (Math.abs(this.getPosition() - this.cuePoint) < 0.02) {
        // CUEポイント上: プレビュー再生はシンプル化のため即再生
        this.play(this.cuePoint);
      } else {
        this.cuePoint = this.quantize(this.getPosition());
        this.seek(this.cuePoint);
      }
    }
  }

  /** ビートグリッドの手動調整 (自動検出の位相を±deltaSec補正)。
   *  ホットキュー/ループ等は gridOffset を直接参照して量子化されるため、
   *  再解析なしにその場で波形グリッド線・CUE量子化位置へ反映される。 */
  nudgeGrid(deltaSec) {
    if (!this.track) return;
    this.track.gridOffset += deltaSec;
    this._markGridManual();
    this._notify();
  }

  /** 手動でグリッド/BPMを補正したことを記録する。以後この曲のビートグリッドは
   *  ユーザーが定めた絶対基準として扱い、AutoMixのキックピーク自動検出は
   *  entry位置を動かさない (グリッド管理とキック管理を分離する)。 */
  _markGridManual() {
    if (this.track) this.track.gridManual = true;
  }

  /** 現在の再生位置を「1拍目(小節の頭)」に設定する。
   *  自動検出のダウンビートが実際とずれている時に、頭出しした位置を
   *  基準にグリッド全体を合わせ直す。BPM(拍間隔)は変えず位相だけを移す。
   *  現在位置がちょうど小節の頭(拍0)になるよう gridOffset を再計算する。 */
  setDownbeatHere() {
    if (!this.track || this.bpm <= 0) return;
    const bar = 4 * this.spb();
    const pos = this.getPosition();
    // 現在のbar番号をなるべく維持したまま、現在位置をその小節の1拍目へ置く。
    // moduloで0付近へ戻すと「1小節目」で設定した絶対起点が失われるため、
    // 現在のgridOffsetから最も近い小節番号を逆算してアンカーを移動する。
    const barIndex = Math.round((pos - this.track.gridOffset) / bar);
    this.track.gridOffset = pos - barIndex * bar;
    this._markGridManual();
    this._notify();
  }

  /** 現在の再生位置を「4小節ウィンドウの1小節目」に設定する。
   *  曲全体の絶対起点を動かすのではなく、現在位置が属する4小節(16拍)の
   *  ウィンドウ番号をなるべく維持したまま、そのウィンドウの1小節目が
   *  現在位置に来るようgridOffsetを再計算する(setDownbeatHereの4小節版)。 */
  setFirstBarHere() {
    if (!this.track || this.bpm <= 0) return;
    const window = 16 * this.spb(); // 4小節 = 16拍
    const pos = this.getPosition();
    const windowIndex = Math.round((pos - this.track.gridOffset) / window);
    this.track.gridOffset = pos - windowIndex * window;
    this._markGridManual();
    this._notify();
  }

  /** 指定バッファ位置がちょうど拍(ビート)になるようグリッド位相を合わせる。
   *  タップテンポで最後に叩いた位置に拍を合わせるのに使う。 */
  alignBeatTo(pos) {
    if (!this.track || this.bpm <= 0) return;
    const spb = this.spb();
    const beatIndex = Math.round((pos - this.track.gridOffset) / spb);
    this.track.gridOffset = pos - beatIndex * spb;
    this._markGridManual();
    this._notify();
  }

  /** BPM検出の半分/2倍テンポ誤り (メトリカルな半分/2倍・3拍子系の1.5倍など、
   *  信号処理だけでは常に正しく解けるとは限らない曖昧さ) を手動補正する。
   *  gridOffsetはbar 1の絶対起点として維持し、アンカー自体
   *  (実際のキック位置)を変えない。 */
  rescaleBpm(factor) { this.setBpm(this.track ? this.track.bpm * factor : 0); }

  /** BPMを直接指定して補正する (½×/×2でも直らない3:2等の曖昧さの最終手段)。 */
  setBpm(bpm) {
    if (!this.track || !(bpm > 0)) return;
    this.track.bpm = bpm;
    this._markGridManual();
    this._notify();
  }

  /* ---------- ビート演算 ---------- */
  quantize(pos) {
    if (!this.tempoMap) return pos;
    return this.tempoMap.quantizeTime(pos, 1);
  }
  beatAt(pos) {
    if (!this.tempoMap) return this.track ? (pos - this.track.gridOffset) / this.spb() : 0;
    return this.tempoMap.beatAtTime(pos);
  }
  /** 現在のビート位相 (0..1) */
  beatPhase() {
    if (!this.tempoMap) {
      const b = this.beatAt(this.getPosition());
      return b - Math.floor(b);
    }
    return this.tempoMap.beatPhaseAt(this.getPosition());
  }
  /** 次の (拍インデックス mod beatsMultiple == 0) 境界の ctx 時刻とバッファ位置。
   *  beatsMultiple=4 で小節頭、16 で4小節フレーズ頭。 */
  nextBoundaryTime(beatsMultiple = 4, minLead = 0.06) {
    const now = this.ctx.currentTime;
    const pos = this.getPosition(now);
    if (!this.tempoMap) {
      const beats = this.beatAt(pos);
      let targetBeat = Math.ceil(beats / beatsMultiple) * beatsMultiple;
      let target = this.track.gridOffset + targetBeat * this.spb();
      let when = now + (target - pos) / this.rate;
      if (when - now < minLead) {
        targetBeat += beatsMultiple;
        target = this.track.gridOffset + targetBeat * this.spb();
        when = now + (target - pos) / this.rate;
      }
      return { when, pos: target, beatIndex: targetBeat };
    }
    
    const beat = this.tempoMap.beatAtTime(pos);
    let targetBeat = Math.ceil(beat / beatsMultiple) * beatsMultiple;
    let target = this.tempoMap.timeAtBeat(targetBeat);
    let when = now + (target - pos) / this.rate;
    if (when - now < minLead) {
      targetBeat += beatsMultiple;
      target = this.tempoMap.timeAtBeat(targetBeat);
      when = now + (target - pos) / this.rate;
    }
    return { when, pos: target, beatIndex: targetBeat };
  }

  /** 次の4拍(小節)境界に到達する ctx 時刻とバッファ位置 */
  nextBarTime(minLead = 0.06) { return this.nextBoundaryTime(4, minLead); }

  /* ---------- テンポ / SYNC ---------- */
  setPitch(v) {
    // 現在位置は必ず旧レートで確定してから新レートへ切り替える。
    // 順序が逆だと、再生開始からの経過時間へ新レートが遡及して拍位置が飛ぶ。
    this._reanchor();
    this.pitch = Math.max(-1, Math.min(1, v));
    this._applyRate();
  }
  setPitchRange(r) {
    this._reanchor();
    this.pitchRange = r;
    this._applyRate();
  }
  setBend(b) {
    this._reanchor();
    this.bend = b;
    this._applyRate();
  }
  _applyRate() {
    if (this.source) this.source.playbackRate.setTargetAtTime(this.rate, this.ctx.currentTime, 0.01);
    this._updateKeylockRatio();
    this._notify();
  }

  /* ---------- キーロック (テンポ変更時に音程を維持) ---------- */
  async _ensureKeylockNode() {
    if (this.keylockNode) return;
    if (!Deck._keylockReady) {
      Deck._keylockReady = this.ctx.audioWorklet.addModule('js/keylock-worklet.js');
    }
    await Deck._keylockReady;
    if (!this.keylockNode) {
      this.keylockNode = new AudioWorkletNode(this.ctx, 'keylock-processor', {
        channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
      });
      this._ratioParam = this.keylockNode.parameters.get('ratio');
    }
  }

  /** 音程を半音単位でシフト (テンポは変えない)。ハーモニックミックス用。
   *  キーロックのピッチシフタを流用し、比 2^(semi/12) を掛ける。 */
  async setKeyShift(semitones) {
    this.keyShift = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (this.keyShift !== 0) await this._ensureKeylockNode();
    this._applyKeylockRouting();
    this._updateKeylockRatio();
    this._notify();
  }
  nudgeKeyShift(delta) { this.setKeyShift(this.keyShift + delta); }

  async setKeylock(on) {
    this.keylock = on;
    if (on) await this._ensureKeylockNode();
    this._applyKeylockRouting();
    this._updateKeylockRatio();
    this._notify();
  }

  _applyKeylockRouting() {
    try { this.srcBus.disconnect(); } catch (e) {}
    // キーロック ON か、キーシフトが掛かっている時にシフタを経路へ挿入
    if ((this.keylock || this.keyShift !== 0) && this.keylockNode) {
      this.srcBus.connect(this.keylockNode);
      try { this.keylockNode.disconnect(); } catch (e) {}
      this.keylockNode.connect(this.out);
    } else {
      this.srcBus.connect(this.out);
    }
  }

  _updateKeylockRatio() {
    if (!this._ratioParam) return;
    // スクラッチ中は補正しない (スクラッチは音程を変えるのが目的)。
    // ナッジ(bend)も補正対象外にして、CDJ同様わずかな音程ベンドを残す。
    const tempo = this.scratch.active ? 1 : (1 + this.pitch * this.pitchRange);
    const lock = this.keylock && tempo > 0 ? 1 / tempo : 1; // テンポ由来の音程を打ち消す
    const shift = Math.pow(2, this.keyShift / 12);          // 半音シフト
    this._ratioParam.setTargetAtTime(lock * shift, this.ctx.currentTime, 0.02);
  }

  /* ---------- キーの手動補正 (検出は不確実なため。Rekordbox相当) ---------- */
  setKey(root, mode) {
    if (!this.track) return;
    root = ((Math.round(root) % 12) + 12) % 12;
    this.track.key = { root, mode, name: keyName(root, mode), camelot: toCamelot(root, mode) };
    this.track.keySource = 'manual';
    this.track.keyConfidence = 1.0;
    this._notify();
  }
  nudgeKeyRoot(delta) { if (this.track) this.setKey(this.track.key.root + delta, this.track.key.mode); }
  toggleKeyMode() { if (this.track) this.setKey(this.track.key.root, this.track.key.mode === 'major' ? 'minor' : 'major'); }

  /** 他デッキにBPMと位相を合わせる */
  syncTo(master) {
    if (!this.track || !master.track) return;
    // BPMマッチ: effBpm = master.effBpm となる pitch を逆算
    const rawRatio = master.effBpm / this.bpm;
    // 70↔140のような倍テンは原速を壊さず、2拍:1拍のグリッドとして同期する。
    const targetRatio = rawRatio >= 0.45 && rawRatio <= 0.55 ? rawRatio * 2
      : rawRatio >= 1.9 && rawRatio <= 2.1 ? rawRatio / 2
      : rawRatio; // = 1 + pitch*range
    const pitch = (targetRatio - 1) / this.pitchRange;
    if (Math.abs(pitch) > 1) {
      // レンジ不足なら自動で拡大
      this.setPitchRange(Math.abs(targetRatio - 1) <= 0.16 ? 0.16 : 0.5);
    }
    this.setPitch((targetRatio - 1) / this.pitchRange);
    // 位相合わせ (再生中のみ)
    if (this.playing && master.playing) {
      const myPhase = this.beatPhase();
      const mPhase = master.beatPhase();
      let diff = mPhase - myPhase;
      if (diff > 0.5) diff -= 1;
      if (diff < -0.5) diff += 1;
      this.seek(this.getPosition() + diff * this.spb());
    }
    this.synced = true;
    this._notify();
  }

  /* ---------- HOT CUE ---------- */
  pressHotcue(i) {
    if (!this.buffer) return;
    if (this.hotcues[i] == null) {
      this.hotcues[i] = this.quantize(this.getPosition());
    } else {
      this.playing ? this.play(this.hotcues[i]) : this.seek(this.hotcues[i]);
    }
    this._notify();
  }
  clearHotcue(i) { this.hotcues[i] = null; this._notify(); }

  /* ---------- LOOP ---------- */
  loopIn() { this._loopIn = this.quantize(this.getPosition()); this._notify(); }
  loopOut() {
    if (this._loopIn == null) return;
    const end = this.quantize(this.getPosition());
    if (end > this._loopIn) this._setLoop(this._loopIn, end);
  }
  autoLoop(beats) {
    if (!this.buffer) return;
    if (this.loop && this.loop.beats === beats) { this.exitLoop(); return; }
    const start = this.quantize(this.getPosition());
    this._setLoop(start, start + beats * this.spb(), beats);
  }
  _setLoop(start, end, beats = null) {
    this._reanchor();
    this.loop = { start, end, beats };
    if (this.source) {
      this.source.loopStart = start;
      this.source.loopEnd = end;
      this.source.loop = true;
    }
    this._notify();
  }
  exitLoop() {
    if (!this.loop) return;
    this._reanchor();
    this.loop = null;
    if (this.source) this.source.loop = false;
    this._notify();
  }
  /** ループ長を半分/2倍 */
  loopHalf() { if (this.loop) this._resizeLoop(0.5); }
  loopDouble() { if (this.loop) this._resizeLoop(2); }
  _resizeLoop(f) {
    const len = (this.loop.end - this.loop.start) * f;
    if (len < this.spb() / 8 || len > this.duration / 2) return;
    this._setLoop(this.loop.start, this.loop.start + len, this.loop.beats ? this.loop.beats * f : null);
  }

  /* ---------- BEAT JUMP ---------- */
  beatJump(beats) {
    if (!this.buffer) return;
    this.seek(this.getPosition() + beats * this.spb());
  }

  /* ---------- アナログスクラッチ ----------
     AudioBufferSourceNode は逆再生できないため、スクラッチ中は
     AudioWorklet (scratch-processor) が現在位置±8秒の窓を符号付き速度で読む。
     離した後も200msの猶予でセッションを維持し、ベビースクラッチの
     連続グラブでもエンジンを切り替えない。 */

  async ensureScratchNode() {
    if (this.scratch.node) return;
    if (!Deck._workletReady) {
      Deck._workletReady = this.ctx.audioWorklet.addModule('js/scratch-worklet.js');
    }
    await Deck._workletReady;
    if (this.scratch.node) return;
    const node = new AudioWorkletNode(this.ctx, 'scratch-processor', {
      numberOfInputs: 0, outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      if (e.data.type === 'pos') {
        if (e.data.generation !== this.scratch.generation) return;
        this.scratch.pos = e.data.pos;
        if (e.data.final) this._finishScratch(e.data.pos);
        else this._maybeShiftScratchWindow(e.data.pos);
      }
    };
    this.scratch.node = node;
  }

  /** グラブ開始 (プラッターを押さえる)。既にセッション中なら継続。 */
  async startScratch() {
    if (!this.buffer) return;
    clearTimeout(this.scratch.endTimer);
    if (this.scratch.active) { this.setScratchVelocity(0); return; }
    await this.ensureScratchNode();
    if (this.scratch.active || !this.buffer) return;
    const pos = this.getPosition();
    this.scratch.wasPlaying = this.playing;
    this.stopSource();
    this.playing = false;
    this.scratch.active = true;
    this.scratch.velocity = 0;
    this._loadScratchWindow(pos, 0);
    this.scratch.node.connect(this.srcBus);
    this._updateKeylockRatio(); // スクラッチ中はキーロック補正を無効化 (音程変化が目的)
    this._notify();
  }

  /** スクラッチ速度 (1.0=順方向通常速, 負=逆回し, 0=停止) */
  setScratchVelocity(v) {
    if (this.scratch.active && this.scratch.node) {
      this.scratch.velocity = v;
      this.scratch.node.port.postMessage({ type: 'vel', v });
    }
  }

  _loadScratchWindow(absolutePosition, velocity) {
    if (!this.buffer || !this.scratch.node) return;
    const sr = this.buffer.sampleRate;
    const bounds = scratchWindowBounds(this.duration, absolutePosition);
    const s0 = Math.floor(bounds.start * sr), s1 = Math.ceil(bounds.end * sr);
    const channels = [];
    for (let c = 0; c < Math.min(2, this.buffer.numberOfChannels); c++) {
      channels.push(this.buffer.getChannelData(c).slice(s0, s1));
    }
    this.scratch.winStart = bounds.start;
    this.scratch.winEnd = bounds.end;
    this.scratch.pos = Math.max(0, (absolutePosition - bounds.start) * sr);
    this.scratch.velocity = velocity;
    this.scratch.generation++;
    this.scratch.node.port.postMessage({
      type: 'load', channels, pos: this.scratch.pos, vel: velocity,
      generation: this.scratch.generation,
    }, channels.map((channel) => channel.buffer));
  }

  _maybeShiftScratchWindow(posSamples) {
    if (!this.scratch.active || !this.buffer) return;
    const sr = this.buffer.sampleRate;
    const windowSamples = Math.max(1, (this.scratch.winEnd - this.scratch.winStart) * sr);
    const margin = Math.min(sr * 2, windowSamples * 0.3);
    const absolutePosition = this.scratch.winStart + posSamples / sr;
    if (this.scratch.velocity < 0 && posSamples < margin && this.scratch.winStart > 0) {
      this._loadScratchWindow(absolutePosition, this.scratch.velocity);
    } else if (this.scratch.velocity > 0 && posSamples > windowSamples - margin
      && this.scratch.winEnd < this.duration) {
      this._loadScratchWindow(absolutePosition, this.scratch.velocity);
    }
  }

  /** リリース: 再生中だったなら等速へ戻し、少し待ってから通常再生へ引き継ぐ */
  endScratch() {
    if (!this.scratch.active) return;
    this.setScratchVelocity(this.scratch.wasPlaying ? this.rate : 0);
    clearTimeout(this.scratch.endTimer);
    this.scratch.endTimer = setTimeout(() => {
      if (this.scratch.active && this.scratch.node) {
        this.scratch.node.port.postMessage({ type: 'stop' });
      }
    }, 220);
  }

  /** Backspin FX: スクラッチエンジンで逆回転し、そのまま停止する。
   *  AudioBufferSourceNodeは負のplaybackRateを取れないため、既存の
   *  scratch-workletを短時間だけ使う。AUTO MIXのトランジション脱出や
   *  手動BEAT FXで使うことを想定し、通常再生へは復帰しない。 */
  async performBackspin(durationSec = 1.2, intensity = 1) {
    if (!this.buffer || this.scratch.active) return false;
    await this.startScratch();
    if (!this.scratch.active) return false;
    const start = this.ctx.currentTime;
    const dur = Math.max(0.25, Math.min(3.5, durationSec));
    const power = Math.max(0.5, Math.min(1.8, intensity));
    const startVel = -3.5 * power;
    const endVel = -0.18;
    const tick = () => {
      if (!this.scratch.active) return;
      const p = Math.max(0, Math.min(1, (this.ctx.currentTime - start) / dur));
      const ease = 1 - Math.pow(p, 1.7);
      this.setScratchVelocity(endVel + (startVel - endVel) * ease);
      if (p < 1) {
        requestAnimationFrame(tick);
      } else {
        this.scratch.wasPlaying = false;
        this.setScratchVelocity(0);
        clearTimeout(this.scratch.endTimer);
        this.scratch.endTimer = setTimeout(() => {
          if (this.scratch.active && this.scratch.node) {
            this.scratch.node.port.postMessage({ type: 'stop' });
          }
        }, 80);
      }
    };
    tick();
    return true;
  }

  _finishScratch(posSamples) {
    if (!this.scratch.active) return;
    this.scratch.active = false;
    try { this.scratch.node.disconnect(); } catch (e) {}
    let pos = Math.max(0, Math.min(this.duration,
      this.scratch.winStart + posSamples / this.buffer.sampleRate));
    this.scratch.velocity = 0;
    this._updateKeylockRatio(); // スクラッチ終了 → キーロック補正を復帰

    // SYNC中かつ相手が再生中の場合、スクラッチ解放位置(pos)を相手のビート位相にアラインする
    if (this.synced && this.otherDeck && this.otherDeck.playing && this.otherDeck.track) {
      const mPhase = this.otherDeck.beatPhase();
      const localBpm = this.tempoMap ? this.tempoMap.localBpmAt(pos) : this.bpm;
      pos = beatAlignedSeekPosition(pos, this.duration, localBpm, this.track.gridOffset || 0, mPhase);
    }

    if (this.scratch.wasPlaying) this.play(pos);
    else { this.startOffset = pos; this._notify(); }
  }

  _notify() { if (this.onchange) this.onchange(this); }
}

export { beatAlignedSeekPosition };
