// ===== DeckGhost アプリケーション統合 (UI構築 / イベント / 描画ループ) =====
import { Deck } from './deck.js';
import { Mixer } from './mixer.js';
import { FXUnit, FX_TYPES, FX_BEATS } from './fx.js';
import { Planner } from './automix.js';
import { analyzeTrackWithProgress, analyzeStructure } from './analysis.js';
import { cueTimeForTrack, generateCues, harmonicRelation, spectralConflict, criticReport, planTransition, PRESETS, TECHNIQUES } from './brain.js';
import { renderDemoTrack, DEMO_PRESETS } from './demotracks.js';
import { drawZoomWave, drawOverview, drawJog, drawVu, drawMasterVu, HOTCUE_COLORS } from './waveform.js';
import { formatTime } from './keyutil.js';
import { MidiController } from './midi.js';
import { COMPOSER_PRESETS, DEFAULT_COMPOSITION, normalizeComposition } from './composer.js';
import { SessionJournal } from './session.js';
import { DecodedBufferCache } from './audio-memory.js';
import { analysisHintsForTrack } from './grid-store.js';
import { estimateTapBpm, tapFinishDelay } from './bpm-tap.js';
import { getCachedAudio, cacheAudio } from './audio-cache.js';

const $ = (sel) => document.querySelector(sel);
const DECK_COLORS = { A: '#22d3ee', B: '#fb923c' };
const END_WARNING_SEC = 20; // 残りこの秒数を切ったら「次に行けよ」警告を点滅
const MIB = 1024 * 1024;
const deviceMemory = Number(navigator.deviceMemory) || 0;
const mobileLike = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// モバイル/4GB以下はアイドルPCMを保持しない。デスクトップも直近1曲・192MiBまで。
const idlePcmBudget = mobileLike || (deviceMemory > 0 && deviceMemory <= 4) ? 0 : 192 * MIB;
let planner = null;

/* ================= オーディオコア ================= */
const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const mixer = new Mixer(ctx);
const decks = { A: new Deck(ctx, 'A'), B: new Deck(ctx, 'B') };
decks.A.otherDeck = decks.B;
decks.B.otherDeck = decks.A;
decks.A.out.connect(mixer.chA.input);
decks.B.out.connect(mixer.chB.input);
const fx = new FXUnit(ctx);
const decodedCache = new DecodedBufferCache({ maxIdleBytes: idlePcmBudget, maxIdleTracks: 1 });
let decodeSerial = Promise.resolve();

function protectedDecodedTracks(extra = []) {
  const tracks = new Set(extra.filter(Boolean));
  for (const side of ['A', 'B']) if (decks[side].track) tracks.add(decks[side].track);
  if (planner?.plan?._toTrackRef) tracks.add(planner.plan._toTrackRef);
  if (planner?._pendingStartTrack) tracks.add(planner._pendingStartTrack);
  return [...tracks];
}

function refreshMemoryStatus() {
  const el = $('#memory-status');
  if (!el) return;
  const stats = decodedCache.stats(protectedDecodedTracks());
  el.textContent = `PCM ${stats.decodedTracks}曲 / ${Math.round(stats.totalBytes / MIB)} MB`;
  el.title = idlePcmBudget
    ? `再生中・準備中 + アイドル最大1曲 (${Math.round(idlePcmBudget / MIB)} MB)`
    : '省メモリモード: 再生中・準備中のPCMだけ保持';
}

function trimDecodedCache(extra = []) {
  decodedCache.trim(protectedDecodedTracks(extra));
  refreshMemoryStatus();
}

function runDecodeSerial(task) {
  const run = decodeSerial.catch(() => {}).then(task);
  decodeSerial = run.catch(() => {});
  return run;
}

// FXアサイン (ルーティング差し替え)
fx.assignTarget = 'OFF';
fx.assign = (target) => {
  mixer.chA.setInsert(null);
  mixer.chB.setInsert(null);
  mixer.setMasterInsert(null);
  if (target === 'A') mixer.chA.setInsert(fx);
  else if (target === 'B') mixer.chB.setInsert(fx);
  else if (target === 'MST') mixer.setMasterInsert(fx);
  fx.assignTarget = target;
  document.querySelectorAll('.fx-assign-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.target === target));
};

async function triggerBackspinFx(onBtn) {
  let side = ['A', 'B'].includes(fx.assignTarget) ? fx.assignTarget : null;
  if (!side) side = planner.liveSide || (decks.A.playing ? 'A' : decks.B.playing ? 'B' : null);
  if (!side || !decks[side].track) {
    fx.setOn(false);
    onBtn.classList.remove('on');
    setStatus('BACKSPIN FX: Deck A/Bにトラックをロードしてから使ってください');
    return;
  }
  if (fx.assignTarget !== side) fx.assign(side);
  const duration = Math.max(0.55, Math.min(2.4, fx.beatTime() * (1.5 + fx.depth)));
  const ok = await decks[side].performBackspin(duration, 0.7 + fx.param);
  fx.setOn(false);
  onBtn.classList.remove('on');
  if (ok) setStatus(`BACKSPIN FX → Deck ${side}`);
}

// 初回操作でAudioContextを起動
document.addEventListener('pointerdown', () => {
  if (ctx.state === 'suspended') ctx.resume();
  setStatus('オーディオエンジン起動済み — トラックをロードしてください');
}, { once: true });

// ===== モバイル等での中断→復帰対策 =====
// バックグラウンド化・電話着信・画面ロック等で AudioContext が
// suspended/interrupted になると、iOS/Safari では再生中の
// AudioBufferSourceNode がOSに停止され、復帰後も音が出なくなる。
// 状態変化を監視し、復帰時に ctx.resume() + 再生中デッキのソース張り直しを行う。
let ctxWasInterrupted = false;
ctx.onstatechange = () => {
  if (ctx.state !== 'running') ctxWasInterrupted = true;
};
async function resumeAudio() {
  try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) { /* gesture必要 */ }
  if (ctx.state === 'running' && ctxWasInterrupted) {
    ctxWasInterrupted = false;
    for (const side of ['A', 'B']) decks[side].restartPlayback();
    setStatus('再生を復帰しました');
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAudio();
});
window.addEventListener('focus', resumeAudio);
window.addEventListener('pageshow', resumeAudio);
// suspended のまま操作された場合の保険 (毎ジェスチャで復帰を試みる)
document.addEventListener('pointerdown', () => { if (ctx.state !== 'running') resumeAudio(); });

// ズーム抑制: Safariのピンチジェスチャ / Ctrl+ホイール / ダブルタップ を無効化
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  // TAPテンポは短い間隔の連続入力そのものが機能なので、ズーム抑制の対象外。
  if (e.target.closest?.('.tap-btn')) return;
  const now = Date.now();
  if (now - lastTouchEnd < 300) e.preventDefault(); // ダブルタップズーム防止
  lastTouchEnd = now;
}, { passive: false });

function setStatus(msg) { $('#status-msg').textContent = msg; }

let taskProgressSequence = 0;
let taskProgressHideTimer = null;

function beginTaskProgress(trackName) {
  const id = ++taskProgressSequence;
  const root = $('#task-progress');
  const label = $('#task-progress-label');
  const percent = $('#task-progress-percent');
  const fill = $('#task-progress-fill');
  let lastPercent = 0;
  clearTimeout(taskProgressHideTimer);
  root.hidden = false;
  root.classList.remove('error');

  const update = (fraction, stage) => {
    if (id !== taskProgressSequence) return;
    lastPercent = Math.max(lastPercent, Math.min(100, Math.round(fraction * 100)));
    label.textContent = `${trackName} — ${stage}`;
    percent.textContent = `${lastPercent}%`;
    fill.style.width = `${lastPercent}%`;
    root.setAttribute('aria-valuenow', String(lastPercent));
    root.setAttribute('aria-label', label.textContent);
  };
  const hideAfter = (ms) => {
    taskProgressHideTimer = setTimeout(() => {
      if (id === taskProgressSequence) root.hidden = true;
    }, ms);
  };

  update(0, '準備中');
  return {
    update,
    complete(stage = '完了') { update(1, stage); hideAfter(700); },
    fail(stage = '失敗') {
      if (id !== taskProgressSequence) return;
      root.classList.add('error');
      update(Math.max(lastPercent / 100, 0.05), stage);
      percent.textContent = 'ERROR';
      hideAfter(1800);
    },
  };
}

/* ================= グリッドマップ (SHA256 → 拍開始タイミング等) =================
   ファイル内容のSHA256をキーに、手動補正したBPM/拍開始タイミング(gridOffset)/
   キーを保存する。同じ曲を(ファイル名が違っても)再読込したとき自動で復元し、
   毎回グリッドを合わせ直す手間を無くす。localStorageに永続化し、
   JSONでエクスポート/インポートもできる(機材間・セッション間の持ち運び用)。 */
