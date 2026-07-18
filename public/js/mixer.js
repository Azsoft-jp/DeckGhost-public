// ===== Mixer: DJM相当の2chミキサー (TRIM/3band EQ/COLOR FX/フェーダー/クロスフェーダー) =====

const EQ_MIN_DB = -40; // ノブ最小でほぼキル

export class Channel {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();

    this.trim = ctx.createGain();

    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 120;

    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.7;

    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 8500;

    // COLOR FX (1ノブフィルター: 左=LPF / 右=HPF)
    this.hpf = ctx.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 10;
    this.hpf.Q.value = 0.9;
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = 0.9;

    this.fader = ctx.createGain();
    this.xfGain = ctx.createGain(); // クロスフェーダーによる係数
    this.values = {
      trim: 1,
      high: 0.5,
      mid: 0.5,
      low: 0.5,
      color: 0,
      fader: 1,
    };

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this._vuBuf = new Uint8Array(this.analyser.fftSize);

    // CUE (PFL) 送り: EQ後・フェーダー前からヘッドホンモニターへ
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    this.cueOn = false;

    this.input.connect(this.trim);
    this.trim.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.hpf);
    this.hpf.connect(this.lpf);
    this.lpf.connect(this.fader);
    this.lpf.connect(this.cueSend);
    this.fader.connect(this.xfGain);
    this.fader.connect(this.analyser);

    // FXインサート用: fader → [FX] → xfGain を差し替え可能に
    this._insert = null;
  }

  /** CUE (PFL): フェーダー位置に関係なく EQ後の音をモニターバスへ送る */
  setCue(on) {
    this.cueOn = !!on;
    this.cueSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** 出力ノード (→ マスターバスに接続する) */
  get output() { return this.xfGain; }

  setTrim(v) {
    this.values.trim = Math.max(0, Math.min(1.4, v));
    this.trim.gain.setTargetAtTime(this.values.trim, this.ctx.currentTime, 0.01);
  }

  /** EQ: v=0..1 (0.5センター)。下半分は -40dB(キル)まで、上半分は +6dB まで */
  setEq(band, v) {
    v = Math.max(0, Math.min(1, v));
    this.values[band] = v;
    const d = (v - 0.5) * 2;
    const db = d < 0 ? d * -EQ_MIN_DB : d * 6;
    this[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
  }

  /** COLOR: v=-1..+1。負: LPF 20k→150Hz / 正: HPF 10→8kHz (指数カーブ) */
  setColor(v) {
    v = Math.max(-1, Math.min(1, v));
    this.values.color = v;
    const t = this.ctx.currentTime;
    if (v < -0.02) {
      const f = 20000 * Math.pow(150 / 20000, -v);
      this.lpf.frequency.setTargetAtTime(f, t, 0.02);
      this.hpf.frequency.setTargetAtTime(10, t, 0.02);
    } else if (v > 0.02) {
      const f = 10 * Math.pow(8000 / 10, v);
      this.hpf.frequency.setTargetAtTime(f, t, 0.02);
      this.lpf.frequency.setTargetAtTime(20000, t, 0.02);
    } else {
      this.lpf.frequency.setTargetAtTime(20000, t, 0.02);
      this.hpf.frequency.setTargetAtTime(10, t, 0.02);
    }
  }

  setFader(v) {
    this.values.fader = Math.max(0, Math.min(1, v));
    this.fader.gain.setTargetAtTime(this.values.fader * this.values.fader, this.ctx.currentTime, 0.01);
  } // 2乗カーブ

  /** VUレベル (0..1) */
  getLevel() {
    this.analyser.getByteTimeDomainData(this._vuBuf);
    let sum = 0;
    for (let i = 0; i < this._vuBuf.length; i += 2) {
      const v = (this._vuBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / (this._vuBuf.length / 2)) * 2.2);
  }

  /** FXインサート: fader→fx.input, fx.output→xfGain */
  setInsert(fx) {
    if (this._insert === fx) return;
    this.fader.disconnect();
    this.fader.connect(this.analyser);
    if (this._insert) this._insert.output.disconnect(this.xfGain);
    if (fx) {
      this.fader.connect(fx.input);
      fx.output.connect(this.xfGain);
    } else {
      this.fader.connect(this.xfGain);
    }
    this._insert = fx;
  }
}

export class Mixer {
  constructor(ctx) {
    this.ctx = ctx;
    this.chA = new Channel(ctx);
    this.chB = new Channel(ctx);

    this.masterSum = ctx.createGain();
    this.masterInsertOut = ctx.createGain(); // FXマスターインサートの出力先
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.9;
    this.safetyGain = ctx.createGain();
    this.safetyGain.gain.value = 1;

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this._vuBuf = new Uint8Array(this.masterAnalyser.fftSize);
    this._safetyBuf = new Float32Array(this.masterAnalyser.fftSize);
    this.safety = { enabled: true, gain: 1, peak: 0, reduction: 0, clipEvents: 0, lastClipAt: -Infinity, warning: false };

    this.chA.output.connect(this.masterSum);
    this.chB.output.connect(this.masterSum);
    this.masterSum.connect(this.masterInsertOut); // FX未挿入時は素通し
    this.masterInsertOut.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(this.safetyGain);
    this.safetyGain.connect(this.masterAnalyser);
    this.safetyGain.connect(ctx.destination);

    // CUEモニターバス: 各chのPFL + マスターCUE → MediaStreamDestination。
    // メイン出力とは別の <audio> 要素 + setSinkId() で任意の出力デバイスへ送る。
    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = 1;
    this.masterCueSend = ctx.createGain();
    this.masterCueSend.gain.value = 0;
    this.masterCueOn = false;
    this.safetyGain.connect(this.masterCueSend);
    this.chA.cueSend.connect(this.cueBus);
    this.chB.cueSend.connect(this.cueBus);
    this.masterCueSend.connect(this.cueBus);
    this.cueDest = ctx.createMediaStreamDestination();
    this.cueBus.connect(this.cueDest);

    this._masterInsert = null;
    this.xf = 0; // -1 (A) .. +1 (B)
    this.setCrossfader(0);
  }

  get cueStream() { return this.cueDest.stream; }
  get output() { return this.safetyGain; }

  setSafetyEnabled(on) {
    this.safety.enabled = !!on;
    if (!on) {
      this.safety.gain = 1;
      this.safetyGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
    }
  }

  tickSafety(now = this.ctx.currentTime) {
    this.masterAnalyser.getFloatTimeDomainData(this._safetyBuf);
    let peak = 0;
    for (let i = 0; i < this._safetyBuf.length; i++) peak = Math.max(peak, Math.abs(this._safetyBuf[i]));
    this.safety.peak = peak;
    this.safety.reduction = Number.isFinite(this.limiter.reduction) ? this.limiter.reduction : 0;
    const overloaded = peak >= 0.985 || this.safety.reduction <= -8;
    if (overloaded) {
      if (now - this.safety.lastClipAt > 0.12) {
        this.safety.clipEvents++;
        this.safety.lastClipAt = now;
      }
      if (this.safety.enabled && this.safety.clipEvents >= 3) {
        this.safety.gain = Math.max(0.6, this.safety.gain - 0.025);
        this.safetyGain.gain.setTargetAtTime(this.safety.gain, now, 0.08);
        this.safety.clipEvents = 0;
      }
    } else if (now - this.safety.lastClipAt > 5) {
      this.safety.clipEvents = 0;
      if (this.safety.enabled && this.safety.gain < 1) {
        this.safety.gain = Math.min(1, this.safety.gain + 0.001);
        this.safetyGain.gain.setTargetAtTime(this.safety.gain, now, 0.5);
      }
    }
    this.safety.warning = peak >= 0.985 || this.safety.reduction <= -6 || this.safety.gain < 0.995;
    return { ...this.safety };
  }

  setMasterCue(on) {
    this.masterCueOn = !!on;
    this.masterCueSend.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  setCueVolume(v) {
    this.cueBus.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), this.ctx.currentTime, 0.01);
  }

  /** クロスフェーダー: 等パワーカーブ */
  setCrossfader(v) {
    this.xf = Math.max(-1, Math.min(1, v));
    const t = (this.xf + 1) / 2; // 0..1
    const gA = Math.cos(t * Math.PI / 2);
    const gB = Math.sin(t * Math.PI / 2);
    const now = this.ctx.currentTime;
    this.chA.xfGain.gain.setTargetAtTime(gA, now, 0.008);
    this.chB.xfGain.gain.setTargetAtTime(gB, now, 0.008);
  }

  setMasterInsert(fx) {
    if (this._masterInsert === fx) return;
    this.masterSum.disconnect();
    if (this._masterInsert) this._masterInsert.output.disconnect(this.masterInsertOut);
    if (fx) {
      this.masterSum.connect(fx.input);
      fx.output.connect(this.masterInsertOut);
    } else {
      this.masterSum.connect(this.masterInsertOut);
    }
    this._masterInsert = fx;
  }

  getMasterLevel() {
    this.masterAnalyser.getByteTimeDomainData(this._vuBuf);
    let sum = 0;
    for (let i = 0; i < this._vuBuf.length; i += 2) {
      const v = (this._vuBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / (this._vuBuf.length / 2)) * 2.0);
  }

  channel(id) { return id === 'A' ? this.chA : this.chB; }
}
