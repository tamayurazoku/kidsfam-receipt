/**
 * きっずふぁむ 領収書アプリ — Google Apps Script 側（保存・集計・AI読み取り・カレンダー照合）
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）:
 *   CLAUDE_API_KEY  : Claude API キー（必須）
 *   APP_TOKEN       : アプリとの合言葉（setup() を実行すると自動で作成されます）
 *   ROOT_FOLDER_ID  : 保存先フォルダID（未設定なら DEFAULT_ROOT_FOLDER_ID）
 *   CALENDAR_ID     : 照合に使うカレンダーID（未設定ならメインのカレンダー）
 *   CLAUDE_MODEL    : AIのモデル（未設定なら DEFAULT_CLAUDE_MODEL）
 */

const DEFAULT_ROOT_FOLDER_ID = '1Xn5dU9KPJWiRGyxQIpYZ31782x6Rd0vw'; // 「きっずふぁむ　領収書」
// AIのモデル（スクリプトプロパティ CLAUDE_MODEL で変更可。読み取り精度を最優先したい場合は claude-opus-5-5）
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
const CATEGORIES = ['レッスン室', '交通費', '駐車場代', '備品代', 'その他'];
// よく使う施設（名前の統一とカレンダー照合に使用）。ここにない施設も自動で集計表に追加されます
const FACILITIES = [
  { name: '釜石市民ホール', room: 'スタジオA', keywords: ['釜石', 'TETTO', 'テット'] },
  { name: '大槌町文化交流センター', room: 'レッスン室', keywords: ['大槌', 'おしゃっち', 'オシャッチ'] },
];
const MONTH_ORDER = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const HEADER = ['No', '支払日', '種類', '支払先', '内容', '金額(税込)', 'うち消費税', '宛名', '番号', '写真', '備考', '登録日時', 'ファイルID', '登録ID'];
const COL = { no: 1, date: 2, category: 3, payee: 4, detail: 5, amount: 6, tax: 7, addressee: 8, number: 9, photo: 10, note: 11, created: 12, fileId: 13, clientId: 14 };
const DATA_START = 5;
const SUMMARY_SHEET = '年間集計';

/* ============================== Web API ============================== */