const GRIDMAP_KEY = 'deckghost-gridmap-v2';
const gridMap = new Map();
(function loadGridMap() {
  try {
    const raw = localStorage.getItem(GRIDMAP_KEY) || localStorage.getItem('deckghost-gridmap-v1');
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw).records || {})) {
        if (v && !v.beatGrid && Number.isFinite(v.bpm) && Number.isFinite(v.gridOffset)) {
          v.beatGrid = {
            mode: 'rigid',
            anchors: [{ beatIndex: 0, timeSec: v.gridOffset, localBpm: v.bpm, confidence: 1.0, source: 'manual' }],
            meterSegments: [{ startBeat: 0, numerator: 4, denominator: 4, beatUnit: 'quarter', downbeatBeatIndex: 0, confidence: 1.0, source: 'manual' }],
            firstReliableBeatTimeSec: v.gridOffset,
            barOriginBeatIndex: 0,
            barOneBeatIndex: 0,
            analysisVersion: '2.0',
            locked: false
          };
        }
        gridMap.set(k, v);
      }
    }
  } catch (e) { /* 破損時は無視 */ }
})();
function persistGridMap() {
  try {
    localStorage.setItem(GRIDMAP_KEY, JSON.stringify({ version: 2, records: Object.fromEntries(gridMap) }));
  } catch (e) { /* 容量オーバー等は無視 */ }
}
async function sha256hex(arrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** 手動補正(グリッド/BPM/キー/BeatGrid)を SHA256 に紐づけて保存 */
function saveGridRecord(track) {
  if (!track || !track.sha256) return;
  gridMap.set(track.sha256, {
    name: track.name,
    bpm: track.bpm,
    gridOffset: track.gridOffset,
    key: track.key,
    beatGrid: track.beatGrid,
    savedAt: new Date().toISOString(),
  });
  persistGridMap();
}

/* ================= ライブラリ (Musical State 管理) ================= */
const library = { tracks: [], nextId: 1 };

async function addTrackFromBuffer(buffer, meta = {}, source = null, onProgress = null) {
  setStatus(`解析中: ${meta.name || 'track'} …`);
  await new Promise((r) => setTimeout(r, 20)); // UI反映のための小休止
  // 保存済みグリッドがあれば解析ヒントとして先に適用(自動復元)
  const stored = meta.sha256 ? gridMap.get(meta.sha256) : null;
  // 読込は保存済み値を参照するだけで、gridMapへ書き戻さない。
  // 手動補正は音源メタデータや再解析ヒントより常に優先する。
  const hints = analysisHintsForTrack(meta, stored);
  const a = await analyzeTrackWithProgress(buffer, hints, onProgress);
  const track = {
    id: library.nextId++,
    name: meta.name || 'Untitled',
    artist: meta.artist || '',
    buffer,
    sha256: meta.sha256 || null,
    _source: source,
    _decodePromise: null,
    ...a,
  };
  // 保存済みグリッドの復元は、そのユーザーが過去に手動補正した絶対基準を再適用する
  // ことに等しい。以後この曲はグリッドを信頼し、AutoMixのキック検出でentryを動かさない。
  if (stored) track.gridManual = true;
  track.cues = generateCues(track); // 自動CUE (roles: entry/blend/safe/exit/drop)
  library.tracks.push(track);
  decodedCache.touch(track);
  trimDecodedCache();
  renderLibrary();
  const restored = stored ? ' (保存済みグリッドを復元)' : '';
  setStatus(`追加: ${track.name} — ${track.bpm} BPM / ${track.key.camelot.code} (${track.key.name}) / ${track.spectrum.character}${restored}`);
  return track;
}

async function refreshTrackGridAnalysis(track, recomputeStructure = false, { showProgress = true } = {}) {
  if (!track) return;
  let progress = null;
  if (recomputeStructure) {
    progress = showProgress ? beginTaskProgress(track.name) : null;
    try {
      progress?.update(0.08, 'グリッド変更を反映');
      await new Promise((resolve) => setTimeout(resolve, 0));
      Object.assign(track, analyzeStructure(track.buffer, track.bpm, track.gridOffset));
      progress?.update(0.82, 'CUEを再生成');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } catch (error) {
      progress?.fail('再解析に失敗');
      console.error(error);
      return;
    }
  } else {
    const barSec = (60 / track.bpm) * 4;
    for (const item of [...(track.phraseBoundaries || []), ...(track.dropCandidates || [])]) {
      item.time = track.gridOffset + (item.bar - 1) * barSec;
    }
  }
  const manual = (track.cues || []).filter((cue) => cue.source === 'manual');
  track.cues = [...generateCues(track), ...manual].sort((a, b) => a.time - b.time);
  planner?.handleGridChange(track);
  renderWorkbench();
  updateBrainPanel();
  progress?.complete('再解析完了');
}

function renderLibrary() {
  const tbody = $('#track-tbody');
  tbody.innerHTML = '';
  for (const t of library.tracks) {
    const tr = document.createElement('tr');
    if (decks.A.track === t) tr.classList.add('loaded-A');
    if (decks.B.track === t) tr.classList.add('loaded-B');
    const loadedMark = decks.A.track === t ? '▶A' : decks.B.track === t ? '▶B' : t.buffer ? 'RAM' : '·';
    tr.innerHTML = `
      <td>${loadedMark}</td>
      <td>${escapeHtml(t.name)}</td>
      <td>${t.bpm.toFixed(1)}</td>
      <td><span class="key-chip">${t.key.camelot.code} ${t.key.name}</span></td>
      <td>${formatTime(t.duration)}</td>
      <td title="True Peak ${t.truePeak.toFixed(1)} dBTP / Auto Gain ${t.normGain.toFixed(3)}">${t.loudness.toFixed(1)}</td>
      <td><span class="energy-bar" style="width:${Math.round(t.energy * 40)}px"></span></td>
      <td>
        <button class="row-btn a">A</button>
        <button class="row-btn b">B</button>
        <button class="row-btn q">+Q</button>
      </td>`;
    tr.querySelector('.row-btn.a').onclick = () => loadToDeck('A', t);
    tr.querySelector('.row-btn.b').onclick = () => loadToDeck('B', t);
    tr.querySelector('.row-btn.q').onclick = () => planner.addToQueue(t);
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadToDeck(side, track) {
  const deck = decks[side];
  try {
    // 差し替え対象を先に解放し、旧A/B + 新規の3曲ぶんPCMが重なるのを避ける。
    if (deck.track && deck.track !== track) {
      deck.unload();
      resetDeckHeader(side);
      trimDecodedCache();
    }
    await ensureTrackBuffer(track, `Deck ${side}`);
    deck.load(track);
    decodedCache.touch(track);
    trimDecodedCache([track]);
    updateDeckHeader(side, track);
    renderLibrary();
    renderWorkbench();
    updateBrainPanel();
    setStatus(`Deck ${side} ← ${track.name}`);
  } catch (error) {
    setStatus(`Deck ${side} 読込失敗: ${track.name}`);
    console.error(error);
  }
}

function updateDeckHeader(side, track) {
  $(`#title-${side}`).textContent = track.name;
  $(`#key-${side}`).textContent = `${track.key.camelot.code} ${track.key.name}`;
  $(`#bpm-orig-${side}`).textContent = track.bpm.toFixed(1);
}

function resetDeckHeader(side) {
  $(`#title-${side}`).textContent = 'NO TRACK LOADED';
  $(`#key-${side}`).textContent = '--';
  $(`#bpm-orig-${side}`).textContent = '---.-';
  $(`#time-${side}`).textContent = '00:00.0';
  $(`#remain-${side}`).textContent = '-00:00.0';
  $(`#bpm-eff-${side}`).textContent = '---.-';
}

/** デッキから曲を取り出す (UNLOAD) */
function ejectDeck(side) {
  const deck = decks[side];
  if (!deck.track) return;
  const track = deck.track;
  // AUTO MIX が参照中のデッキを抜くと破綻するため、ライブ側なら停止扱いに
  if (planner.enabled && planner.liveSide === side) {
    planner.setEnabled(false);
    setStatus('AUTO MIXを停止してデッキを取り出しました');
  }
  deck.unload();
  decodedCache.touch(track);
  trimDecodedCache();
  resetDeckHeader(side);
  renderLibrary();
  renderWorkbench();
  updateBrainPanel();
  setStatus(`Deck ${side}: 曲を取り出しました (UNLOAD)`);
}

/* ---------- ファイル読み込み ---------- */
async function streamToArrayBuffer(stream, totalBytes, onProgress, label) {
  if (!stream?.getReader) return null;
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const fraction = totalBytes > 0 ? Math.min(1, received / totalBytes) : 0;
    onProgress?.(0.03 + fraction * 0.27,
      totalBytes > 0 ? `${label} ${Math.round(fraction * 100)}%` : label);
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined.buffer;
}

async function decodeTrackSource(source, expected = {}, onProgress = null) {
  if (source.kind === 'demo') {
    onProgress?.(0.03, 'デモ音源を合成');
    const generated = await renderDemoTrack(source.preset, onProgress);
    onProgress?.(1, '音声準備完了');
    return { buffer: generated.buffer, meta: generated.meta, sha256: null };
  }

  let arr = null;
  const targetSha = expected.sha256 || source.sha256;

  // 1. IndexedDB からキャッシュ検索を試みる
  if (targetSha) {
    onProgress?.(0.02, 'キャッシュを検索中');
    const cached = await getCachedAudio(targetSha);
    if (cached) {
      arr = cached;
      onProgress?.(0.30, 'キャッシュから読込完了');
    }
  }

  // 2. キャッシュにない場合は通常通り読み込み/ダウンロード
  if (!arr) {
    if (source.kind === 'file') {
      onProgress?.(0.03, 'ファイルを読み込み');
      arr = await streamToArrayBuffer(source.file.stream?.(), source.file.size, onProgress, 'ファイル読込')
        ?? await source.file.arrayBuffer();
    } else if (source.kind === 'url') {
      onProgress?.(0.03, '音源をダウンロード');
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`audio HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length')) || source.bytes || 0;
      arr = await streamToArrayBuffer(response.body, contentLength, onProgress, 'ダウンロード')
        ?? await response.arrayBuffer();
    } else {
      throw new Error('audio source is not reloadable');
    }
  }

  const expectedBytes = expected.bytes ?? source.bytes;
  if (expectedBytes != null && arr.byteLength !== expectedBytes) throw new Error('audio size mismatch');

  // SHA256はdecodeAudioDataより先に計算する。一部ブラウザはデコード時にArrayBufferをdetachする。
  onProgress?.(0.34, 'SHA-256を検証');
  const sha256 = await sha256hex(arr);
  const expectedSha = expected.sha256 ?? source.sha256;
  if (expectedSha && sha256 !== expectedSha) throw new Error('audio checksum mismatch');

  // 3. 今後のために IndexedDB へ非同期で保存
  // (デコード後にarrがdetachされる可能性があるため、デコード前に保存を実行)
  try {
    const name = source.file?.name || source.url || '';
    cacheAudio(sha256, arr.slice(0), name);
  } catch (e) {
    console.error('Failed to cache audio in IndexedDB:', e);
  }

  onProgress?.(0.55, '音声をPCMへデコード');
  const buffer = await ctx.decodeAudioData(arr);
  onProgress?.(1, '音声準備完了');
  return { buffer, meta: {}, sha256 };
}

async function importTrackSource(source, meta = {}) {
  return runDecodeSerial(async () => {
    const displayName = meta.name || source.preset?.name || source.file?.name || 'トラック';
    const progress = beginTaskProgress(displayName);
    try {
      decodedCache.prepareForDecode(protectedDecodedTracks());
      refreshMemoryStatus();
      const decoded = await decodeTrackSource(source, {
        bytes: meta.bytes,
        sha256: meta.sha256,
      }, (value, label) => progress.update(value * 0.38, label));
      const sha256 = meta.sha256 || decoded.sha256;
      const duplicate = sha256 && library.tracks.find((track) => track.sha256 === sha256);
      if (duplicate) {
        setStatus(`読み込み済み: ${duplicate.name}`);
        progress.complete('読み込み済み');
        return duplicate;
      }
      const track = await addTrackFromBuffer(decoded.buffer, {
        ...decoded.meta,
        ...meta,
        sha256,
      }, source, (value, label) => progress.update(0.38 + value * 0.6, label));
      progress.complete('ライブラリへ追加完了');
      return track;
    } catch (error) {
      progress.fail('処理に失敗');
      throw error;
    }
  });
}

async function ensureTrackBuffer(track, purpose = '再生準備') {
  if (track.buffer) {
    decodedCache.touch(track);
    return track;
  }
  if (!track._source) throw new Error(`${track.name}: 再読込元がありません`);
  if (track._decodePromise) return track._decodePromise;

  const pending = runDecodeSerial(async () => {
    if (track.buffer) return track;
    const progress = beginTaskProgress(track.name);
    try {
      decodedCache.prepareForDecode(protectedDecodedTracks([track]));
      refreshMemoryStatus();
      setStatus(`${purpose}: ${track.name} を省メモリ再読込中…`);
      const decoded = await decodeTrackSource(track._source, { sha256: track.sha256 },
        (value, label) => progress.update(value * 0.96, label));
      track.buffer = decoded.buffer;
      decodedCache.touch(track);
      trimDecodedCache([track]);
      renderLibrary();
      progress.complete('再生準備完了');
      return track;
    } catch (error) {
      progress.fail('再読込に失敗');
      throw error;
    }
  });
  track._decodePromise = pending.finally(() => {
    track._decodePromise = null;
  });
  return track._decodePromise;
}

async function importFiles(files) {
  for (const file of files) {
    try {
      await importTrackSource({ kind: 'file', file }, {
        name: file.name.replace(/\.[^.]+$/, ''),
        bytes: file.size,
      });
    } catch (e) {
      setStatus(`読み込み失敗: ${file.name}`);
      console.error(e);
    }
  }
}

let sampleManifest = null;

async function initSampleLibrary() {
  const select = $('#sample-select');
  try {
    const response = await fetch('/samples/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    sampleManifest = await response.json();
    const tracks = [...(sampleManifest.tracks || [])].sort((a, b) => a.order - b.order);
    for (const [index, track] of tracks.entries()) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${track.order}. ${track.title}`;
      select.appendChild(option);
    }
    if (!tracks.length) select.disabled = true;
  } catch (error) {
    select.disabled = true;
    select.options[0].textContent = 'サンプル一覧を取得できません';
    console.error(error);
  }
}

async function importSampleTrack(index) {
  const select = $('#sample-select');
  const track = [...(sampleManifest?.tracks || [])].sort((a, b) => a.order - b.order)[index];
  if (!track) return;
  select.disabled = true;
  try {
    if (library.tracks.some((item) => item.sha256 === track.sha256)) {
      setStatus(`読み込み済み: ${track.title}`);
      return;
    }
    setStatus(`サンプルをダウンロード中: ${track.order}. ${track.title}`);
    await importTrackSource({
      kind: 'url', url: track.url, bytes: track.bytes, sha256: track.sha256,
    }, {
      name: track.title, artist: track.artist || '', bytes: track.bytes, sha256: track.sha256,
    });
    const option = [...select.options].find((item) => item.value === String(index));
    if (option) { option.disabled = true; option.textContent = `✓ ${option.textContent}`; }
  } catch (error) {
    setStatus(`サンプル読込失敗: ${track.title}`);
    console.error(error);
  } finally {
    select.value = '';
    select.disabled = false;
  }
}

$('#btn-open').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (e) => {
  await importFiles([...e.target.files]);
  e.target.value = '';
};
$('#sample-select').onchange = (event) => {
  if (event.target.value !== '') importSampleTrack(Number(event.target.value));
};
$('#btn-sample-all').onclick = async () => {
  const btn = $('#btn-sample-all');
  const tracks = [...(sampleManifest?.tracks || [])].sort((a, b) => a.order - b.order);
  if (!tracks.length) { setStatus('追加できるサンプル曲がありません'); return; }
  btn.disabled = true;
  try {
    // デコードは runDecodeSerial で直列化されるため順に await すれば安全。
    for (let index = 0; index < tracks.length; index++) await importSampleTrack(index);
    setStatus(`サンプル全${tracks.length}曲をライブラリへ追加しました`);
  } finally {
    btn.disabled = false;
  }
};
initSampleLibrary();

const browserEl = $('#browser');
browserEl.addEventListener('dragover', (e) => { e.preventDefault(); browserEl.classList.add('dragover'); });
browserEl.addEventListener('dragleave', () => browserEl.classList.remove('dragover'));
browserEl.addEventListener('drop', (e) => {
  e.preventDefault();
  browserEl.classList.remove('dragover');
  importFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('audio')));
});

$('#btn-server').onclick = async () => {
  try {
    const res = await fetch('/api/tracks');
    const { tracks } = await res.json();
    if (!tracks.length) { setStatus('サーバの tracks/ フォルダに楽曲がありません'); return; }
    for (const t of tracks) {
      setStatus(`ダウンロード中: ${t.name}`);
      await importTrackSource({ kind: 'url', url: t.url }, {
        name: t.name.replace(/\.[^.]+$/, ''),
      });
    }
  } catch (e) { setStatus('サーバからの読込に失敗しました'); }
};

$('#btn-demo').onclick = async () => {
  $('#btn-demo').disabled = true;
  for (const preset of DEMO_PRESETS) {
    setStatus(`デモトラック生成中: ${preset.name} (${preset.bpm} BPM)…`);
    await importTrackSource({ kind: 'demo', preset });
  }
  $('#btn-demo').disabled = false;
  setStatus(`デモトラック ${DEMO_PRESETS.length}曲を生成しました — AUTO MIXを試してみてください`);
};

$('#btn-queue-all').onclick = () => {
  library.tracks.forEach((t) => planner.addToQueue(t));
};

/* ---------- グリッド情報のエクスポート / インポート ---------- */
$('#btn-grid-export').onclick = () => {
  // 読込中の曲の現在値も反映してから書き出す
  for (const t of library.tracks) if (t.sha256) saveGridRecord(t);
  const data = {
    app: 'DeckGhost', type: 'gridmap', version: 1, exportedAt: new Date().toISOString(),
    records: Object.fromEntries(gridMap),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deckghost-gridmap-${Date.now()}.json`;
  a.click();
  setStatus(`グリッド情報 ${gridMap.size}曲分を書き出しました`);
};

$('#btn-grid-import').onclick = () => $('#grid-import-input').click();
$('#grid-import-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const records = data.records || data; // 素の {sha:rec} も受け付ける
    let n = 0;
    for (const [sha, rec] of Object.entries(records)) {
      if (rec && typeof rec.gridOffset === 'number' && typeof rec.bpm === 'number') { gridMap.set(sha, rec); n++; }
    }
    persistGridMap();
    // 既に読み込み済みの曲に即適用 (BPM/グリッド/キー + CUE再生成)
    let applied = 0;
    for (const t of library.tracks) {
      const rec = t.sha256 && gridMap.get(t.sha256);
      if (!rec) continue;
      t.bpm = rec.bpm; t.gridOffset = rec.gridOffset;
      if (rec.key) { t.key = rec.key; t.keySource = 'known'; }
      t.bpmSource = 'known'; t.bpmConfidence = 1.0; t.gridConfidence = 1.0;
      t.gridManual = true; // 取り込んだグリッドは手動補正済みの絶対基準として扱う
      t.cues = generateCues(t);
      planner.handleGridChange(t);
      applied++;
    }
    // ロード中デッキの表示更新
    for (const side of ['A', 'B']) if (decks[side].track) { updateDeckHeader(side, decks[side].track); decks[side]._notify(); }
    renderLibrary(); renderWorkbench(); updateBrainPanel();
    setStatus(`グリッド情報 ${n}曲分を読込 (読込済み${applied}曲に適用)`);
  } catch (err) {
    setStatus('グリッドJSONの読込に失敗しました');
    console.error(err);
  }
  e.target.value = '';
};

/* ================= デッキUI ================= */
const jogHold = { A: null, B: null }; // ジョグ操作状態 (rafの静止検知でも参照)
const zoomHold = { A: null, B: null }; // ズーム波形スクラッチ操作状態

function buildDeckUI(side) {
  const deck = decks[side];

  // HOT CUE パッド
  const grid = $(`#hotcues-${side}`);
  for (let i = 0; i < 8; i++) {
    const b = document.createElement('button');
    b.className = 'hotcue';
    b.textContent = String.fromCharCode(65 + i); // A-H
    b.onclick = () => deck.pressHotcue(i);
    b.oncontextmenu = (e) => { e.preventDefault(); deck.clearHotcue(i); };
    grid.appendChild(b);
  }

  // LOOP / BEAT JUMP
  const loopRow = $(`#loop-${side}`);
  const mkBtn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'loop-btn ' + cls;
    b.textContent = label;
    b.onclick = fn;
    loopRow.appendChild(b);
    return b;
  };
  mkBtn('IN', () => deck.loopIn());
  mkBtn('OUT', () => deck.loopOut());
  mkBtn('EXIT', () => deck.exitLoop());
  const autoBtns = {};
  for (const beats of [1, 2, 4, 8]) autoBtns[beats] = mkBtn(String(beats), () => deck.autoLoop(beats), 'auto');
  mkBtn('½', () => deck.loopHalf());
  mkBtn('×2', () => deck.loopDouble());
  mkBtn('◀4', () => deck.beatJump(-4));
  mkBtn('4▶', () => deck.beatJump(4));

  // トランスポート。手動Pause/再開はPlannerにも通知し、AutoMIX時計を同期停止する。
  const togglePlayback = () => {
    const wasPlaying = deck.playing;
    if (!deck.playing && deck.getPosition() >= deck.duration - 0.05) deck.seek(deck.cuePoint);
    deck.togglePlay();
    planner.handleManualTransport(side, wasPlaying, deck.playing, ctx.currentTime);
  };
  const pressCue = () => {
    const wasPlaying = deck.playing;
    deck.pressCue();
    planner.handleManualTransport(side, wasPlaying, deck.playing, ctx.currentTime);
  };
  $(`#play-${side}`).onclick = togglePlayback;
  $(`#cue-${side}`).onclick = pressCue;
  deck.manualTogglePlayback = togglePlayback;
  deck.manualPressCue = pressCue;
  $(`#sync-${side}`).onclick = () => {
    if (deck.synced) { deck.synced = false; deck._notify(); }
    else {
      deck.syncTo(decks[side === 'A' ? 'B' : 'A']);
      // ユーザーが明示的に押したSYNCなので、自動テンポ回帰の対象にはしない
      // (勝手に元のBPMへ戻っていくと「SYNCが効かない」ように見える)
      deck.autoPitch = false;
    }
  };

  // ピッチフェーダー (下=速い / Pioneer準拠)
  const pitchEl = $(`#pitch-${side}`);
  pitchEl.oninput = () => {
    deck.synced = false;
    deck.autoPitch = false; // 手動操作は自動テンポ回帰の対象外にする
    deck.setPitch(-pitchEl.value / 1000);
  };
  const rangeBtn = $(`#pitch-range-${side}`);
  rangeBtn.onclick = () => {
    const next = { 0.08: 0.16, 0.16: 0.5, 0.5: 0.08 }[deck.pitchRange] || 0.08;
    deck.setPitchRange(next);
    rangeBtn.textContent = `±${Math.round(next * 100)}%`;
  };
  // キーロック (テンポを変えても音程を維持)
  $(`#keylock-${side}`).onclick = () => deck.setKeylock(!deck.keylock);
  // キーシフト (音程を半音単位で調整、テンポ不変)
  $(`#keyshift-${side}`).querySelectorAll('.keyshift-btn').forEach((b) => {
    b.onclick = () => deck.nudgeKeyShift(Number(b.dataset.semi));
  });

  // キーの手動補正 (検出が不確実なため。♭/♯で半音, A/Bでメジャー/マイナー)
  $(`#key-edit-${side}`).querySelectorAll('.key-edit-btn').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.key === 'mode') deck.toggleKeyMode();
      else deck.nudgeKeyRoot(Number(b.dataset.key));
      renderLibrary();
      updateBrainPanel();
      saveGridRecord(deck.track); // 補正をSHA256に紐づけ保存
    };
  });

  // 曲を取り出す (UNLOAD)
  $(`#eject-${side}`).onclick = () => ejectDeck(side);

  // ビートグリッド手動調整 (±1/±10/±50ms)。長押しで連続移動(加速)するので
  // 大きくずれていても素早く合わせられる。現在の拍開始位置をmsで明示。
  $(`#grid-nudge-${side}`).querySelectorAll('.grid-nudge-btn').forEach((b) => {
    const ms = Number(b.dataset.ms);
    const step = () => {
      if (!deck.track) return;
      deck.nudgeGrid(ms / 1000);
      // アーム済みでも古い開始予約を残さず、補正した拍位置へ即座に再計画する。
      if (planner.phase === 'armed') planner.handleGridChange(deck.track);
      saveGridRecord(deck.track);
      setStatus(`Deck ${side}: グリッド ${ms > 0 ? '+' : ''}${ms}ms → 拍開始 ${(deck.track.gridOffset * 1000).toFixed(0)}ms`);
    };
    let holdTimer = null, holdInterval = null;
    const stop = () => {
      clearTimeout(holdTimer); clearInterval(holdInterval); holdTimer = holdInterval = null;
      refreshTrackGridAnalysis(deck.track);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      step();                                   // 押した瞬間に1回
      holdTimer = setTimeout(() => {            // 400ms後から連続
        let delay = 120;
        holdInterval = setInterval(() => { step(); }, delay);
      }, 400);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
  });
  // 現在位置を1拍目(小節の頭)に設定
  $(`#grid-set1-${side}`).onclick = () => {
    deck.setDownbeatHere();
    refreshTrackGridAnalysis(deck.track);
    saveGridRecord(deck.track);
    setStatus(`Deck ${side}: 現在位置を1拍目(小節の頭)に設定`);
  };
  // 現在位置を4小節ウィンドウの1小節目へ設定。1拍目は位相補正、1小節目は4小節単位の位相補正。
  $(`#grid-setbar-${side}`).onclick = () => {
    deck.setFirstBarHere();
    refreshTrackGridAnalysis(deck.track);
    saveGridRecord(deck.track);
    setStatus(`Deck ${side}: 現在位置を4小節ウィンドウの1小節目に設定`);
  };
  $(`#grid-beat-${side}`).querySelectorAll('.grid-beat-btn').forEach((b) => {
    b.onclick = () => {
      if (!deck.track) return;
      const beats = Number(b.dataset.beats);
      deck.nudgeGrid(beats * (60 / deck.track.bpm));
      refreshTrackGridAnalysis(deck.track);
      saveGridRecord(deck.track);
      setStatus(`Deck ${side}: 小節位相を${beats > 0 ? '+' : '-'}1拍移動`);
    };
  });
  $(`#grid-reanalyze-${side}`).onclick = () => {
    if (!deck.track) return;
    refreshTrackGridAnalysis(deck.track, true);
    saveGridRecord(deck.track);
    setStatus(`Deck ${side}: 修正済みBPM/グリッドで構造とCUEを再解析`);
  };
  // BPM検出の半分/2倍テンポ誤りを手動補正 (信号処理だけでは解けない曖昧さがある)
  $(`#bpm-rescale-${side}`).querySelectorAll('.bpm-rescale-btn').forEach((b) => {
    b.onclick = () => {
      deck.rescaleBpm(Number(b.dataset.factor));
      refreshTrackGridAnalysis(deck.track, true);
      renderLibrary(); saveGridRecord(deck.track);
    };
  });
  // BPM直接入力 (½×/×2でも直らない3:2等の曖昧さの最終手段)
  const bpmInput = $(`#bpm-input-${side}`);
  bpmInput.onchange = () => {
    const v = Number(bpmInput.value);
    if (v > 0) {
      deck.setBpm(v); refreshTrackGridAnalysis(deck.track, true);
      renderLibrary(); saveGridRecord(deck.track);
    }
  };

  // TAPテンポ: タップ中は収集と暫定表示だけを行う。入力が止まってから
  // BPM設定・構造/CUE再計算を一度だけ行い、タップごとの重い再解析を避ける。
  const tapBtn = $(`#tap-${side}`);
  const tap = { times: [], positions: [], trackId: null, finishTimer: null };
  const resetTap = (trackId = null) => {
    clearTimeout(tap.finishTimer);
    tap.times = [];
    tap.positions = [];
    tap.trackId = trackId;
    tap.finishTimer = null;
  };
  const finishTap = async (expectedTrackId) => {
    tap.finishTimer = null;
    if (!deck.track || deck.track.id !== expectedTrackId || tap.trackId !== expectedTrackId) return;
    const n = tap.times.length;
    const bpm = estimateTapBpm(tap.times);
    if (n < 4 || bpm == null) {
      setStatus(`Deck ${side}: TAP ${n}回 — 4回以上叩いてください`);
      resetTap(deck.track.id);
      return;
    }
    const lastPosition = tap.positions.at(-1);
    deck.setBpm(bpm);
    if (lastPosition != null) deck.alignBeatTo(lastPosition);
    // TAP確定は明示的なプログレスを出さず、入力終了後に一度だけ再計算する。
    await refreshTrackGridAnalysis(deck.track, true, { showProgress: false });
    renderLibrary();
    saveGridRecord(deck.track);
    setStatus(`Deck ${side}: TAP ${n}回 → ${bpm} BPM に設定`);
    resetTap(deck.track.id);
  };
  const recordTap = () => {
    if (!deck.track) return;
    const now = performance.now();
    // 2秒以上空いた or 別の曲になったら計測リセット(叩き直し)
    if ((tap.times.length && now - tap.times[tap.times.length - 1] > 2000) || tap.trackId !== deck.track.id) {
      resetTap(deck.track.id);
    }
    tap.times.push(now);
    if (deck.playing) tap.positions.push(deck.getPosition());
    tapBtn.classList.add('flash');
    setTimeout(() => tapBtn.classList.remove('flash'), 90);
    const n = tap.times.length;
    const bpm = estimateTapBpm(tap.times);
    setStatus(bpm == null
      ? `Deck ${side}: TAP… ビートに合わせて叩いてください`
      : `Deck ${side}: TAP ${n}回 → 約${bpm} BPM (入力待ち)`);
    clearTimeout(tap.finishTimer);
    const pendingTrackId = tap.trackId;
    tap.finishTimer = setTimeout(() => finishTap(pendingTrackId), tapFinishDelay(tap.times));
  };
  tapBtn.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    recordTap();
  });
  tapBtn.addEventListener('keydown', (event) => {
    if (event.repeat || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    recordTap();
  });

  // 波形クリックシーク
  $(`#over-${side}`).onclick = (e) => {
    if (!deck.track) return;
    const r = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - r.left) / r.width) * deck.duration;
    const other = decks[side === 'A' ? 'B' : 'A'];
    // SYNC中はマスター側、それ以外は自デッキの現在フェーズを保ってジャンプする。
    const referencePhase = deck.synced && other.playing && other.track
      ? other.beatPhase()
      : null;
    deck.seekBeatAligned(target, referencePhase);
  };

  // ジョグ: 中央面=アナログスクラッチ (逆回し可) / 外周リング=ナッジ (ピッチベンド)
  // ジョグ: 全体=アナログスクラッチ (逆回し可) (外周/中央の区別なく全体が触ると極止まるスクラッチになる)
  // プラッターは 1回転=1.8秒 (drawJog of jog-wheel)。角速度を再生速度に変換する。
  const jog = $(`#jog-${side}`);
  const JOG_SEC_PER_REV = 1.8;
  const jogInfo = (e) => {
    const r = jog.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return { angle: Math.atan2(dy, dx), dist: Math.hypot(dx, dy) / (r.width / 2) };
  };
  jog.addEventListener('pointerdown', async (e) => {
    if (!deck.track) return;
    jog.setPointerCapture(e.pointerId);
    const info = jogInfo(e);
    const state = { mode: 'scratch', angle: info.angle, t: performance.now(), lastMove: performance.now() };
    jogHold[side] = state;
    zoomHold[side] = null; // ズーム波形側は無効化
    await deck.startScratch(); // グラブ: レコードを押さえて停止
    deck.setScratchVelocity(0);
  });
  jog.addEventListener('pointermove', (e) => {
    const state = jogHold[side];
    if (!state) return;
    const info = jogInfo(e);
    const now = performance.now();
    let dA = info.angle - state.angle;
    if (dA > Math.PI) dA -= 2 * Math.PI;
    if (dA < -Math.PI) dA += 2 * Math.PI;
    const dt = Math.max(0.004, (now - state.t) / 1000);
    state.angle = info.angle;
    state.t = now;
    state.lastMove = now;
    // プラッター角速度 → 再生速度 (1.0 = 順方向等速)
    const vel = (dA / (2 * Math.PI)) * JOG_SEC_PER_REV / dt;
    deck.setScratchVelocity(Math.max(-8, Math.min(8, vel)));
  });
  const endJog = () => {
    const state = jogHold[side];
    if (!state) return;
    deck.endScratch(); // リリース: 通常再生へ引き継ぎ
    jogHold[side] = null;
  };
  jog.addEventListener('pointerup', endJog);
  jog.addEventListener('pointercancel', endJog);

  // ズーム波形スクラッチ: 波形全体に触って前後にドラッグすることでスクラッチ操作を可能にする
  const zoomCanvas = $(`#zoom-${side}`);
  zoomCanvas.addEventListener('pointerdown', async (e) => {
    if (!deck.track) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    zoomCanvas.setPointerCapture(e.pointerId);
    const state = {
      startX: e.clientX,
      lastX: e.clientX,
      t: performance.now(),
      lastMove: performance.now(),
    };
    zoomHold[side] = state;
    jogHold[side] = null; // ジョグ側は無効化
    await deck.startScratch(); // グラブ: 波形を押さえて停止
    deck.setScratchVelocity(0);
  });
  zoomCanvas.addEventListener('pointermove', (e) => {
    const state = zoomHold[side];
    if (!state) return;
    const now = performance.now();
    const dx = e.clientX - state.lastX;
    const dt = Math.max(0.004, (now - state.t) / 1000);
    
    const w = zoomCanvas.clientWidth || 1;
    const windowSec = 11; // ズーム波形の秒数範囲
    const dSec = (dx / w) * windowSec;
    // 波形は右から左に流れるため、右ドラッグ(dx>0)は時間を巻き戻し、左ドラッグ(dx<0)は進める
    const vel = -dSec / dt;
    
    state.lastX = e.clientX;
    state.t = now;
    state.lastMove = now;
    deck.setScratchVelocity(Math.max(-8, Math.min(8, vel)));
  });
  const endZoomScratch = () => {
    const state = zoomHold[side];
    if (!state) return;
    deck.endScratch(); // リリース
    zoomHold[side] = null;
  };
  zoomCanvas.addEventListener('pointerup', endZoomScratch);
  zoomCanvas.addEventListener('pointercancel', endZoomScratch);

  // デッキ状態 → UI反映
  deck.onchange = () => {
    $(`#play-${side}`).classList.toggle('on', deck.playing);
    $(`#play-${side}`).textContent = deck.playing ? '❚❚' : '▶';
    $(`#sync-${side}`).classList.toggle('on', deck.synced);
    pitchEl.value = -deck.pitch * 1000;
    // SYNC/AUTO MIXが±8%を超えるレンジへ自動拡張することがあるため、
    // ボタン表示を常に実際の deck.pitchRange と同期させる
    // (表示が古いままだと「わずかに触れただけでBPMが激変する」ように見える)
    rangeBtn.textContent = `±${Math.round(deck.pitchRange * 100)}%`;
    // BPM直接入力欄は、入力中(フォーカス中)でなければ常に実際のtrack.bpmへ同期する
    if (deck.track && document.activeElement !== bpmInput) {
      bpmInput.value = deck.track.bpm.toFixed(1);
    }
    $(`#keylock-${side}`).classList.toggle('on', deck.keylock);
    $(`#keyshift-val-${side}`).textContent = (deck.keyShift > 0 ? '+' : '') + deck.keyShift;
    $(`#keyshift-${side}`).classList.toggle('on', deck.keyShift !== 0);
    $(`#key-edit-label-${side}`).textContent = deck.track ? deck.track.key.camelot.code : '--';
    $(`#key-${side}`).textContent = deck.track ? `${deck.track.key.camelot.code} ${deck.track.key.name}` : '--';
    grid.querySelectorAll('.hotcue').forEach((b, i) => {
      const set = deck.hotcues[i] != null;
      b.classList.toggle('set', set);
      b.style.background = set ? HOTCUE_COLORS[i] : '';
      b.style.color = set ? '#000' : '';
    });
    for (const [beats, btn] of Object.entries(autoBtns)) {
      btn.classList.toggle('active', !!deck.loop && deck.loop.beats === Number(beats));
    }
  };
}
buildDeckUI('A');
buildDeckUI('B');

