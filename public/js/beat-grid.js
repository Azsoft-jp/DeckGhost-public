/**
 * BeatGrid / TempoMap 共通モジュール
 * 
 * 可変テンポ (Dynamic Grid) および変拍子 (Meter) に対応した時間・拍数・小節番号の相互変換を提供します。
 */

/**
 * クリック位置に最も近く、指定した拍内フェーズを持つバッファ位置を返す。
 * 従来の deck.js の実装と互換性を持ちつつ、テンポマップから正確な spb を求めて配置します。
 */
export function beatAlignedSeekPosition(target, duration, bpm, gridOffset = 0, phase = 0) {
  const maxPosition = Math.max(0, duration - 0.01);
  const clampedTarget = Math.max(0, Math.min(target, maxPosition));
  if (!(bpm > 0)) return clampedTarget;
  const spb = 60 / bpm;
  const normalizedPhase = ((phase % 1) + 1) % 1;
  const beatIndex = Math.round((clampedTarget - gridOffset) / spb - normalizedPhase);
  let aligned = gridOffset + (beatIndex + normalizedPhase) * spb;
  if (aligned < 0) aligned += Math.ceil(-aligned / spb) * spb;
  if (aligned > maxPosition) aligned -= Math.ceil((aligned - maxPosition) / spb) * spb;
  return Math.max(0, Math.min(aligned, maxPosition));
}

export class TempoMap {
  /**
   * @param {object} beatGrid BeatGridデータモデル
   */
  constructor(beatGrid) {
    this.mode = beatGrid?.mode || 'rigid';
    this.anchors = Array.isArray(beatGrid?.anchors) ? [...beatGrid.anchors] : [];
    this.meterSegments = Array.isArray(beatGrid?.meterSegments) ? [...beatGrid.meterSegments] : [];
    
    this.firstReliableBeatTimeSec = beatGrid?.firstReliableBeatTimeSec ?? null;
    this.barOriginBeatIndex = beatGrid?.barOriginBeatIndex ?? 0;
    this.barOneBeatIndex = beatGrid?.barOneBeatIndex ?? 0;
    this.analysisVersion = beatGrid?.analysisVersion || '2.0';
    this.locked = !!beatGrid?.locked;

    // デフォルトのフォールバック値 (アンカーがない場合)
    this.defaultBpm = 120;
    this.defaultOffset = 0;

    // ソート処理
    this.anchors.sort((a, b) => a.beatIndex - b.beatIndex);
    this.meterSegments.sort((a, b) => a.startBeat - b.startBeat);

    // 重複や不正なアンカーのクリーンアップ
    this.anchors = this.anchors.filter((anchor, index) => {
      if (index === 0) return true;
      const prev = this.anchors[index - 1];
      // 同一時刻・同一拍のアンカーは排除し、単調増加を保証
      return anchor.beatIndex > prev.beatIndex && anchor.timeSec > prev.timeSec;
    });

    if (this.anchors.length === 0) {
      // 最小限の初期アンカーを作成 (BPMフォールバック)
      this.anchors = [{
        beatIndex: 0,
        timeSec: this.defaultOffset,
        localBpm: this.defaultBpm,
        confidence: 0.5,
        source: 'estimated'
      }];
    }

    if (this.meterSegments.length === 0) {
      // デフォルトは 4/4 拍子
      this.meterSegments = [{
        startBeat: 0,
        numerator: 4,
        denominator: 4,
        beatUnit: 'quarter',
        downbeatBeatIndex: 0,
        confidence: 0.8,
        source: 'estimated'
      }];
    }
  }

  /**
   * timeSec (秒) における拍数 (beatIndex: 小数値を含む) を計算して返す
   */
  beatAtTime(timeSec) {
    const a0 = this.anchors[0];
    if (this.anchors.length === 1 || this.mode === 'rigid') {
      const spb = 60 / a0.localBpm;
      return a0.beatIndex + (timeSec - a0.timeSec) / spb;
    }

    // 左側外操 (最初のアンカーより前)
    if (timeSec <= a0.timeSec) {
      const segBpm = this._segmentBpm(0);
      const spb = 60 / segBpm;
      return a0.beatIndex + (timeSec - a0.timeSec) / spb;
    }

    // 右側外操 (最後のアンカーより後)
    const lastIdx = this.anchors.length - 1;
    const alast = this.anchors[lastIdx];
    if (timeSec >= alast.timeSec) {
      const segBpm = this._segmentBpm(lastIdx - 1);
      const spb = 60 / segBpm;
      return alast.beatIndex + (timeSec - alast.timeSec) / spb;
    }

    // アンカー間の線形内挿
    for (let i = 0; i < this.anchors.length - 1; i++) {
      const curr = this.anchors[i];
      const next = this.anchors[i + 1];
      if (timeSec >= curr.timeSec && timeSec <= next.timeSec) {
        const ratio = (timeSec - curr.timeSec) / (next.timeSec - curr.timeSec);
        return curr.beatIndex + ratio * (next.beatIndex - curr.beatIndex);
      }
    }

    return a0.beatIndex;
  }

