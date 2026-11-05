/* 画面（app.js）とサービスワーカー（sw.js）の両方で使う共通処理：端末内保存と送信 */
(function (g) {
  'use strict';
  const DB_NAME = 'kidsfam-receipt';
  const DB_VER = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function run(store, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(r && 'result' in r ? r.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  const DB = {
    put: (item) => run('queue', 'readwrite', (s) => s.put(item)),
    get: (id) => run('queue', 'readonly', (s) => s.get(id)),
    del: (id) => run('queue', 'readwrite', (s) => s.delete(id)),
    all: async () => ((await run('queue', 'readonly', (s) => s.getAll())) || []).sort((a, b) => a.createdAt - b.createdAt),
    getKV: (k) => run('kv', 'readonly', (s) => s.get(k)),
    setKV: (k, v) => run('kv', 'readwrite', (s) => s.put(v, k)),
    async settings() { return (await DB.getKV('settings')) || { gasUrl: '', token: '' }; },
  };

  async function api(action, payload) {
    const s = await DB.settings();
    if (!s.gasUrl || !s.token) { const e = new Error('設定画面で「GASのURL」と「合言葉」を入力してください'); e.code = 'nosettings'; throw e; }
    let res;
    try {
      res = await fetch(s.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: s.token }, payload || {})),
        redirect: 'follow',
      });
    } catch (err) {
      const e = new Error('通信できませんでした（電波を確認してください）'); e.code = 'network'; throw e;
    }
    let j;
    try { j = await res.json(); } catch (err) { const e = new Error('サーバーの応答が読めませんでした（GASのURL・公開設定を確認）'); e.code = 'server'; throw e; }
    if (!j.ok) { const e = new Error(j.error || 'エラーが発生しました'); e.code = j.code || 'server'; e.data = j; throw e; }
    return j;
  }

  let running = null;
  /**
   * 送信待ちを処理する
   *  - ready（確認済み）→ 保存（重複なら duplicate にして止める）
   *  - needs_analysis（あとで読み取り）→ AI読み取り → needs_review（確認待ち）
   */
  function processQueue() {
    if (running) return running;
    running = (async () => {
      const summary = { saved: [], duplicates: 0, reviewed: 0, errors: 0, offline: false };
      const items = await DB.all();
      for (const item of items) {
        try {
          if (item.status === 'ready') {
            const r = await api('save', { record: item.record, image: item.image, clientId: item.id, force: !!item.force });
            if (r.duplicate) {
              item.status = 'duplicate'; item.duplicates = r.duplicates; item.error = '';
              await DB.put(item); summary.duplicates++;
            } else {
              await DB.del(item.id); summary.saved.push(r.fileName || '');
            }
          } else if (item.status === 'needs_analysis') {
            const r = await api('analyze', { image: item.image });
            item.ai = r.result; item.record = aiToRecord(r.result, item.record); item.status = 'needs_review'; item.error = '';
            await DB.put(item); summary.reviewed++;
          }
        } catch (err) {
          if (err.code === 'network') { summary.offline = true; break; }
          if (err.code === 'nosettings') break;
          item.lastError = err.message; item.tries = (item.tries || 0) + 1;
          if (item.tries >= 3 && item.status === 'ready') item.status = 'error';
          await DB.put(item); summary.errors++;
        }
      }
      return summary;
    })().finally(() => { running = null; });
    return running;
  }

  function aiToRecord(ai, base) {
    const r = Object.assign({ date: '', category: 'レッスン室', payee: '', detail: '', amount: '', tax: '', addressee: '', number: '', note: '' }, base || {});
    if (!ai) return r;
    if (ai.payment_date) r.date = ai.payment_date;
    if (ai.category) r.category = ai.category;
    if (ai.payee) r.payee = ai.payee;
    if (ai.detail) r.detail = ai.detail;
    if (ai.amount) r.amount = ai.amount;
    if (ai.tax) r.tax = ai.tax;
    if (ai.addressee) r.addressee = ai.addressee;
    if (ai.number) r.number = ai.number;
    return r;
  }

  g.KF = { DB, api, processQueue, aiToRecord };
})(typeof self !== 'undefined' ? self : window);
