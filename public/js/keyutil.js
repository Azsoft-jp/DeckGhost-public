// ===== 音楽キー / Camelot ホイール ユーティリティ =====

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Camelot 番号 (メジャー: 8B=C, マイナー: 8A=Am)
const CAMELOT_MAJOR = { 0: 8, 1: 3, 2: 10, 3: 5, 4: 12, 5: 7, 6: 2, 7: 9, 8: 4, 9: 11, 10: 6, 11: 1 };
const CAMELOT_MINOR = { 9: 8, 10: 3, 11: 10, 0: 5, 1: 12, 2: 7, 3: 2, 4: 9, 5: 4, 6: 11, 7: 6, 8: 1 };

/** ルート音(0-11)とモードから Camelot コードを返す (例: {code:"8A", num:8, letter:"A"}) */
export function toCamelot(root, mode) {
  const num = mode === 'major' ? CAMELOT_MAJOR[root] : CAMELOT_MINOR[root];
  const letter = mode === 'major' ? 'B' : 'A';
  return { code: num + letter, num, letter };
}

/** キー表示名 (例: "Am" / "C") */
export function keyName(root, mode) {
  return NOTE_NAMES[root] + (mode === 'minor' ? 'm' : '');
}

/**
 * Camelot 互換距離 (0=同一, 1=隣接/相対キー, 大きいほど不協和)
 * ハーモニックミキシングの基本則:
 *   同番号同文字=0 / ±1同文字=1 / 同番号異文字(相対キー)=1 / それ以外は円周距離+ペナルティ
 */
export function camelotDistance(k1, k2) {
  if (!k1 || !k2) return 3;
  const circ = Math.min(Math.abs(k1.num - k2.num), 12 - Math.abs(k1.num - k2.num));
  const letterDiff = k1.letter === k2.letter ? 0 : 1;
  if (circ === 0) return letterDiff;          // 0 or 1 (相対キー)
  if (circ === 1 && letterDiff === 0) return 1; // 隣接
  return circ + letterDiff + 1;
}

export function formatTime(sec) {
  if (!isFinite(sec)) return '00:00.0';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}