  /**
   * beatIndex (拍数) における時間 (秒) を計算して返す
   */
  timeAtBeat(beatIndex) {
    const a0 = this.anchors[0];
    if (this.anchors.length === 1 || this.mode === 'rigid') {
      const spb = 60 / a0.localBpm;
      return a0.timeSec + (beatIndex - a0.beatIndex) * spb;
    }

    // 左側外操
    if (beatIndex <= a0.beatIndex) {
      const segBpm = this._segmentBpm(0);
      const spb = 60 / segBpm;
      return a0.timeSec + (beatIndex - a0.beatIndex) * spb;
    }

    // 右側外操
    const lastIdx = this.anchors.length - 1;
    const alast = this.anchors[lastIdx];
    if (beatIndex >= alast.beatIndex) {
      const segBpm = this._segmentBpm(lastIdx - 1);
      const spb = 60 / segBpm;
      return alast.timeSec + (beatIndex - alast.beatIndex) * spb;
    }

    // アンカー間の内挿
    for (let i = 0; i < this.anchors.length - 1; i++) {
      const curr = this.anchors[i];
      const next = this.anchors[i + 1];
      if (beatIndex >= curr.beatIndex && beatIndex <= next.beatIndex) {
        const ratio = (beatIndex - curr.beatIndex) / (next.beatIndex - curr.beatIndex);
        return curr.timeSec + ratio * (next.timeSec - curr.timeSec);
      }
    }

    return a0.timeSec;
  }

  /**
   * アンカー i から i+1 の区間における平均BPMを計算
   */
  _segmentBpm(i) {
    const curr = this.anchors[i];
    const next = this.anchors[i + 1];
    const db = next.beatIndex - curr.beatIndex;
    const dt = next.timeSec - curr.timeSec;
    return dt > 0 ? (60 * db) / dt : curr.localBpm;
  }

  /**
   * timeSec における局所BPMを返す
   */
  localBpmAt(timeSec) {
    if (this.anchors.length === 0) return this.defaultBpm;
    if (this.anchors.length === 1 || this.mode === 'rigid') return this.anchors[0].localBpm;

    if (timeSec <= this.anchors[0].timeSec) {
      return this._segmentBpm(0);
    }
    const lastIdx = this.anchors.length - 1;
    if (timeSec >= this.anchors[lastIdx].timeSec) {
      return this._segmentBpm(lastIdx - 1);
    }

    for (let i = 0; i < this.anchors.length - 1; i++) {
      if (timeSec >= this.anchors[i].timeSec && timeSec <= this.anchors[i + 1].timeSec) {
        return this._segmentBpm(i);
      }
    }
    return this.anchors[0].localBpm;
  }

  /**
   * 拍内の位相 (0.0 以上 1.0 未満の少数値)
   */
  beatPhaseAt(timeSec) {
    const beat = this.beatAtTime(timeSec);
    return ((beat % 1) + 1) % 1;
  }

  /**
   * beatIndex に対応する拍子セグメントを返す
   */
  _meterSegmentAt(beatIndex) {
    if (this.meterSegments.length === 0) {
      return { startBeat: 0, numerator: 4, denominator: 4, beatUnit: 'quarter' };
    }
    for (let i = this.meterSegments.length - 1; i >= 0; i--) {
      if (beatIndex >= this.meterSegments[i].startBeat) {
        return this.meterSegments[i];
      }
    }
    return this.meterSegments[0];
  }

