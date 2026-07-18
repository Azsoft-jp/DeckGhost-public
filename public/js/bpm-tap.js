// ===== TAPテンポの純粋計算 =====
// UIはタップ中にこの推定値だけを表示し、無入力時間が続いてから一度だけ確定する。

export function estimateTapBpm(times) {
  if (!Array.isArray(times) || times.length < 2) return null;
  const elapsed = Number(times.at(-1)) - Number(times[0]);
  if (!(elapsed > 0)) return null;
  let bpm = 60000 / (elapsed / (times.length - 1));
  while (bpm < 70) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return Math.round(bpm * 100) / 100;
}

export function tapFinishDelay(times) {
  if (!Array.isArray(times) || times.length < 2) return 1200;
  const averageInterval = (Number(times.at(-1)) - Number(times[0])) / (times.length - 1);
  if (!(averageInterval > 0)) return 1200;
  return Math.round(Math.max(900, Math.min(1800, averageInterval * 1.75)));
}
