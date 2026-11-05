/* きっずふぁむ 領収書アプリ（画面側） */
(function () {
  'use strict';
  const APP_VERSION = '1.1.0';
  const { DB, api, processQueue, aiToRecord } = window.KF;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let stream = null;
  let srcCanvas = null;   // 撮影した元画像（縮小済み）
  let quad = null;        // 切り抜く四隅
  let current = null;     // 確認中のデータ { id?, image, ai, record }
  let spec = null;        // 先読み（切り抜き画面を見ている間に、自動検出の範囲で切り抜き＋AI読み取りを始めておく）

  /* ---------------- 共通 UI ---------------- */
  function showScreen(name) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    const tab = ['camera', 'crop', 'review'].includes(name) ? 'camera' : name;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (name === 'camera') startCamera(); else stopCamera();
    if (name === 'list') renderList();
    if (name === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  function busy(on, text) {
    $('#busy').classList.toggle('hidden', !on);
    if (text) $('#busyText').textContent = text;
  }

  let toastTimer = null;
  function toast(msg, ms, ic) {
    const t = $('#toast');
    t.innerHTML = (ic ? Icon(ic) : '') + esc(msg); t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 3500);
  }

  /** ボタン付きダイアログ。buttons: [{label, value, cls}] → 押したボタンの value を返す */
  function ask(html, buttons) {
    return new Promise((resolve) => {
      const d = $('#dialog');
      $('#dialogBody').innerHTML = html;
      const box = $('#dialogButtons');
      box.innerHTML = '';
      buttons.forEach((b) => {
        const el = document.createElement('button');
        el.className = 'btn ' + (b.cls || '');
        el.textContent = b.label;
        el.onclick = () => { d.close(); resolve(b.value); };
        box.appendChild(el);
      });
      d.oncancel = (e) => { e.preventDefault(); };
      d.showModal();
    });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => (Number(n) || 0).toLocaleString('ja-JP') + '円';
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function updateNet() {
    const on = navigator.onLine;
    const n = $('#netState');
    n.textContent = on ? 'オンライン' : 'オフライン';
    n.classList.toggle('off', !on);
  }

  async function updateBadge() {
    const items = await DB.all();
    const b = $('#badge');
    b.textContent = items.length;
    b.classList.toggle('hidden', !items.length);
  }

  /* ---------------- カメラ ---------------- */
  async function startCamera() {
    if (stream) return;
    const msg = $('#cameraMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.innerHTML = 'このブラウザではカメラを直接使えません。<br>右下のカメラボタンで撮影してください。';
      msg.classList.remove('hidden');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      const v = $('#video');
      v.srcObject = stream;
      await v.play().catch(() => {});
      msg.classList.add('hidden');
    } catch (err) {
      stream = null;
      msg.innerHTML = 'カメラを起動できませんでした。<br>カメラの使用を「許可」してください。<br>または右下のカメラボタンで撮影できます。';
      msg.classList.remove('hidden');
    }
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  async function capture() {
    if (!stream) { $('#fileCapture').click(); return; }
    // 映像のコマをそのまま使う（高画質撮影 takePhoto は数秒かかるため使わない）
    const v = $('#video');
    if (!v.videoWidth) return;
    openCrop(v);
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    busy(true, '読み込み中…');
    try { openCrop(await loadImage(f)); } catch (err) { toast(err.message); } finally { busy(false); }
  }

  /* ---------------- トリミング ---------------- */
  function openCrop(img) {
    srcCanvas = Crop.toCanvas(img, 2000, 0);
    quad = Crop.detectCorners(srcCanvas);
    spec = null;
    showScreen('crop');
    drawCrop();
    // 画面を表示してから裏で先読みを開始
    setTimeout(() => { if (srcCanvas) spec = prepare(quad); }, 60);
  }

  const quadKey = (q) => q.map((p) => p.map(Math.round).join(',')).join(';');

  /** 切り抜き（保存用 1500px / AI用 1100px）を作り、オンラインならAI読み取りを開始する */
  function prepare(q) {
    const out = Crop.warp(srcCanvas, q, 1500);
    const image = out.toDataURL('image/jpeg', 0.85);
    const s = Math.min(1, 1100 / Math.max(out.width, out.height));
    const small = document.createElement('canvas');
    small.width = Math.round(out.width * s); small.height = Math.round(out.height * s);
    small.getContext('2d').drawImage(out, 0, 0, small.width, small.height);
    const aiImage = small.toDataURL('image/jpeg', 0.8);
    const p = { key: quadKey(q), image, aiImage, promise: null };
    if (navigator.onLine) {
      p.promise = api('analyze', { image: aiImage });
      p.promise.catch(() => {}); // 未処理エラーの警告を防ぐ
    }
    return p;
  }

  function drawCrop() {
    const c = $('#cropCanvas');
    c.width = srcCanvas.width; c.height = srcCanvas.height;
    c.getContext('2d').drawImage(srcCanvas, 0, 0);
    // 画面に収まるよう高さを制限
    const maxH = window.innerHeight * 0.58;
    const ratio = srcCanvas.height / srcCanvas.width;
    const stage = $('#cropStage');
    const w = Math.min(stage.parentElement.clientWidth, maxH / ratio);
    stage.style.width = w + 'px';
    stage.style.margin = '0 auto';
    const svg = $('#cropSvg');
    svg.setAttribute('viewBox', '0 0 ' + srcCanvas.width + ' ' + srcCanvas.height);
    renderQuad();
  }

  function renderQuad() {
    const svg = $('#cropSvg');
    const r = Math.max(srcCanvas.width, srcCanvas.height) * 0.028;
    const sw = Math.max(srcCanvas.width, srcCanvas.height) * 0.004;
    svg.innerHTML = '<polygon points="' + quad.map((p) => p.join(',')).join(' ') + '" style="stroke-width:' + sw + '"></polygon>' +
      quad.map((p, i) => '<circle data-i="' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '" style="stroke-width:' + sw * 1.5 + '"></circle>').join('');
  }

  function setupCropDrag() {
    const svg = $('#cropSvg');
    let dragging = -1;
    const toSrc = (e) => {
      const rect = svg.getBoundingClientRect();
      return [
        Math.max(0, Math.min(srcCanvas.width, (e.clientX - rect.left) / rect.width * srcCanvas.width)),
        Math.max(0, Math.min(srcCanvas.height, (e.clientY - rect.top) / rect.height * srcCanvas.height)),
      ];
    };
    svg.addEventListener('pointerdown', (e) => {
      const p = toSrc(e);
      let best = -1, bd = Infinity;
      quad.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = i; } });
      if (bd < Math.max(srcCanvas.width, srcCanvas.height) * 0.15) {
        dragging = best; svg.setPointerCapture(e.pointerId); e.preventDefault();
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (dragging < 0) return;
      quad[dragging] = toSrc(e); renderQuad(); e.preventDefault();
    });
    const end = () => { dragging = -1; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  async function cropOk() {
    let p = spec && spec.key === quadKey(quad) ? spec : null;
    if (!p) {
      busy(true, '切り抜き中…');
      await new Promise((r) => setTimeout(r, 30));
      try { p = prepare(quad); } finally { busy(false); }
    }
    spec = null;
    current = { image: p.image, aiImage: p.aiImage, ai: null, record: null };
    await analyzeCurrent(p.promise);
  }

  /* ---------------- AI 読み取り ---------------- */
  async function analyzeCurrent(pending) {
    if (navigator.onLine) {
      busy(true, 'AIが領収書を読み取っています…');
      try {
        const r = await (pending || api('analyze', { image: current.aiImage || current.image }));
        current.ai = r.result;
        current.record = aiToRecord(r.result);
        busy(false);
        if (r.result && r.result.is_receipt === false) {
          const v = await ask('<h3>' + Icon('alert') + '領収書ではないかもしれません</h3>このまま入力を続けますか？', [
            { label: '撮り直す', value: 'retake', cls: 'ghost' }, { label: '続ける', value: 'go', cls: 'primary' }]);
          if (v === 'retake') { showScreen('camera'); return; }
        }
        openReview();
        return;
      } catch (err) {
        busy(false);
        if (err.code !== 'network') {
          const v = await ask('<h3>' + Icon('alert') + '読み取りできませんでした</h3>' + esc(err.message), [
            { label: '手入力する', value: 'manual', cls: 'primary' }, { label: 'あとで読み取る', value: 'later' }]);
          if (v === 'later') return saveForLater();
          current.record = aiToRecord(null); openReview(); return;
        }
      }
    }
    const v = await ask('<h3>' + Icon('wifiOff') + '電波がありません</h3>AIでの読み取りは電波がつながってから行えます。<br>どうしますか？', [
      { label: 'あとで読み取る', value: 'later', cls: 'primary' }, { label: '今すぐ手入力', value: 'manual' }]);
    if (v === 'later') return saveForLater();
    current.record = aiToRecord(null);
    openReview();
  }

  async function saveForLater() {
    await DB.put({ id: uuid(), createdAt: Date.now(), status: 'needs_analysis', image: current.image, record: null });
    current = null;
    await updateBadge();
    requestSync();
    toast('端末に保存しました。電波が戻ったらAIが読み取り、「送信待ち」に確認依頼が出ます。', 5000, 'cloud');
    showScreen('camera');
  }

  /* ---------------- 確認画面 ---------------- */
  function openReview() {
    const f = $('#reviewForm');
    const r = current.record || aiToRecord(null);
    f.date.value = r.date || todayStr();
    f.category.value = r.category || 'レッスン室';
    f.payee.value = r.payee || '';
    f.detail.value = r.detail || '';
    f.amount.value = r.amount || '';
    f.tax.value = r.tax || '';
    f.addressee.value = r.addressee || '';
    f.number.value = r.number || '';
    f.note.value = r.note || '';
    $('#reviewImg').src = current.image;
    const notes = [];
    if (current.ai && current.ai.notes) notes.push('AIからのメモ：' + current.ai.notes);
    if (!r.date) notes.push('支払日が読み取れなかったため、今日の日付を入れています。');
    if (!current.ai) notes.push('手入力モードです。');
    $('#aiNotes').textContent = notes.join('\n');
    $('#aiNotes').classList.toggle('hidden', !notes.length);
    updateFileName();
    showScreen('review');
  }

  function formRecord() {
    const f = $('#reviewForm');
    return {
      date: f.date.value, category: f.category.value, payee: f.payee.value.trim(), detail: f.detail.value.trim(),
      amount: Number(f.amount.value) || 0, tax: Number(f.tax.value) || 0, addressee: f.addressee.value.trim(),
      number: f.number.value.trim(), note: f.note.value.trim(),
    };
  }

  function updateFileName() {
    const r = formRecord();
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s　]/g, '') || '不明';
    $('#fileNamePreview').textContent = '保存名：' + [r.date, r.category, safe(r.payee), (r.amount || 0) + '円'].join('_') + '.jpg';
  }

  async function submitReview(e) {
    e.preventDefault();
    const record = formRecord();
    if (!record.date || !record.payee || !record.amount) { toast('支払日・支払先・金額を入力してください'); return; }
    const item = {
      id: current.id || uuid(), createdAt: current.createdAt || Date.now(), status: 'ready',
      image: current.image, record, ai: current.ai, force: false,
    };
    await DB.put(item);
    current = null;
    await updateBadge();
    // すぐに撮影画面へ戻り、保存は裏で行う（続けて次の領収書を撮れる）
    showScreen('camera');
    if (!navigator.onLine) {
      requestSync();
      toast('電波がないため端末に保存しました。つながったら自動で送信します。', 5000, 'cloud');
      return;
    }
    toast('保存しています…', 20000, 'upload');
    const s = await processQueue();
    await updateBadge();
    const after = await DB.get(item.id);
    if (!after) { toast('保存しました\n' + (s.saved[0] || ''), 3500, 'check'); return; }
    if (after.status === 'duplicate') { $('#toast').classList.add('hidden'); await resolveDuplicate(after); return; }
    if (s.offline) { requestSync(); toast('通信できなかったため端末に保存しました。あとで自動で送信します。', 5000, 'cloud'); }
    else toast('保存に失敗しました：' + (after.lastError || '') + '（送信待ちに残しています）', 6000, 'alert');
  }

  async function resolveDuplicate(item) {
    const list = (item.duplicates || []).map((d) =>
      '<div class="card"><div class="body"><div class="main">' + esc(d.date) + '　' + yen(d.amount) + '</div><div class="sub">' +
      esc(d.payee) + ' ' + esc(d.detail) + (d.number ? '<br>番号：' + esc(d.number) : '') + '<br>理由：' + esc(d.reason) +
      (d.fileUrl ? '<br><a href="' + esc(d.fileUrl) + '" target="_blank" rel="noopener">' + Icon('link') + '登録済みの写真を見る</a>' : '') + '</div></div></div>').join('');
    const v = await ask('<h3>' + Icon('alert') + '同じ領収書が登録済みかもしれません</h3>今回：' + esc(item.record.date) + '　' + esc(item.record.payee) + '　' + yen(item.record.amount) + list, [
      { label: '保存しない', value: 'drop', cls: 'danger' }, { label: 'それでも保存', value: 'force', cls: 'primary' }]);
    if (v === 'drop') { await DB.del(item.id); toast('保存を取りやめました', 3000, 'trash'); }
    else {
      item.force = true; item.status = 'ready'; await DB.put(item);
      busy(true, '保存しています…');
      await processQueue().finally(() => busy(false));
      const after = await DB.get(item.id);
      toast(after ? '送信待ちに残っています（あとで自動送信）' : '保存しました', 3500, after ? 'cloud' : 'check');
    }
    await updateBadge();
  }

  /* ---------------- 送信待ち・履歴 ---------------- */
  async function renderList() {
    const items = await DB.all();
    const box = $('#queueList');
    if (!items.length) box.innerHTML = '<p class="muted">送信待ちはありません</p>';
    else {
      box.innerHTML = '';
      items.forEach((it) => {
        const r = it.record || {};
        const label = {
          ready: '<span class="pill ready">送信待ち</span>',
          needs_analysis: '<span class="pill wait">読み取り待ち</span>',
          needs_review: '<span class="pill review">確認してください</span>',
          duplicate: '<span class="pill dup">重複の可能性</span>',
          error: '<span class="pill err">エラー</span>',
        }[it.status] || '';
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = '<img src="' + it.image + '" alt=""><div class="body"><div>' + label + '</div><div class="main">' +
          (r.date ? esc(r.date) + '　' + yen(r.amount) : '（未入力）') + '</div><div class="sub">' + esc(r.payee || '') + ' ' + esc(r.detail || '') +
          (it.lastError ? '<br>' + Icon('alert') + ' ' + esc(it.lastError) : '') + '</div></div><div class="actions"></div>';
        const act = el.querySelector('.actions');
        const add = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = text; b.onclick = fn; act.appendChild(b); };
        if (it.status === 'needs_review' || it.status === 'error' || it.status === 'needs_analysis' || it.status === 'ready') {
          add(it.status === 'needs_review' ? '確認する' : '修正', it.status === 'needs_review' ? 'primary' : '', () => {
            current = { id: it.id, createdAt: it.createdAt, image: it.image, ai: it.ai || null, record: it.record || aiToRecord(it.ai) };
            openReview();
          });
        }
        if (it.status === 'duplicate') add('確認する', 'primary', async () => { await resolveDuplicate(it); renderList(); });
        if (it.status === 'error') add('再送', '', async () => { it.status = 'ready'; it.tries = 0; await DB.put(it); syncNow(); });
        add('削除', 'danger', async () => {
          const v = await ask('この領収書の写真を端末から削除しますか？（まだ保存されていません）', [{ label: 'やめる', value: 0, cls: 'ghost' }, { label: '削除', value: 1, cls: 'danger' }]);
          if (v) { await DB.del(it.id); await updateBadge(); renderList(); }
        });
        box.appendChild(el);
      });
    }
    renderRecent();
  }

  async function renderRecent() {
    const box = $('#recentList');
    if (!navigator.onLine) { box.innerHTML = '<p class="muted">オフラインのため表示できません</p>'; return; }
    try {
      const r = await api('recent', { limit: 20 });
      box.innerHTML = r.items.length ? r.items.map((x) =>
        '<div class="card"><div class="body"><div class="main">' + esc(x.date) + '　' + yen(x.amount) + '</div><div class="sub">' +
        esc(x.category) + '｜' + esc(x.payee) + ' ' + esc(x.detail) + '</div></div>' +
        (x.fileUrl ? '<a class="btn" style="width:auto" href="' + esc(x.fileUrl) + '" target="_blank" rel="noopener">' + Icon('image') + '写真</a>' : '') + '</div>').join('')
        : '<p class="muted">まだ登録がありません</p>';
    } catch (err) { box.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; }
  }

  async function syncNow(silent) {
    if (!navigator.onLine) { if (!silent) toast('オフラインです'); return; }
    const items = await DB.all();
    if (!items.length) { if (!silent) toast('送信待ちはありません'); return; }
    if (!silent) busy(true, '送信しています…');
    const s = await processQueue().finally(() => busy(false));
    await updateBadge();
    const msgs = [];
    if (s.saved.length) msgs.push(s.saved.length + '件 保存しました');
    if (s.reviewed) msgs.push(s.reviewed + '件 AIが読み取りました。「送信待ち」で確認してください');
    if (s.duplicates) msgs.push(s.duplicates + '件 重複の可能性があります。「送信待ち」で確認してください');
    if (s.errors) msgs.push(s.errors + '件 エラーがありました');
    if (msgs.length) toast(msgs.join('\n'), 5000, s.duplicates || s.errors ? 'alert' : 'check');
    if ($('#screen-list').classList.contains('active')) renderList();
  }

  function requestSync() {
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.sync && reg.sync.register('kf-upload')).catch(() => {});
    }
  }

  /* ---------------- カレンダー照合 ---------------- */
  function initCalendarDates() {
    const t = todayStr();
    const [y, m] = t.split('-').map(Number);
    const fy = m >= 4 ? y : y - 1;
    $('#calFrom').value = fy + '-04-01';
    $('#calTo').value = t;
  }

  async function runCalendar() {
    busy(true, 'カレンダーを確認しています…');
    try {
      const r = await api('calendar', { from: $('#calFrom').value, to: $('#calTo').value });
      const items = r.items;
      const cnt = { ok: 0, near: 0, missing: 0 };
      items.forEach((x) => cnt[x.status]++);
      $('#calSummary').innerHTML = 'レッスン ' + items.length + '日：<span class="st-ok">' + Icon('check') + cnt.ok + '</span><span class="st-near">' + Icon('alert') + cnt.near +
        '</span><span class="st-missing">' + Icon('x') + cnt.missing + '</span>';
      const order = { missing: 0, near: 1, ok: 2 };
      items.sort((a, b) => order[a.status] - order[b.status] || (a.date < b.date ? -1 : 1));
      $('#calList').innerHTML = items.length ? items.map((x) => {
        const st = x.status === 'ok' ? '<span class="st-ok">' + Icon('check') + '領収書あり</span>'
          : x.status === 'near' ? '<span class="st-near">' + Icon('alert') + '近い日に領収書あり（' + esc(x.receipt.date) + '）</span>'
            : '<span class="st-missing">' + Icon('x') + '領収書なし</span>';
        return '<div class="card"><div class="body"><div class="main">' + esc(x.date) + ' ' + esc(x.time) + '　' + esc(x.facility) + '</div><div class="sub">' +
          esc(x.titles.join(' / ')) + '</div><div>' + st + '</div></div></div>';
      }).join('') : '<p class="muted">この期間にSARAのレッスン予定は見つかりませんでした</p>';
    } catch (err) { toast(err.message, 5000, 'alert'); } finally { busy(false); }
  }

  /* ---------------- 設定 ---------------- */
  async function renderSettings() {
    const s = await DB.settings();
    const f = $('#settingsForm');
    f.gasUrl.value = s.gasUrl || '';
    f.token.value = s.token || '';
    $('#appVersion').textContent = APP_VERSION;
  }

  async function saveSettings(e) {
    e.preventDefault();
    const f = $('#settingsForm');
    await DB.setKV('settings', { gasUrl: f.gasUrl.value.trim(), token: f.token.value.trim() });
    await testConnection();
  }

  async function testConnection() {
    busy(true, '接続テスト中…');
    try {
      const r = await api('ping');
      $('#settingsInfo').innerHTML = '<span class="ok">' + Icon('check') + '接続できました</span><br>今年度：' + r.fiscalYear + '年度<br>' +
        '<a href="' + esc(r.spreadsheetUrl) + '" target="_blank" rel="noopener">' + Icon('sheet') + '経費一覧スプレッドシートを開く</a><br>' +
        '<a href="' + esc(r.folderUrl) + '" target="_blank" rel="noopener">' + Icon('folder') + '領収書フォルダを開く</a><br>' +
        (r.hasApiKey ? Icon('sparkle') + 'AI読み取り：設定済み' : '<span class="ng">' + Icon('alert') + 'Claude APIキーが未設定です（GASのスクリプトプロパティ）</span>');
    } catch (err) {
      $('#settingsInfo').innerHTML = '<span class="ng">' + Icon('x') + esc(err.message) + '</span>';
    } finally { busy(false); }
  }

  /** URL の # に設定を入れて開くと自動で設定（例: index.html#gas=URL&token=XXXX） */
  async function settingsFromHash() {
    if (!location.hash) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.get('gas') || !p.get('token')) return false;
    await DB.setKV('settings', { gasUrl: p.get('gas'), token: p.get('token') });
    history.replaceState(null, '', location.pathname);
    toast('設定を読み込みました');
    return true;
  }

  /* ---------------- 起動 ---------------- */
  let installEvt = null;
  async function init() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.tab)));
    $('#shutter').addEventListener('click', capture);
    $('#fileInput').addEventListener('change', onFile);
    $('#fileCapture').addEventListener('change', onFile);
    $('#cropRotate').addEventListener('click', () => { srcCanvas = Crop.rotateCanvas(srcCanvas, 90); quad = Crop.detectCorners(srcCanvas); drawCrop(); });
    $('#cropAuto').addEventListener('click', () => { quad = Crop.detectCorners(srcCanvas); renderQuad(); });
    $('#cropFull').addEventListener('click', () => { const W = srcCanvas.width, H = srcCanvas.height; quad = [[0, 0], [W, 0], [W, H], [0, H]]; renderQuad(); });
    $('#cropRetake').addEventListener('click', () => { spec = null; showScreen('camera'); });
    $('#cropOk').addEventListener('click', cropOk);
    setupCropDrag();
    $('#reviewForm').addEventListener('submit', submitReview);
    $('#reviewForm').addEventListener('input', updateFileName);
    $('#reviewCancel').addEventListener('click', async () => {
      const inQueue = current && current.id;
      const v = await ask(inQueue ? '確認をやめますか？（送信待ちに残ります）' : 'この領収書を保存せずに戻りますか？', [
        { label: '入力に戻る', value: 0, cls: 'ghost' }, { label: inQueue ? 'やめる' : '保存せず戻る', value: 1, cls: 'danger' }]);
      if (v) { current = null; showScreen(inQueue ? 'list' : 'camera'); }
    });
    $('#syncNow').addEventListener('click', () => syncNow(false));
    $('#calRun').addEventListener('click', runCalendar);
    $('#settingsForm').addEventListener('submit', saveSettings);
    window.addEventListener('online', () => { updateNet(); syncNow(true); });
    window.addEventListener('offline', updateNet);
    window.addEventListener('resize', () => { if ($('#screen-crop').classList.contains('active')) drawCrop(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopCamera();
      else { if ($('#screen-camera').classList.contains('active')) startCamera(); syncNow(true); }
    });
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
    $('#installBtn').addEventListener('click', async () => { if (installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').classList.add('hidden'); } });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'queue-updated') { updateBadge(); if ($('#screen-list').classList.contains('active')) renderList(); }
      });
    }

    updateNet();
    initCalendarDates();
    const fromHash = await settingsFromHash();
    const s = await DB.settings();
    await updateBadge();
    if (!s.gasUrl || !s.token) { showScreen('settings'); toast('最初に設定を入力してください', 4000); return; }
    if (fromHash) { showScreen('settings'); testConnection(); return; }
    showScreen('camera');
    // Google側を先に起こしておく（最初の読み取り・保存が速くなる）
    if (navigator.onLine) api('ping').catch(() => {});
    syncNow(true);
  }

  init();
})();