/* ================= ノブ部品 ================= */
function makeKnob({ label, value = 0.5, min = 0, max = 1, accent = false, small = false, onInput }) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const knob = document.createElement('div');
  knob.className = 'knob' + (accent ? ' accent' : '') + (small ? ' small' : '');
  const pointer = document.createElement('div');
  pointer.className = 'pointer';
  knob.appendChild(pointer);
  const lab = document.createElement('div');
  lab.className = 'knob-label';
  lab.textContent = label;
  wrap.appendChild(knob);
  wrap.appendChild(lab);

  let v = value;
  const initial = value;
  const render = () => {
    const t = (v - min) / (max - min);
    pointer.style.transform = `rotate(${-135 + t * 270}deg)`;
  };
  const set = (nv, fire = false) => {
    v = Math.max(min, Math.min(max, nv));
    render();
    if (fire && onInput) onInput(v);
  };
  let drag = null;
  knob.addEventListener('pointerdown', (e) => {
    knob.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, v };
  });
  knob.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    set(drag.v + (dy / 140) * (max - min), true);
  });
  knob.addEventListener('pointerup', () => (drag = null));
  knob.addEventListener('dblclick', () => set(initial, true));
  render();
  return { el: wrap, set, get value() { return v; } };
}

/* ================= ミキサーUI ================= */
function buildStrip(side) {
  const ch = mixer.channel(side);
  const root = $(`#strip-${side}`);
  const knobs = {
    trim: makeKnob({ label: 'TRIM', value: 0.7, min: 0, max: 1.4, small: true, onInput: (v) => ch.setTrim(v) }),
    high: makeKnob({ label: 'HI', onInput: (v) => ch.setEq('high', v) }),
    mid: makeKnob({ label: 'MID', onInput: (v) => ch.setEq('mid', v) }),
    low: makeKnob({ label: 'LOW', onInput: (v) => ch.setEq('low', v) }),
    color: makeKnob({ label: 'COLOR', value: 0, min: -1, max: 1, accent: true, onInput: (v) => ch.setColor(v) }),
  };
  for (const k of Object.values(knobs)) root.appendChild(k.el);

  const fvWrap = document.createElement('div');
  fvWrap.className = 'fader-vu';
  const fader = document.createElement('input');
  fader.type = 'range';
  fader.className = 'ch-fader';
  fader.min = 0; fader.max = 1000; fader.value = 1000;
  fader.oninput = () => ch.setFader(fader.value / 1000);
  const vu = document.createElement('div');
  vu.className = 'vu';
  if (side === 'A') { fvWrap.appendChild(fader); fvWrap.appendChild(vu); }
  else { fvWrap.appendChild(vu); fvWrap.appendChild(fader); }
  root.appendChild(fvWrap);

  // ヘッドホンCUE (PFL): フェーダーを上げる前にモニターで聴く
  const pfl = document.createElement('button');
  pfl.className = 'pfl-btn';
  pfl.textContent = 'CUE';
  pfl.title = `Deck ${side} をヘッドホンモニターへ`;
  pfl.onclick = () => {
    ch.setCue(!ch.cueOn);
    pfl.classList.toggle('on', ch.cueOn);
  };
  root.appendChild(pfl);

  ch.setTrim(0.7);
  return { knobs, fader, vu, ch, pfl };
}
const strips = { A: buildStrip('A'), B: buildStrip('B') };

