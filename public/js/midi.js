// ===== Web MIDI 入出力 / MIDI Learn / MIDI Clock =====

const STORE_KEY = 'deckghost-midi-map-v1';

const ACTIONS = [
  ['deckA.play', 'Deck A PLAY'],
  ['deckA.cue', 'Deck A CUE'],
  ['deckA.sync', 'Deck A SYNC'],
  ['deckA.fader', 'Deck A FADER'],
  ['deckA.eq.low', 'Deck A LOW'],
  ['deckA.eq.mid', 'Deck A MID'],
  ['deckA.eq.high', 'Deck A HIGH'],
  ['deckA.color', 'Deck A COLOR'],
  ['deckB.play', 'Deck B PLAY'],
  ['deckB.cue', 'Deck B CUE'],
  ['deckB.sync', 'Deck B SYNC'],
  ['deckB.fader', 'Deck B FADER'],
  ['deckB.eq.low', 'Deck B LOW'],
  ['deckB.eq.mid', 'Deck B MID'],
  ['deckB.eq.high', 'Deck B HIGH'],
  ['deckB.color', 'Deck B COLOR'],
  ['mixer.xfader', 'Crossfader'],
  ['fx.depth', 'FX DEPTH'],
  ['fx.param', 'FX PARAM'],
  ['fx.on', 'FX ON/OFF'],
  ['automix.toggle', 'AUTO MIX ON/OFF'],
];

const DEFAULT_MAP = {
  'cc:0:1': 'deckA.eq.low',
  'cc:0:2': 'deckA.eq.mid',
  'cc:0:3': 'deckA.eq.high',
  'cc:0:4': 'deckA.color',
  'cc:0:7': 'deckA.fader',
  'note:0:60': 'deckA.play',
  'note:0:61': 'deckA.cue',
  'note:0:62': 'deckA.sync',

  'cc:1:1': 'deckB.eq.low',
  'cc:1:2': 'deckB.eq.mid',
  'cc:1:3': 'deckB.eq.high',
  'cc:1:4': 'deckB.color',
  'cc:1:7': 'deckB.fader',
  'note:1:60': 'deckB.play',
  'note:1:61': 'deckB.cue',
  'note:1:62': 'deckB.sync',

  'cc:15:10': 'mixer.xfader',
  'cc:15:20': 'fx.depth',
  'cc:15:21': 'fx.param',
  'note:15:64': 'fx.on',
  'note:15:65': 'automix.toggle',
};

export class MidiController {
  constructor({ decks, mixer, fx, planner, onStatus }) {
    this.decks = decks;
    this.mixer = mixer;
    this.fx = fx;
    this.planner = planner;
    this.onStatus = onStatus || (() => {});
    this.access = null;
    this.input = null;
    this.output = null;
    this.enabled = false;
    this.clockEnabled = false;
    this.learning = null;
    this.map = { ...DEFAULT_MAP, ...loadMap() };
    this.lastClockAt = 0;
    this.clockRemainder = 0;
    this.lastFeedback = new Map();
  }

  get supported() { return 'requestMIDIAccess' in navigator; }
  get actions() { return ACTIONS; }

  async init() {
    if (!this.supported) {
      this.onStatus('このブラウザはWeb MIDI APIに対応していません');
      return false;
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.onStatus('MIDIデバイス構成が変わりました');
    this.enabled = true;
    this.onStatus('MIDIを有効化しました');
    return true;
  }

  inputs() { return this.access ? Array.from(this.access.inputs.values()) : []; }
  outputs() { return this.access ? Array.from(this.access.outputs.values()) : []; }

  setInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.inputs().find((d) => d.id === id) || null;
    if (this.input) {
      this.input.onmidimessage = (ev) => this._onMessage(ev);
      this.onStatus(`MIDI IN: ${this.input.name}`);
    }
  }

  setOutput(id) {
    this.output = this.outputs().find((d) => d.id === id) || null;
    if (this.output) this.onStatus(`MIDI OUT: ${this.output.name}`);
  }

  startLearn(action) {
    this.learning = action || null;
    if (this.learning) this.onStatus(`MIDI Learn待機: ${labelOf(this.learning)}`);
  }

  clearLearned() {
    this.map = { ...DEFAULT_MAP };
    localStorage.removeItem(STORE_KEY);
    this.onStatus('MIDI Learn設定をリセットしました');
  }

