/**
 * DeckGhost — Cloudflare Worker
 * 静的アセット(public/)は wrangler.json の assets binding が配信。
 * ここでは計算のみの Brain API を処理し、それ以外は env.ASSETS へフォールバックする。
 *
 * 注意: /api/tracks (一覧/アップロード) は server/index.js ではローカルの
 * tracks/ フォルダに永続書き込みしているが、Workers には永続ファイルシステムが
 * ないため未実装。必要であれば R2 バケットを bind して置き換えること。
 * ライブラリ機能はブラウザ側のファイル読込/デモトラック生成で完結するため必須ではない。
 */
import techniques from '../data/techniques.json';

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

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

async function handleApi(request, url) {
  const { pathname } = url;

  if (pathname === '/api/techniques' && request.method === 'GET') {
    return json(techniques);
  }

  // 2曲のトランジション評価: 調性互換 + スペクトル衝突 → 推奨技法
  // Key Clash ≠ Transition Rejection — 拒否せず技法選択の入力にする
  if (pathname === '/api/brain/transition' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const a = body?.a || {}, b = body?.b || {};
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
    return json({
      camelot: { a: ac, b: bc, relationship: harmonicName(dist) },
      technique,
      scores: {
        harmonic: Math.max(0, 1 - dist / 4),
        spectral: Math.max(0, 1 - conflict),
      },
    });
  }

  // パフォーマンスセット検証 (Plan Queue の妥当性チェック)
  if (pathname === '/api/performance-set/validate' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const queue = Array.isArray(body?.queue) ? body.queue : [];
    const warnings = [];
    for (const [i, q] of queue.entries()) {
      if (!q.technique) warnings.push(`Plan ${i + 1}: missing technique`);
      if (!q.entryCue || !q.exitCue) warnings.push(`Plan ${i + 1}: missing cue pair`);
      if ((q.scores?.confidence ?? 1) < 0.45) warnings.push(`Plan ${i + 1}: low confidence`);
    }
    return json({ ok: warnings.length === 0, planCount: queue.length, warnings });
  }

  // プロジェクトレポート (Mix Critic 用サマリ)
  if (pathname === '/api/project/report' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const cueBanks = body?.cueBanks || {};
    const queue = body?.performance?.queue || [];
    const history = body?.performance?.history || [];
    const report = {
      cueCount: Object.fromEntries(
        Object.entries(cueBanks).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
      queueCount: Array.isArray(queue) ? queue.length : 0,
      historyCount: Array.isArray(history) ? history.length : 0,
      warnings: [],
    };
    let streak = 1;
    for (let i = 1; i < history.length; i++) {
      streak = history[i].technique === history[i - 1].technique ? streak + 1 : 1;
      if (streak >= 3) {
        report.warnings.push(`Technique "${history[i].technique}" used ${streak} times in a row.`);
        break;
      }
    }
    if (report.queueCount < 1) report.warnings.push('Performance queue is empty.');
    return json({ ok: report.warnings.length === 0, report });
  }

  // 未実装: 永続ファイルシステムが必要 (R2導入時にここへ実装する)
  if (pathname === '/api/tracks') {
    return json({ tracks: [] });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url);
    }
    return env.ASSETS.fetch(request);
  },
};