function syncStripControls(side) {
  const strip = strips[side];
  const values = strip.ch.values;
  strip.knobs.trim.set(values.trim);
  strip.knobs.high.set(values.high);
  strip.knobs.mid.set(values.mid);
  strip.knobs.low.set(values.low);
  strip.knobs.color.set(values.color);
  const faderValue = Math.round(values.fader * 1000);
  if (Number(strip.fader.value) !== faderValue) strip.fader.value = faderValue;
  strip.pfl.classList.toggle('on', strip.ch.cueOn);
}

function autoMixMarkerFor(side) {
  const plan = planner?.plan;
  const deck = decks[side];
  if (!planner?.enabled || !plan || !deck.track) return null;

  const ex = planner.exec;
  if (ex && (side === ex.from || side === ex.to)) {
    const role = side === ex.from ? 'out' : 'in';
    const start = role === 'out' ? (ex.fromStart ?? plan.exitCue.time) : ex.entryStart;
    return {
      start,
      end: start + ex.durBars * 4 * deck.spb(),
      role,
      state: plan.state,
    };
  }

  if (side !== planner.liveSide) return null;
  const start = cueTimeForTrack(deck.track, plan.exitCue)
    + (plan.automation?.startBeatOffset || 0) * deck.spb();
  return {
    start,
    end: start + plan.durationBars * 4 * deck.spb(),
    role: 'out',
    state: plan.state,
  };
}