  setClockEnabled(on) {
    this.clockEnabled = !!on;
    this.lastClockAt = performance.now();
    this.clockRemainder = 0;
    if (this.output) this.output.send([on ? 0xfa : 0xfc]);
    this.onStatus(on ? 'MIDI Clock OUTを開始しました' : 'MIDI Clock OUTを停止しました');
  }

  tick(nowMs, bpm) {
    if (!this.output) return;
    if (this.clockEnabled && bpm > 0) this._tickClock(nowMs, bpm);
    else {
      this.lastClockAt = nowMs;
      this.clockRemainder = 0;
    }
    this._sendFeedback();
  }

  _onMessage(ev) {
    if (!this.enabled) return;
    const [status, d1, d2 = 0] = ev.data;
    const type = status & 0xf0;
    const ch = status & 0x0f;
    const key = type === 0xb0 ? `cc:${ch}:${d1}` : (type === 0x90 || type === 0x80) ? `note:${ch}:${d1}` : null;
    if (!key) return;

    const isNoteOff = type === 0x80 || (type === 0x90 && d2 === 0);
    if (this.learning) {
      this.map[key] = this.learning;
      saveMap(stripDefaults(this.map));
      this.onStatus(`MIDI Learn: ${labelOf(this.learning)} ← ${formatKey(key)}`);
      this.learning = null;
      return;
    }

    const action = this.map[key];
    if (!action) return;
    if (key.startsWith('note:') && isNoteOff) return;
    const value = key.startsWith('cc:') ? d2 / 127 : d2 > 0 ? 1 : 0;
    this._dispatch(action, value);
  }

  _dispatch(action, value) {
    const deckAction = (side, op) => {
      const deck = this.decks[side];
      const ch = this.mixer.channel(side);
      // UI/キーボードと同じ経路を通し、AutoMIX中のPause時計も確実に止める。
      if (op === 'play') {
        if (deck.manualTogglePlayback) deck.manualTogglePlayback();
        else deck.togglePlay();
      } else if (op === 'cue') {
        if (deck.manualPressCue) deck.manualPressCue();
        else deck.pressCue();
      } else if (op === 'sync') deck.syncTo(this.decks[side === 'A' ? 'B' : 'A']);
      else if (op === 'fader') ch.setFader(value);
      else if (op.startsWith('eq.')) ch.setEq(op.slice(3), value);
      else if (op === 'color') ch.setColor(value * 2 - 1);
    };
    if (action.startsWith('deckA.')) deckAction('A', action.slice(6));
    else if (action.startsWith('deckB.')) deckAction('B', action.slice(6));
    else if (action === 'mixer.xfader') this.mixer.setCrossfader(value * 2 - 1);
    else if (action === 'fx.depth') this.fx.setDepth(value);
    else if (action === 'fx.param') this.fx.setParam(value);
    else if (action === 'fx.on') this.fx.setOn(!this.fx.on);
    else if (action === 'automix.toggle') this.planner.setEnabled(!this.planner.enabled);
  }

  _tickClock(nowMs, bpm) {
    const interval = 60000 / (bpm * 24);
    const elapsed = Math.max(0, nowMs - this.lastClockAt) + this.clockRemainder;
    const pulses = Math.min(24, Math.floor(elapsed / interval));
    this.clockRemainder = elapsed - pulses * interval;
    this.lastClockAt = nowMs;
    for (let i = 0; i < pulses; i++) this.output.send([0xf8]);
  }

  _sendFeedback() {
    const states = [
      ['note:0:60', this.decks.A.playing],
      ['note:1:60', this.decks.B.playing],
      ['note:15:65', this.planner.enabled],
      ['note:15:64', this.fx.on],
    ];
    for (const [key, on] of states) {
      if (this.lastFeedback.get(key) === on) continue;
      this.lastFeedback.set(key, on);
      const [, ch, note] = key.split(':').map(Number);
      this.output.send([0x90 | ch, note, on ? 127 : 0]);
    }
  }
}

function labelOf(action) {
  return ACTIONS.find(([id]) => id === action)?.[1] || action;
}

function formatKey(key) {
  const [type, ch, num] = key.split(':');
  return `${type.toUpperCase()} ch${Number(ch) + 1} #${num}`;
}

function loadMap() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch (e) { return {}; }
}

function saveMap(map) {
  localStorage.setItem(STORE_KEY, JSON.stringify(map));
}

function stripDefaults(map) {
  const out = {};
  for (const [key, action] of Object.entries(map)) {
    if (DEFAULT_MAP[key] !== action) out[key] = action;
  }
  return out;
}
