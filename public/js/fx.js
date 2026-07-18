// ===== FXUnit: DJM BEAT FX 相当のエフェクトユニット =====
// タイプ: ECHO / DELAY / REVERB / FLANGER / PHASER / FILTER / LPF / HPF /
//         CRUSH / ROLL / GATE / DISTORTION / NOISE / BACKSPIN
// 拍同期 (BEATボタン 1/8〜4拍) + ASSIGN (A/B/MASTER) + LEVEL/DEPTH

export const FX_TYPES = ['ECHO', 'DELAY', 'REVERB', 'FLANGER', 'PHASER', 'FILTER', 'LPF', 'HPF', 'CRUSH', 'ROLL', 'GATE', 'DISTORTION', 'NOISE', 'BACKSPIN'];
export const FX_BEATS = [0.0625, 0.125, 0.25, 0.5, 0.75, 1, 2, 4];

// インサート系 (ONでドライを depth ぶん減衰させるタイプ)
const INSERT_TYPES = new Set(['FLANGER', 'PHASER', 'FILTER', 'LPF', 'HPF', 'CRUSH', 'ROLL', 'GATE', 'DISTORTION']);
// 原音と並列にすると処理を迂回した音が漏れる直列インサート。
const SERIAL_TYPES = new Set(['FILTER', 'LPF', 'HPF', 'DISTORTION']);

/** LPF/HPFのDEPTHを聴感に近い対数カーブのカットオフ周波数へ変換する。 */
export function toneFilterCutoff(type, depth) {
  const value = Math.max(0, Math.min(1, depth));
  if (type === 'LPF') return 20000 * Math.pow(150 / 20000, value);
  if (type === 'HPF') return 20 * Math.pow(12000 / 20, value);
  return 20000;
}