const xfaderEl = $('#xfader');
xfaderEl.oninput = () => mixer.setCrossfader(xfaderEl.value / 1000);

/* ================= FXパネルUI ================= */
function buildFxPanel() {
  const root = $('#fx-panel');
  root.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'fx-title';
  title.textContent = 'BEAT FX';
  root.appendChild(title);

  const types = document.createElement('div');
  types.className = 'fx-types';
  for (const t of FX_TYPES) {
    const b = document.createElement('button');
    b.className = 'fx-type-btn' + (t === fx.type ? ' active' : '');
    b.textContent = t;
    b.onclick = () => {
      fx.setType(t);
      types.querySelectorAll('.fx-type-btn').forEach((x) => x.classList.toggle('active', x.textContent === t));
    };
    types.appendChild(b);
  }
  root.appendChild(types);

  const beats = document.createElement('div');
  beats.className = 'fx-beats';
  for (const bt of FX_BEATS) {
    const b = document.createElement('button');
    b.className = 'fx-beat-btn' + (bt === fx.beats ? ' active' : '');
    b.textContent = bt < 1 ? (bt === 0.75 ? '3/4' : `1/${Math.round(1 / bt)}`) : String(bt);
    b.onclick = () => {
      fx.setBeats(bt);
      beats.querySelectorAll('.fx-beat-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    beats.appendChild(b);
  }
  root.appendChild(beats);

  const assigns = document.createElement('div');
  assigns.className = 'fx-assigns';
  for (const target of ['OFF', 'A', 'B', 'MST']) {
    const b = document.createElement('button');
    b.className = 'fx-assign-btn' + (target === 'OFF' ? ' active' : '');
    b.dataset.target = target;
    b.textContent = target;
    b.onclick = () => fx.assign(target);
    assigns.appendChild(b);
  }
  root.appendChild(assigns);

  const knobRow = document.createElement('div');
  knobRow.className = 'fx-knobs';
  knobRow.appendChild(makeKnob({ label: 'DEPTH', value: 0.5, small: true, onInput: (v) => fx.setDepth(v) }).el);
  knobRow.appendChild(makeKnob({ label: 'PARAM', value: 0.5, small: true, onInput: (v) => fx.setParam(v) }).el);
  root.appendChild(knobRow);

  const onBtn = document.createElement('button');
  onBtn.className = 'fx-on-btn';
  onBtn.textContent = 'ON / OFF';
  onBtn.onclick = () => {
    if (fx.type === 'BACKSPIN') {
      triggerBackspinFx(onBtn);
      return;
    }
    fx.setOn(!fx.on);
    onBtn.classList.toggle('on', fx.on);
    if (fx.on && fx.assignTarget === 'OFF') fx.assign('MST');
  };
  root.appendChild(onBtn);
}
buildFxPanel();

/* ================= Planner (AUTO MIX) ================= */
let sessionJournal = null;
planner = new Planner({
  decks, mixer, fx, prepareTrack: ensureTrackBuffer,
  onEvent: (ev) => {
    sessionJournal?.record(`planner:${ev.type}`, ev);
    if (ev.type === 'queue') renderQueue();
    if (ev.type === 'state') {
      $('#btn-automix').classList.toggle('on', ev.enabled);
      $('#automix-status').textContent = ev.enabled ? 'ON' : 'OFF';
      $('#automix-status').classList.toggle('on', ev.enabled);
      renderPlan();
    }
    if (ev.type === 'trackstart') {
      decodedCache.touch(ev.track);
      trimDecodedCache([ev.track]);
      updateDeckHeader(ev.side, ev.track);
      renderLibrary();
      renderQueue();
      renderWorkbench();
      updateBrainPanel();
      renderPlan();
      setStatus(`AUTO MIX ▶ Deck ${ev.side}: ${ev.track.name}`);
    }
    if (ev.type === 'plan') {
      renderPlan();
      setStatus(`Brain: 「${ev.plan.fromTrack}」→「${ev.plan.toTrack}」 ${ev.plan.techniqueName} (${ev.plan.durationBars}小節) を計画`);
    }
    if (ev.type === 'planstate') renderPlan();
    if (ev.type === 'deckunload') {
      resetDeckHeader(ev.side);
      trimDecodedCache();
      renderLibrary();
    }
    if (ev.type === 'loading') setStatus(`${ev.purpose}: ${ev.track.name} を読み込み中…`);
    if (ev.type === 'loaderror') {
      setStatus(`${ev.purpose}失敗: ${ev.track.name}`);
      console.error(ev.error);
      renderPlan();
      renderQueue();
    }
    if (ev.type === 'transition') {
      updateDeckHeader(ev.side, planner.decks[ev.side].track);
      renderLibrary();
      renderWorkbench();
      updateBrainPanel();
      renderPlan();
      setStatus(`準備中: ${ev.plan.techniqueName} — Deck ${ev.side}をミュートで並走`);
    }
    if (ev.type === 'preroll') {
      const kick = ev.kickMatch.reliable ? `キック補正 ${ev.kickMatch.shiftMs >= 0 ? '+' : ''}${ev.kickMatch.shiftMs}ms` : 'グリッド位相同期';
      setStatus(`ヘッドホン準備: Deck ${ev.side} PFL / ${ev.kickMatch.preRollBeats}拍 / ${kick}`);
    }
    if (ev.type === 'preroll-open') {
      setStatus(`MIX開始: ${ev.plan.techniqueName} — PFL解除 / キック同期済み`);
    }
    if (ev.type === 'history') { renderHistory(); renderPlan(); }
    if (ev.type === 'preset') renderPresets();
    if (ev.type === 'composition') renderComposerState();
    if (ev.type === 'xf') xfaderEl.value = ev.value * 1000;
    if (ev.type === 'msg') setStatus(ev.text);
    if (ev.type === 'autofx') $('#btn-autofx').classList.toggle('on', ev.on);
    if (ev.type === 'autoperf') $('#btn-autoperf').classList.toggle('on', ev.on);
  },
});

const COMPOSER_KEY = 'deckghost-composer-v1';
function readComposition() {
  try { return normalizeComposition(JSON.parse(localStorage.getItem(COMPOSER_KEY) || 'null') || DEFAULT_COMPOSITION); }
  catch (e) { return { ...DEFAULT_COMPOSITION }; }
}

function composerValue() {
  const intro = $('#composer-intro').value;
  const handoff = $('#composer-handoff').value;
  const release = $('#composer-release').value;
  return normalizeComposition({
    enabled: $('#btn-composer-enable').classList.contains('on'),
    name: `${$('#composer-intro').selectedOptions[0].textContent} → ${$('#composer-handoff').selectedOptions[0].textContent} → ${$('#composer-release').selectedOptions[0].textContent}`,
    durationBars: Number($('#composer-bars').value), intro, handoff, release,
  });
}

function renderComposerState() {
  const c = planner.composition;
  $('#btn-composer-enable').classList.toggle('on', c.enabled);
  $('#btn-composer-enable').textContent = c.enabled ? 'COMPOSER ON' : 'COMPOSER OFF';
  $('#composer-state').textContent = `${c.durationBars} bars · ${c.name}`;
}

function applyComposerFromUi() {
  const c = composerValue();
  localStorage.setItem(COMPOSER_KEY, JSON.stringify(c));
  planner.setComposition(c);
  setStatus(`Transition Composer: ${c.enabled ? c.name : 'OFF'}`);
}

function buildComposer() {
  const preset = $('#composer-preset');
  for (const [id, value] of Object.entries(COMPOSER_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = value.name; preset.appendChild(opt);
  }
  preset.onchange = () => {
    const p = COMPOSER_PRESETS[preset.value];
    $('#composer-intro').value = p.intro;
    $('#composer-handoff').value = p.handoff;
    $('#composer-release').value = p.release;
    $('#composer-bars').value = String(p.durationBars);
    applyComposerFromUi();
  };
  $('#btn-composer-enable').onclick = () => {
    $('#btn-composer-enable').classList.toggle('on');
    applyComposerFromUi();
  };
  ['#composer-intro', '#composer-handoff', '#composer-release', '#composer-bars'].forEach((sel) => {
    $(sel).onchange = applyComposerFromUi;
  });
  const saved = readComposition();
  $('#composer-intro').value = saved.intro;
  $('#composer-handoff').value = saved.handoff;
  $('#composer-release').value = saved.release;
  $('#composer-bars').value = String(saved.durationBars);
  $('#btn-composer-enable').classList.toggle('on', saved.enabled);
  planner.setComposition(saved);
}
buildComposer();

sessionJournal = new SessionJournal({
  ctx, decks, mixer, planner,
  getTracks: () => library.tracks,
  prepareTrack: ensureTrackBuffer,
  onState: (ev) => {
    if (ev.type === 'record') {
      $('#btn-session-rec').classList.toggle('on', ev.active);
      $('#btn-session-rec').textContent = ev.active ? 'SESSION STOP' : 'SESSION REC';
      $('#session-state').textContent = ev.active ? '操作を記録中' : ev.session ? `${ev.session.snapshots.length} snapshots` : '未記録';
    }
    if (ev.type === 'replay') {
      $('#btn-session-replay').classList.toggle('on', ev.active);
      $('#btn-session-replay').textContent = ev.active ? 'REPLAY STOP' : 'REPLAY';
      if (!ev.active) setStatus('セッションリプレイを終了しました');
    }
    if (ev.type === 'replayerror') {
      setStatus(`セッション再生の音源読込失敗: ${ev.track.name}`);
      console.error(ev.error);
    }
  },
});

$('#btn-session-rec').onclick = () => {
  if (sessionJournal.active) {
    const session = sessionJournal.stop();
    setStatus(`セッション記録完了: ${session.snapshots.length} snapshots / ${session.events.length} events`);
  } else {
    sessionJournal.start();
    setStatus('セッション操作を記録中');
  }
};
$('#btn-session-replay').onclick = () => {
  if (sessionJournal.replay) sessionJournal.stopReplay();
  else if (sessionJournal.startReplay()) setStatus('記録したセッションをリプレイ中');
  else setStatus('先にSESSION RECで操作を記録してください');
};
$('#btn-session-export').onclick = () => {
  if (sessionJournal.active) sessionJournal.stop();
  const blob = sessionJournal.exportBlob();
  if (!blob) { setStatus('書き出せるセッション記録がありません'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deckghost-session-${Date.now()}.json`;
  a.click();
  setStatus('セッション履歴をJSONで書き出しました');
};

const midi = new MidiController({
  decks, mixer, fx, planner,
  onStatus: (msg) => {
    $('#midi-status').textContent = msg;
    setStatus(msg);
  },
});

function renderMidiDevices() {
  const inputSel = $('#midi-input');
  const outputSel = $('#midi-output');
  inputSel.innerHTML = '<option value="">未接続</option>';
  outputSel.innerHTML = '<option value="">未接続</option>';
  for (const input of midi.inputs()) {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = input.name || input.id;
    inputSel.appendChild(opt);
  }
  for (const output of midi.outputs()) {
    const opt = document.createElement('option');
    opt.value = output.id;
    opt.textContent = output.name || output.id;
    outputSel.appendChild(opt);
  }
  if (midi.input) inputSel.value = midi.input.id;
  if (midi.output) outputSel.value = midi.output.id;
}

function buildMidiPanel() {
  const actionSel = $('#midi-learn-action');
  actionSel.innerHTML = '';
  for (const [id, label] of midi.actions) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    actionSel.appendChild(opt);
  }
  $('#btn-midi-enable').onclick = async () => {
    const ok = await midi.init();
    $('#btn-midi-enable').classList.toggle('midi-on', ok);
    renderMidiDevices();
    if (midi.access) {
      midi.access.onstatechange = () => {
        renderMidiDevices();
        $('#midi-status').textContent = 'MIDIデバイス構成が変わりました';
      };
    }
  };
  $('#midi-input').onchange = (e) => midi.setInput(e.target.value);
  $('#midi-output').onchange = (e) => midi.setOutput(e.target.value);
  $('#btn-midi-clock').onclick = () => {
    midi.setClockEnabled(!midi.clockEnabled);
    $('#btn-midi-clock').classList.toggle('midi-on', midi.clockEnabled);
  };
  $('#btn-midi-learn').onclick = () => midi.startLearn(actionSel.value);
  $('#btn-midi-clear').onclick = () => midi.clearLearned();
}
buildMidiPanel();

$('#btn-autofx').onclick = () => planner.setAutoFx(!planner.autoFx);
$('#btn-autoperf').onclick = () => planner.setAutoPerf(!planner.autoPerf);

function renderQueue() {
  const ol = $('#queue-list');
  ol.innerHTML = '';
  for (const t of planner.queue) {
    const li = document.createElement('li');
    li.textContent = `${t.name} — ${t.bpm.toFixed(0)} BPM / ${t.key.camelot.code}`;
    ol.appendChild(li);
  }
  $('#queue-count').textContent = planner.queue.length;
}

$('#btn-automix').onclick = () => {
  if (!planner.enabled) {
    if (planner.queue.length === 0) {
      library.tracks.forEach((t) => planner.addToQueue(t));
      if (planner.queue.length === 0) {
        setStatus('ライブラリが空です。まず「DEMOトラック生成」かファイル読込を。');
        return;
      }
    }
    planner.setEnabled(true);
    setStatus(`AUTO MIX ON — ${planner.queue.length}曲をBrainが自動選曲・計画・実行します`);
  } else {
    planner.setEnabled(false);
    setStatus('AUTO MIX OFF');
  }
};

/* ================= Brain Panel ================= */
function pickRecommendedTechnique(a, b) {
  // 実際のトランジション計画と同じ planTransition を使い、Brainパネルの
  // 推奨と AUTO MIX の実挙動が食い違わないようにする (簡易ヒューリスティックは
  // 較正のたびに本体とズレるため廃止)。
  try {
    return planTransition(a, b, { preset: planner.preset }).techniqueName;
  } catch (e) {
    return '—';
  }
}

function updateBrainPanel() {
  const a = decks.A.track, b = decks.B.track;
  const fmtKey = (t) => t ? `${t.key.camelot.code} ${t.key.name}` : '--';
  const fmtSpec = (t) => t ? `${t.spectrum.character} (L${Math.round(t.spectrum.low * 100)} M${Math.round(t.spectrum.mid * 100)} H${Math.round(t.spectrum.high * 100)})` : '--';
  $('#brain-key-A').textContent = fmtKey(a);
  $('#brain-key-B').textContent = fmtKey(b);
  $('#brain-spec-A').textContent = fmtSpec(a);
  $('#brain-spec-B').textContent = fmtSpec(b);
  if (a && b) {
    const h = harmonicRelation(a.key, b.key);
    const c = spectralConflict(a.spectrum, b.spectrum);
    $('#brain-harmonic').textContent = `${h.name} (score ${h.score.toFixed(2)})`;
    $('#brain-conflict').textContent = `${c < 0.4 ? 'LOW' : c < 0.62 ? 'MID' : 'HIGH'} (${c.toFixed(2)})`;
    $('#brain-technique').textContent = pickRecommendedTechnique(a, b);
  } else {
    $('#brain-harmonic').textContent = '--';
    $('#brain-conflict').textContent = '--';
    $('#brain-technique').textContent = '両デッキにトラックをロードしてください';
  }
}

/* ================= Performance Lab ================= */
function renderPresets() {
  const row = $('#preset-row');
  row.innerHTML = '';
  for (const p of Object.values(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'preset-btn' + (planner.preset.id === p.id ? ' active' : '');
    if (p.analysisOnly) b.classList.add('auto-preset');
    b.textContent = p.name;
    b.title = p.description;
    b.onclick = () => planner.setPreset(p.id);
    row.appendChild(b);
  }
  $('#preset-help').textContent = planner.preset.description;
}

function renderPlan() {
  const plan = planner.plan;
  $('#plan-state').textContent = plan ? plan.state : '-';
  const detail = $('#plan-detail');
  const tl = $('#plan-timeline');
  tl.innerHTML = '';
  if (!plan) {
    detail.innerHTML = planner.enabled
      ? '次のプランを計画中…'
      : 'プランはまだありません (AUTO MIX ONで生成)';
    return;
  }
  detail.innerHTML =
    `<b>${escapeHtml(plan.techniqueName)}</b> — ${plan.durationBars}小節<br>` +
    `${escapeHtml(plan.fromTrack)} <span style="color:var(--txt-dim)">(${escapeHtml(plan.exitCue.label)})</span><br>` +
    `→ ${escapeHtml(plan.toTrack)} <span style="color:var(--txt-dim)">(${escapeHtml(plan.entryCue.label)})</span><br>` +
    `score ${plan.scores.total} / harmonic ${plan.scores.harmonic} / spectral ${plan.scores.spectral} / conf ${plan.scores.confidence.toFixed(2)}` +
    (plan.kickMatch ? `<br>silent pre-roll ${plan.kickMatch.preRollBeats} beats / ${plan.kickMatch.reliable ? `kick ${plan.kickMatch.shiftMs >= 0 ? '+' : ''}${plan.kickMatch.shiftMs}ms` : 'grid phase'}` : '');
  for (const ev of plan.timeline) {
    const li = document.createElement('li');
    li.textContent = `BAR ${ev.bar}: ${ev.action}`;
    tl.appendChild(li);
  }
}

function renderHistory() {
  const ul = $('#history-list');
  ul.innerHTML = '';
  for (const h of planner.history.slice(-8).reverse()) {
    const li = document.createElement('li');
    li.textContent = `${h.techniqueName}: ${h.from} → ${h.to}`;
    ul.appendChild(li);
  }
  $('#history-count').textContent = planner.history.length;
}

/* ================= Cue Workbench ================= */
function renderWorkbench() {
  for (const side of ['A', 'B']) {
    const list = $(`#wb-list-${side}`);
    list.innerHTML = '';
    const track = decks[side].track;
    if (!track) {
      list.innerHTML = '<div style="font-size:10px;color:var(--txt-dim)">NO TRACK</div>';
      continue;
    }
    for (const cue of track.cues) {
      const row = document.createElement('div');
      row.className = 'wb-cue';
      row.innerHTML =
        `<span class="role ${cue.role}">${cue.role}</span>` +
        `<span class="lbl">${escapeHtml(cue.label)}</span>` +
        `<span class="q">${formatTime(cue.time)} · Q${cue.quality}</span>` +
        `<button class="del" title="削除">✕</button>`;
      row.onclick = () => decks[side].seek(cue.time);
      row.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        track.cues = track.cues.filter((c) => c !== cue);
        renderWorkbench();
      };
      list.appendChild(row);
    }
    $(`#wb-add-${side}`).onclick = () => {
      const t = decks[side].track;
      if (!t) return;
      const role = $(`#wb-role-${side}`).value;
      const pos = decks[side].quantize(decks[side].getPosition());
      const bar = Math.floor((pos - t.gridOffset) / ((60 / t.bpm) * 4)) + 1;
      t.cues.push({
        id: `cue_m_${Date.now()}`, time: pos, bar,
        phrase: Math.floor((bar - 1) / 16) + 1,
        role, label: `${role.toUpperCase()} (manual) · bar ${bar}`,
        source: 'manual', confidence: 1.0,
        quality: 100, // 手動CUEを常に優先 (仕様 §28: ユーザー修正を優先)
      });
      t.cues.sort((x, y) => x.time - y.time);
      renderWorkbench();
    };
  }
}

/* ================= Mix Critic / Export ================= */
$('#btn-critic').onclick = async () => {
  const report = criticReport({
    history: planner.history,
    plans: planner.plan ? [planner.plan] : [],
    tracks: library.tracks,
  });
  // サーバ側レポートもマージ (仕様 §27 POST /api/project/report)
  try {
    const res = await fetch('/api/project/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cueBanks: { a: decks.A.track?.cues || [], b: decks.B.track?.cues || [] },
        performance: { queue: planner.plan ? [planner.plan] : [], history: planner.history },
      }),
    });
    const server = await res.json();
    for (const w of server.report?.warnings || []) {
      if (!report.warnings.includes(w)) report.warnings.push(w);
    }
  } catch (e) { /* サーバ不通でもローカルCriticは動く */ }

  const el = $('#critic-report');
  const sec = (title, cls, items) => items.length
    ? `<h4>${title}</h4><ul>${items.map((i) => `<li class="${cls}">${escapeHtml(i)}</li>`).join('')}</ul>` : '';
  el.innerHTML =
    sec('GOOD', 'crit-good', report.good) +
    sec('WARNINGS', 'crit-warn', report.warnings) +
    sec('SUGGESTIONS', 'crit-sugg', report.suggestions) || 'レポート項目なし';
};

