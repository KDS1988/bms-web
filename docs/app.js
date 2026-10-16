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

  // ---------- доска
  function slotNode(row, slot, key) {
    const wrap = h('div', { class: 'slot' + (slot.employee ? '' : ' empty') });
    if (slot.employee) {
      const isCon = row.contractor && row.contractor.name === slot.employee.name;
      const cls = isCon ? 'contractor' : (slot.status || 'pending');
      wrap.append(h('span', { class: 'chip ' + cls, title: (isCon ? 'подрядчик · ' : '') + (STATUS[slot.status] || '') + (slot.logistics ? ' · ' + slot.logistics : '') }, slot.employee.name));
      if (slot.hasRate === false) wrap.append(h('span', { class: 'warn', title: 'Нет ставки — доначислите на вкладке «Ставки»' }, '⚠'));
    } else if (canEdit() && !row.cancelled) {
      wrap.append(h('button', { title: 'Назначить: ' + slot.roleName, onclick: () => openPicker(row, slot) }, '＋'));
    } else wrap.append(h('span', { class: 'no' }, '—'));
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
          ...used.map(([k]) => h('td', null, ...(r.slots[k].length ? r.slots[k].map(s => slotNode(r, s, k)) : [h('span', { class: 'muted' }, '')]))),
          h('td', { class: 'stat' + (full ? ' full' : '') }, `${r.stats.filled}/${r.stats.total}`, r.stats.declined ? ` · отказ ${r.stats.declined}` : '')));
      }
    }
    $('boardOut').replaceChildren(shown
      ? h('div', { class: 'tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Мероприятие'), ...used.map(([, l]) => h('th', null, l)), h('th', null, 'Комплект'))), tbody))
      : h('p', { class: 'muted' }, 'Ничего не найдено за выбранный период.'));
  }

  // ---------- назначение
  async function openPicker(row, slot) {
    const body = $('mBody');
    $('mTitle').textContent = `${slot.roleName} · ${row.title} · ${fmtDay(row.date)}`;
    body.replaceChildren(h('p', { class: 'muted' }, 'Загрузка кандидатов…'));
    $('modal').hidden = false;
    try {
      const d = await api('/api/employees', { query: { date: row.date, lineId: slot.roleId } });
      if (!d.candidates.length) return body.replaceChildren(h('p', { class: 'muted' }, 'Нет сотрудников с этим амплуа.'));
      const label = { free: 'свободен', busy: 'занят', off: 'не может' };
      body.replaceChildren(...d.candidates.map(c => h('div', { class: 'cand' },
        h('span', { class: 'cell ' + c.state }, label[c.state]),
        h('span', { class: 'nm' }, c.name, c.category ? ' · ' + c.category : '', c.busyWith.length ? h('small', null, c.busyWith.join('; ')) : null),
        h('button', { class: c.state === 'free' ? 'primary' : '', onclick: ev => doAssign(row, slot, c, ev.target) }, 'Назначить'))));
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
  }
  async function doAssign(row, slot, c, btn) {
    if (c.state !== 'free' && !confirm(`${c.name} — ${c.state === 'busy' ? 'уже занят в этот день' : 'отмечен как «не может»'}. Всё равно назначить?`)) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('/api/assign', { method: 'POST', body: { eventServiceId: row.eventServiceId, lineId: slot.lineId, employeeId: c.id, lineName: slot.roleName } });
      closeModal();
      if (r.rate === 'failed') toast('Назначен, но ставка не записалась — доначислите на вкладке «Ставки»', true);
      else toast(c.name + ' назначен(а)');
      reload();
    } catch (e) { btn.disabled = false; btn.textContent = 'Назначить'; toast(e.message, true); }
  }
  function closeModal() { $('modal').hidden = true; }

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
    showTab('board');
  }
  function bind() {
    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('reload').onclick = reload; $('prev').onclick = () => shift(-7); $('next').onclick = () => shift(7);
    $('today').onclick = () => { const t = iso(new Date()); setRange(addDays(t, -1), addDays(t, 6)); reload(); };
    $('logout').onclick = logout; $('mClose').onclick = closeModal;
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    ['q', 'league', 'onlyGaps', 'onlyProblems'].forEach(id => $(id).addEventListener('input', () => S.board && renderBoard()));
    ['sq', 'sline'].forEach(id => $(id).addEventListener('input', () => S.staff && renderStaff()));
    $('ratesFix').onclick = fixRates; $('sendOtp').onclick = sendOtp; $('doLogin').onclick = doLogin;
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
