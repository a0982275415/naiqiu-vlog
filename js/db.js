/* IndexedDB 簡易包裝 — 資料庫 naiqiu-vlog */
const DB = (() => {
  const NAME = 'naiqiu-vlog';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const clips = db.createObjectStore('clips', { keyPath: 'id' });
        clips.createIndex('date', 'date');
        db.createObjectStore('dailyVideos', { keyPath: 'date' });
        db.createObjectStore('diary', { keyPath: 'date' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r && 'onsuccess' in r) {
        r.onsuccess = () => { result = r.result; };
      }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  /* 取出所有「有片段的日期」（index 的 getAllKeys 回傳的是主鍵，要用 cursor 讀 index key） */
  function allClipDates() {
    return open().then(db => new Promise((resolve, reject) => {
      const dates = new Set();
      const req = db.transaction('clips', 'readonly')
        .objectStore('clips').index('date').openKeyCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { dates.add(cur.key); cur.continue(); }
        else resolve([...dates]);
      };
      req.onerror = () => reject(req.error);
    }));
  }

  return {
    putClip: c => tx('clips', 'readwrite', s => s.put(c)),
    deleteClip: id => tx('clips', 'readwrite', s => s.delete(id)),
    clipsByDate: date => tx('clips', 'readonly', s => s.index('date').getAll(date)),
    allClipDates,
    putDaily: d => tx('dailyVideos', 'readwrite', s => s.put(d)),
    getDaily: date => tx('dailyVideos', 'readonly', s => s.get(date)),
    putDiary: d => tx('diary', 'readwrite', s => s.put(d)),
    getDiary: date => tx('diary', 'readonly', s => s.get(date)),
  };
})();
