(function () {
  'use strict';
  const CFG = window.BMS_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const COLS = [['vr', 'ВР'], ['prod', 'Прод'], ['dir', 'Реж'], ['replay', 'Повт'], ['gfx', 'Титры'], ['sound', 'Звук'], ['eng', 'Инж'], ['cam', 'Опер'], ['other', 'Др.']];
  const STATUS = { appointed: 'принял', pending: 'ждёт ответа', declined: 'отказ' };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const $ = id => document.getElementById(id);
  const S = { token: null, user: null, tab: 'board', board: null, staff: null, rates: null };

  // ---------- утилиты
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const fmtDay = s => { const d = new Date(s + 'T00:00:00Z'); return `${WD[d.getUTCDay()]} ${s.slice(8)}.${s.slice(5, 7)}`; };
  const canEdit = () => S.user && (S.user.role === 'editor' || S.user.role === 'admin');
  const lower = s => String(s || '').toLowerCase();

  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
  }
  const DEMO_NOTE = 'ДЕМО-РЕЖИМ: тестовые данные, ничего не отправляется в BMS';
  function banner(msg) { const b = $('banner'); const t = msg || (DEMO ? DEMO_NOTE : ''); b.textContent = t; b.hidden = !t; }

  async function api(path, { method = 'GET', body, query } = {}) {
    if (DEMO) return window.DEMO(path, { method, body }, query || (body || {}));
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const r = await fetch(CFG.API_URL + path + qs, {
      method,
      headers: { ...(S.token ? { authorization: 'Bearer ' + S.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {}; try { data = await r.json(); } catch (e) { /* пусто */ }
    if (r.status === 401 && S.token) { logout(); throw new Error('Сессия истекла — войдите заново'); }
    if (!r.ok) { const e = new Error(data.error || ('Ошибка ' + r.status)); e.code = data.code; throw e; }
    return data;
  }

  // ---------- вход
  function logout() {
    S.token = null; S.user = null; try { sessionStorage.removeItem('bms_token'); } catch (e) { /* ok */ }
    $('top').hidden = true; document.querySelectorAll('.view').forEach(v => { v.hidden = true; }); $('login').hidden = false;
  }
  async function onGoogle(resp) {
    $('loginErr').textContent = '';
    try {
      const d = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } });
      S.token = d.token; S.user = d.user;
      try { sessionStorage.setItem('bms_token', d.token); } catch (e) { /* ok */ }
      start();
    } catch (e) { $('loginErr').textContent = e.message; }
  }
  function initGoogle() {
    if (!window.google || !google.accounts) return setTimeout(initGoogle, 300);
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogle });
    google.accounts.id.renderButton($('gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', locale: 'ru' });
  }

  // ---------- диапазон дат
  function range() { return { from: $('from').value, to: $('to').value }; }
  function validRange() {
    const { from, to } = range();
    if (!from || !to || from > to) { toast('Проверьте даты периода', true); return false; }
    if ((new Date(to) - new Date(from)) / 864e5 > 30) { toast('Период не больше 31 дня', true); return false; }
    return true;
  }
  function setRange(from, to) { $('from').value = from; $('to').value = to; }
  function shift(n) { const { from, to } = range(); setRange(addDays(from, n), addDays(to, n)); reload(); }

  // ---------- вкладки
  function showTab(t) {
    S.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    ['board', 'staff', 'rates', 'admin'].forEach(k => { $('view-' + k).hidden = k !== t; });
    $('rangeBox').hidden = t === 'admin';
    reload();
  }
  async function reload() {
    banner('');
    try {
      if (S.tab === 'admin') return await loadAdmin();
      if (!validRange()) return;
      $('reload').disabled = true; $('reload').textContent = 'Загрузка…';
      if (S.tab === 'board') { S.board = await api('/api/board', { query: range() }); renderBoard(); }
      if (S.tab === 'staff') { S.staff = await api('/api/staff', { query: range() }); renderStaff(); }
      if (S.tab === 'rates') { S.rates = await api('/api/rates/missing', { query: range() }); renderRates(); }
    } catch (e) {
      banner(e.message);
      if (e.code === 'bms_login' && S.user.role === 'admin') showTab('admin');
    } finally { $('reload').disabled = false; $('reload').textContent = 'Обновить'; }
  }

  // ---------- доска как таблица с вводом
  // Черновик: назначения, которые вы вписали, но ещё не отправили в BMS. Хранится в браузере.
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem('bms_draft') || '{}'); } catch (e) { draft = {}; }
  const saveDraft = () => { try { localStorage.setItem('bms_draft', JSON.stringify(draft)); } catch (e) { /* ok */ } updateBar(); };
  const keyOf = (row, slot) => row.eventServiceId + ':' + slot.lineId;
  const candCache = new Map();
  function candidates(row, slot) {
    const k = row.date + '|' + slot.roleId;
    if (!candCache.has(k)) {
      const pr = api('/api/employees', { query: { date: row.date, lineId: slot.roleId } }).then(d => d.candidates)
        .catch(e => { candCache.delete(k); throw e; });
      candCache.set(k, pr);
    }
    return candCache.get(k);
  }
  const words = n => lower(n).split(/\s+/).filter(Boolean);
  function matchCands(list, q) {
    const toks = words(q);
    if (!toks.length) return list.slice(0, 12);
    return list.filter(c => { const w = words(c.name); return toks.every(t => w.some(x => x.startsWith(t))); }).slice(0, 12);
  }
  const STATE_LABEL = { free: 'свободен', busy: 'занят', off: 'не может' };

  // выпадающий список подсказок (один на всю страницу)
  const pop = h('div', { class: 'pop', hidden: true });
  document.body.append(pop);
  let popState = null; // { input, items, idx, pick }
  function hidePop() { pop.hidden = true; popState = null; }
  function showPop(input, items, row, slot, pick) {
    popState = { input, items, idx: 0, pick };
    const r = input.getBoundingClientRect();
    const w = Math.max(r.width, 300);
    pop.style.minWidth = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 16)) + 'px';
    const below = window.innerHeight - r.bottom;
    pop.style.maxHeight = Math.max(160, Math.min(300, below - 12)) + 'px';
    pop.style.top = (below < 180 ? Math.max(8, r.top - 306) : r.bottom + 2) + 'px';
    drawPop();
    pop.hidden = false;
  }
  function drawPop() {
    const st = popState; if (!st) return;
    if (!st.items.length) { pop.replaceChildren(h('div', { class: 'opt none' }, 'Никого не найдено')); return; }
    pop.replaceChildren(...st.items.map((c, i) => {
      const used = c.inDraft ? ' · в черновике на этот день' : '';
      return h('div', { class: 'opt' + (i === st.idx ? ' on' : ''), title: (c.busyWith || []).join('\n'),
        onmousedown: ev => { ev.preventDefault(); st.pick(c); } },
      h('span', { class: 'cell ' + c.state }, STATE_LABEL[c.state]), ' ', c.name, c.category ? ' · ' + c.category : '', used);
    }));
    const on = pop.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function cellInput(row, slot) {
    const key = keyOf(row, slot);
    const d = draft[key];
    const inp = h('input', { class: 'cellin' + (d ? ' draft' : '') + (d && d.error ? ' err' : '') + (d && d.state && d.state !== 'free' ? ' warnc' : ''),
      type: 'text', autocomplete: 'off', spellcheck: 'false', value: d ? d.employeeName : '',
      title: d ? (d.error ? 'Ошибка: ' + d.error : 'Черновик — не отправлено в BMS' + (d.state && d.state !== 'free' ? ' · ' + STATE_LABEL[d.state] : '')) : slot.roleName,
      'data-key': key });
    let list = [];
    const refresh = async () => {
      try { list = await candidates(row, slot); } catch (e) { toast(e.message, true); return; }
      const used = new Set(Object.values(draft).filter(x => x.date === row.date && x.employeeId).map(x => x.employeeId));
      const items = matchCands(list, inp.value).map(c => ({ ...c, inDraft: used.has(c.id) && !(draft[key] && draft[key].employeeId === c.id) }));
      showPop(inp, items, row, slot, pick);
    };
    function pick(c) {
      draft[key] = { eventServiceId: row.eventServiceId, lineId: slot.lineId, roleId: slot.roleId, roleName: slot.roleName,
        date: row.date, title: row.title, employeeId: c.id, employeeName: c.name, state: c.state };
      inp.value = c.name; inp.className = 'cellin draft' + (c.state !== 'free' ? ' warnc' : '');
      inp.title = 'Черновик — не отправлено в BMS' + (c.state !== 'free' ? ' · ' + STATE_LABEL[c.state] : '');
      hidePop(); saveDraft(); focusNext(inp, 1);
    }
    inp.addEventListener('focus', () => { inp.select(); refresh(); });
    inp.addEventListener('input', () => {
      if (draft[key]) { delete draft[key]; inp.classList.remove('draft', 'err', 'warnc'); saveDraft(); }
      refresh();
    });
    inp.addEventListener('keydown', ev => {
      const st = popState && popState.input === inp ? popState : null;
      if (ev.key === 'ArrowDown' && st) { ev.preventDefault(); st.idx = Math.min(st.items.length - 1, st.idx + 1); drawPop(); }
      else if (ev.key === 'ArrowUp' && st) { ev.preventDefault(); st.idx = Math.max(0, st.idx - 1); drawPop(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (st && st.items[st.idx]) pick(st.items[st.idx]); else focusNext(inp, 1); }
      else if (ev.key === 'Escape') { hidePop(); inp.blur(); }
      else if (ev.key === 'Delete' && !inp.value) { ev.preventDefault(); }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === inp) return;
        if (popState && popState.input === inp) {
          // «вписал фамилию и ушёл»: если подходит ровно один — берём его
          if (!draft[key] && inp.value.trim() && popState.items.length === 1 && !popState.items[0].inDraft) pick(popState.items[0]);
          else hidePop();
        }
        if (!draft[key]) inp.value = '';
      }, 120);
    });
    return inp;
  }
  function focusNext(from, dir) {
    const all = [...document.querySelectorAll('#boardOut .cellin')];
    const i = all.indexOf(from); const nxt = all[i + dir]; if (nxt) nxt.focus();
  }

  function slotNode(row, slot) {
    const wrap = h('div', { class: 'slot' });
    if (slot.employee) {
      const isCon = row.contractor && row.contractor.name === slot.employee.name;
      const cls = isCon ? 'contractor' : (slot.status || 'pending');
      wrap.append(h('span', { class: 'chip ' + cls, title: (isCon ? 'подрядчик · ' : '') + (STATUS[slot.status] || '') + (slot.logistics ? ' · ' + slot.logistics : '') }, slot.employee.name));
      if (slot.hasRate === false) wrap.append(h('span', { class: 'warn', title: 'Нет ставки — доначислите на вкладке «Ставки»' }, '⚠'));
      delete draft[keyOf(row, slot)]; // уже назначено в BMS — черновик не нужен
    } else if (canEdit() && !row.cancelled) {
      wrap.append(cellInput(row, slot));
    } else wrap.append(h('span', { class: 'muted' }, '—'));
    for (const b of slot.badges || []) wrap.append(h('span', { class: 'badge' }, b));
    return wrap;
  }
  function rowMatches(r, f) {
    if (f.league && r.league !== f.league) return false;
    if (f.gaps && r.stats.filled >= r.stats.total) return false;
    if (f.problems && !(r.stats.declined || r.stats.noRate)) return false;
    if (f.q) {
      const hay = lower([r.title, r.league, ...Object.values(r.slots).flat().map(s => s.employee && s.employee.name)].join(' '));
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }
  function renderBoard() {
    hidePop();
    const f = { q: lower($('q').value.trim()), league: $('league').value, gaps: $('onlyGaps').checked, problems: $('onlyProblems').checked };
    const sel = $('league'), cur = sel.value;
    if (sel.options.length - 1 !== S.board.leagues.length) {
      sel.replaceChildren(h('option', { value: '' }, 'Все лиги'), ...S.board.leagues.map(l => h('option', { value: l }, l)));
      sel.value = cur;
    }
    const used = COLS.filter(([k]) => k !== 'other' || S.board.days.some(d => d.rows.some(r => r.slots.other.length)));
    const tbody = h('tbody');
    let shown = 0;
    for (const day of S.board.days) {
      const rows = day.rows.filter(r => rowMatches(r, f));
      if (!rows.length) continue;
      tbody.append(h('tr', { class: 'dayrow' }, h('td', { colspan: used.length + 2 }, fmtDay(day.date), ' · ', rows.length)));
      for (const r of rows) {
        shown++;
        const full = r.stats.filled >= r.stats.total;
        tbody.append(h('tr', { class: r.cancelled ? 'cancelled' : '' },
          h('td', { class: 'ev' },
            h('div', { class: 't' }, r.title || '—'),
            h('div', { class: 'm' }, [r.start && (r.start + (r.end ? '–' + r.end : '')), r.league, r.service, ...(r.additional || [])].filter(Boolean).join(' · ')),
            r.contractor ? h('span', { class: 'chip contractor' }, 'подрядчик ' + r.contractor.name) : null),
          ...used.map(([k]) => h('td', { class: 'g' }, ...(r.slots[k].length ? r.slots[k].map(s => slotNode(r, s)) : []))),
          h('td', { class: 'stat' + (full ? ' full' : '') }, `${r.stats.filled}/${r.stats.total}`, r.stats.declined ? ` · отказ ${r.stats.declined}` : '')));
      }
    }
    $('boardOut').replaceChildren(shown
      ? h('div', { class: 'tablewrap grid' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Мероприятие'), ...used.map(([, l]) => h('th', null, l)), h('th', null, 'Комплект'))), tbody))
      : h('p', { class: 'muted' }, 'Ничего не найдено за выбранный период.'));
    saveDraft();
  }

  function closeModal() { $('modal').hidden = true; }

  // ---------- панель черновика и отправка в BMS
  function updateBar() {
    const n = Object.keys(draft).length;
    $('draftbar').hidden = !n || !canEdit();
    $('draftN').textContent = n;
  }
  async function sendDraft() {
    const items = Object.entries(draft);
    if (!items.length) return;
    const odd = items.filter(([, d]) => d.state && d.state !== 'free').length;
    if (!confirm(`Отправить в BMS назначений: ${items.length}?` + (odd ? `\nИз них занятых / «не может»: ${odd}.` : ''))) return;
    const btn = $('draftSend'); btn.disabled = true;
    const report = []; let i = 0;
    for (const [key, d] of items) {
      btn.textContent = `Отправка ${++i}/${items.length}…`;
      const label = `${fmtDay(d.date)} · ${d.title} · ${d.roleName}: ${d.employeeName}`;
      try {
        const r = await api('/api/assign', { method: 'POST', body: { eventServiceId: d.eventServiceId, lineId: d.lineId, employeeId: d.employeeId, lineName: d.roleName } });
        delete draft[key];
        report.push(r.rate === 'failed' ? ['warn', label + ' — назначен, но ставка не записалась (доначислите на вкладке «Ставки»)'] : ['ok', label]);
      } catch (e) {
        if (/уже есть/.test(e.message)) { delete draft[key]; report.push(['skip', label + ' — уже было в BMS']); }
        else { draft[key].error = e.message; report.push(['err', label + ' — ' + e.message]); }
      }
    }
    btn.disabled = false; btn.textContent = 'Отправить в BMS';
    saveDraft();
    const cnt = t => report.filter(x => x[0] === t).length;
    $('mTitle').textContent = `Готово: отправлено ${cnt('ok') + cnt('warn')}, пропущено ${cnt('skip')}, ошибок ${cnt('err')}`;
    $('mBody').replaceChildren(...report.map(([t, txt]) => h('div', { class: 'rep ' + t }, ({ ok: '✓ ', warn: '⚠ ', skip: '• ', err: '✗ ' })[t], txt)));
    $('modal').hidden = false;
    candCache.clear();
    reload();
  }
  function clearDraft() {
    if (!confirm('Удалить все неотправленные назначения из черновика?')) return;
    draft = {}; saveDraft(); if (S.board) renderBoard();
  }

  // ---------- график
  function renderStaff() {
    const st = S.staff, q = lower($('sq').value.trim()), line = Number($('sline').value) || 0;
    const sel = $('sline');
    if (sel.options.length - 1 !== st.lines.length) {
      const cur = sel.value;
      sel.replaceChildren(h('option', { value: '' }, 'Все амплуа'), ...st.lines.map(l => h('option', { value: l.id }, l.name)));
      sel.value = cur;
    }
    const emps = st.employees.filter(e => (!q || lower(e.name).includes(q)) && (!line || e.lines.some(l => l.id === line)));
    const label = { free: '', busy: 'занят', off: 'вых.' };
    const table = h('table', { class: 'staff' },
      h('thead', null, h('tr', null, h('th', null, 'Сотрудник'), ...st.dates.map(d => h('th', { class: 'd' }, fmtDay(d))))),
      h('tbody', null, ...emps.map(e => h('tr', null,
        h('td', { class: 'n' }, e.name, h('div', { class: 'sub' }, e.lines.map(l => l.name + (l.category ? ' ' + l.category : '')).join(', '))),
        ...st.dates.map(d => { const x = e.days[d] || { state: 'free', items: [] }; return h('td', { class: 'd' }, h('span', { class: 'cell ' + x.state, title: x.items.join('\n') }, label[x.state])); })))));
    $('staffOut').replaceChildren(emps.length ? h('div', { class: 'tablewrap' }, table) : h('p', { class: 'muted' }, 'Никого не найдено.'));
  }

  // ---------- ставки
  function renderRates() {
    const m = S.rates.missing;
    $('ratesInfo').textContent = m.length ? `Назначений без ставки: ${m.length}` : 'Все назначения за период со ставками ✓';
    $('ratesFix').disabled = !m.length || !canEdit();
    $('ratesOut').replaceChildren(m.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ...['Дата', 'Мероприятие', 'Роль', 'Сотрудник'].map(x => h('th', null, x)))),
      h('tbody', null, ...m.map(x => h('tr', null, h('td', null, fmtDay(x.date)), h('td', null, x.title), h('td', null, x.role), h('td', null, x.employee)))))) : '');
  }
  async function fixRates() {
    if (!confirm('Доначислить ставки всем назначениям за период?')) return;
    $('ratesFix').disabled = true;
    try {
      const r = await api('/api/rates/fix', { method: 'POST', body: range() });
      toast(`Доначислено: ${r.fixed.length}` + (r.failed.length ? `, ошибок: ${r.failed.length}` : ''), r.failed.length > 0);
      reload();
    } catch (e) { toast(e.message, true); $('ratesFix').disabled = false; }
  }

  // ---------- вход в BMS
  async function loadAdmin() {
    const s = await api('/api/admin/bms/status');
    $('bmsStatus').textContent = s.loggedIn ? `Сессия активна (${s.phone}, вошёл ${s.loginBy}, ${String(s.loginAt).slice(0, 16).replace('T', ' ')})` : 'Сессия BMS не активна — войдите.';
  }
  async function sendOtp() {
    try { const r = await api('/api/admin/bms/otp', { method: 'POST', body: { phone: $('phone').value } }); $('adminMsg').textContent = r.ok ? 'Код отправлен' : 'Не удалось: ' + r.message; }
    catch (e) { $('adminMsg').textContent = e.message; }
  }
  async function doLogin() {
    try {
      const r = await api('/api/admin/bms/login', { method: 'POST', body: { phone: $('phone').value, code: $('otp').value } });
      $('adminMsg').textContent = r.ok ? 'Готово' : 'Не удалось: ' + r.message; if (r.ok) loadAdmin();
    } catch (e) { $('adminMsg').textContent = e.message; }
  }

  // ---------- старт
  function start() {
    $('login').hidden = true; $('top').hidden = false;
    $('who').textContent = `${S.user.name} · ${{ admin: 'админ', editor: 'редактор', viewer: 'просмотр' }[S.user.role]}`;
    $('tab-admin').hidden = S.user.role !== 'admin';
    if (!$('from').value) { const t = iso(new Date()); setRange(addDays(t, -1), addDays(t, 6)); }
    showTab('board'); updateBar();
  }
  function bind() {
    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('reload').onclick = reload; $('prev').onclick = () => shift(-7); $('next').onclick = () => shift(7);
    $('today').onclick = () => { const t = iso(new Date()); setRange(addDays(t, -1), addDays(t, 6)); reload(); };
    $('logout').onclick = logout; $('mClose').onclick = closeModal;
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    ['q', 'league', 'onlyGaps', 'onlyProblems'].forEach(id => $(id).addEventListener('input', () => S.board && renderBoard()));
    ['sq', 'sline'].forEach(id => $(id).addEventListener('input', () => S.staff && renderStaff()));
    $('ratesFix').onclick = fixRates; $('draftSend').onclick = sendDraft; $('draftClear').onclick = clearDraft; $('sendOtp').onclick = sendOtp; $('doLogin').onclick = doLogin;
  }

  bind();
  if (DEMO) {
    S.user = window.DEMO('/api/me').user; S.token = 'demo';
    start();
  } else {
    let t = null; try { t = sessionStorage.getItem('bms_token'); } catch (e) { /* ok */ }
    if (t) {
      S.token = t;
      api('/api/me').then(d => { S.user = d.user; start(); }).catch(() => { logout(); initGoogle(); });
    } else { $('login').hidden = false; initGoogle(); }
  }
})();
