// ===== 波形描画: ズームビュー / オーバービュー / ジョグ =====

const HOTCUE_COLORS = ['#ef4444', '#fb923c', '#f5b942', '#4ade80', '#22d3ee', '#8fb8e8', '#94a3b8', '#f472b6'];
export { HOTCUE_COLORS };

export const SECTION_COLORS = {
  intro:  { fill: 'rgba(34,211,238,0.22)',  line: '#22d3ee', label: 'INTRO' },
  verse:  { fill: 'rgba(148,163,184,0.18)', line: '#94a3b8', label: 'VERSE' },
  build:  { fill: 'rgba(245,185,66,0.24)',  line: '#f5b942', label: 'BUILD' },
  chorus: { fill: 'rgba(74,222,128,0.22)',  line: '#4ade80', label: 'CHORUS' },
  drop:   { fill: 'rgba(239,68,68,0.24)',   line: '#ef4444', label: 'DROP' },
  break:  { fill: 'rgba(143,184,232,0.22)', line: '#8fb8e8', label: 'BREAK' },
  outro:  { fill: 'rgba(125,129,138,0.22)', line: '#7d818a', label: 'OUTRO' },
};

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  // 表示サイズはCSSレイアウト(clientWidth/Height)から取得。
  // バッキングストア(canvas.width/height)は clientWidth に影響しないよう
  // CSSで表示サイズを固定してあるため、ここでの再確保がフィードバックしない。
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (w === 0 || h === 0) return { g: canvas.getContext('2d'), w, h };
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

/* ---------- ズーム波形 (再生ヘッド中央固定・スクロール) ---------- */
export function drawZoomWave(canvas, deck, color) {
  const { g, w, h } = setupCanvas(canvas);
  if (w === 0 || h === 0) return;
  g.clearRect(0, 0, w, h);
  if (!deck.track) return;

  const peaks = deck.track.peaksZoom;
  const pps = 200; // peaks per second
  const windowSec = 11;
  const pos = deck.getPosition();
  const t0 = pos - windowSec / 2;
  const pxPerSec = w / windowSec;
  const mid = h / 2;

  // 波形: 1ピクセルに複数のピークサンプル(200Hz)が対応するため、
  // 単一サンプルの最近傍だけを選ぶとスクロール中の端数位置によって
  // フレームごとに選ばれるサンプルが飛び、ちらついて見える。
  // ピクセル幅ぶんの区間で最大値を取ることで滑らかにする。
  for (let x = 0; x < w; x++) {
    const t = t0 + x / pxPerSec;
    if (t < 0 || t >= deck.duration) continue;
    const i0 = Math.floor(t * pps);
    const i1 = Math.max(i0 + 1, Math.floor((t + 1 / pxPerSec) * pps));
    let peak = 0;
    for (let i = i0; i < i1; i++) { const v = peaks[i] || 0; if (v > peak) peak = v; }
    const amp = peak * (h / 2 - 4);
    const played = t < pos;
    g.fillStyle = played ? color : 'rgba(140,150,175,0.55)';
    g.fillRect(x, mid - amp, 1, amp * 2 || 1);
  }

  // ビートグリッド (小節頭=太い白線, 4小節フレーズ頭=シアン, 拍=細い線)
  if (deck.bpm > 0 && deck.tempoMap) {
    const startBeat = Math.max(0, Math.floor(deck.tempoMap.beatAtTime(t0)));
    for (let b = startBeat; ; b++) {
      const t = deck.tempoMap.timeAtBeat(b);
      if (t > t0 + windowSec) break;
      const x = (t - t0) * pxPerSec;
      const barInfo = deck.tempoMap.barAtTime(t);
      const isBar = barInfo.beatInBar === 1;
      const isPhrase = isBar && (barInfo.bar - 1) % 4 === 0;
      if (isPhrase) { g.fillStyle = 'rgba(34,211,238,0.9)'; g.fillRect(x - 1, 0, 2, h); continue; }
      g.fillStyle = isBar ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.22)';
      g.fillRect(x, 0, isBar ? 1.5 : 1, isBar ? h : h * 0.35);
    }
  }

  // ループ範囲
  if (deck.loop) {
    const x1 = (deck.loop.start - t0) * pxPerSec;
    const x2 = (deck.loop.end - t0) * pxPerSec;
    g.fillStyle = 'rgba(74,222,128,0.18)';
    g.fillRect(x1, 0, x2 - x1, h);
    g.strokeStyle = '#4ade80';
    g.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, h - 1);
  }

  // HOT CUEマーカー
  deck.hotcues.forEach((cue, i) => {
    if (cue == null) return;
    const x = (cue - t0) * pxPerSec;
    if (x < 0 || x > w) return;
    g.fillStyle = HOTCUE_COLORS[i];
    g.fillRect(x - 1, 0, 2, h);
    g.beginPath();
    g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7);
    g.fill();
  });

  // CUEポイント
  const cx = (deck.cuePoint - t0) * pxPerSec;
  if (cx >= 0 && cx <= w) {
    g.fillStyle = '#fff';
    g.fillRect(cx - 0.5, 0, 1.5, h);
  }

  // 再生ヘッド (中央)
  g.fillStyle = '#f43f5e';
  g.fillRect(w / 2 - 1, 0, 2, h);
}

