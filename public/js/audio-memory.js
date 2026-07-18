// ===== デコード済みPCMのメモリ管理 =====
// AudioBufferは圧縮MP3の数十倍になるため、ライブラリ全曲ぶんは保持しない。
// 再生中/準備中のトラックは呼び出し側がprotectedとして渡し、それ以外だけをLRU解放する。

export function decodedAudioBytes(buffer) {
  if (!buffer) return 0;
  const channels = Math.max(1, Number(buffer.numberOfChannels) || 1);
  const length = Math.max(0, Number(buffer.length) || 0);
  return channels * length * Float32Array.BYTES_PER_ELEMENT;
}

export class DecodedBufferCache {
  constructor({ maxIdleBytes = 0, maxIdleTracks = 1 } = {}) {
    this.maxIdleBytes = Math.max(0, maxIdleBytes);
    this.maxIdleTracks = Math.max(0, maxIdleTracks);
    this.entries = new Map();
    this.clock = 0;
  }

  touch(track) {
    if (!track?.buffer) return;
    this.entries.set(track, {
      bytes: decodedAudioBytes(track.buffer),
      usedAt: ++this.clock,
    });
  }

  release(track) {
    if (!track?.buffer) {
      this.entries.delete(track);
      return 0;
    }
    const bytes = this.entries.get(track)?.bytes ?? decodedAudioBytes(track.buffer);
    track.buffer = null;
    this.entries.delete(track);
    return bytes;
  }

  /** 次のデコード前にアイドルPCMを全解放し、ピーク時の多重保持を防ぐ。 */
  prepareForDecode(protectedTracks = []) {
    const protectedSet = new Set(protectedTracks);
    let releasedBytes = 0;
    for (const track of [...this.entries.keys()]) {
      if (!protectedSet.has(track)) releasedBytes += this.release(track);
    }
    return releasedBytes;
  }

  /** アイドルPCMをLRU順に削り、曲数とバイト数の両上限へ収める。 */
  trim(protectedTracks = []) {
    const protectedSet = new Set(protectedTracks);
    const idle = [...this.entries.entries()]
      .filter(([track]) => track.buffer && !protectedSet.has(track))
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    let idleBytes = idle.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    let idleTracks = idle.length;
    let releasedBytes = 0;
    for (const [track, entry] of idle) {
      if (idleTracks <= this.maxIdleTracks && idleBytes <= this.maxIdleBytes) break;
      releasedBytes += this.release(track);
      idleBytes -= entry.bytes;
      idleTracks--;
    }
    return releasedBytes;
  }

  stats(protectedTracks = []) {
    const protectedSet = new Set(protectedTracks);
    let totalBytes = 0, protectedBytes = 0, decodedTracks = 0;
    for (const [track, entry] of this.entries) {
      if (!track.buffer) continue;
      totalBytes += entry.bytes;
      decodedTracks++;
      if (protectedSet.has(track)) protectedBytes += entry.bytes;
    }
    return { totalBytes, protectedBytes, idleBytes: totalBytes - protectedBytes, decodedTracks };
  }
}
