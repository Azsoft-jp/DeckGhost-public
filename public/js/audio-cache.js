// ===== IndexedDB による音声ファイルデータの永続キャッシュ管理 =====

const DB_NAME = 'DeckGhostAudioCache';
const STORE_NAME = 'audioFiles';
const DB_VERSION = 1;
// キャッシュサイズ上限: 250MB (適度な保管容量)
const MAX_CACHE_BYTES = 250 * 1024 * 1024;

let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sha256' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

/** キャッシュから音声ファイル(ArrayBuffer)を取得する。 */
export async function getCachedAudio(sha256) {
  if (!sha256) return null;
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(sha256);
      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          // タッチされたので updatedAt を更新する非同期処理を走らせる
          updateTouchTime(sha256);
          resolve(result.buffer);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    console.error('Failed to get cached audio from IndexedDB:', e);
    return null;
  }
}

async function updateTouchTime(sha256) {
  try {
    const db = await getDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const getReq = store.get(sha256);
    getReq.onsuccess = () => {
      const data = getReq.result;
      if (data) {
        data.updatedAt = Date.now();
        store.put(data);
      }
    };
  } catch (e) {}
}

/** 音声ファイル(ArrayBuffer)をキャッシュに保管する。 */
export async function cacheAudio(sha256, buffer, name = '') {
  if (!sha256 || !buffer) return;
  
  // PCM (WAV) などの無圧縮音源は重いため、MP3 の場合のみ IndexedDB キャッシュに保存する
  const lowerName = name.toLowerCase();
  const isMp3 = lowerName.endsWith('.mp3') || 
                lowerName.includes('mime=audio/mpeg') || 
                lowerName.includes('audio/mp3') ||
                lowerName.includes('audio/mpeg');
  if (!isMp3) {
    return;
  }

  try {
    const db = await getDB();
    // 自身のサイズを考慮しつつLRUで古いファイルを削る
    await trimCache(buffer.byteLength);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({
        sha256,
        buffer,
        name,
        size: buffer.byteLength,
        updatedAt: Date.now()
      });
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  } catch (e) {
    console.error('Failed to cache audio in IndexedDB:', e);
  }
}

/** 保存前に容量をトリミング。 */
async function trimCache(incomingBytes) {
  try {
    const db = await getDB();
    const allItems = await new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });

    let currentTotalBytes = allItems.reduce((sum, item) => sum + (item.size || 0), 0);
    if (currentTotalBytes + incomingBytes <= MAX_CACHE_BYTES) return;

    // updatedAtの古い順に並び替え
    allItems.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

    for (const item of allItems) {
      if (currentTotalBytes + incomingBytes <= MAX_CACHE_BYTES) break;
      await new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const req = store.delete(item.sha256);
        req.onsuccess = () => {
          currentTotalBytes -= (item.size || 0);
          resolve();
        };
        req.onerror = () => resolve();
      });
    }
  } catch (e) {
    console.error('Failed to trim IndexedDB cache:', e);
  }
}