export function autoMixRegionPixels(duration, width, marker) {
  if (!marker || !(duration > 0) || !(width > 0)
    || !Number.isFinite(marker.start) || !Number.isFinite(marker.end)) return null;
  const start = Math.max(0, Math.min(duration, marker.start));
  const end = Math.max(start, Math.min(duration, marker.end));
  return {
    x1: (start / duration) * width,
    x2: (end / duration) * width,
  };
}

function drawAutoMixRegion(g, w, h, duration, marker) {
  const region = autoMixRegionPixels(duration, w, marker);
  if (!region) return;
  const { x1, x2 } = region;
  const width = Math.max(2, x2 - x1);
  const active = marker.state === 'executing';
  const armed = marker.state === 'armed';
  const line = active ? '#4ade80' : armed ? '#22d3ee' : '#f5b942';
  const fill = active ? 'rgba(74,222,128,0.20)'
    : armed ? 'rgba(34,211,238,0.18)' : 'rgba(245,185,66,0.18)';

  g.fillStyle = fill;
  g.fillRect(x1, 0, width, h);
  g.fillStyle = line;
  g.fillRect(x1, 0, 2, h);
  g.fillRect(Math.max(x1, x2 - 2), 0, 2, h);
  g.fillRect(x1, h - 3, width, 3);

  if (width >= 38) {
    const label = `AUTO MIX ${marker.role === 'in' ? 'IN' : 'OUT'}`;
    const labelWidth = Math.min(width - 4, label.length * 5 + 6);
    g.fillStyle = 'rgba(5,6,7,0.82)';
    g.fillRect(x1 + 2, h - 14, labelWidth, 10);
    g.font = '700 7px system-ui';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = line;
    g.fillText(label, x1 + 5, h - 13, Math.max(0, labelWidth - 6));
  }
}

/* ---------- オーバービュー ---------- */
export function drawOverview(canvas, deck, color, autoMixMarker = null) {
  const { g, w, h } = setupCanvas(canvas);
  if (w === 0 || h === 0) return;
  g.clearRect(0, 0, w, h);
  if (!deck.track) return;

  const peaks = deck.track.peaksOverview;
  const n = peaks.length;
  const pos = deck.getPosition();
  const playedX = (pos / deck.duration) * w;
  const mid = h / 2;

  // 曲構成を全体波形の背景色として表示。解析境界は1小節精度の推定値なので、
  // ラベルと境界を明示しつつ波形/HOT CUEは前面に残す。
  for (const section of deck.track.sections || []) {
    const style = SECTION_COLORS[section.label] || SECTION_COLORS.verse;
    let start, end;
    if (deck.tempoMap) {
      start = Math.max(0, deck.tempoMap.timeAtBeat(deck.tempoMap.beatAtBar(section.startBar)));
      end = Math.min(deck.duration, deck.tempoMap.timeAtBeat(deck.tempoMap.beatAtBar(section.startBar + section.lengthBars)));
    } else {
      const barSec = deck.bpm > 0 ? deck.spb() * 4 : 0;
      start = Math.max(0, deck.track.gridOffset + (section.startBar - 1) * barSec);
      end = Math.min(deck.duration, start + section.lengthBars * barSec);
    }
    const x1 = (start / deck.duration) * w;
    const x2 = (end / deck.duration) * w;
    g.fillStyle = style.fill;
    g.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    g.fillStyle = style.line;
    g.fillRect(x1, 0, 1, h);
    if (x2 - x1 >= 34) {
      g.font = '700 7px system-ui';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = style.line;
      g.fillText(style.label, x1 + 3, 2, Math.max(0, x2 - x1 - 5));
    }
  }

  for (let x = 0; x < w; x++) {
    const idx = Math.floor((x / w) * n);
    const amp = Math.max(1, peaks[idx] * (h / 2 - 2));
    g.fillStyle = x < playedX ? color : 'rgba(210,214,224,0.58)';
    g.fillRect(x, mid - amp, 1, amp * 2);
  }

  // AUTO MIXの計画区間。計画時は予定位置、アーム後は確定した実位置を描く。
  drawAutoMixRegion(g, w, h, deck.duration, autoMixMarker);

  deck.hotcues.forEach((cue, i) => {
    if (cue == null) return;
    const x = (cue / deck.duration) * w;
    g.fillStyle = HOTCUE_COLORS[i];
    g.fillRect(x, 0, 1.5, h);
  });

  g.fillStyle = '#fff';
  g.fillRect(playedX - 0.75, 0, 1.5, h);
}

