// ===== ScratchProcessor: アナログスクラッチ用の可変速(符号付き)プレイヤー =====
//
// AudioBufferSourceNode の playbackRate は負値(逆再生)を取れないため、
// スクラッチ中はこの Worklet がバッファ窓を直接読む。
// - velocity: 再生速度 (1.0=通常, 0=停止, 負=逆回し)。ターゲットに向けて
//   サンプル単位で平滑化し、ビニールの慣性感を出す。
// - メインスレッドからは現在位置±8秒の窓だけ転送し、端へ近づくと窓を更新する。

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.pos = 0;        // 窓内サンプル位置 (小数)
    this.vel = 0;        // 現在速度
    this.target = 0;     // 目標速度
    this.active = false;
    this.blockCount = 0;
    this.generation = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'load') {
        this.channels = d.channels;
        this.pos = d.pos;
        this.vel = d.vel || 0;
        this.target = d.vel || 0;
        this.generation = d.generation || 0;
        this.active = true;
      } else if (d.type === 'vel') {
        this.target = d.v;
      } else if (d.type === 'stop') {
        this.active = false;
        this.port.postMessage({ type: 'pos', pos: this.pos, final: true, generation: this.generation });
        this.channels = null;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.active || !this.channels) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const n = out[0].length;
    const len = this.channels[0].length;
    for (let i = 0; i < n; i++) {
      // 速度平滑化: 時定数 ~10ms — 手の動きに追従しつつカクつかない
      this.vel += (this.target - this.vel) * 0.002;
      const i0 = Math.floor(this.pos);
      const f = this.pos - i0;
      for (let c = 0; c < out.length; c++) {
        const d = this.channels[Math.min(c, this.channels.length - 1)];
        const a = d[i0] || 0;
        const b = d[i0 + 1] || 0;
        out[c][i] = a + (b - a) * f;
      }
      this.pos += this.vel;
      if (this.pos < 0) { this.pos = 0; this.vel = 0; if (this.target < 0) this.target = 0; }
      if (this.pos >= len - 1) { this.pos = len - 1; this.vel = 0; if (this.target > 0) this.target = 0; }
    }
    // 位置を定期報告 (~46ms間隔) — 波形/ジョグ描画用
    if (++this.blockCount % 16 === 0) {
      this.port.postMessage({ type: 'pos', pos: this.pos, generation: this.generation });
    }
    return true;
  }
}

registerProcessor('scratch-processor', ScratchProcessor);
