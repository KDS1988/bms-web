// Вкладка «СТУДИИ»: матчи из листа «ВНОСИТЬ СЮДА!!!», ПК, ВР, проверки.
(function () {
  const A = window.APP, C = window.StudiosCore;
  const { h, api, toast, S } = A;
  const ST = { matches: [], configured: true, sync: null, studio: '', q: '', loaded: false, pause: 15, cap: 1, tol: 0, onlyConf: false };
  try { const s = JSON.parse(localStorage.getItem('bms_studios_cfg') || '{}'); ['pause', 'cap', 'tol'].forEach(k => { if (Number.isFinite(s[k])) ST[k] = s[k]; }); } catch (e) { /* ok */ }
  const saveCfg = () => { try { localStorage.setItem('bms_studios_cfg', JSON.stringify({ pause: ST.pause, cap: ST.cap, tol: ST.tol })); } catch (e) { /* ok */ } };
  const $ = id => document.getElementById(id);
  const STATUSES = ['', 'запланировано', 'выполнено', 'отмена', 'проблемы в студии', 'проблемы на площадке'];
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(sessionStorage.getItem('bms_sc_collapsed') || '[]')); } catch (e) { /* ok */ }
  const saveCol = () => { try { sessionStorage.setItem('bms_sc_collapsed', JSON.stringify([...collapsed])); } catch (e) { /* ok */ } };
  let sort = { key: 'start', dir: 1 };
  try { const x = JSON.parse(localStorage.getItem('bms_sc_sort') || 'null'); if (x && x.key) sort = x; } catch (e) { /* ok */ }
  const COLS = [['status', 'Статус'], ['support', 'Саппорт'], ['engineer', 'Инженер'], ['studio', 'Студия'], ['pc', '№ ПК'], ['start', 'Начало'], ['end', 'Конец'], ['project', 'Проект'], ['t1', 'Команда 1'], ['t2', 'Команда 2'], ['vr', 'Выпускающий режиссёр'], ['comm', 'Комментатор'], ['tri', 'TRI'], ['comment', 'Комментарий'], ['scomment', 'Комментарий саппорта']];
  function sortList(list) {
    const k = sort.key, time = k === 'start' || k === 'end';
    const val = m => time ? (C.toMin(m[k]) == null ? -1 : C.toMin(m[k])) : String(m[k] || '').toLowerCase();
    return list.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      // пустые значения всегда внизу
      if (!time && (x === '') !== (y === '')) return x === '' ? 1 : -1;
      const c = time ? x - y : x.localeCompare(y, 'ru', { numeric: true });
      return c * sort.dir || (C.span(a) || [0])[0] - (C.span(b) || [0])[0];
    });
  }
  function setSort(k) {
    sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: 1 };
    try { localStorage.setItem('bms_sc_sort', JSON.stringify(sort)); } catch (e) { /* ok */ }
    render();
  }
  const cfg = () => ({ pause: ST.pause, cap: ST.cap });

  async function load() {
    const d = await api('/api/studios', { query: A.range() });
    ST.matches = d.matches; ST.configured = d.configured; ST.sync = d.sync; ST.loaded = true;
    render();
  }

  function names(key) { return [...new Set(ST.matches.map(m => m[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')); }

  function pcsOf(studio) {
    return [...new Set(ST.matches.filter(m => m.studio === studio && m.pc).map(m => m.pc))].sort();
  }

  async function save(m, patch) {
    const prev = {}; Object.keys(patch).forEach(k => { prev[k] = m[k]; });
    if (patch.pc !== undefined || patch.start !== undefined || patch.end !== undefined || patch.studio !== undefined) {
      const test = { ...m, ...patch };
      const bad = C.pcConflicts(test, ST.matches, ST.tol)[0];
      if (bad) { toast(`ПК ${test.pc} занят: «${bad.project} ${bad.t1}» ${bad.start}–${bad.end}`, true); render(); return; }
    }
    Object.assign(m, patch); render();
    try { const r = await api('/api/studios', { method: 'POST', body: { id: m.id, ...patch } }); Object.assign(m, r.match); }
    catch (e) { Object.assign(m, prev); toast(e.message, true); }
    render();
  }

  function cell(m, key, o = {}) {
    const can = A.canEdit();
    const attrs = { class: 'sc-in ' + (o.cls || ''), value: m[key] || '', disabled: !can, list: o.list };
    if (o.type) attrs.type = o.type;
    const el = h('input', { ...attrs, onchange: ev => { const v = ev.target.value.trim(); if (v !== (m[key] || '')) save(m, { [key]: v }); } });
    return h('td', null, el);
  }

  function statusCell(m) {
    const sel = h('select', { class: 'sc-in', disabled: !A.canEdit(), onchange: ev => save(m, { status: ev.target.value }) },
      STATUSES.map(s => h('option', { value: s, selected: s === m.status }, s || '—')));
    return h('td', null, sel);
  }

  function dayBlock(date, list) {
    const isCol = collapsed.has(date);
    const head = h('div', { class: 'sc-dayhead' + (isCol ? ' collapsed' : ''), title: isCol ? 'Развернуть день' : 'Свернуть день',
      onclick: () => { if (collapsed.has(date)) collapsed.delete(date); else collapsed.add(date); saveCol(); render(); } },
      h('span', { class: 'tg' }, isCol ? '▸' : '▾'), ' ',
      h('b', null, A.fmtDay(date)), ' ',
      h('span', { class: 'muted' }, `матчей: ${list.filter(C.alive).length}`));
    const need = C.minVr(list, cfg());
    const assigned = new Set(list.filter(C.alive).map(m => m.vr).filter(Boolean));
    head.append(h('span', { class: 'sc-need', title: 'Минимум ВР при выбранной паузе между матчами' }, `нужно ВР: ${need.count}`),
      h('span', { class: 'muted' }, ` · поставлено: ${assigned.size}`));
    if (assigned.size && assigned.size < need.count) head.append(h('span', { class: 'sc-warn' }, ` · не хватает ${need.count - assigned.size}`));
    const rows = isCol ? [] : sortList(list).map(m => {
      const conf = C.pcConflicts(m, ST.matches, ST.tol);
      const tr = h('tr', { class: (m.status === 'отмена' ? 'sc-cancel ' : '') + (conf.length ? 'sc-conf' : ''), title: conf.length ? 'Конфликт ПК с: ' + conf.map(c => `${c.project} ${c.start}–${c.end}`).join('; ') : null },
        statusCell(m), cell(m, 'support'), cell(m, 'engineer'),
        cell(m, 'studio', { list: 'sc-studios', cls: 'w90' }), cell(m, 'pc', { list: 'sc-pcs-' + (m.studio || ''), cls: 'w50' }),
        cell(m, 'start', { cls: 'w50' }), cell(m, 'end', { cls: 'w50' }),
        cell(m, 'project', { cls: 'w140' }), cell(m, 't1', { cls: 'w160' }), cell(m, 't2', { cls: 'w100' }),
        cell(m, 'vr', { list: 'sc-vrs', cls: 'w130' }), cell(m, 'comm', { cls: 'w110' }), cell(m, 'tri', { cls: 'w50' }),
        cell(m, 'comment', { cls: 'w140' }), cell(m, 'scomment', { cls: 'w140' }),
        h('td', null, A.canEdit() ? h('button', { class: 'sc-del', title: 'Убрать матч', onclick: () => del(m) }, '✕') : null));
      return tr;
    });
    if (isCol) return h('div', { class: 'sc-day' }, head);
    return h('div', { class: 'sc-day' }, head, h('div', { class: 'tablewrap' }, h('table', { class: 'sc-table' },
      h('thead', null, h('tr', null, [...COLS.map(([k, t]) => h('th', { class: 'sc-sort' + (sort.key === k ? ' on' : ''), title: 'Сортировать внутри каждого дня', onclick: () => setSort(k) }, t, sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '')), h('th')])),
      h('tbody', null, rows))));
  }

  async function del(m) {
    if (!confirm(`Убрать матч «${m.project} ${m.t1}» ${m.start}?` + (m.manual ? '' : '\nОн перестанет показываться на доске (в Google-таблице останется).'))) return;
    try { await api('/api/studios/delete', { method: 'POST', body: { id: m.id } }); ST.matches = ST.matches.filter(x => x.id !== m.id); render(); }
    catch (e) { toast(e.message, true); }
  }

  function render() {
    const out = $('studiosOut'); if (!out) return;
    const studios = names('studio');
    const sel = $('scStudio');
    if (sel) { const cur = ST.studio; sel.replaceChildren(h('option', { value: '' }, 'Все студии'), ...studios.map(s => h('option', { value: s, selected: s === cur }, s))); }
    const q = (ST.q || '').toLowerCase();
    let list = ST.matches.filter(m => (!ST.studio || m.studio === ST.studio) &&
      (!q || [m.project, m.t1, m.t2, m.vr, m.comm, m.pc].join(' ').toLowerCase().includes(q)));
    if (ST.onlyConf) list = list.filter(m => C.pcConflicts(m, ST.matches, ST.tol).length);
    const days = new Map();
    list.forEach(m => (days.get(m.date) || days.set(m.date, []).get(m.date)).push(m));
    const dl = h('div', null,
      h('datalist', { id: 'sc-studios' }, studios.map(s => h('option', { value: s }))),
      h('datalist', { id: 'sc-vrs' }, names('vr').map(s => h('option', { value: s }))),
      studios.map(s => h('datalist', { id: 'sc-pcs-' + s }, pcsOf(s).map(p => h('option', { value: p })))));
    const body = [...days.keys()].sort().map(d => dayBlock(d, days.get(d)));
    window.__scDays = [...days.keys()];
    const info = ST.sync ? `Синхронизация: ${String(ST.sync.at).slice(0, 16).replace('T', ' ')} UTC, ${ST.sync.by}` : 'Синхронизации ещё не было';
    const sm = $('scInfo');
    sm.textContent = syncMsg ? syncMsg.text : (ST.configured ? info : 'Источник не подключён: Админ → «Студии: источник матчей»') + ` · матчей: ${list.length}`;
    sm.style.color = syncMsg && !syncMsg.ok || (!syncMsg && !ST.configured) ? '#c0392b' : '';
    out.replaceChildren(dl, ...(body.length ? body : [h('p', { class: 'muted' }, ST.loaded ? 'В этом месяце матчей нет.' : 'Загрузка…')]));
  }

  let syncMsg = null;
  async function sync() {
    const btn = $('scSync'); btn.disabled = true; btn.textContent = '⟳ Читаю таблицу…';
    syncMsg = null;
    try {
      const r = await api('/api/studios/sync', { method: 'POST', body: {} });
      toast(`Прочитано строк: ${r.rows}, новых: ${r.added}`); await load();
      syncMsg = { ok: true, text: `Готово: прочитано строк ${r.rows}, новых ${r.added}` };
    } catch (e) {
      syncMsg = { ok: false, text: 'Не удалось прочитать таблицу: ' + e.message };
      toast(syncMsg.text, true);
    }
    btn.disabled = !A.canEdit(); btn.textContent = '⟳ Из таблицы';
    render();
  }

  function addModal() {
    const today = new Date().toISOString().slice(0, 10);
    const f = { date: h('input', { type: 'date', value: today }), start: h('input', { placeholder: '18:00' }), end: h('input', { placeholder: '20:00' }),
      studio: h('input', { list: 'sc-studios', value: ST.studio || 'Калужская' }), pc: h('input'), project: h('input'), t1: h('input'), t2: h('input'), vr: h('input', { list: 'sc-vrs' }), comm: h('input') };
    const labels = { date: 'Дата', start: 'Начало', end: 'Конец', studio: 'Студия', pc: '№ ПК', project: 'Проект', t1: 'Команда 1', t2: 'Команда 2', vr: 'ВР', comm: 'Комментатор' };
    const form = h('div', { class: 'planform' }, Object.keys(f).map(k => h('label', null, labels[k], f[k])));
    const ok = h('button', { class: 'primary', onclick: async () => {
      const body = Object.fromEntries(Object.keys(f).map(k => [k, f[k].value.trim()]));
      try { const r = await api('/api/studios', { method: 'POST', body }); if (r.match.date.slice(0, 7) === S.month) ST.matches.push(r.match); A.closeModal(); render(); }
      catch (e) { toast(e.message, true); }
    } }, 'Добавить');
    A.openModal('Матч студии', h('div', null, form, h('div', { class: 'form' }, ok)));
  }

  function init() {
    const bar = $('scBar');
    const opt = (arr, cur, fmt) => arr.map(v => h('option', { value: v, selected: v === cur }, fmt(v)));
    bar.append(
      h('select', { id: 'scStudio', onchange: e => { ST.studio = e.target.value; render(); } }),
      h('input', { type: 'search', placeholder: 'Поиск: проект, команда, ВР, ПК…', oninput: e => { ST.q = e.target.value; render(); } }),
      h('label', { title: 'Сколько минут ВР нужно между окончанием одного матча и началом следующего' }, 'Пауза между матчами ',
        h('select', { onchange: e => { ST.pause = +e.target.value; saveCfg(); render(); } }, opt([5, 10, 15, 20, 30, 45, 60], ST.pause, v => v + ' мин'))),
      h('label', { title: 'Сколько матчей одного проекта один ВР может вести одновременно. 1 — параллели нет' }, 'Параллель в проекте ',
        h('select', { onchange: e => { ST.cap = +e.target.value; saveCfg(); render(); } }, opt([1, 2, 3, 4], ST.cap, v => v === 1 ? 'нет' : 'до ' + v))),
      h('label', { title: 'Какой нахлёст матчей на одном ПК допустим' }, 'Нахлёст на ПК ',
        h('select', { onchange: e => { ST.tol = +e.target.value; saveCfg(); render(); } }, opt([0, 5, 10, 15], ST.tol, v => v + ' мин'))),
      h('label', null, h('input', { type: 'checkbox', onchange: e => { ST.onlyConf = e.target.checked; render(); } }), ' только конфликты ПК'),
      h('button', { id: 'scCollapse', title: 'Свернуть все дни', onclick: () => { (window.__scDays || []).forEach(d => collapsed.add(d)); saveCol(); render(); } }, '⊟ Свернуть все'),
      h('button', { id: 'scExpand', title: 'Развернуть все дни', onclick: () => { collapsed.clear(); saveCol(); render(); } }, '⊞ Развернуть все'),
      h('button', { id: 'scAdd', onclick: addModal }, '＋ Матч'),
      h('button', { id: 'scSync', class: 'primary', onclick: sync, title: 'Перечитать лист «ВНОСИТЬ СЮДА!!!»' }, '⟳ Из таблицы'));
    $('scAdd').disabled = $('scSync').disabled = !A.canEdit();
    setInterval(() => { if (S.tab === 'studios' && !document.hidden && !document.activeElement.classList.contains('sc-in')) load().catch(() => {}); }, 20000);
  }

  window.Studios = { load, render, init };
})();