/* ---------- ジョグホイール ---------- */
export function drawJog(canvas, deck, color) {
  const { g, w, h } = setupCanvas(canvas);
  if (w === 0 || h === 0) return;
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 3;

  // 外周リング
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = '#12151f';
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = '#2a2f40';
  g.stroke();

  // ストロボ模様
  g.save();
  g.translate(cx, cy);
  const pos = deck.getPosition();
  const rot = (pos / 1.8) * Math.PI * 2; // 1.8秒/回転 (33回転相当)
  g.rotate(rot);
  for (let i = 0; i < 24; i++) {
    g.rotate(Math.PI / 12);
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)';
    g.beginPath();
    g.arc(0, 0, R - 4, -Math.PI / 24, Math.PI / 24);
    g.arc(0, 0, R * 0.62, Math.PI / 24, -Math.PI / 24, true);
    g.fill();
  }
  // 位置マーカー
  g.fillStyle = deck.playing ? color : 'rgba(160,168,190,0.9)';
  g.beginPath();
  g.arc(0, -(R * 0.8), 4.5, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // センターディスプレイ
  g.beginPath();
  g.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
  g.fillStyle = '#05060a';
  g.fill();
  g.strokeStyle = '#2a2f40';
  g.stroke();

  if (deck.track) {
    // 残り時間に応じた円弧
    const frac = pos / deck.duration;
    g.beginPath();
    g.arc(cx, cy, R * 0.55 - 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.stroke();

    g.fillStyle = '#d6dae6';
    g.font = '700 15px system-ui';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(deck.effBpm.toFixed(1), cx, cy - 8);
    g.font = '600 9px system-ui';
    g.fillStyle = '#7a8095';
    g.fillText('BPM', cx, cy + 8);
    // 拍位相インジケータ (4分割)
    const beat = Math.floor(deck.beatAt(pos)) % 4;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i === ((beat % 4) + 4) % 4 && deck.playing ? color : '#2a2f40';
      g.fillRect(cx - 22 + i * 12, cy + 18, 8, 4);
    }
  }
}

/* ---------- VUメーター描画 (縦バー, DOM要素の背景として) ---------- */
export function drawVu(el, level) {
  const pct = Math.round(level * 100);
  const grad = `linear-gradient(to top,
    #4ade80 0%, #4ade80 ${Math.min(pct, 65)}%,
    ${pct > 65 ? '#fbbf24' : 'transparent'} ${Math.min(pct, 88)}%,
    ${pct > 88 ? '#f43f5e' : 'transparent'} ${pct}%,
    transparent ${pct}%, transparent 100%)`;
  el.style.background = `${grad}, #05060a`;
}

/* ---------- マスターVU (縦, canvas) ---------- */
export function drawMasterVu(canvas, level) {
  const { g, w, h } = setupCanvas(canvas);
  if (w === 0 || h === 0) return;
  g.clearRect(0, 0, w, h);
  const segs = 24;
  const lit = Math.round(level * segs);
  for (let i = 0; i < segs; i++) {
    const segmentHeight = h / segs;
    const y = h - ((i + 1) * segmentHeight) + 1;
    if (i < lit) g.fillStyle = i > segs * 0.85 ? '#f43f5e' : i > segs * 0.65 ? '#fbbf24' : '#4ade80';
    else g.fillStyle = '#1a1e2b';
    g.fillRect(3, y, Math.max(1, w - 6), Math.max(1, segmentHeight - 2));
  }
}
