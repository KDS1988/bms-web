(function () {
  'use strict';
  const CFG = window.BMS_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const COLS = [['vr', 'ВР'], ['prod', 'Прод'], ['dir', 'Реж'], ['replay', 'Повт'], ['gfx', 'Титры'], ['sound', 'Звук'], ['eng', 'Инж'], ['cam', 'Опер'], ['other', 'Др.']];
  const STATUS = { appointed: 'принял', pending: 'ждёт ответа', declined: 'отказ' };
  const STATE_LABEL = { free: 'свободен', busy: 'занят', off: 'не может' };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const $ = id => document.getElementById(id);
  const S = { token: null, user: null, tab: 'board', board: null, staff: null, rates: null, month: null, all: false };

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
  const pad = n => String(n).padStart(2, '0');
  const iso = d => d.toISOString().slice(0, 10);
  const fmtDay = s => { const d = new Date(s + 'T00:00:00Z'); return `${WD[d.getUTCDay()]} ${s.slice(8)}.${s.slice(5, 7)}`; };
  const canEdit = () => S.user && (S.user.role === 'editor' || S.user.role === 'admin');
  const lower = s => String(s || '').toLowerCase();
  const curMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthShift = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
  function range() {
    const [y, mo] = S.month.split('-').map(Number);
    return { from: `${S.month}-01`, to: `${S.month}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}` };
  }

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

  // ---------- месяцы (листы)
  function renderMonths() {
    const base = monthShift(curMonth(), -2);
    const first = S.month < base ? S.month : base;
    const lastWanted = monthShift(curMonth(), 6);
    const last = S.month > lastWanted ? S.month : lastWanted;
    const btns = [];
    for (let m = first; m <= last; m = monthShift(m, 1)) {
      const [y, mo] = m.split('-').map(Number);
      btns.push(h('button', { class: (m === S.month ? 'on ' : '') + (m === curMonth() ? 'cur' : ''), title: `${MONTHS[mo - 1]} ${y}`, onclick: () => setMonth(m) },
        MONTHS[mo - 1].slice(0, 3) + (mo === 1 || m === first ? ` ${String(y).slice(2)}` : '')));
    }
    $('months').replaceChildren(...btns);
  }
  function setMonth(m) {
    S.month = m; try { sessionStorage.setItem('bms_month', m); } catch (e) { /* ok */ }
    S.board = S.staff = S.rates = null;
    renderMonths(); reload();
  }

  // ---------- вкладки
  function showTab(t) {
    S.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    ['board', 'staff', 'rates', 'admin'].forEach(k => { $('view-' + k).hidden = k !== t; });
    $('rangeBox').hidden = t === 'admin';
    reload();
  }
  let refreshNow = false;
  async function reload() {
    banner('');
    try {
      if (S.tab === 'admin') return await loadAdmin();
      $('reload').disabled = true; $('reload').textContent = 'Загрузка…';
      if (S.tab === 'board') {
        if (!S.board) $('boardOut').replaceChildren(h('p', { class: 'muted' }, 'Загружаю ' + MONTHS[Number(S.month.slice(5)) - 1].toLowerCase() + '…'));
        await loadBoard(false, refreshNow); refreshNow = false;
      }
      if (S.tab === 'staff') { if (!S.staff) $('staffOut').replaceChildren(h('p', { class: 'muted' }, 'Загружаю график…')); const m = S.month, d = await api('/api/staff', { query: range() }); if (m === S.month) { S.staff = d; renderStaff(); } }
      if (S.tab === 'rates') { if (!S.rates) $('ratesOut').replaceChildren(h('p', { class: 'muted' }, 'Ищу назначения без ставки…')); const m = S.month, d = await api('/api/rates/missing', { query: range() }); if (m === S.month) { S.rates = d; renderRates(); } }
    } catch (e) {
      banner(e.message);
      if (e.code === 'bms_login' && S.user.role === 'admin') showTab('admin');
    } finally { $('reload').disabled = false; $('reload').textContent = 'Обновить'; }
  }

  // ---------- общий черновик (живёт на сервере, виден всем)
  let draft = {};
  let draftVersion = null, boardVersion = null, lastBoardAt = 0, needBoard = false;
  const inflight = new Set();     // ключи, которые мы прямо сейчас записываем на сервер
  const candCache = new Map();
  const keyOf = (row, slot) => row.eventServiceId + ':' + slot.lineId;

  function isStale(d, slot) {
    if (!d) return false;
    if (slot.employee) return !d.replaceAssignmentId || d.replaceAssignmentId !== slot.assignmentId;
    return !!d.replaceAssignmentId;
  }
  async function putDraft(rec) {
    const key = rec.eventServiceId + ':' + rec.lineId;
    draft[key] = { ...rec, by: S.user.name }; inflight.add(key); updateBar();
    try { await api('/api/draft', { method: 'POST', body: rec }); }
    catch (e) { delete draft[key]; toast('Не удалось сохранить в общий черновик: ' + e.message, true); syncCells(); }
    finally { inflight.delete(key); updateBar(); poll(true); }
  }
  async function dropDrafts(keys, all) {
    keys.forEach(k => { delete draft[k]; inflight.add(k); }); updateBar();
    try { await api('/api/draft/delete', { method: 'POST', body: all ? { all: true } : { keys } }); }
    catch (e) { toast(e.message, true); }
    finally { keys.forEach(k => inflight.delete(k)); poll(true); }
  }

  function candidates(row, slot) {
    const k = row.date + '|' + slot.roleId;
    const hit = candCache.get(k);
    if (hit && Date.now() - hit.at < 60000) return hit.p;
    const p = api('/api/employees', { query: { date: row.date, lineId: slot.roleId } }).catch(e => { candCache.delete(k); throw e; });
    candCache.set(k, { at: Date.now(), p });
    return p;
  }
  const words = n => lower(n).split(/\s+/).filter(Boolean);
  function matchCands(list, q) {
    const toks = words(q);
    if (!toks.length) return list;
    return list.filter(c => { const w = words(c.name); return toks.every(t => w.some(x => x.startsWith(t))); });
  }

  // выпадающий список подсказок
  const pop = h('div', { class: 'pop', hidden: true });
  document.body.append(pop);
  let popState = null;
  function hidePop() { pop.hidden = true; popState = null; }
  function showPop(input, items, pick, fetchedAt) {
    popState = { input, items, idx: 0, pick, fetchedAt };
    const r = input.getBoundingClientRect();
    const w = Math.max(r.width, 300);
    pop.style.minWidth = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 16)) + 'px';
    const MAXH = 290;                       // окно на ~8 человек, остальные — прокруткой
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 200 && above > below;   // не помещается снизу — раскрываем вверх
    const hh = Math.max(120, Math.min(MAXH, up ? above : below));
    pop.style.maxHeight = hh + 'px';
    pop.style.top = (up ? Math.max(8, r.top - hh - 4) : r.bottom + 2) + 'px';
    drawPop(); pop.hidden = false;
  }
  function drawPop() {
    const st = popState; if (!st) return;
    const foot = st.fetchedAt ? h('div', { class: 'opt none foot' }, 'Занятость из BMS на ' + new Date(st.fetchedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' · «занят» = есть назначение в этот день') : null;
    if (!st.items.length) { pop.replaceChildren(...[h('div', { class: 'opt none' }, 'Никого не найдено'), foot].filter(Boolean)); return; }
    pop.replaceChildren(...[foot].filter(Boolean), ...st.items.map((c, i) => h('div', { class: 'opt' + (i === st.idx ? ' on' : ''), title: (c.busyWith || []).join('\n'),
      onmousedown: ev => { ev.preventDefault(); st.pick(c); } },
    h('span', { class: 'cell ' + c.state }, STATE_LABEL[c.state]), ' ', c.name, c.category ? ' · ' + c.category : '', c.inDraft ? ' · в черновике на этот день' : '')));
    const on = pop.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function focusNext(from, dir) {
    const all = [...document.querySelectorAll('#boardOut .cellin')];
    const nxt = all[all.indexOf(from) + dir]; if (nxt) nxt.focus();
  }

  function cellInput(row, slot, onLeave) {
    const key = keyOf(row, slot);
    const replacing = !!slot.employee;
    const inp = h('input', { class: 'cellin', type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-key': key,
      placeholder: replacing ? slot.employee.name : '＋' });
    let list = [];
    const applyLook = () => {
      const d = draft[key];
      inp.value = d ? d.employeeName : (document.activeElement === inp ? inp.value : '');
      inp.className = 'cellin' + (d ? ' draft' : '') + (d && replacing ? ' repl' : '') + (d && d.error ? ' err' : '') +
        (d && d.state && d.state !== 'free' ? ' warnc' : '') + (d && d.by && d.by !== S.user.name ? ' others' : '');
      inp.title = d ? ((d.error ? 'Ошибка: ' + d.error + '\n' : '') + (replacing ? `Заменит: ${slot.employee.name}\n` : '') +
        `Вписал(а): ${d.by || '—'} · не отправлено в BMS` + (d.state && d.state !== 'free' ? ' · ' + STATE_LABEL[d.state] : '')) : slot.roleName;
    };
    inp._look = applyLook;
    const refresh = async () => {
      let info;
      try { info = await candidates(row, slot); list = info.candidates; } catch (e) { toast(e.message, true); return; }
      const used = new Set(Object.values(draft).filter(x => x.date === row.date && x.employeeId).map(x => x.employeeId));
      const items = matchCands(list, inp.value).map(c => ({ ...c, inDraft: used.has(c.id) && !(draft[key] && draft[key].employeeId === c.id) }));
      showPop(inp, items, pick, info.fetchedAt);
    };
    function pick(c) {
      putDraft({ eventServiceId: row.eventServiceId, lineId: slot.lineId, roleId: slot.roleId, roleName: slot.roleName, date: row.date, title: row.title,
        employeeId: c.id, employeeName: c.name, state: c.state,
        replaceAssignmentId: replacing ? slot.assignmentId : null, prevName: replacing ? slot.employee.name : '' });
      inp.value = c.name; applyLook(); hidePop(); focusNext(inp, 1);
    }
    inp.addEventListener('focus', () => { inp.select(); refresh(); });
    inp.addEventListener('input', () => {
      if (draft[key]) { dropDrafts([key]); inp.classList.remove('draft', 'err', 'warnc', 'repl', 'others'); }
      refresh();
    });
    inp.addEventListener('keydown', ev => {
      const st = popState && popState.input === inp ? popState : null;
      if (ev.key === 'ArrowDown' && st) { ev.preventDefault(); st.idx = Math.min(st.items.length - 1, st.idx + 1); drawPop(); }
      else if (ev.key === 'ArrowUp' && st) { ev.preventDefault(); st.idx = Math.max(0, st.idx - 1); drawPop(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (st && st.items[st.idx]) pick(st.items[st.idx]); else focusNext(inp, 1); }
      else if (ev.key === 'Escape') { hidePop(); inp.blur(); }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === inp) return;
        if (popState && popState.input === inp) {
          if (!draft[key] && inp.value.trim() && popState.items.length === 1 && !popState.items[0].inDraft) pick(popState.items[0]);
          else hidePop();
        }
        if (!draft[key]) { inp.value = ''; if (onLeave) onLeave(); }
      }, 120);
    });
    applyLook();
    return inp;
  }

  // ячейка: сама перерисовывается при изменении общего черновика
  function slotNode(row, slot) {
    const key = keyOf(row, slot);
    const wrap = h('div', { class: 'slot', 'data-slot': key });
    const editable = canEdit() && !row.cancelled;
    const isContractor = !!(slot.employee && !slot.assignmentId);   // подрядчик — другой тип назначения
    const render = () => {
      if (wrap.contains(document.activeElement) && document.activeElement.classList.contains('cellin')) return;
      const d = isStale(draft[key], slot) ? null : draft[key];
      const kids = [];
      if (!slot.employee) {
        kids.push(editable ? cellInput(row, slot, render) : h('span', { class: 'muted' }, '—'));
      } else if (editable && !isContractor && d) {
        kids.push(cellInput(row, slot, render));
      } else {
        const isCon = row.contractor && row.contractor.name === slot.employee.name;
        const cls = isCon ? 'contractor' : (slot.status || 'pending');
        const can = editable && !isContractor;
        kids.push(h('span', { class: 'chip ' + cls + (can ? ' editable' : ''),
          title: (isCon ? 'подрядчик · ' : '') + (STATUS[slot.status] || '') + (slot.logistics ? ' · ' + slot.logistics : '') + (can ? '\nНажмите, чтобы заменить' : ''),
          onclick: can ? () => { const inp = cellInput(row, slot, render); wrap.replaceChildren(inp, ...badges()); inp.focus(); } : null }, slot.employee.name));
        if (slot.hasRate === false) kids.push(h('span', { class: 'warn', title: 'Нет ставки — доначислите на вкладке «Ставки»' }, '⚠'));
      }
      wrap.replaceChildren(...kids, ...badges());
    };
    const badges = () => (slot.badges || []).map(b => h('span', { class: 'badge' }, b));
    wrap._render = render;
    render();
    return wrap;
  }

  // обновить ячейки на экране после прихода общего черновика (не трогаем ту, где вы печатаете)
  function syncCells() {
    document.querySelectorAll('#boardOut .slot[data-slot]').forEach(w => w._render && w._render());
    document.querySelectorAll('#boardOut .cellin').forEach(i => { if (document.activeElement !== i && i._look) i._look(); });
  }
  // таблица скроллится внутри себя на всю высоту экрана — шапка и колонка «Мероприятие» остаются на месте
  function fitGrid() {
    document.querySelectorAll('#boardOut .tablewrap, #staffOut .tablewrap, #ratesOut .tablewrap').forEach(w => {
      const top = Math.max(0, w.getBoundingClientRect().top);
      w.style.maxHeight = Math.max(220, window.innerHeight - top - 12) + 'px';
    });
  }
  function updateBar() {
    const n = Object.keys(draft).length;
    $('draftbar').hidden = !n || !canEdit();
    $('draftN').textContent = n;
    fitGrid();
  }

  // ---------- доска
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(sessionStorage.getItem('bms_collapsed') || '[]')); } catch (e) { /* ok */ }
  const saveCollapsed = () => { try { sessionStorage.setItem('bms_collapsed', JSON.stringify([...collapsed])); } catch (e) { /* ok */ } };
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
  let boardReq = 0, staleRetries = 0;
  async function loadBoard(silent, fresh) {
    const my = ++boardReq, month = S.month, all = S.all;
    const q = { ...range() }; if (all) q.all = '1'; if (fresh) q.fresh = '1';
    const data = await api('/api/board', { query: q });
    if (my !== boardReq || month !== S.month || all !== S.all) return;   // пока ждали — переключили месяц: старый ответ выбрасываем
    lastBoardAt = Date.now();
    S.board = data; renderBoard();
    if (data.generatedAt) {
      const t = new Date(data.generatedAt).toLocaleTimeString('ru-RU');
      $('live').title = `Общая доска. Данные BMS от ${t}` + (data.meta ? ` · ${data.meta.items} записей, ${(data.meta.fetchMs / 1000).toFixed(1)} с на загрузку из BMS` : '');
    }
    // сервер отдал снимок и обновляет его в фоне — через пару секунд заберём свежий
    if (data.stale && staleRetries < 6) { staleRetries++; setTimeout(() => { if (month === S.month && S.tab === 'board' && !editingNow()) loadBoard(true); }, 4000); }
    else if (!data.stale) staleRetries = 0;
    if (!silent) poll(true);
  }
  function renderBoard() {
    hidePop();
    const wrapOld = document.querySelector('#boardOut .tablewrap');
    const sc = wrapOld ? [wrapOld.scrollLeft, wrapOld.scrollTop] : null, wy = window.scrollY;
    const f = { q: lower($('q').value.trim()), league: $('league').value, gaps: $('onlyGaps').checked, problems: $('onlyProblems').checked };
    const sel = $('league'), cur = sel.value;
    if (sel.options.length - 1 !== S.board.leagues.length) {
      sel.replaceChildren(h('option', { value: '' }, 'Все лиги'), ...S.board.leagues.map(l => h('option', { value: l }, l)));
      sel.value = cur;
    }
    const used = COLS.filter(([k]) => k !== 'other' || S.board.days.some(d => d.rows.some(r => r.slots.other.length)));
    const tbody = h('tbody');
    let shown = 0; const stale = [];
    for (const day of S.board.days) {
      const rows = day.rows.filter(r => rowMatches(r, f));
      if (!rows.length) continue;
      const isCol = collapsed.has(day.date);
      tbody.append(h('tr', { class: 'dayrow' + (isCol ? ' collapsed' : ''), title: isCol ? 'Развернуть день' : 'Свернуть день',
        onclick: () => { if (collapsed.has(day.date)) collapsed.delete(day.date); else collapsed.add(day.date); saveCollapsed(); renderBoard(); } },
      h('td', { colspan: used.length + 2 }, h('span', { class: 'tg' }, isCol ? '▸' : '▾'), ' ', fmtDay(day.date), ' · ', rows.length)));
      if (isCol) { shown += rows.length; continue; }
      for (const r of rows) {
        shown++;
        for (const k of Object.keys(r.slots)) for (const s of r.slots[k]) if (draft[keyOf(r, s)] && isStale(draft[keyOf(r, s)], s)) stale.push(keyOf(r, s));
        const full = r.stats.filled >= r.stats.total;
        tbody.append(h('tr', { class: r.cancelled ? 'cancelled' : '' },
          h('td', { class: 'ev' },
            h('div', { class: 't' }, r.title || '—'),
            h('div', { class: 'm' }, [r.start && (r.start + (r.end ? '–' + r.end : '')), r.league, r.service, ...(r.additional || [])].filter(Boolean).join(' · ')),
            h('div', { class: 'ids' }, h('span', { title: 'ID мероприятия' }, 'мер. ' + r.eventId), ' · ', h('span', { title: 'ID услуги' }, 'усл. ' + r.eventServiceId)),
            r.contractor ? h('span', { class: 'chip contractor' }, 'подрядчик ' + r.contractor.name) : null),
          ...used.map(([k]) => h('td', { class: 'g' }, ...r.slots[k].map(s => slotNode(r, s)))),
          h('td', { class: 'stat' + (full ? ' full' : '') }, `${r.stats.filled}/${r.stats.total}`, r.stats.declined ? ` · отказ ${r.stats.declined}` : '')));
      }
    }
    $('boardOut').replaceChildren(shown
      ? h('div', { class: 'tablewrap grid' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Мероприятие'), ...used.map(([, l]) => h('th', null, l)), h('th', null, 'Комплект'))), tbody))
      : h('p', { class: 'muted' }, 'Ничего не найдено за выбранный месяц.'));
    const wn = document.querySelector('#boardOut .tablewrap');
    if (sc && wn) { wn.scrollLeft = sc[0]; wn.scrollTop = sc[1]; }
    window.scrollTo(0, wy);
    if (stale.length && canEdit()) dropDrafts([...new Set(stale)]);
    updateBar(); fitGrid();
  }

  // ---------- синхронизация: каждые 3 секунды, пока вкладка открыта
  const editingNow = () => { const a = document.activeElement; return a && a.classList && a.classList.contains('cellin'); };
  let polling = false;
  async function poll(force) {
    if (polling || !S.user || document.hidden || S.tab !== 'board') return;
    polling = true;
    try {
      const d = await api('/api/draft', { query: draftVersion == null || force === 'full' ? {} : { since: draftVersion } });
      if (!d.unchanged) {
        const mine = {}; inflight.forEach(k => { if (draft[k]) mine[k] = draft[k]; });
        const next = { ...d.drafts, ...mine }; inflight.forEach(k => { if (!draft[k]) delete next[k]; });
        draft = next; draftVersion = d.version; syncCells(); updateBar();
      }
      if (boardVersion != null && d.boardVersion !== boardVersion) needBoard = true;
      boardVersion = d.boardVersion;
      if (Date.now() - lastBoardAt > 60000) needBoard = true;
      $('live').textContent = '● онлайн'; $('live').classList.remove('off');
      if (needBoard && !editingNow() && S.board) { needBoard = false; await loadBoard(true); }
    } catch (e) { $('live').textContent = '● нет связи'; $('live').classList.add('off'); }
    finally { polling = false; }
  }

  // ---------- отправка в BMS
  async function sendDraft() {
    const items = Object.entries(draft).filter(([k]) => !inflight.has(k));
    if (!items.length) return;
    const odd = items.filter(([, d]) => d.state && d.state !== 'free').length;
    const repl = items.filter(([, d]) => d.replaceAssignmentId).length;
    if (!confirm(`Отправить в BMS назначений: ${items.length}?` + (repl ? `\nЗамен: ${repl} (прежний исполнитель будет снят в BMS).` : '') + (odd ? `\nЗанятых / «не может»: ${odd}.` : ''))) return;
    const btn = $('draftSend'); btn.disabled = true;
    const report = []; let i = 0;
    for (const [key, d] of items) {
      btn.textContent = `Отправка ${++i}/${items.length}…`;
      const label = `${fmtDay(d.date)} · ${d.title} · ${d.roleName}: ${d.employeeName}` + (d.prevName && d.replaceAssignmentId ? ` (вместо ${d.prevName})` : '');
      try {
        const r = await api('/api/assign', { method: 'POST', body: { eventServiceId: d.eventServiceId, lineId: d.lineId, employeeId: d.employeeId, lineName: d.roleName, replaceAssignmentId: d.replaceAssignmentId || undefined } });
        delete draft[key];
        report.push(r.rate === 'failed' ? ['warn', label + ' — назначен, но ставка не записалась (доначислите на вкладке «Ставки»)'] : ['ok', label]);
      } catch (e) {
        if (/уже есть/.test(e.message)) { delete draft[key]; report.push(['skip', label + ' — уже было в BMS']); }
        else { draft[key].error = e.message; report.push(['err', label + ' — ' + e.message]); }
      }
    }
    btn.disabled = false; btn.textContent = 'Отправить в BMS';
    updateBar();
    const cnt = t => report.filter(x => x[0] === t).length;
    $('mTitle').textContent = `Готово: отправлено ${cnt('ok') + cnt('warn')}, пропущено ${cnt('skip')}, ошибок ${cnt('err')}`;
    $('mBody').replaceChildren(...report.map(([t, txt]) => h('div', { class: 'rep ' + t }, ({ ok: '✓ ', warn: '⚠ ', skip: '• ', err: '✗ ' })[t], txt)));
    $('modal').hidden = false;
    candCache.clear(); await loadBoard(true, true); poll('full');
  }
  function clearDraft() {
    if (!confirm('Удалить весь общий черновик? Он очистится у всех участников.')) return;
    dropDrafts([], true).then(() => syncCells());
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
        h('td', { class: 'n', title: e.name + '\n' + e.lines.map(l => l.name + (l.category ? ' ' + l.category : '')).join('\n') }, e.name.split(' ').slice(0, 2).join(' ')),
        ...st.dates.map(d => { const x = e.days[d] || { state: 'free', items: [] }; return h('td', { class: 'd' }, h('span', { class: 'cell ' + x.state, title: x.items.join('\n') }, label[x.state])); })))));
    $('staffOut').replaceChildren(emps.length ? h('div', { class: 'tablewrap' }, table) : h('p', { class: 'muted' }, 'Никого не найдено.'));
    fitGrid();
  }

  // ---------- ставки
  function renderRates() {
    const m = S.rates.missing;
    $('ratesInfo').textContent = m.length ? `Назначений без ставки: ${m.length}` : 'Все назначения за месяц со ставками ✓';
    $('ratesFix').disabled = !m.length || !canEdit();
    $('ratesOut').replaceChildren(m.length ? h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ...['Дата', 'Мероприятие', 'Роль', 'Сотрудник'].map(x => h('th', null, x)))),
      h('tbody', null, ...m.map(x => h('tr', null, h('td', null, fmtDay(x.date)), h('td', null, x.title), h('td', null, x.role), h('td', null, x.employee)))))) : '');
    fitGrid();
  }
  async function fixRates() {
    if (!confirm('Доначислить ставки всем назначениям за месяц?')) return;
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
    if (!S.month) { try { S.month = sessionStorage.getItem('bms_month'); } catch (e) { /* ok */ } }
    if (!S.month) S.month = curMonth();
    renderMonths(); showTab('board');
  }
  function bind() {
    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('reload').onclick = () => { candCache.clear(); refreshNow = true; reload(); };
    $('prev').onclick = () => setMonth(monthShift(S.month, -1)); $('next').onclick = () => setMonth(monthShift(S.month, 1));
    $('logout').onclick = logout; $('mClose').onclick = closeModal;
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    ['q', 'league', 'onlyGaps', 'onlyProblems'].forEach(id => $(id).addEventListener('input', () => S.board && renderBoard()));
    $('allEvents').addEventListener('change', () => { S.all = $('allEvents').checked; S.board = null; reload(); });
    ['sq', 'sline'].forEach(id => $(id).addEventListener('input', () => S.staff && renderStaff()));
    $('collapseAll').onclick = () => { (S.board ? S.board.days : []).forEach(d => collapsed.add(d.date)); saveCollapsed(); if (S.board) renderBoard(); };
    $('expandAll').onclick = () => { collapsed.clear(); saveCollapsed(); if (S.board) renderBoard(); };
    $('ratesFix').onclick = fixRates; $('draftSend').onclick = sendDraft; $('draftClear').onclick = clearDraft;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });
    window.addEventListener('resize', fitGrid);
    setInterval(poll, 3000);
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