$('#btn-export').onclick = () => {
  // DeckGhostProject (仕様 §25) — AudioBufferを除くプロジェクト状態
  const project = {
    app: 'DeckGhost', version: '1.0', exportedAt: new Date().toISOString(),
    tracks: library.tracks.map((t) => ({
      id: t.id, name: t.name, artist: t.artist,
      bpm: t.bpm, bpmSource: t.bpmSource, gridOffset: t.gridOffset,
      tempoAnalysis: t.tempoAnalysis,
      key: t.key, keySource: t.keySource, energy: t.energy,
      spectrum: t.spectrum, sections: t.sections, duration: t.duration,
      chordSequence: t.chordSequence,
      phraseBoundaries: t.phraseBoundaries, dropCandidates: t.dropCandidates,
      audibleStart: t.audibleStart, audibleEnd: t.audibleEnd, silenceRanges: t.silenceRanges,
      loudness: t.loudness, loudnessRange: t.loudnessRange, truePeak: t.truePeak,
      normGain: t.normGain, gainLimited: t.gainLimited,
      cues: t.cues,
    })),
    performance: {
      preset: planner.preset.id,
      queue: planner.queue.map((t) => t.name),
      currentPlan: planner.plan,
      completedPlans: planner.completedPlans,
      history: planner.history,
    },
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deckghost-project-${Date.now()}.json`;
  a.click();
  setStatus('プロジェクトをJSONで書き出しました');
};

/* ================= CUEモニタリング (ヘッドホン出力) =================
   ミキサーのCUEバス(MediaStreamDestination)を <audio> 要素に流し、
   setSinkId() でメイン出力とは別のデバイスへ送る。
   これによりフェーダーを上げる前に次の曲をヘッドホンで仕込める。 */
const cueAudio = new Audio();
cueAudio.srcObject = mixer.cueStream;

async function refreshCueDevices(requestPermission) {
  const sel = $('#cue-device');
  if (requestPermission) {
    // デバイス名の取得にはマイク許可が必要 (ブラウザ仕様)。取得後すぐ停止する。
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) { /* 拒否されてもID列挙は可能 */ }
  }
  const current = sel.value;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const outs = devs.filter((d) => d.kind === 'audiooutput');
  sel.innerHTML = '<option value="">OFF</option>';
  outs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `出力デバイス ${i + 1}`;
    sel.appendChild(opt);
  });
  sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
}

if ('setSinkId' in HTMLMediaElement.prototype && navigator.mediaDevices?.enumerateDevices) {
  const sel = $('#cue-device');
  sel.addEventListener('pointerdown', () => refreshCueDevices(true), { once: true });
  sel.onchange = async () => {
    try {
      if (!sel.value) {
        cueAudio.pause();
        setStatus('CUEモニター OFF');
      } else {
        await cueAudio.setSinkId(sel.value);
        await cueAudio.play();
        setStatus(`CUEモニター → ${sel.options[sel.selectedIndex].textContent}`);
      }
    } catch (e) {
      setStatus('CUE出力デバイスの切替に失敗しました');
      sel.value = '';
    }
  };
  refreshCueDevices(false);
  navigator.mediaDevices.addEventListener?.('devicechange', () => refreshCueDevices(false));
} else {
  // setSinkId 非対応ブラウザ: メイン出力と同じデバイスにしか出せないため無効化
  $('#cue-monitor').style.display = 'none';
}

$('#cue-mst').onclick = () => {
  mixer.setMasterCue(!mixer.masterCueOn);
  $('#cue-mst').classList.toggle('on', mixer.masterCueOn);
};

/* ================= 録音 ================= */
let recorder = null;
$('#btn-rec').onclick = () => {
  const btn = $('#btn-rec');
  if (!recorder) {
    const dest = ctx.createMediaStreamDestination();
    mixer.output.connect(dest);
    const preferred = 'audio/webm;codecs=opus';
    const options = MediaRecorder.isTypeSupported?.(preferred) ? { mimeType: preferred } : undefined;
    recorder = new MediaRecorder(dest.stream, options);
    const activeRecorder = recorder;
    const activeChunks = [];
    recorder.ondataavailable = (e) => activeChunks.push(e.data);
    recorder.onstop = () => {
      mixer.output.disconnect(dest);
      const blob = new Blob(activeChunks, { type: activeRecorder.mimeType || 'audio/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `deckghost-mix-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      a.click();
      setStatus('録音を保存しました');
    };
    recorder.start();
    btn.classList.add('on');
    setStatus('マスター出力を録音中…');
  } else {
    recorder.stop();
    recorder = null;
    btn.classList.remove('on');
  }
};