  /**
   * timeSec における小節情報 { bar, beatInBar } を返す
   */
  barAtTime(timeSec) {
    const beatIndex = this.beatAtTime(timeSec);
    const relativeBeat = beatIndex - this.barOriginBeatIndex;

    if (this.meterSegments.length <= 1) {
      const meter = this._meterSegmentAt(beatIndex);
      const num = meter.numerator;
      // 弱起に対応するため、負の相対拍に対しても正しい小節・拍数を算出する
      const barFloat = relativeBeat / num;
      const bar = Math.floor(barFloat) + 1;
      const beatInBar = ((relativeBeat % num) + num) % num + 1;
      return { bar, beatInBar };
    }

    // 複数拍子セグメントがある場合の累積計算
    let accumulatedBars = 0;
    let currentBeat = this.barOriginBeatIndex;

    // beatIndex が最初のセグメントより前の場合は負の範囲として外操
    if (beatIndex < this.meterSegments[0].startBeat) {
      const meter = this.meterSegments[0];
      const num = meter.numerator;
      const beatsBefore = beatIndex - currentBeat;
      const barsBefore = Math.floor(beatsBefore / num);
      const beatInBar = ((beatsBefore % num) + num) % num + 1;
      return {
        bar: barsBefore + 1,
        beatInBar
      };
    }

    for (let i = 0; i < this.meterSegments.length; i++) {
      const meter = this.meterSegments[i];
      const nextSegmentStart = (i + 1 < this.meterSegments.length) ? this.meterSegments[i + 1].startBeat : Infinity;
      const num = meter.numerator;

      if (beatIndex < nextSegmentStart) {
        const beatsInSeg = beatIndex - currentBeat;
        const barsInSeg = Math.floor(beatsInSeg / num);
        const beatInBar = ((beatsInSeg % num) + num) % num + 1;
        return {
          bar: accumulatedBars + barsInSeg + 1,
          beatInBar
        };
      } else {
        const beatsInSeg = nextSegmentStart - currentBeat;
        accumulatedBars += Math.floor(beatsInSeg / num);
        currentBeat = nextSegmentStart;
      }
    }

    return { bar: 1, beatInBar: 1 };
  }

  /**
   * 小節番号 bar (1-indexed) からその小節の開始拍 (beatIndex) を返す
   */
  beatAtBar(bar) {
    if (bar <= 1) return this.barOriginBeatIndex;
    
    let currentBeat = this.barOriginBeatIndex;
    let accumulatedBars = 0;
    
    for (let i = 0; i < this.meterSegments.length; i++) {
      const meter = this.meterSegments[i];
      const nextSegmentStart = (i + 1 < this.meterSegments.length) ? this.meterSegments[i + 1].startBeat : Infinity;
      const num = meter.numerator;

      if (nextSegmentStart === Infinity) {
        const barsNeeded = bar - 1 - accumulatedBars;
        return currentBeat + barsNeeded * num;
      }
      
      const beatsInSeg = nextSegmentStart - currentBeat;
      const barsInSeg = Math.floor(beatsInSeg / num);
      
      if (accumulatedBars + barsInSeg >= bar - 1) {
        const barsNeeded = bar - 1 - accumulatedBars;
        return currentBeat + barsNeeded * num;
      }
      
      accumulatedBars += barsInSeg;
      currentBeat = nextSegmentStart;
    }
    
    return this.barOriginBeatIndex;
  }


  /**
   * 次の拍/小節/フレーズ境界の秒数を返す
   */
  nextBoundary(timeSec, unit = 'beat') {
    const beatIndex = this.beatAtTime(timeSec);
    const meter = this._meterSegmentAt(beatIndex);
    const num = meter.numerator;

    let targetBeat;
    if (unit === 'beat') {
      targetBeat = Math.floor(beatIndex) + 1;
    } else if (unit === 'bar') {
      const relBeat = beatIndex - this.barOriginBeatIndex;
      const currentBarStartRel = Math.floor(relBeat / num) * num;
      targetBeat = this.barOriginBeatIndex + currentBarStartRel + num;
    } else if (unit === 'phrase') {
      // フレーズ長は通常 4小節（または16小節）
      const phraseLengthBars = 4;
      const beatsInPhrase = num * phraseLengthBars;
      const relBeat = beatIndex - this.barOriginBeatIndex;
      const currentPhraseStartRel = Math.floor(relBeat / beatsInPhrase) * beatsInPhrase;
      targetBeat = this.barOriginBeatIndex + currentPhraseStartRel + beatsInPhrase;
    } else {
      targetBeat = Math.floor(beatIndex) + 1;
    }

    return this.timeAtBeat(targetBeat);
  }

  /**
   * 量子化吸着
   */
  quantizeTime(timeSec, resolutionBeats = 1) {
    const beatIndex = this.beatAtTime(timeSec);
    const quantizedBeat = Math.round(beatIndex / resolutionBeats) * resolutionBeats;
    return this.timeAtBeat(quantizedBeat);
  }
}
