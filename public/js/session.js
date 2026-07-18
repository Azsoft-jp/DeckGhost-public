// ===== Session Journal: ミキサー状態の記録・JSON書き出し・決定論リプレイ =====

function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      if (key === 'buffer' || key === '_toTrackRef') return undefined;
      return item;
    }));
  } catch (e) { return null; }
}

export class SessionJournal {
  constructor({ ctx, decks, mixer, planner, getTracks, onState, prepareTrack = null }) {
    Object.assign(this, { ctx, decks, mixer, planner, getTracks, onState, prepareTrack });
    this.active = false;
    this.session = null;
    this.lastCapture = -Infinity;
    this.replay = null;
  }

  start() {
    this.stopReplay();
    this.active = true;
    this.startedAt = this.ctx.currentTime;
    this.lastCapture = -Infinity;
    this.session = {
      app: 'DeckGhost', type: 'session-replay', version: 1,
      createdAt: new Date().toISOString(),
      tracks: this.getTracks().map((t) => ({ id: t.id, name: t.name, sha256: t.sha256, bpm: t.bpm })),
      events: [], snapshots: [],
    };
    this.capture(this.ctx.currentTime, true);
    this.onState?.({ type: 'record', active: true });
  }

  stop() {
    if (!this.active) return this.session;
    this.capture(this.ctx.currentTime, true);
    this.active = false;
    this.session.duration = Math.max(0, this.ctx.currentTime - this.startedAt);
    this.onState?.({ type: 'record', active: false, session: this.session });
    return this.session;
  }

  record(type, payload = {}) {
    if (!this.active) return;
    this.session.events.push({ t: this.ctx.currentTime - this.startedAt, type, payload: plain(payload) });
  }

  capture(now, force = false) {
    if (!this.active || (!force && now - this.lastCapture < 0.25)) return;
    this.lastCapture = now;
    const deckState = (side) => {
      const d = this.decks[side];
      return { trackId: d.track?.id ?? null, position: d.getPosition(now), playing: d.playing, rate: d.rate };
    };
    this.session.snapshots.push({
      t: now - this.startedAt,
      decks: { A: deckState('A'), B: deckState('B') },
      mixer: {
        xf: this.mixer.xf,
        A: { ...this.mixer.chA.values }, B: { ...this.mixer.chB.values },
      },
    });
  }

  startReplay() {
    if (!this.session?.snapshots?.length) return false;
    this.stopReplay();
    this.planner.setEnabled(false);
    this.replay = { startedAt: performance.now() / 1000, index: 0 };
    this.onState?.({ type: 'replay', active: true });
    return true;
  }

  stopReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.onState?.({ type: 'replay', active: false });
  }

  tickReplay() {
    if (!this.replay || this.replay.pending) return;
    const elapsed = performance.now() / 1000 - this.replay.startedAt;
    const snapshots = this.session.snapshots;
    while (this.replay.index < snapshots.length && snapshots[this.replay.index].t <= elapsed) {
      if (!this._apply(snapshots[this.replay.index])) break;
      this.replay.index++;
    }
    if (this.replay.index >= snapshots.length) this.stopReplay();
  }

  _apply(snapshot) {
    const tracks = this.getTracks();
    for (const side of ['A', 'B']) {
      const state = snapshot.decks[side];
      const deck = this.decks[side];
      const track = tracks.find((t) => t.id === state.trackId);
      if (track && !track.buffer && this.prepareTrack) {
        const replay = this.replay;
        const startedAt = performance.now() / 1000;
        replay.pending = Promise.resolve(this.prepareTrack(track, 'セッション再生準備')).catch((error) => {
          this.onState?.({ type: 'replayerror', track, error });
          this.stopReplay();
        }).finally(() => {
          if (this.replay !== replay) return;
          replay.startedAt += performance.now() / 1000 - startedAt;
          replay.pending = null;
        });
        return false;
      }
      if (track && deck.track !== track) deck.load(track);
      if (!deck.track) continue;
      const drift = Math.abs(deck.getPosition() - state.position);
      if (!deck.playing || drift > 0.35) deck.seek(state.position);
      if (state.playing && !deck.playing) deck.play(state.position);
      if (!state.playing && deck.playing) deck.pause();
    }
    this.mixer.setCrossfader(snapshot.mixer.xf);
    for (const side of ['A', 'B']) {
      const ch = this.mixer.channel(side), v = snapshot.mixer[side];
      ch.setTrim(v.trim); ch.setEq('low', v.low); ch.setEq('mid', v.mid); ch.setEq('high', v.high);
      ch.setColor(v.color); ch.setFader(v.fader);
    }
    return true;
  }

  exportBlob() {
    return this.session ? new Blob([JSON.stringify(this.session, null, 2)], { type: 'application/json' }) : null;
  }
}