/* ================= キーボードショートカット ================= */
// Deck A: Q=CUE W=PLAY E=SYNC / Deck B: I=CUE O=PLAY P=SYNC
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const manualSync = (deck, other) => { deck.syncTo(other); deck.autoPitch = false; };
  const map = {
    q: () => decks.A.manualPressCue(), w: () => decks.A.manualTogglePlayback(), e: () => manualSync(decks.A, decks.B),
    i: () => decks.B.manualPressCue(), o: () => decks.B.manualTogglePlayback(), p: () => manualSync(decks.B, decks.A),
  };
  const fn = map[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

/* ================= モバイル表示タブ ================= */
function setupMobileTabs(tabList) {
  const tabs = [...tabList.querySelectorAll('[data-tab-target]')];
  const activate = (tab, moveFocus = false) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.dataset.tabTarget)?.classList.toggle('mobile-active', selected);
    }
    if (moveFocus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.onclick = () => activate(tab);
    tab.onkeydown = (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') next = tabs[0];
      else if (event.key === 'End') next = tabs.at(-1);
      if (!next) return;
      event.preventDefault();
      activate(next, true);
    };
  });
}

document.querySelectorAll('.mobile-tabs').forEach(setupMobileTabs);

/* ================= 描画ループ ================= */
let lastManualPll = 0;

