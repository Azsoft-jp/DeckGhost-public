// ===== 保存済みGridの復元規則 =====
// ユーザーが手動補正した値は、音源に付随する解析ヒントより常に優先する。
// この関数は読込時に値を選ぶだけで、localStorageや保存レコードを変更しない。

export function analysisHintsForTrack(meta = {}, stored = null) {
  if (stored) {
    const hints = {
      bpm: stored.bpm,
      gridOffset: stored.gridOffset,
      key: stored.key,
    };
    if (stored.beatGrid) {
      hints.beatGrid = stored.beatGrid;
    } else if (Number.isFinite(stored.bpm) && Number.isFinite(stored.gridOffset)) {
      // v1 から v2 への自動移行
      hints.beatGrid = {
        mode: 'rigid',
        anchors: [{ beatIndex: 0, timeSec: stored.gridOffset, localBpm: stored.bpm, confidence: 1.0, source: 'manual' }],
        meterSegments: [{ startBeat: 0, numerator: 4, denominator: 4, beatUnit: 'quarter', downbeatBeatIndex: 0, confidence: 1.0, source: 'manual' }],
        firstReliableBeatTimeSec: stored.gridOffset,
        barOriginBeatIndex: 0,
        barOneBeatIndex: 0,
        analysisVersion: '2.0',
        locked: false
      };
    }
    return hints;
  }
  if (meta.bpm != null) {
    return {
      bpm: meta.bpm,
      gridOffset: meta.gridOffset,
      energy: meta.energy,
      key: meta.key,
      beatGrid: meta.beatGrid
    };
  }
  return {};
}
