/**
 * DeckGhost サーバ — AI / Algorithmic DJ Performance Engine
 * - 静的ファイル配信 (public/)
 * - 楽曲ライブラリ API (tracks/ ディレクトリの列挙・配信・アップロード)
 * - Brain API (技法DB / トランジション評価 / セット検証 / プロジェクトレポート)
 *
 * 方針: 音声はブラウザ内で解析・再生する (local-first)。
 * サーバは「計画と評価」のAPIとファイル配信のみを担う。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TRACKS_DIR = path.join(__dirname, '..', 'tracks');
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.webm']);
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB

fs.mkdirSync(TRACKS_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/tracks', express.static(TRACKS_DIR));

/* ================= ライブラリ API ================= */

// ファイル名のサニタイズ(パストラバーサル防止)
function safeName(name) {
  const base = path.basename(name).replace(/[^\w\-. ()\[\]&+']/g, '_');
  if (!AUDIO_EXT.has(path.extname(base).toLowerCase())) return null;
  return base;
}

app.get('/api/tracks', (req, res) => {
  fs.readdir(TRACKS_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'readdir failed' });
    const list = files
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const st = fs.statSync(path.join(TRACKS_DIR, f));
        return { name: f, url: '/tracks/' + encodeURIComponent(f), size: st.size, mtime: st.mtimeMs };
      });
    res.json({ tracks: list });
  });
});

// 楽曲アップロード (raw body ストリーム書き込み)
app.post('/api/tracks/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'unsupported file type' });
  const dest = path.join(TRACKS_DIR, name);
  const ws = fs.createWriteStream(dest);
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      req.destroy();
      ws.destroy();
      fs.unlink(dest, () => {});
    }
  });
  req.pipe(ws);
  ws.on('finish', () => res.json({ ok: true, name, url: '/tracks/' + encodeURIComponent(name) }));
  ws.on('error', () => res.status(500).json({ error: 'write failed' }));
});

/* ================= Brain API ================= */

function loadTechniques() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'techniques.json'), 'utf8'));
}

// DJ技法データベース (67技法)
app.get('/api/techniques', (req, res) => {
  try { res.json(loadTechniques()); }
  catch (e) { res.status(500).json({ error: 'technique db unavailable' }); }
});

/* ---- Camelot / 調性互換 ---- */
function parseCam(c) {
  const m = /^(\d{1,2})([AB])$/.exec(String(c || '').trim().toUpperCase());
  return m ? { n: +m[1], l: m[2] } : null;
}
function camDist(a, b) {
  const A = parseCam(a), B = parseCam(b);
  if (!A || !B) return 99;
  return Math.min(Math.abs(A.n - B.n), 12 - Math.abs(A.n - B.n)) + (A.l === B.l ? 0 : 0.45);
}
function harmonicName(d) {
  return d === 0 ? 'perfect lock'
    : d <= 0.5 ? 'relative major/minor'
    : d <= 1 ? 'energy-safe adjacent'
    : d <= 2 ? 'creative tension'
    : 'key clash risk';
}

// 2曲のトランジション評価: 調性互換 + スペクトル衝突 → 推奨技法
// Key Clash ≠ Transition Rejection (仕様 §7) — 拒否せず技法選択の入力にする
app.post('/api/brain/transition', express.json(), (req, res) => {
  const a = req.body?.a || {}, b = req.body?.b || {};
  const ac = a.camelot, bc = b.camelot;
  const dist = camDist(ac, bc);
  const lowConflict = Math.min(a.low ?? 0.33, b.low ?? 0.33);
  const midConflict = Math.min(a.mid ?? 0.33, b.mid ?? 0.33);
  const conflict = Math.min(1, lowConflict * 1.25 + midConflict * 0.85);
  const technique =
    dist > 2 && conflict > 0.55 ? 'echo_out_slam'
    : conflict > 0.5 ? 'bass_swap'
    : dist <= 1 ? 'phrase_blend'
    : 'filter_echo_blend';
  res.json({
    camelot: { a: ac, b: bc, relationship: harmonicName(dist) },
    technique,
    scores: {
      harmonic: Math.max(0, 1 - dist / 4),
      spectral: Math.max(0, 1 - conflict),
    },
  });
});

// パフォーマンスセット検証 (Plan Queue の妥当性チェック)
app.post('/api/performance-set/validate', express.json({ limit: '1mb' }), (req, res) => {
  const queue = Array.isArray(req.body?.queue) ? req.body.queue : [];
  const warnings = [];
  for (const [i, q] of queue.entries()) {
    if (!q.technique) warnings.push(`Plan ${i + 1}: missing technique`);
    if (!q.entryCue || !q.exitCue) warnings.push(`Plan ${i + 1}: missing cue pair`);
    if ((q.scores?.confidence ?? 1) < 0.45) warnings.push(`Plan ${i + 1}: low confidence`);
  }
  res.json({ ok: warnings.length === 0, planCount: queue.length, warnings });
});

// プロジェクトレポート (Mix Critic 用サマリ)
app.post('/api/project/report', express.json({ limit: '2mb' }), (req, res) => {
  const cueBanks = req.body?.cueBanks || {};
  const queue = req.body?.performance?.queue || [];
  const history = req.body?.performance?.history || [];
  const report = {
    cueCount: Object.fromEntries(
      Object.entries(cueBanks).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
    queueCount: Array.isArray(queue) ? queue.length : 0,
    historyCount: Array.isArray(history) ? history.length : 0,
    warnings: [],
  };
  // 同一技法の連続使用を検出 (仕様 §13: 同一技法連続の抑制)
  let streak = 1;
  for (let i = 1; i < history.length; i++) {
    streak = history[i].technique === history[i - 1].technique ? streak + 1 : 1;
    if (streak >= 3) {
      report.warnings.push(`Technique "${history[i].technique}" used ${streak} times in a row.`);
      break;
    }
  }
  if (report.queueCount < 1) report.warnings.push('Performance queue is empty.');
  res.json({ ok: report.warnings.length === 0, report });
});

app.listen(PORT, () => {
  console.log(`DeckGhost running: http://localhost:${PORT}`);
});