function raf() {
  const now = ctx.currentTime;
  sessionJournal?.capture(now);
  sessionJournal?.tickReplay();

  // スクラッチ中に指が静止したらレコードを押さえた状態 (速度0) にする
  const perfNow = performance.now();
  for (const side of ['A', 'B']) {
    const js = jogHold[side];
    if (js && js.mode === 'scratch' && perfNow - js.lastMove > 70) {
      decks[side].setScratchVelocity(0);
    }
    const zs = zoomHold[side];
    if (zs && perfNow - zs.lastMove > 70) {
      decks[side].setScratchVelocity(0);
    }
  }

  // 手動SYNC中の常時ビートロック: SYNCボタンで合わせた後のドリフトも
  // 自動MIX時と同じPLLで抑える (AUTO MIXのトランジション中は干渉しない)
  if ((planner.phase === 'idle' || planner.phase === 'planned') && now - lastManualPll > 0.25) {
    lastManualPll = now;
    for (const side of ['A', 'B']) {
      const d = decks[side];
      const o = decks[side === 'A' ? 'B' : 'A'];
      if (d.synced && d.playing && o.playing && !d.scratch.active && !o.scratch.active && !jogHold[side]) {
        let err = o.beatPhase() - d.beatPhase();
        if (err > 0.5) err -= 1;
        if (err < -0.5) err += 1;
        d.setBend(Math.abs(err) < 0.005 ? 1 : 1 + Math.max(-0.004, Math.min(0.004, err * 0.06)));
      }
    }
  }

  for (const side of ['A', 'B']) {
    const deck = decks[side];
    const color = DECK_COLORS[side];
    drawZoomWave($(`#zoom-${side}`), deck, color);
    drawOverview($(`#over-${side}`), deck, color, autoMixMarkerFor(side));
    drawJog($(`#jog-${side}`), deck, color);
    if (deck.track) {
      const pos = deck.getPosition(now);
      const remain = deck.duration - pos;
      $(`#time-${side}`).textContent = formatTime(pos);
      $(`#remain-${side}`).textContent = formatTime(-remain);
      $(`#bpm-eff-${side}`).textContent = deck.effBpm.toFixed(1);
      // 終端警告: 残りわずかで再生中なら波形と残り時間を点滅させる (次に行けよ警告)
      const ending = deck.playing && remain > 0 && remain <= END_WARNING_SEC;
      $(`#zoom-${side}`).classList.toggle('ending', ending);
      $(`#remain-${side}`).classList.toggle('ending', ending);
    } else {
      $(`#zoom-${side}`).classList.remove('ending');
      $(`#remain-${side}`).classList.remove('ending');
    }
    drawVu(strips[side].vu, mixer.channel(side).getLevel());
    syncStripControls(side);
  }

  drawMasterVu($('#master-vu'), mixer.getMasterLevel());
  const safety = mixer.tickSafety(now);
  const safetyEl = $('#master-safety');
  safetyEl.textContent = safety.warning ? `${Math.round(safety.gain * 100)}%` : 'SAFE';
  safetyEl.classList.toggle('warn', safety.warning);

  // マスターBPM表示 & FXの拍同期
  const live = planner.liveSide ? decks[planner.liveSide]
    : decks.A.playing ? decks.A : decks.B.playing ? decks.B : null;
  if (live && live.track) $('#master-bpm').textContent = live.effBpm.toFixed(1);
  const fxDeck = fx.assignTarget === 'A' ? decks.A : fx.assignTarget === 'B' ? decks.B : live;
  if (fxDeck && fxDeck.track) fx.setBpm(fxDeck.effBpm);
  midi.tick(perfNow, live?.track ? live.effBpm : 0);

  planner.tick(now);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

/* ================= 初期描画 ================= */
renderPresets();
renderWorkbench();
updateBrainPanel();

// デバッグ/拡張用に内部オブジェクトを公開
window.DeckGhost = { ctx, decks, mixer, fx, planner, library, TECHNIQUES };
window.AIDJ = window.DeckGhost; // 後方互換

setStatus('DeckGhost 起動完了 — 「DEMOトラック生成」でデモ曲を作成し、AUTO MIXをONにしてみてください');
