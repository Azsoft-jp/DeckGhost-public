// ===== KeylockProcessor: テンポ変更時に音程を維持する粒状ピッチシフタ =====
//
// DeckはAudioBufferSourceNodeのplaybackRateでテンポを変えるため、
// 速度を上げると音程も上がってしまう(リサンプリング)。
// この Worklet を出力段に挿入し、逆比 (1/tempo) だけ音程を戻すことで
// 「テンポは変わるが音程は元のまま」= DJのキーロックを実現する。
//
// アルゴリズム: 2タップ・クロスフェード遅延線による連続ピッチシフト。
// grainSize/2 ずらした2つの読み出しヘッドを三角窓でクロスフェードし、
// 読み出し位相を (1-ratio) で進めることで出力音程を ratio 倍にする。
// (ratio<1 で音程ダウン → テンポを上げた時の補正)

const GRAIN = 2048;           // 粒サイズ (~46ms @44.1k)。低域の保持と過渡のにじみの妥協点
const HALF = GRAIN / 2;
const RING = 4096;            // GRAIN + HALF + 余白を包含する2のべき乗
const MASK = RING - 1;

class KeylockProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.rings = [new Float32Array(RING), new Float32Array(RING)];
    this.wp = 0;
    this.phase = 0;
    this.wet = 0; // ドライ(素通し)↔ウェット(粒処理)の平滑ミックス
  }

  _interp(r, pos) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = r[i0 & MASK];
    const b = r[(i0 + 1) & MASK];
    return a + (b - a) * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) { for (const ch of output) ch.fill(0); return true; }
    const nCh = output.length;
    const blockLen = output[0].length;
    const ratioParam = arguments[2].ratio;
    const rings = this.rings;
    let wp = this.wp, phase = this.phase, wet = this.wet;

    for (let i = 0; i < blockLen; i++) {
      const ratio = ratioParam.length > 1 ? ratioParam[i] : ratioParam[0];
      const targetWet = Math.abs(ratio - 1) < 0.002 ? 0 : 1; // 補正不要時は素通し(コムフィルタ回避)
      wet += (targetWet - wet) * 0.002;

      for (let c = 0; c < nCh; c++) {
        rings[c][wp & MASK] = (input[Math.min(c, input.length - 1)] || EMPTY)[i] || 0;
      }
      phase += (1 - ratio);
      if (phase >= GRAIN) phase -= GRAIN; else if (phase < 0) phase += GRAIN;
      const n = phase / GRAIN;
      let m = n + 0.5; if (m >= 1) m -= 1;
      const g1 = 1 - Math.abs(2 * n - 1); // 三角窓 (g1+g2=1)
      const g2 = 1 - Math.abs(2 * m - 1);
      const d1 = phase + 1;
      const d2 = phase + HALF + 1;

      for (let c = 0; c < nCh; c++) {
        const r = rings[c];
        const dry = r[wp & MASK];
        const wetOut = g1 * this._interp(r, wp - d1) + g2 * this._interp(r, wp - d2);
        output[c][i] = dry * (1 - wet) + wetOut * wet;
      }
      wp++;
    }
    this.wp = wp; this.phase = phase; this.wet = wet;
    return true;
  }
}

const EMPTY = new Float32Array(128);
registerProcessor('keylock-processor', KeylockProcessor);