export class FXUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;

    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.wet.connect(this.output);

    this.type = 'ECHO';
    this.beats = 0.5;
    this.bpm = 128;          // 同期BPM (アサイン先デッキから毎フレーム更新)
    this.on = false;
    this.depth = 0.5;        // LEVEL/DEPTHノブ
    this.param = 0.5;        // TIME/PARAMノブ (タイプ毎の第2パラメータ)
    this.wetOnly = false;    // true時は原音を完全ミュートし、処理済み音だけを出す
    this._rollCaptureToken = 0;

    this._nodes = [];        // 現タイプのウェットチェーン
    this._sources = [];      // ノイズ等の自走ソース
    this._lfo = null;
    this._buildChain();
  }

  beatTime() { return (60 / Math.max(60, this.bpm)) * this.beats; }

  /* ---------- チェーン構築 ---------- */
  _clearChain() {
    if (this._lfo) { try { this._lfo.stop(); } catch (e) {} this._lfo = null; }
    for (const n of this._nodes) { try { n.disconnect(); } catch (e) {} }
    for (const s of this._sources) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }
    this._nodes = [];
    this._sources = [];
    try { this.input.disconnect(this.dry); } catch (e) {}
    this.input.disconnect();
    this.input.connect(this.dry);
  }

  _buildChain() {
    this._clearChain();
    const ctx = this.ctx;
    const t = this.beatTime();

    switch (this.type) {
      case 'ECHO':
      case 'DELAY': {
        const delay = ctx.createDelay(4);
        delay.delayTime.value = t;
        const fb = ctx.createGain();
        fb.gain.value = this.type === 'ECHO' ? 0.55 : 0.35;
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 6000;
        this.input.connect(delay);
        delay.connect(tone);
        tone.connect(fb);
        fb.connect(delay);
        delay.connect(this.wet);
        this._delay = delay; this._fb = fb;
        this._nodes = [delay, fb, tone];
        break;
      }
      case 'REVERB': {
        const conv = ctx.createConvolver();
        conv.buffer = makeImpulse(ctx, 2.5 + this.param * 5.5, 1.8 + this.param * 2.2);
        this.input.connect(conv);
        conv.connect(this.wet);
        this._nodes = [conv];
        break;
      }
      case 'FLANGER': {
        const delay = ctx.createDelay(0.05);
        delay.delayTime.value = 0.004;
        const fb = ctx.createGain();
        fb.gain.value = 0.55;
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 0.25 + this.param * 2;
        lfoGain.gain.value = 0.0028;
        lfo.connect(lfoGain);
        lfoGain.connect(delay.delayTime);
        lfo.start();
        this.input.connect(delay);
        delay.connect(fb);
        fb.connect(delay);
        delay.connect(this.wet);
        this._lfo = lfo;
        this._nodes = [delay, fb, lfoGain];
        break;
      }
      case 'PHASER': {
        const stages = [];
        let node = this.input;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.2 + this.param * 1.5;
        lfo.start();
        for (let i = 0; i < 4; i++) {
          const ap = ctx.createBiquadFilter();
          ap.type = 'allpass';
          ap.frequency.value = 300 * (i + 1);
          ap.Q.value = 0.6;
          const lg = ctx.createGain();
          lg.gain.value = 250 * (i + 1);
          lfo.connect(lg);
          lg.connect(ap.frequency);
          node.connect(ap);
          node = ap;
          stages.push(ap, lg);
        }
        node.connect(this.wet);
        this._lfo = lfo;
        this._nodes = stages;
        break;
      }
      case 'FILTER': {
        // 拍同期LPFスイープ
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.Q.value = 4 + this.param * 10;
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.frequency.value = 1 / Math.max(0.1, t * 4);
        lg.gain.value = 3500;
        filt.frequency.value = 3800;
        lfo.connect(lg);
        lg.connect(filt.frequency);
        lfo.start();
        this.input.connect(filt);
        filt.connect(this.wet);
        this._lfo = lfo;
        this._filter = filt; this._lfoGain = lg;
        this._nodes = [filt, lg];
        break;
      }
      case 'LPF':
      case 'HPF': {
        const filt = ctx.createBiquadFilter();
        filt.type = this.type === 'LPF' ? 'lowpass' : 'highpass';
        filt.frequency.value = toneFilterCutoff(this.type, this.depth);
        filt.Q.value = 0.7 + this.param * 9.3;
        this.input.connect(filt);
        filt.connect(this.wet);
        this._toneFilter = filt;
        this._nodes = [filt];
        break;
      }
      case 'CRUSH': {
        const shaper = ctx.createWaveShaper();
        shaper.curve = makeCrushCurve(2 + Math.round((1 - this.param) * 6));
        shaper.oversample = 'none';
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2500 + this.param * 8000;
        this.input.connect(shaper);
        shaper.connect(lp);
        lp.connect(this.wet);
        this._nodes = [shaper, lp];
        break;
      }
      case 'ROLL': {
        // 直近の拍を捕まえてループ (キャプチャディレイ)
        const gate = ctx.createGain();
        gate.gain.value = 1;
        const delay = ctx.createDelay(4);
        delay.delayTime.value = t;
        const fb = ctx.createGain();
        fb.gain.value = 0; // ON時に1.0へ
        this.input.connect(gate);
        gate.connect(delay);
        delay.connect(fb);
        fb.connect(delay);
        delay.connect(this.wet);
        this._gate = gate; this._delay = delay; this._fb = fb;
        this._nodes = [gate, delay, fb];
        break;
      }
      case 'GATE': {
        const gate = ctx.createGain();
        gate.gain.value = 0.5;
        const lfo = ctx.createOscillator();
        lfo.type = 'sawtooth';
        lfo.frequency.value = 1 / Math.max(0.02, t);
        const dutyShape = ctx.createWaveShaper();
        dutyShape.curve = makeGateCurve(0.15 + this.param * 0.85);
        const amount = ctx.createGain();
        amount.gain.value = 0.5;
        lfo.connect(dutyShape);
        dutyShape.connect(amount);
        amount.connect(gate.gain);
        lfo.start();
        this.input.connect(gate);
        gate.connect(this.wet);
        this._lfo = lfo; this._gateShape = dutyShape;
        this._nodes = [gate, dutyShape, amount];
        break;
      }
      case 'DISTORTION': {
        const drive = ctx.createWaveShaper();
        drive.curve = makeDistortionCurve(2 + this.param * 38);
        drive.oversample = '4x';
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.frequency.value = 3500 + (1 - this.param) * 7000;
        const makeup = ctx.createGain();
        makeup.gain.value = 0.5; // 約-6dB。歪みによるレベル増加を抑える
        this.input.connect(drive);
        drive.connect(tone);
        tone.connect(makeup);
        makeup.connect(this.wet);
        this._drive = drive;
        this._distortionTone = tone;
        this._nodes = [drive, tone, makeup];
        break;
      }
      case 'NOISE': {
        const noise = ctx.createBufferSource();
        noise.buffer = makeNoiseBuffer(ctx, 2);
        noise.loop = true;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 400 * Math.pow(15000 / 400, this.param);
        hp.Q.value = 0.8;
        noise.connect(hp);
        hp.connect(this.wet);
        noise.start();
        this._noiseFilter = hp;
        this._sources = [noise];
        this._nodes = [hp];
        break;
      }
    }
  }

  /* ---------- パラメータ ---------- */
  setType(type) {
    this._rollCaptureToken++;
    this.wetOnly = false;
    this.type = type;
    this._buildChain();
    this._applyMix();
  }

  setBeats(b) {
    this.beats = b;
    this._syncTime();
  }

  setBpm(bpm) {
    if (Math.abs(bpm - this.bpm) < 0.05) return;
    this.bpm = bpm;
    this._syncTime();
  }

  _syncTime() {
    const t = this.beatTime();
    const now = this.ctx.currentTime;
    if (this._delay) this._delay.delayTime.setTargetAtTime(t, now, 0.05);
    if (this.type === 'FILTER' && this._lfo) this._lfo.frequency.setTargetAtTime(1 / Math.max(0.1, t * 4), now, 0.05);
    if (this.type === 'GATE' && this._lfo) this._lfo.frequency.setTargetAtTime(1 / Math.max(0.02, t), now, 0.02);
  }

  setDepth(v) {
    this.depth = v;
    if (['LPF', 'HPF'].includes(this.type) && this._toneFilter) {
      this._toneFilter.frequency.setTargetAtTime(
        toneFilterCutoff(this.type, v), this.ctx.currentTime, 0.03,
      );
    }
    this._applyMix();
  }
  setWetOnly(on) { this.wetOnly = !!on; this._applyMix(); }
  setParam(v) {
    this.param = v;
    // LFO系はライブ更新、他は再構築が必要なものだけ再構築
    if (this.type === 'FLANGER' && this._lfo) this._lfo.frequency.value = 0.25 + v * 2;
    else if (this.type === 'PHASER' && this._lfo) this._lfo.frequency.value = 0.2 + v * 1.5;
    else if (this.type === 'FILTER' && this._filter) this._filter.Q.value = 4 + v * 10;
    else if (['LPF', 'HPF'].includes(this.type) && this._toneFilter) this._toneFilter.Q.setTargetAtTime(0.7 + v * 9.3, this.ctx.currentTime, 0.03);
    else if (this.type === 'NOISE' && this._noiseFilter) this._noiseFilter.frequency.setTargetAtTime(400 * Math.pow(15000 / 400, v), this.ctx.currentTime, 0.03);
    else if (this.type === 'GATE' && this._gateShape) this._gateShape.curve = makeGateCurve(0.15 + v * 0.85);
    else if (this.type === 'DISTORTION' && this._drive) {
      this._drive.curve = makeDistortionCurve(2 + v * 38);
      this._distortionTone.frequency.setTargetAtTime(3500 + (1 - v) * 7000, this.ctx.currentTime, 0.03);
    } else if (['CRUSH', 'REVERB'].includes(this.type)) this._buildChain(), this._applyMix();
  }

  setOn(on) {
    this.on = on;
    if (!on) this.wetOnly = false;
    const captureToken = ++this._rollCaptureToken;
    if (this.type === 'ROLL') {
      const now = this.ctx.currentTime;
      if (on) {
        // 1拍ぶん取り込んでからゲートを閉じ、無限ループ化
        this.wetOnly = false;
        this._gate.gain.setValueAtTime(1, now);
        this._gate.gain.setValueAtTime(0, now + this.beatTime());
        this._fb.gain.setValueAtTime(0.98, now);
        setTimeout(() => {
          if (this.on && this.type === 'ROLL' && this._rollCaptureToken === captureToken) {
            this.setWetOnly(true);
          }
        }, this.beatTime() * 1000);
      } else {
        this.wetOnly = false;
        this._gate.gain.setValueAtTime(1, now);
        this._fb.gain.setValueAtTime(0, now);
      }
    }
    this._applyMix();
  }

  _applyMix() {
    const now = this.ctx.currentTime;
    let wet, dry;
    if (!this.on) {
      wet = 0; dry = 1;
    } else {
      // depth をウェット/ドライの等パワークロスフェードとして扱う。
      // 旧実装は送り系(ECHO/DELAY/REVERB)で dry=1 固定のまま wet を足していたため、
      // モニタ(CUE)と無関係に原音とエフェクトが両方フル音量で鳴り、
      // 「原音とエフェクトがダブる」状態になっていた。
      const d = Math.max(0, Math.min(1, this.depth));
      wet = this.type === 'NOISE' ? d * 0.3 : Math.sin(d * Math.PI / 2);
      const dryX = Math.cos(d * Math.PI / 2);
      // インサート系は原音を置換できる。送り系は残響/エコーの土台として原音を
      // 少しだけ残すが、従来のようにフル音量(=ダブり)では鳴らさない。
      dry = this.wetOnly
        ? 0
        : this.type === 'NOISE' ? 1 : INSERT_TYPES.has(this.type) ? dryX : Math.max(dryX, 0.32);
      if (SERIAL_TYPES.has(this.type)) {
        // フィルター/歪みは処理済み信号そのものが出力。Dry並列では処理を迂回する。
        wet = 1;
        dry = 0;
      }
    }
    this.wet.gain.setTargetAtTime(wet, now, 0.03);
    this.dry.gain.setTargetAtTime(dry, now, 0.03);
  }
}

/* ---------- リバーブ用インパルス応答生成 ---------- */
function makeImpulse(ctx, seconds, decay) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* ---------- ビットクラッシュ用カーブ ---------- */
function makeCrushCurve(bits) {
  const steps = Math.pow(2, bits);
  const curve = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const x = (i / 65535) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function makeDistortionCurve(amount) {
  const n = 65536;
  const curve = new Float32Array(n);
  const k = Math.max(1, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return curve;
}

function makeGateCurve(duty) {
  const n = 2048;
  const curve = new Float32Array(n);
  const threshold = 1 - Math.max(0.05, Math.min(1, duty)) * 2;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = x >= threshold ? 1 : -1;
  }
  return curve;
}

function makeNoiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
