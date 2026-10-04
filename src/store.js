// IndexedDB 에 키-값으로 저장 (이미지 Blob 도 그대로 들어감).
// 사생활 보호 모드 등에서 못 쓰면 저장만 안 되고 앱은 그대로 돌아감

const DB_NAME = 'sticker-board';
const STORE = 'kv';

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close(); // 다른 탭이 지우거나 올리려 하면 비켜 줌
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (key) => run('readonly', (store) => store.get(key)).catch(() => undefined);
export const set = (key, value) => run('readwrite', (store) => store.put(value, key)).catch(() => {});
export const remove = (key) => run('readwrite', (store) => store.delete(key)).catch(() => {});
