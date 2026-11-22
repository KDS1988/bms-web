/** Только чтение. Разверните отдельным веб-приложением от имени владельца таблиц. */
const RESTREAM_SHEET = '1Q-7oBLSAQPzPf7OV3oqLaww4NYtq7JcSNT_JSABeOpA';

// Номера столбцов листа «ВНОСИТЬ СЮДА!!!» (начиная с 1).
const STREAM_COLUMNS = {
  input: [21, { address: 22, passphrase: 23, port: 24 }],
  srt: [25, { address: 26, passphrase: 27, port: 28 }, 'SRT LISTENER'],
  rtmp: [29, { address: 30, key: 31 }, 'RTMP'],
  tricolor: [32, { address: 33, key: 34, login: 35, password: 36 }],
  inventos: [37, { address: 38, key: 39 }, 'RTMP'],
  league: [40, { link: 41, key: 42 }, 'RTMP'],
  regional: [43, { address: 44, key: 45, passphrase: 46 }],
  sl: [47, {}, 'RTMP'],
  regional2: [48, { address: 49, key: 50, passphrase: 51 }],
  club: [52, { address: 53, key: 54 }, 'RTMP'],
  kp: [55, { address: 56, passphrase: 57, port: 58 }, 'SRT CALLER'],
};

function doPost(e) {
  let request;
  try { request = JSON.parse(e.postData.contents); }
  catch (_) { return restreamOutput_({ error: 'bad request' }); }
  const properties = PropertiesService.getScriptProperties();
  const key = properties.getProperty('RESTREAM_EXPORT_KEY');
  if (!key || key.length < 24 || key !== request?.key) return restreamOutput_({ error: 'bad key' });
  const { from, to } = request;
  if (![from, to].every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) return restreamOutput_({ error: 'bad range' });
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!(days >= 0 && days <= 30)) return restreamOutput_({ error: 'bad range' });

  const book = SpreadsheetApp.openById(RESTREAM_SHEET);
  const sheet = book.getSheetByName('ВНОСИТЬ СЮДА!!!');
  const tz = book.getSpreadsheetTimeZone();
  const rows = [];
  const count = sheet.getLastRow() - 3;
  if (count > 0) {
    const range = sheet.getRange(4, 1, count, 63);
    const data = range.getDisplayValues();
    const dates = sheet.getRange(4, 3, count, 1).getValues();
    data.forEach((row, i) => {
      const date = restreamDate_(dates[i][0], tz);
      const eventId = row[62].trim();
      if (!/^[1-9]\d{0,14}$/.test(eventId) || !date || date < from || date > to) return;
      const setup = { studio: row[0], pc: row[1], format: row[3], airStart: row[4], airEnd: row[6], round: row[8],
        production: row[11], brief: row[12], manager: row[13], vr: row[15], graphics: row[16], cabin: row[17],
        commentator1: row[18], commentator2: row[19], slKey: row[59], pass: row[60], leagueCode: row[61] };
      const streams = Object.fromEntries(Object.entries(STREAM_COLUMNS).map(([recipient, config]) => [
        recipient, restreamSheetStream_(row, recipient, config),
      ]));
      rows.push({ eventId, setup, streams });
    });
  }

  const srt = [];
  let srtUnavailable = false;
  try {
    const serverBook = SpreadsheetApp.openById(properties.getProperty('SRT_SPREADSHEET_ID'));
    const ids = new Set(Array.isArray(request.eventIds) ? request.eventIds.map(String) : []);
    for (const year of new Set([from.slice(0, 4), to.slice(0, 4)])) {
      const tab = serverBook.getSheetByName(year);
      if (!tab) { srtUnavailable = true; continue; }
      if (!tab.getLastRow()) continue;
      for (const [eventId, , address, port, passphrase] of tab.getRange(1, 7, tab.getLastRow(), 5).getDisplayValues()) {
        if (ids.has(eventId.trim())) srt.push({ eventId: eventId.trim(), params: { protocol: 'SRT LISTENER', address, port, passphrase } });
      }
    }
  } catch (_) { srtUnavailable = true; }
  return restreamOutput_({ rows, srt, srtUnavailable });
}

function restreamSheetStream_(row, recipient, [column, fields, defaultProtocol]) {
  const flag = row[column - 1].trim();
  const normalized = flag.toLowerCase();
  if (!normalized) return { needed: null };
  if (['нет', '-', '—'].includes(normalized)) return { needed: false };
  const params = Object.fromEntries(Object.entries(fields).map(([key, i]) => [key, row[i - 1].trim()]));
  const srt = /srt/i.test(flag) || /^srt:\/\//i.test(params.address || '');
  const rtmp = /rtmp/i.test(flag) || /^rtmps?:\/\//i.test(params.address || '');
  params.protocol = srt ? (recipient === 'tricolor' ? 'SRT CALLER' : 'SRT') : (rtmp ? 'RTMP' : defaultProtocol || '');
  if (recipient === 'tricolor' && srt) {
    params.port = params.password || params.key;
    if (/^\d+$/.test(params.key)) delete params.key;
    if (/^\d+$/.test(params.password)) delete params.password;
  }
  if (recipient === 'input' && rtmp) { params.key = params.passphrase; delete params.passphrase; }
  if (recipient === 'league' && /^rtmps?:\/\//i.test(params.link)) { params.address = params.link; delete params.link; }
  return { needed: true, params };
}

function restreamDate_(value, tz) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
  return m ? [m[3].length === 2 ? '20' + m[3] : m[3], m[2].padStart(2, '0'), m[1].padStart(2, '0')].join('-') : '';
}

function restreamOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