function doGet() {
  return json_({ ok: true, app: 'kidsfam-receipt', message: 'POSTで呼び出してください' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = prop_('APP_TOKEN');
    if (!token || req.token !== token) return json_({ ok: false, error: '合言葉（トークン）が違います。アプリの設定を確認してください。', code: 'auth' });

    switch (req.action) {
      case 'ping': return json_(Object.assign({ ok: true }, info_()));
      case 'analyze': return json_({ ok: true, result: analyzeReceipt_(req.image) });
      case 'save': return json_(save_(req));
      case 'checkDuplicate': return json_({ ok: true, duplicates: findDuplicates_(normalizeRecord_(req.record)) });
      case 'recent': return json_({ ok: true, items: recent_(req.limit || 30) });
      case 'calendar': return json_({ ok: true, items: calendarCheck_(req.from, req.to) });
      default: return json_({ ok: false, error: '不明な操作: ' + req.action });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/* ============================== 初期設定 ============================== */

/** 最初に一度だけエディタから実行してください（権限の承認＋今年度のフォルダ・シート作成） */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('APP_TOKEN')) {
    props.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  }
  const fy = fiscalYearOf_(today_());
  const ctx = yearContext_(fy);
  CalendarApp.getDefaultCalendar(); // カレンダー権限の承認用
  installYearTrigger_();
  if (!props.getProperty('CLAUDE_API_KEY')) console.warn('CLAUDE_API_KEY が未設定です。スクリプトプロパティに追加してください。');
  console.log('合言葉（APP_TOKEN）: ' + props.getProperty('APP_TOKEN'));
  console.log(fy + '年度スプレッドシート: ' + ctx.ss.getUrl());
  console.log(fy + '年度フォルダ: ' + ctx.folder.getUrl());
}

/** 毎月1日の朝に autoCreateYear を自動実行する設定（setup で登録） */
function installYearTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoCreateYear'; });
  if (!exists) ScriptApp.newTrigger('autoCreateYear').timeBased().onMonthDay(1).atHour(5).create();
}

/** 自動実行：今年度のフォルダ・スプレッドシートがなければ作る（4月1日に新年度分ができます）。3月には来年度分も先に作ります */
function autoCreateYear() {
  const t = today_();
  const fy = fiscalYearOf_(t);
  yearContext_(fy);
  if (parseDate_(t).m === 3) yearContext_(fy + 1);
}

/** 来年度分を前もって作りたいときに実行（通常は保存時・毎月1日に自動作成されます） */
function setupNextYear() {
  const fy = fiscalYearOf_(today_()) + 1;
  console.log(yearContext_(fy).ss.getUrl());
}

function info_() {
  const fy = fiscalYearOf_(today_());
  const ctx = yearContext_(fy);
  return {
    fiscalYear: fy,
    spreadsheetUrl: ctx.ss.getUrl(),
    folderUrl: ctx.folder.getUrl(),
    hasApiKey: !!prop_('CLAUDE_API_KEY'),
  };
}

/* ============================== 日付・年度 ============================== */

function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function parseDate_(s) {
  const m = String(s || '').match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (!m) throw new Error('支払日の形式が正しくありません: ' + s);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function fiscalYearOf_(dateStr) {
  const p = parseDate_(dateStr);
  return p.m >= 4 ? p.y : p.y - 1;
}

function pad2_(n) { return ('0' + n).slice(-2); }
function monthFolderName_(m) { return m + '月'; }
function monthSheetName_(m) { return pad2_(m) + '月'; }
function slashDate_(dateStr) { const p = parseDate_(dateStr); return p.y + '/' + pad2_(p.m) + '/' + pad2_(p.d); }

/* ============================== フォルダ・スプレッドシート ============================== */

function rootFolder_() {
  return DriveApp.getFolderById(prop_('ROOT_FOLDER_ID') || DEFAULT_ROOT_FOLDER_ID);
}

function findOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

const yearCache_ = {};
function yearContext_(fy) {
  if (yearCache_[fy]) return yearCache_[fy];
  const props = PropertiesService.getScriptProperties();
  const key = 'YEAR_' + fy;
  let folder, ss;
  const cached = props.getProperty(key);
  if (cached) {
    try {
      const c = JSON.parse(cached);
      folder = DriveApp.getFolderById(c.folderId);
      ss = SpreadsheetApp.openById(c.ssId);
    } catch (e) { folder = null; ss = null; }
  }
  if (!folder || !ss) {
    folder = findOrCreateFolder_(rootFolder_(), fy + '年度');
    MONTH_ORDER.forEach(function (m) { findOrCreateFolder_(folder, monthFolderName_(m)); });
    const name = fy + '年度_経費一覧';
    const files = folder.getFilesByName(name);
    let file = null;
    while (files.hasNext()) { const f = files.next(); if (f.getMimeType() === MimeType.GOOGLE_SHEETS) { file = f; break; } }
    if (file) {
      ss = SpreadsheetApp.openById(file.getId());
    } else {
      ss = SpreadsheetApp.create(name);
      DriveApp.getFileById(ss.getId()).moveTo(folder);
    }
    props.setProperty(key, JSON.stringify({ folderId: folder.getId(), ssId: ss.getId() }));
  }
  ensureStructure_(ss, fy);
  yearCache_[fy] = { fy: fy, folder: folder, ss: ss };
  return yearCache_[fy];
}

function ensureStructure_(ss, fy) {
  if (ss.getSheetByName(SUMMARY_SHEET)) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (ss.getSheetByName(SUMMARY_SHEET)) return;
    ss.setSpreadsheetTimeZone('Asia/Tokyo');
    const initial = ss.getSheets();

    MONTH_ORDER.forEach(function (m, i) {
      const sh = ss.insertSheet(monthSheetName_(m), i);
      const calYear = m >= 4 ? fy : fy + 1;
      sh.getRange('A1').setValue(fy + '年度　' + calYear + '年' + m + '月　経費一覧（きっずふぁむ）').setFontSize(14).setFontWeight('bold');
      sh.getRange('A2:B2').setValues([['月合計', '=SUM(F' + DATA_START + ':F)']]);
      sh.getRange('A2:B2').setFontWeight('bold');
      sh.getRange('B2').setNumberFormat('#,##0"円"');
      sh.getRange('D2:E2').setValues([['件数', '=COUNTA(B' + DATA_START + ':B)']]);
      sh.getRange(4, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold').setBackground('#fde7ef');
      sh.setFrozenRows(4);
      sh.getRange(DATA_START, COL.date, 1000, 1).setNumberFormat('yyyy/mm/dd');
      sh.getRange(DATA_START, COL.amount, 1000, 2).setNumberFormat('#,##0');
      sh.getRange(DATA_START, COL.number, 1000, 1).setNumberFormat('@');
      sh.getRange(DATA_START, COL.created, 1000, 1).setNumberFormat('yyyy/mm/dd hh:mm');
      [40, 95, 80, 190, 120, 90, 80, 150, 100, 60, 200, 120].forEach(function (w, c) { sh.setColumnWidth(c + 1, w); });
      sh.hideColumns(COL.fileId, 2);
    });

    const sum = ss.insertSheet(SUMMARY_SHEET, 0);
    sum.getRange('A1').setValue(fy + '年度（' + fy + '年4月〜' + (fy + 1) + '年3月）　経費 年間集計（きっずふぁむ）').setFontSize(14).setFontWeight('bold');
    const head = ['月'].concat(CATEGORIES, ['合計', '件数']);
    sum.getRange(3, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#fde7ef');
    const rows = MONTH_ORDER.map(function (m, i) {
      const sn = "'" + monthSheetName_(m) + "'!";
      const r = 4 + i;
      const cells = [m + '月'];
      CATEGORIES.forEach(function (_, ci) {
        const colL = String.fromCharCode(66 + ci); // B..F
        cells.push('=SUMIF(' + sn + '$C$' + DATA_START + ':$C,' + colL + '$3,' + sn + '$F$' + DATA_START + ':$F)');
      });
      cells.push('=SUM(B' + r + ':F' + r + ')');
      cells.push('=COUNTA(' + sn + '$B$' + DATA_START + ':$B)');
      return cells;
    });
    sum.getRange(4, 1, 12, head.length).setValues(rows);
    const totalRow = ['年度合計'];
    for (let c = 0; c < head.length - 1; c++) { const L = String.fromCharCode(66 + c); totalRow.push('=SUM(' + L + '4:' + L + '15)'); }
    sum.getRange(16, 1, 1, head.length).setValues([totalRow]).setFontWeight('bold').setBackground('#fff4c2');
    sum.getRange(4, 2, 13, head.length - 2).setNumberFormat('#,##0"円"');

    // 施設別（レッスン室）
    const fHead = ['レッスン室 施設別'].concat(MONTH_ORDER.map(function (m) { return m + '月'; }), ['合計']);
    sum.getRange(19, 1, 1, fHead.length).setValues([fHead]).setFontWeight('bold').setBackground('#e3f2fd');
    const fRows = FACILITIES.map(function (f, fi) {
      const r = 20 + fi;
      const cells = [f.name];
      MONTH_ORDER.forEach(function (m) {
        const sn = "'" + monthSheetName_(m) + "'!";
        cells.push('=SUMIFS(' + sn + '$F$' + DATA_START + ':$F,' + sn + '$C$' + DATA_START + ':$C,"レッスン室",' + sn + '$D$' + DATA_START + ':$D,$A' + r + ')');
      });
      cells.push('=SUM(B' + r + ':M' + r + ')');
      return cells;
    });
    sum.getRange(20, 1, fRows.length, fHead.length).setValues(fRows);
    sum.getRange(20, 2, fRows.length, fHead.length - 1).setNumberFormat('#,##0"円"');
    sum.setColumnWidth(1, 190);
    sum.setFrozenRows(3);

    initial.forEach(function (s) { if (!s.getName().match(/^\d\d月$/) && s.getName() !== SUMMARY_SHEET) ss.deleteSheet(s); });
  } finally {
    lock.releaseLock();
  }
}

/* ============================== 保存 ============================== */

function normalizeRecord_(r) {
  r = r || {};
  const amount = Math.round(Number(String(r.amount == null ? '' : r.amount).replace(/[^\d.-]/g, '')));
  if (!amount || amount <= 0) throw new Error('金額が入力されていません');
  const tax = Math.round(Number(String(r.tax == null ? '' : r.tax).replace(/[^\d.-]/g, ''))) || 0;
  const date = String(r.date || '').replace(/\//g, '-');
  parseDate_(date);
  const category = CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'その他';
  const payee = String(r.payee || '').trim();
  if (!payee) throw new Error('支払先が入力されていません');
  return {
    date: date, category: category, payee: payee,
    detail: String(r.detail || '').trim(), amount: amount, tax: tax,
    addressee: String(r.addressee || '').trim(), number: String(r.number || '').trim(),
    note: String(r.note || '').trim(),
  };
}

function normNumber_(s) { return String(s || '').replace(/[\s　\-‐ー－No.№:：#]/gi, '').toUpperCase(); }
function normPayee_(s) { return String(s || '').replace(/[\s　（）()]/g, ''); }

function save_(req) {
  const rec = normalizeRecord_(req.record);
  if (!req.image) throw new Error('写真がありません');
  const clientId = String(req.clientId || '');
  const p = parseDate_(rec.date);
  const fy = fiscalYearOf_(rec.date);
  const ctx = yearContext_(fy); // ロックの前に年度フォルダ・シートを用意しておく

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = allRows_(fy); // 1回だけ読み込んで、送信済みチェックと重複チェックの両方に使う
    if (clientId) {
      const existing = rows.filter(function (r) { return r.clientId === clientId; })[0];
      if (existing) return { ok: true, alreadySaved: true, fileName: existing.date + ' ' + existing.payee, fileUrl: existing.fileUrl };
    }
    if (!req.force) {
      const dups = findDuplicates_(rec, rows);
      if (dups.length) return { ok: true, duplicate: true, duplicates: dups };
    }

    const monthFolder = findOrCreateFolder_(ctx.folder, monthFolderName_(p.m));
    const baseName = [rec.date, rec.category, safeName_(rec.payee), rec.amount + '円'].join('_');
    let fileName = baseName + '.jpg';
    for (let i = 2; monthFolder.getFilesByName(fileName).hasNext(); i++) fileName = baseName + '_' + i + '.jpg';
    const blob = Utilities.newBlob(Utilities.base64Decode(String(req.image).replace(/^data:image\/\w+;base64,/, '')), 'image/jpeg', fileName);
    const file = monthFolder.createFile(blob);
    file.setDescription([rec.date, rec.category, rec.payee, rec.detail, rec.amount + '円', rec.number].join(' / '));

    const sh = ctx.ss.getSheetByName(monthSheetName_(p.m));
    const row = Math.max(sh.getLastRow(), DATA_START - 1) + 1;
    const values = [[
      '', new Date(p.y, p.m - 1, p.d), rec.category, rec.payee, rec.detail, rec.amount, rec.tax || '',
      rec.addressee, rec.number, '=HYPERLINK("' + file.getUrl() + '","写真")', rec.note, new Date(), file.getId(), clientId,
    ]];
    sh.getRange(row, 1, 1, HEADER.length).setValues(values);
    sortAndNumber_(sh);
    if (rec.category === 'レッスン室') ensureFacilityRow_(ctx.ss, rec.payee);
    SpreadsheetApp.flush();
    return { ok: true, saved: true, fileName: fileName, fileUrl: file.getUrl(), spreadsheetUrl: ctx.ss.getUrl(), sheet: sh.getName() };
  } finally {
    lock.releaseLock();
  }
}

function safeName_(s) {
  return String(s).replace(/[\\\/:*?"<>|\s　]/g, '').slice(0, 40) || '不明';
}

function sortAndNumber_(sh) {
  const last = sh.getLastRow();
  if (last < DATA_START) return;
  const n = last - DATA_START + 1;
  sh.getRange(DATA_START, 1, n, HEADER.length).sort([{ column: COL.date, ascending: true }, { column: COL.created, ascending: true }]);
  const nums = [];
  for (let i = 1; i <= n; i++) nums.push([i]);
  sh.getRange(DATA_START, COL.no, n, 1).setValues(nums);
}

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < DATA_START) return [];
  const rng = sh.getRange(DATA_START, 1, last - DATA_START + 1, HEADER.length);
  const disp = rng.getDisplayValues();
  const formulas = rng.getFormulas();
  return disp.map(function (r, i) {
    const link = (formulas[i][COL.photo - 1].match(/HYPERLINK\("([^"]+)"/) || [])[1] || '';
    return {
      sheet: sh.getName(), row: DATA_START + i,
      date: r[COL.date - 1].replace(/\//g, '-'), category: r[COL.category - 1], payee: r[COL.payee - 1],
      detail: r[COL.detail - 1], amount: Number(String(r[COL.amount - 1]).replace(/[^\d]/g, '')) || 0,
      number: r[COL.number - 1], fileUrl: link, fileId: r[COL.fileId - 1], clientId: r[COL.clientId - 1], created: r[COL.created - 1],
    };
  }).filter(function (x) { return x.date; });
}

function allRows_(fy) {
  const ctx = yearContext_(fy);
  let rows = [];
  MONTH_ORDER.forEach(function (m) {
    const sh = ctx.ss.getSheetByName(monthSheetName_(m));
    if (sh) rows = rows.concat(readRows_(sh));
  });
  return rows;
}

/** 年間集計の「レッスン室 施設別」に、まだない施設の行を自動で追加する */
function ensureFacilityRow_(ss, payee) {
  const sum = ss.getSheetByName(SUMMARY_SHEET);
  if (!sum || !payee) return;
  const FIRST = 20;
  const last = Math.max(sum.getLastRow(), FIRST - 1);
  const names = last >= FIRST ? sum.getRange(FIRST, 1, last - FIRST + 1, 1).getValues().map(function (r) { return normPayee_(r[0]); }) : [];
  if (names.indexOf(normPayee_(payee)) >= 0) return;
  const r = last + 1;
  const cells = [payee];
  MONTH_ORDER.forEach(function (m) {
    const sn = "'" + monthSheetName_(m) + "'!";
    cells.push('=SUMIFS(' + sn + '$F$' + DATA_START + ':$F,' + sn + '$C$' + DATA_START + ':$C,"レッスン室",' + sn + '$D$' + DATA_START + ':$D,$A' + r + ')');
  });
  cells.push('=SUM(B' + r + ':M' + r + ')');
  sum.getRange(r, 1, 1, cells.length).setValues([cells]);
  sum.getRange(r, 2, 1, cells.length - 1).setNumberFormat('#,##0"円"');
}

/** 二重登録チェック：①番号＋支払先が同じ ②支払日＋支払先＋金額が同じ */
function findDuplicates_(rec, rows) {
  const fy = fiscalYearOf_(rec.date);
  const num = normNumber_(rec.number);
  const payee = normPayee_(rec.payee);
  const out = [];
  (rows || allRows_(fy)).forEach(function (r) {
    const samePayee = normPayee_(r.payee) === payee;
    let reason = '';
    if (num && num.length >= 3 && normNumber_(r.number) === num && samePayee) reason = '番号が同じ（' + r.number + '）';
    else if (r.date === rec.date && r.amount === rec.amount && samePayee) reason = '支払日・支払先・金額が同じ';
    if (reason) out.push({ reason: reason, date: r.date, payee: r.payee, detail: r.detail, amount: r.amount, number: r.number, fileUrl: r.fileUrl, sheet: r.sheet });
  });
  return out;
}

function recent_(limit) {
  const fy = fiscalYearOf_(today_());
  let rows = allRows_(fy);
  const p = parseDate_(today_());
  if (p.m === 4 || p.m === 5) rows = rows.concat(allRows_(fy - 1)); // 年度の変わり目は前年度分も表示
  rows.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
  return rows.slice(0, limit);
}

/* ============================== カレンダー照合 ============================== */

function facilityFromTitle_(title) {
  const t = String(title || '');
  if (!/sara/i.test(t)) return null;
  for (let i = 0; i < FACILITIES.length; i++) {
    const f = FACILITIES[i];
    if (f.keywords.some(function (k) { return t.toUpperCase().indexOf(k.toUpperCase()) >= 0; })) return f.name;
  }
  return null;
}

function calendarCheck_(from, to) {
  const todayStr = today_();
  to = to || todayStr;
  from = from || (fiscalYearOf_(todayStr) + '-04-01');
  const pf = parseDate_(from), pt = parseDate_(to);
  const start = new Date(pf.y, pf.m - 1, pf.d, 0, 0, 0);
  const end = new Date(pt.y, pt.m - 1, pt.d, 23, 59, 59);
  const calId = prop_('CALENDAR_ID');
  const cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();

  // レッスン予定を「日付×施設」でまとめる
  const lessons = {};
  cal.getEvents(start, end).forEach(function (ev) {
    const fac = facilityFromTitle_(ev.getTitle());
    if (!fac) return;
    const d = Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const key = d + '|' + fac;
    if (!lessons[key]) lessons[key] = { date: d, facility: fac, titles: [], time: Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'HH:mm') };
    lessons[key].titles.push(ev.getTitle());
  });

  // 期間内のレッスン室の領収書
  let receipts = [];
  for (let fy = fiscalYearOf_(from); fy <= fiscalYearOf_(to); fy++) receipts = receipts.concat(allRows_(fy));
  receipts = receipts.filter(function (r) { return r.category === 'レッスン室'; });

  const used = {};
  const items = Object.keys(lessons).sort().map(function (k) {
    const l = lessons[k];
    const exact = receipts.filter(function (r) { return r.date === l.date && normPayee_(r.payee) === normPayee_(l.facility); });
    if (exact.length) { exact.forEach(function (r) { used[r.sheet + r.row] = true; }); return Object.assign(l, { status: 'ok', receipt: exact[0] }); }
    return l;
  });
  // 同じ日になければ ±7日以内の未使用の領収書を探す
  items.forEach(function (l) {
    if (l.status) return;
    const t = parseDate_(l.date);
    const lt = new Date(t.y, t.m - 1, t.d).getTime();
    const near = receipts.filter(function (r) {
      if (used[r.sheet + r.row] || normPayee_(r.payee) !== normPayee_(l.facility)) return false;
      const rp = parseDate_(r.date);
      return Math.abs(new Date(rp.y, rp.m - 1, rp.d).getTime() - lt) <= 7 * 86400000;
    });
    if (near.length) { used[near[0].sheet + near[0].row] = true; l.status = 'near'; l.receipt = near[0]; }
    else l.status = 'missing';
  });
  return items;
}

/* ============================== AI 読み取り（Claude API） ============================== */

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'payment_date', 'category', 'payee', 'detail', 'amount', 'tax', 'addressee', 'number', 'notes'],
  properties: {
    is_receipt: { type: 'boolean', description: '領収書・レシート・施設利用許可書など支払いの書類なら true' },
    payment_date: { type: 'string', description: '支払日 YYYY-MM-DD（西暦）。読めなければ空文字' },
    category: { type: 'string', enum: CATEGORIES },
    payee: { type: 'string', description: '支払先（施設名・店名）' },
    detail: { type: 'string', description: '内容（部屋名・品名など、短く）' },
    amount: { type: 'integer', description: '支払総額（税込、円）。読めなければ 0' },
    tax: { type: 'integer', description: 'うち消費税（円）。記載がなければ 0' },
    addressee: { type: 'string', description: '宛名' },
    number: { type: 'string', description: 'この書類固有の番号（領収書No.・申請受付番号など）' },
    notes: { type: 'string', description: '読み取りに自信がない項目や注意点（日本語、なければ空文字）' },
  },
};

function receiptPrompt_() {
  return [
    'あなたは日本の領収書を読み取る経理アシスタントです。画像から次の項目を読み取り、JSONで返してください。',
    '今日の日付: ' + today_(),
    '',
    '# 支払日（payment_date）',
    '- 実際にお金を支払った日を西暦 YYYY-MM-DD で返す。',
    '- 和暦は西暦に変換する（令和N年 = 2018+N 年。例: 令和8年 = 2026年）。',
    '- 「決済」欄の日付、領収印（丸い日付印。例「-8.10.-2」は令和8年10月2日）、「上記のとおり領収しました」の日付を優先する。',
    '- 施設利用許可書の右上にある発行日や、利用日は支払日ではない（決済日・領収日がない場合のみ利用日を使い、notes にその旨を書く）。',
    '',
    '# 金額（amount / tax）',
    '- 税込の支払総額。「合計」欄があればそれを使う（例: 施設利用料700円＋消費税70円＝合計770円 → amount=770, tax=70）。',
    '- 手書きの場合は桁の枠をよく見て読む（例: 万・千・百・十・円の枠に「¥1000」→ 1000）。',
    '',
    '# 番号（number）',
    '- その書類だけの番号を入れる: 領収書の「No.」、施設利用許可書の「申請受付番号」など。',
    '- 「利用者登録番号」は毎回同じ番号なので使わない。',
    '',
    '# 支払先（payee）と種類（category）',
    '- 次の施設は必ずこの名前に統一する:',
    '  - 釜石市民ホール（TETTO・釜石市民ホール指定管理者）→ payee「釜石市民ホール」、detail は部屋名（例「スタジオA」）',
    '  - 大槌町文化交流センター（おしゃっち・大槌町長・「文化交流センター」の領収印）→ payee「大槌町文化交流センター」、detail は摘要（例「レッスン室」）',
    '- 上記以外の施設（市民会館・公民館・体育館・貸しスタジオ・貸し会議室など）は、書類に書かれた正式な施設名を payee に、部屋名を detail に入れる。',
    '- 種類: レッスン室（施設・部屋・スタジオの利用料。初めての施設でもレッスン室）/ 交通費（電車・バス・タクシー・高速代・ガソリン）/ 駐車場代 / 備品代（物品の購入）/ その他。',
    '',
    '# 宛名（addressee）',
    '- 「株式会社キッズピース」「きっずふぁむ」「益子翔太」などの宛名をそのまま書く（どれでも問題ない）。',
    '',
    '読めない項目は空文字（数値は0）にし、推測した項目や不確かな項目は notes に日本語で短く書いてください。',
  ].join('\n');
}

function analyzeReceipt_(imageB64) {
  const key = prop_('CLAUDE_API_KEY');
  if (!key) throw new Error('Claude APIキーが設定されていません（スクリプトプロパティ CLAUDE_API_KEY）');
  if (!imageB64) throw new Error('写真がありません');
  const data = String(imageB64).replace(/^data:image\/\w+;base64,/, '');

  const model = prop_('CLAUDE_MODEL') || DEFAULT_CLAUDE_MODEL;
  const body = {
    model: model,
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data } },
        { type: 'text', text: receiptPrompt_() },
      ],
    }],
  };
  // Sonnet 5.5 は考える処理を省いて高速化（読み取りの単純作業なので十分）
  // （between_tools は他のモデルでは使えないため、この場合は自動切り替え(fallbacks)を付けない）
  let useFallback = true;
  if (/^claude-sonnet-5-5/.test(model)) { body.thinking = { type: 'between_tools' }; delete body.fallbacks; useFallback = false; }
  let res = callClaude_(key, body, useFallback);
  if (useFallback && res.code === 400 && /fallback/i.test(res.text)) { // フォールバック機能が使えない場合は外して再実行
    delete body.fallbacks;
    res = callClaude_(key, body, false);
  }
  if (res.code !== 200) throw new Error('AI読み取りに失敗しました（' + res.code + '）: ' + res.text.slice(0, 300));
  const msg = JSON.parse(res.text);
  if (msg.stop_reason === 'refusal') throw new Error('AIがこの画像の読み取りを断りました。手入力してください。');
  const textBlock = (msg.content || []).filter(function (b) { return b.type === 'text'; }).pop();
  if (!textBlock) throw new Error('AIの応答が空でした');
  const r = JSON.parse(textBlock.text);
  // 施設名の統一（念のため）
  FACILITIES.forEach(function (f) {
    if (f.keywords.some(function (k) { return String(r.payee).indexOf(k) >= 0; })) r.payee = f.name;
  });
  return r;
}

function callClaude_(key, body, withFallbackBeta) {
  const headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  if (withFallbackBeta) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    last = { code: resp.getResponseCode(), text: resp.getContentText() };
    if (last.code !== 429 && last.code < 500) return last;
    Utilities.sleep(1500 * (attempt + 1));
  }
  return last;
}
