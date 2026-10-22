/**
 * Экспорт листа «ВНОСИТЬ СЮДА!!!» для доски BMS (вкладка «СТУДИИ»).
 *
 * Как поставить:
 *  1. https://script.google.com → «Новый проект», вставить этот код.
 *  2. Вместо СЕКРЕТНЫЙ_КЛЮЧ вписать длинную случайную строку (запомнить её).
 *  3. «Развернуть» → «Новое развертывание» → тип «Веб-приложение»:
 *     выполнять от имени «Меня», доступ «У кого есть ссылка» (или «Все»).
 *  4. Скопировать URL веб-приложения и вместе с ключом вписать в доске: Админ → «Студии».
 * Скрипт только читает таблицу и ничего в ней не меняет.
 */
var SHEET_ID = '1Q-7oBLSAQPzPf7OV3oqLaww4NYtq7JcSNT_JSABeOpA';
var SHEET_NAME = 'ВНОСИТЬ СЮДА!!!';
var KEY = 'СЕКРЕТНЫЙ_КЛЮЧ';
// Таблица студий — для истории ВР (режим mode=history)
var HISTORY_ID = '1kFZX_9Waxv7Pxcfm8HPbxgrCUwFTmy4t8KJsXxNPYZY';
var HISTORY_SHEET = '2025 (РАСПИСАНИЕ СТУДИЙ)';

function doGet(e) {
  if (!e || !e.parameter || e.parameter.key !== KEY) return out_({ error: 'bad key' });
  if (e.parameter.mode === 'history') return history_();
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  var tz = SpreadsheetApp.openById(SHEET_ID).getSpreadsheetTimeZone();
  var v = sh.getDataRange().getValues();
  var hdr = -1;
  for (var i = 0; i < Math.min(v.length, 10); i++) if (String(v[i][0]).trim().toLowerCase() === 'студия') { hdr = i; break; }
  if (hdr < 0) return out_({ error: 'header not found' });
  var from = e.parameter.from || '';            // yyyy-MM-dd — отдаём только строки не раньше этой даты
  var rows = [];
  for (var r = hdr + 1; r < v.length; r++) {
    var x = v[r];
    var date = fmtDate_(x[2], tz);
    if (!date || (from && date < from)) continue;
    rows.push({
      studio: x[0], pc: String(x[1]), date: date,
      start: fmtTime_(x[4], tz), evStart: fmtTime_(x[5], tz), end: fmtTime_(x[6], tz),
      project: x[7], t1: x[9], t2: x[10],
      vr: x[15], comm1: x[18], comm2: x[19], cabin: x[17]
    });
  }
  return out_({ rows: rows });
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fmtDate_(d, tz) {
  if (Object.prototype.toString.call(d) === '[object Date]') return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d)); return m ? String(d) : '';
}
function fmtTime_(d, tz) {
  if (Object.prototype.toString.call(d) === '[object Date]') return Utilities.formatDate(d, tz, 'HH:mm');
  var m = /^(\d{1,2}):(\d{2})/.exec(String(d)); return m ? m[1] + ':' + m[2] : '';
}

/** История: [дата, студия, проект, ВР, статус, начало, конец] по строкам листа «2025 (РАСПИСАНИЕ СТУДИЙ)». */
function history_() {
  var ss = SpreadsheetApp.openById(HISTORY_ID);
  var sh = ss.getSheetByName(HISTORY_SHEET);
  if (!sh) return out_({ error: 'history sheet not found' });
  var tz = ss.getSpreadsheetTimeZone();
  var v = sh.getDataRange().getValues();
  var hdr = -1;
  for (var i = 0; i < Math.min(v.length, 10); i++) if (String(v[i][0]).trim() === 'Статус') { hdr = i; break; }
  if (hdr < 0) return out_({ error: 'history header not found' });
  var rows = [];
  for (var r = hdr + 1; r < v.length; r++) {
    var x = v[r];
    var date = fmtDate_(x[5], tz);
    if (!date || !x[11]) continue;
    rows.push([date, String(x[3]), String(x[8]), String(x[11]), String(x[0]), fmtTime_(x[6], tz), fmtTime_(x[7], tz)]);
  }
  return out_({ history: rows });
}
