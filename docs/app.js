(function () {
  'use strict';
  const CFG = window.BMS_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const COLS = [['vr', 'ВР'], ['prod', 'Прод'], ['dir', 'Реж'], ['replay', 'Повт'], ['gfx', 'Титры'], ['sound', 'Звук'], ['eng', 'Инж'], ['cam', 'Опер'], ['other', 'Др.']];
  const CONTRACTOR_RE = /^(ИП|СЗ|АНО|ООО|ОГАУ)(\s|$)/i;     // как на сервере: подрядчик определяется по названию
  const STATUS = { appointed: 'принял', pending: 'ждёт ответа', declined: 'отказ', not_appointed: 'ещё не отправлено в BMS' };
  const STATE_LABEL = { free: 'свободен', busy: 'занят', off: 'не может' };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const $ = id => document.getElementById(id);
  const S = { view: (function () { try { return localStorage.getItem('bms_view') || 'table'; } catch (e) { return 'table'; } })(), order: {}, token: null, user: null, tab: 'board', board: null, boardRaw: null, plans: [], trips: {}, linkFail: new Set(), lines: null, staff: null, rates: null, month: null, all: false };

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
    const doFetch = () => fetch(CFG.API_URL + path + qs, {
      method,
      headers: { ...(S.token ? { authorization: 'Bearer ' + S.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r;
    try { r = await doFetch(); }
    catch (err) {
      // «Failed to fetch»: ответа от сервера не было вовсе (сеть, VPN, блокировка, обрыв). Чтение безопасно повторить; запись — нет
      if (method === 'GET') { await new Promise(ok => setTimeout(ok, 900)); try { r = await doFetch(); } catch (err2) { err = err2; } }
      if (!r) {
        const e = new Error('Нет ответа от сервера (' + (err && err.message || 'сеть') + '). Проверьте интернет, отключите VPN / блокировщики рекламы или попробуйте другую сеть.');
        e.network = true; throw e;
      }
    }
    let data = {}; try { data = await r.json(); } catch (e) { /* пусто */ }
    if (r.status === 401 && S.token) { logout(); throw new Error('Сессия истекла — войдите заново'); }
    if (!r.ok) { const e = new Error(data.error || ('Ошибка ' + r.status)); e.code = data.code; e.status = r.status; throw e; }
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
    S.board = S.boardRaw = S.staff = S.rates = null;
    renderMonths(); reload();
  }

  // ---------- вкладки
  function showTab(t) {
    S.tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    ['board', 'rates', 'admin'].forEach(k => { $('view-' + k).hidden = k !== t; });
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
    if (slot.employee) return (d.replaceAssignmentId || d.updateAssignmentId) !== slot.assignmentId;
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
  function showMsg(input, text) {
    popState = { input, items: [], idx: 0, pick: () => {}, fetchedAt: null };
    const r = input.getBoundingClientRect();
    pop.style.minWidth = Math.max(r.width, 300) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 316)) + 'px';
    pop.style.top = (r.bottom + 2) + 'px'; pop.style.maxHeight = '120px';
    pop.replaceChildren(h('div', { class: 'opt none' }, text)); pop.hidden = false;
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

  // ---------- доп.услуги юнита (МОБ, ЗАЯВ, ФЛЕШ…) из списка услуги мероприятия
  const extras = new Map();       // key -> [id…] выбранное до того, как вписан человек
  const extraIds = (key, slot) => (draft[key] ? draft[key].additionalIds : (extras.get(key) || (slot && slot.employee && slot.additionalIds) || [])) || [];
  let extraMenu = null;
  function closeExtraMenu() { if (extraMenu) { extraMenu.remove(); extraMenu = null; } }
  document.addEventListener('mousedown', e => { if (extraMenu && !extraMenu.contains(e.target) && !e.target.closest('.addbtn')) closeExtraMenu(); });
  function toggleExtra(row, slot, id) {
    const key = keyOf(row, slot);
    const cur = new Set(extraIds(key, slot));
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    const ids = [...cur];
    if (draft[key]) {
      const names = ids.map(i => (row.additionalServices.find(a => a.id === i) || {}).short || String(i));
      putDraft({ ...draft[key], additionalIds: ids, additionalNames: names });
    } else if (slot.employee && slot.assignmentId) {
      // уже назначен: меняем допуслуги на месте (PUT назначения), человек тот же
      const names = ids.map(i => (row.additionalServices.find(a => a.id === i) || {}).short || String(i));
      putDraft({ eventServiceId: row.eventServiceId, lineId: slot.lineId, roleId: slot.roleId, roleName: slot.roleName, date: row.date, title: row.title,
        employeeId: slot.employee.id, employeeName: slot.employee.name, state: 'free', updateAssignmentId: slot.assignmentId,
        expenseId: slot.expenseId || null, logistics: slot.logistics || null, prevName: slot.employee.name,
        additionalIds: ids, additionalNames: names });
    } else extras.set(key, ids);
  }
  function openExtraMenu(btn, row, slot, rerender) {
    closeExtraMenu();
    const key = keyOf(row, slot);
    const box = h('div', { class: 'extramenu' }, h('div', { class: 'muted' }, 'Доп.услуги юнита'));
    for (const a of row.additionalServices) {
      const cb = h('input', { type: 'checkbox' }); cb.checked = extraIds(key, slot).includes(a.id);
      cb.addEventListener('change', () => { toggleExtra(row, slot, a.id); setTimeout(rerender, 0); });
      box.append(h('label', { title: a.name }, cb, ' ', a.short || a.name, a.name && a.short && a.name !== a.short ? h('span', { class: 'muted' }, ' · ' + a.name) : null));
    }
    document.body.append(box); extraMenu = box;
    const r = btn.getBoundingClientRect();
    box.style.left = Math.min(r.left, window.innerWidth - 240) + 'px'; box.style.top = (r.bottom + 2) + 'px';
  }

  function pickedExtras(row, key, slot) {
    const ids = extraIds(key, slot);   // при замене человека допуслуги юнита, уже стоящие в BMS, сохраняются extras.delete(key);
    return { additionalIds: ids, additionalNames: ids.map(i => (row.additionalServices.find(a => a.id === i) || {}).short || String(i)) };
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
      inp.className = 'cellin' + (d ? ' draft' : '') + (d && replacing && !d.updateAssignmentId ? ' repl' : '') + (d && d.error ? ' err' : '') +
        (d && d.state && d.state !== 'free' ? ' warnc' : '') + (d && d.by && d.by !== S.user.name ? ' others' : '');
      inp.title = d ? ((d.error ? 'Ошибка: ' + d.error + '\n' : '') + (d.updateAssignmentId ? 'Изменятся допуслуги у назначенного\n' : replacing ? `Заменит: ${slot.employee.name}\n` : '') +
        `Вписал(а): ${d.by || '—'} · не отправлено в BMS` + (d.state && d.state !== 'free' ? ' · ' + STATE_LABEL[d.state] : '')) : slot.roleName;
    };
    inp._look = applyLook;
    const refresh = async () => {
      let info;
      const ck = row.date + '|' + slot.roleId, hit = candCache.get(ck);
      if (!(hit && Date.now() - hit.at < 60000)) showMsg(inp, 'Загружаю список сотрудников из BMS…');
      try { info = await candidates(row, slot); list = info.candidates; }
      catch (e) { if (document.activeElement === inp) showMsg(inp, 'Не удалось загрузить список: ' + e.message + ' (кликните в ячейку ещё раз)'); return; }
      if (document.activeElement !== inp) return;
      const used = new Set(Object.values(draft).filter(x => x.date === row.date && x.employeeId).map(x => x.employeeId));
      const items = matchCands(list, inp.value).map(c => ({ ...c, inDraft: used.has(c.id) && !(draft[key] && draft[key].employeeId === c.id) }));
      showPop(inp, items, pick, info.fetchedAt);
    };
    function pick(c) {
      putDraft({ eventServiceId: row.eventServiceId, lineId: slot.lineId, roleId: slot.roleId, roleName: slot.roleName, date: row.date, title: row.title,
        employeeId: c.id, employeeName: c.name, state: c.state, ...pickedExtras(row, key, slot),
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
        const isCon = isContractor || CONTRACTOR_RE.test(slot.employee.name) || (row.contractor && row.contractor.name === slot.employee.name);   // подрядчик всегда синий
        const cls = isCon ? 'contractor' : (slot.status || 'pending');
        const can = editable && !isContractor;
        kids.push(h('span', { class: 'chip ' + cls + (can ? ' editable' : ''),
          title: (isCon ? 'подрядчик · ' : '') + (STATUS[slot.status] || '') + (slot.logistics ? ' · ' + slot.logistics : '') + (can ? '\nНажмите, чтобы заменить' : ''),
          onclick: can ? () => { const inp = cellInput(row, slot, render); wrap.replaceChildren(inp, ...badges()); inp.focus(); } : null }, slot.employee.name));
        if (editable && slot.assignmentId && slot.status === 'not_appointed')
          kids.push(h('button', { class: 'sendbtn', title: 'Отправить назначение сотруднику (BMS пришлёт уведомление)',
            onclick: e => { e.stopPropagation(); notifyAssignments([{ id: slot.assignmentId, who: slot.employee.name, role: slot.roleName }]); } }, '✉'));
        if (slot.hasRate === false) kids.push(h('span', { class: 'warn', title: 'Нет ставки — доначислите на вкладке «Ставки»' }, '⚠'));
      }
      if (editable && d && !isContractor)
        kids.unshift(h('button', { class: 'xbtn', title: 'Убрать из черновика', onclick: e => { e.stopPropagation(); extras.delete(key); dropDrafts([key]); setTimeout(render, 0); } }, '✕'));
      const ex = extraIds(key, slot);
      if (editable && !isContractor && row.additionalServices && row.additionalServices.length)
        kids.push(h('button', { class: 'addbtn' + (ex.length ? ' on' : ''), title: 'Доп.услуги к этому юниту',
          onclick: e => { e.stopPropagation(); openExtraMenu(e.currentTarget, row, slot, render); } },
        ex.length ? ex.map(i => (row.additionalServices.find(a => a.id === i) || {}).short || i).join('+') : '＋доп'));
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
  // верхняя панель и строка фильтров закреплены: запоминаем их высоту для CSS
  function setStick() {
    const hd = $('top'), fl = document.querySelector('#view-board .filters'), r = document.documentElement.style;
    r.setProperty('--hh', (hd && !hd.hidden ? hd.offsetHeight : 0) + 'px');
    r.setProperty('--fh', (fl && fl.offsetParent ? fl.offsetHeight : 0) + 'px');
  }
  window.addEventListener('resize', setStick);
  function fitGrid() {
    setStick();
    document.querySelectorAll('#boardOut .tablewrap, #staffOut .tablewrap, #ratesOut .tablewrap').forEach(w => {
      const top = Math.max(0, w.getBoundingClientRect().top);
      w.style.maxHeight = Math.max(220, window.innerHeight - top - 12) + 'px';
    });
  }
  function updateBar() {
    const n = Object.values(draft).filter(d => d.eventServiceId > 0).length;
    $('draftbar').hidden = !n || !canEdit();
    $('draftN').textContent = n;
    fitGrid();
  }

  // ---------- «Отправить назначение»: серые (созданные, но не отправленные сотруднику) уходят в BMS как кнопкой «Отправить» в самом BMS
  const greyOf = rows => rows.filter(r => !r.cancelled && !r.planned).flatMap(r => Object.values(r.slots).flat()
    .filter(s => s.employee && s.assignmentId && s.status === 'not_appointed').map(s => ({ id: s.assignmentId, who: s.employee.name, role: s.roleName })));
  async function notifyAssignments(list) {
    if (!list.length || !canEdit()) return;
    const sample = list.slice(0, 10).map(x => `${x.who} (${x.role})`).join('\n') + (list.length > 10 ? `\n…и ещё ${list.length - 10}` : '');
    if (!confirm(`Отправить назначения в BMS: ${list.length}?\nСотрудники получат уведомление.\n\n${sample}`)) return;
    let sent = 0; const failed = [];
    for (let i = 0; i < list.length; i += 30) {
      try { const r = await api('/api/notify', { method: 'POST', body: { ids: list.slice(i, i + 30).map(x => x.id) } }); sent += r.sent.length; failed.push(...r.failed); }
      catch (e) { failed.push({ error: e.message }); break; }
    }
    toast(`Отправлено: ${sent}` + (failed.length ? `. Не удалось: ${failed.length} (${failed[0].error})` : ''), failed.length > 0);
    candCache.clear(); try { await loadBoard(true, true); } catch (e) { /* ok */ }
  }
  const dayNotifyBtn = rows => {
    const g = greyOf(rows);
    return g.length && canEdit() ? h('button', { class: 'daysend', title: 'Отправить сотрудникам все назначения этого дня, которые ещё не отправлены',
      onclick: e => { e.stopPropagation(); notifyAssignments(g); } }, `✉ отправить серые (${g.length})`) : null;
  };

  // ---------- подписи мероприятия: «отмена», город · вид спорта · …, информация из BMS, паровозик (командировка)
  const metaLine = r => [r.start && (r.start + (r.end ? '–' + r.end : '')), r.city, r.sport, r.league, r.service, ...(r.additional || [])].filter(Boolean).join(' · ');
  const cancelTag = r => (r.cancelled ? h('span', { class: 'canceltag', title: r.serviceStatus }, 'отмена') : null);
  const infoNode = r => (r.info ? h('div', { class: 'info', title: r.info }, r.info) : null);
  const tripKey = r => (r.planned ? 'p' + r.plan.id : 'e' + r.eventId);
  async function toggleTrip(r) {
    const key = tripKey(r), on = !S.trips[key];
    if (on) S.trips[key] = true; else delete S.trips[key];
    repaint();
    try { await api('/api/trips', { method: 'POST', body: { key, date: r.date, on } }); }
    catch (e) { if (on) delete S.trips[key]; else S.trips[key] = true; toast(e.message, true); repaint(); }
  }
  function tripBtn(r) {
    const on = !!S.trips[tripKey(r)];
    if (!on && !canEdit()) return null;
    return h('button', { class: 'tripbtn' + (on ? ' on' : ''), title: on ? 'Командировка: на этом мероприятии нужна. Нажмите, чтобы убрать' : 'Поставить паровозик: на этом мероприятии будет командировка',
      onclick: e => { e.stopPropagation(); if (canEdit()) toggleTrip(r); } }, '🚂');
  }

  // ---------- мероприятия-черновики: событие уже известно, а в BMS его ещё нет
  // Живут на сервере (видны всем). Когда мероприятие появится в BMS, в блоке вписывают его ID —
  // и вписанные в черновике люди переносятся в настоящий блок на свободные места тех же ролей.
  const planKey = (p, s) => (-p.id) + ':' + s.sid;
  function planRow(p) {
    const slots = {}; COLS.forEach(([k]) => { slots[k] = []; });
    for (const s of p.slots) (slots[s.group] || slots.other).push({ lineId: s.sid, assignmentId: null, roleId: s.roleId, roleName: s.roleName, badges: [], employee: null, status: '', hasRate: null, logistics: null, expenseId: null, additionalIds: [] });
    return { eventServiceId: -p.id, eventId: null, date: p.date, start: p.start, end: p.end, league: p.league, city: p.city || '', sport: p.sport || '', info: p.info || '', title: p.title, service: p.service,
      cancelled: false, serviceStatus: '', additionalServices: [], additional: [], slots, contractor: null, planned: true, plan: p,
      stats: { total: p.slots.length, filled: 0, accepted: 0, declined: 0, noRate: 0, cameras: 0, camerasFilled: 0 } };
  }
  function findRow(p, rows) {
    if (!p.bmsId) return null;
    const bySvc = rows.find(r => r.eventServiceId === p.bmsId);
    if (bySvc) return bySvc;
    const byEv = rows.filter(r => r.eventId === p.bmsId);
    return byEv.find(r => r.service === p.service) || byEv[0] || null;
  }
  function mergePlans(raw) {
    const rows = raw.days.flatMap(d => d.rows);
    const days = raw.days.map(d => ({ date: d.date, rows: [...d.rows] }));
    const leagues = new Set(raw.leagues);
    for (const p of S.plans) {
      if (findRow(p, rows) && !S.linkFail.has(p.id)) continue;      // уже есть в BMS — блок заменит настоящий
      let day = days.find(d => d.date === p.date);
      if (!day) { day = { date: p.date, rows: [] }; days.push(day); }
      day.rows.push(planRow(p));
      if (p.league) leagues.add(p.league);
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    for (const d of days) d.rows = d.rows.map((r, i) => [r, i]).sort((a, b) => (a[0].start || '').localeCompare(b[0].start || '') || (a[0].planned ? 1 : 0) - (b[0].planned ? 1 : 0) || a[1] - b[1]).map(x => x[0]);
    return { ...raw, days, leagues: [...leagues].sort() };
  }
  function repaint() { if (S.boardRaw) { S.board = mergePlans(S.boardRaw); renderBoard(); } }

  function planBar(r) {
    const p = r.plan;
    const inp = h('input', { class: 'planid', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'ID BMS', value: p.bmsId || '',
      title: 'Когда мероприятие появится в BMS, впишите сюда его ID (мер. или усл.) — состав перенесётся в настоящий блок' });
    if (!canEdit()) inp.disabled = true;
    const save = () => {
      const v = inp.value.trim(), n = v ? Number(v) : null;
      if (v && !(Number.isInteger(n) && n > 0)) { toast('ID — это число', true); inp.value = p.bmsId || ''; return; }
      if ((p.bmsId || null) !== n) { S.linkFail.delete(p.id); savePlan({ ...p, bmsId: n }); }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', save);
    const note = p.bmsId ? (S.linkFail.has(p.id) ? 'не все места перенесены' : 'в BMS не найдено') : '';
    return h('div', { class: 'planbar' },
      h('span', { class: 'ptag' }, 'черновик мероприятия'),
      h('label', { class: 'pid' }, 'ID BMS ', inp),
      note ? h('span', { class: 'pnote', title: S.linkFail.has(p.id) ? 'В настоящем блоке не хватило свободных мест нужных ролей' : 'Этого ID нет в загруженном месяце / услугах доски. Проверьте номер или включите «все услуги и лиги»' }, note) : null,
      canEdit() ? h('button', { class: 'pbtn', title: 'Изменить мероприятие и состав', onclick: e => { e.stopPropagation(); openPlanModal(p); } }, '✎') : null,
      canEdit() ? h('button', { class: 'pbtn', title: 'Удалить мероприятие-черновик', onclick: e => { e.stopPropagation(); delPlan(p); } }, '🗑') : null);
  }
  async function savePlan(plan) {
    try {
      const d = await api('/api/plans', { method: 'POST', body: plan });
      const i = S.plans.findIndex(x => x.id === d.plan.id);
      if (i >= 0) S.plans[i] = d.plan; else S.plans.push(d.plan);
      repaint(); linkPlans();
      return d.plan;
    } catch (e) { toast(e.message, true); repaint(); return null; }
  }
  async function delPlan(p) {
    const n = p.slots.filter(s => draft[planKey(p, s)]).length;
    if (!confirm(`Удалить мероприятие-черновик «${p.title}»?` + (n ? `\nВписанные в нём люди (${n}) тоже пропадут.` : ''))) return;
    try { await api('/api/plans/delete', { method: 'POST', body: { id: p.id } }); } catch (e) { toast(e.message, true); return; }
    S.plans = S.plans.filter(x => x.id !== p.id);
    p.slots.forEach(s => { delete draft[planKey(p, s)]; });
    repaint(); updateBar(); poll(true);
  }

  // перенос состава в настоящий блок, когда ID найден в BMS
  let linking = false;
  const linkWarned = new Set();
  async function linkPlans() {
    if (linking || !canEdit() || !S.boardRaw) return;
    const rows = S.boardRaw.days.flatMap(d => d.rows);
    const todo = S.plans.filter(p => findRow(p, rows));
    if (!todo.length) return;
    linking = true;
    try {
      for (const p of todo) {
        const row = findRow(p, rows), real = Object.values(row.slots).flat(), used = new Set(), left = [];
        for (const s of p.slots) {
          const k = planKey(p, s), d = draft[k]; if (!d) continue;
          if (real.some(x => x.roleId === s.roleId && x.employee && x.employee.id === d.employeeId)) { await dropDrafts([k]); continue; }   // этот человек уже назначен в BMS
          const free = real.find(x => x.roleId === s.roleId && !x.employee && !used.has(x.lineId) && !draft[keyOf(row, x)]);
          if (!free) { left.push(`${s.roleName}: ${d.employeeName}`); continue; }
          used.add(free.lineId);
          await putDraft({ eventServiceId: row.eventServiceId, lineId: free.lineId, roleId: free.roleId, roleName: free.roleName, date: row.date, title: row.title,
            employeeId: d.employeeId, employeeName: d.employeeName, state: d.state || 'free', additionalIds: [], additionalNames: [], replaceAssignmentId: null, prevName: '' });
          await dropDrafts([k]);
        }
        if (left.length) {
          S.linkFail.add(p.id);
          if (!linkWarned.has(p.id)) { linkWarned.add(p.id); toast(`«${p.title}»: в BMS не нашлось свободных мест для: ${left.join(', ')}`, true); }
          continue;
        }
        S.linkFail.delete(p.id);
        const o = S.order[p.date];
        if (Array.isArray(o) && p.date === row.date) {
          let hit = false;
          const sw = x => { if (x === -p.id) { hit = true; return row.eventServiceId; } return x; };
          const nw = o.map(c => Array.isArray(c) ? c.map(sw) : sw(c));
          if (hit) await saveLayout(p.date, nw);
        }
        if (S.trips['p' + p.id] && row.eventId) {          // паровозик переезжает на настоящее мероприятие
          S.trips['e' + row.eventId] = true; delete S.trips['p' + p.id];
          await api('/api/trips', { method: 'POST', body: { key: 'e' + row.eventId, date: row.date, on: true } });
        }
        await api('/api/plans/delete', { method: 'POST', body: { id: p.id } });
        S.plans = S.plans.filter(x => x.id !== p.id);
        toast(`«${p.title}» найдено в BMS — состав перенесён в настоящий блок`);
      }
    } catch (e) { toast('Не удалось перенести состав: ' + e.message, true); }
    finally { linking = false; }
    repaint(); updateBar();
  }

  const TPL_KEY = 'bms_plan_tpl';
  function openPlanModal(plan) {
    const go = async () => {
      let lines;
      try { lines = S.lines || (S.lines = (await api('/api/lines')).lines); } catch (e) { toast('Не удалось загрузить роли: ' + e.message, true); return; }
      let tpl = null; try { tpl = JSON.parse(localStorage.getItem(TPL_KEY) || 'null'); } catch (e) { /* ok */ }
      const order = COLS.map(([k]) => k);
      const sorted = [...lines].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name, 'ru'));
      const firstOf = {}; sorted.forEach(l => { if (!(l.group in firstOf)) firstOf[l.group] = l.id; });
      const def = l => plan ? plan.slots.filter(s => s.roleId === l.id).length
        : (tpl && String(l.id) in tpl ? tpl[l.id] : (l.group !== 'other' && firstOf[l.group] === l.id ? (l.group === 'cam' ? 4 : 1) : 0));
      const today = iso(new Date());
      const f = {
        title: h('input', { type: 'text', placeholder: 'Например: Динамо — Спартак', value: plan ? plan.title : '' }),
        date: h('input', { type: 'date', value: plan ? plan.date : (today.slice(0, 7) === S.month ? today : S.month + '-01') }),
        start: h('input', { type: 'time', value: plan ? plan.start : '' }),
        end: h('input', { type: 'time', value: plan ? plan.end : '' }),
        league: h('input', { type: 'text', placeholder: 'КХЛ', value: plan ? plan.league : '', list: 'leagueList' }),
        city: h('input', { type: 'text', placeholder: 'Москва', value: plan ? plan.city || '' : '' }),
        sport: h('input', { type: 'text', placeholder: 'Хоккей', value: plan ? plan.sport || '' : '' }),
        info: h('input', { type: 'text', placeholder: 'Коротко: что за мероприятие', value: plan ? plan.info || '' : '' }),
        service: h('select', null, h('option', null, 'Прямая трансляция'), h('option', null, 'Студия')),
        bms: h('input', { type: 'text', inputmode: 'numeric', placeholder: 'пусто — пока нет в BMS', value: plan && plan.bmsId ? plan.bmsId : '' }),
      };
      if (plan) f.service.value = plan.service;
      const cnt = {};
      const roleBox = h('div', { class: 'rolegrid' });
      for (const l of sorted) {
        cnt[l.id] = h('input', { type: 'number', min: 0, max: 12, value: def(l) });
        roleBox.append(h('label', null, cnt[l.id], ' ', l.name));
      }
      const row = (label, el) => h('label', { class: 'frow' }, h('span', null, label), el);
      const save = h('button', { class: 'primary', onclick: async () => {
        const slots = []; const removed = [];
        let sid = plan ? Math.max(0, ...plan.slots.map(s => s.sid)) : 0;
        const tplOut = {};
        for (const l of sorted) {
          const want = Math.max(0, Math.min(12, Number(cnt[l.id].value) || 0)); tplOut[l.id] = want;
          const have = plan ? plan.slots.filter(s => s.roleId === l.id) : [];
          have.slice(0, want).forEach(s => slots.push(s)); removed.push(...have.slice(want));
          for (let i = have.length; i < want; i++) slots.push({ sid: ++sid, roleId: l.id, roleName: l.name, group: l.group });
        }
        if (plan) plan.slots.filter(s => !lines.some(l => l.id === s.roleId)).forEach(s => slots.push(s));
        const bms = f.bms.value.trim();
        if (bms && !/^\d+$/.test(bms)) { toast('ID BMS — это число', true); return; }
        save.disabled = true;
        const body = { id: plan ? plan.id : undefined, title: f.title.value, date: f.date.value, start: f.start.value, end: f.end.value, league: f.league.value, city: f.city.value, sport: f.sport.value, info: f.info.value, service: f.service.value, bmsId: bms ? Number(bms) : null, slots };
        const saved = await savePlan(body);
        save.disabled = false;
        if (!saved) return;
        try { localStorage.setItem(TPL_KEY, JSON.stringify(tplOut)); } catch (e) { /* ok */ }
        closeModal();
        if (plan) {
          if (removed.length) dropDrafts(removed.map(s => planKey(plan, s)));
          if (plan.date !== saved.date || plan.title !== saved.title)      // у вписанных людей обновляем дату и название
            for (const s of saved.slots) { const d = draft[planKey(saved, s)]; if (d) putDraft({ ...d, date: saved.date, title: saved.title }); }
        }
      } }, plan ? 'Сохранить' : 'Создать');
      $('mTitle').textContent = plan ? 'Мероприятие-черновик' : 'Новое мероприятие-черновик';
      $('mBody').replaceChildren(
        h('p', { class: 'muted' }, 'Мероприятие, которого ещё нет в BMS. Вписывайте людей как обычно; когда оно появится в BMS — впишите его ID в блоке, и состав перенесётся.'),
        h('div', { class: 'planform' }, row('Название', f.title), row('Дата', f.date), row('Начало', f.start), row('Конец', f.end), row('Лига', f.league), row('Город', f.city), row('Вид спорта', f.sport), row('Информация', f.info), row('Услуга', f.service), row('ID BMS', f.bms)),
        h('datalist', { id: 'leagueList' }, ...((S.board && S.board.leagues) || []).map(l => h('option', { value: l }))),
        h('div', { class: 'muted', style: 'margin:8px 0 4px' }, 'Сколько человек нужно по ролям:'), roleBox,
        h('div', { style: 'margin-top:10px' }, save));
      $('modal').hidden = false; f.title.focus();
    };
    go();
  }

  // ---------- доска
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(sessionStorage.getItem('bms_collapsed') || '[]')); } catch (e) { /* ok */ }
  const saveCollapsed = () => { try { sessionStorage.setItem('bms_collapsed', JSON.stringify([...collapsed])); } catch (e) { /* ok */ } };
  function rowMatches(r, f) {
    if (f.league && r.league !== f.league) return false;
    if (f.gaps && r.stats.filled >= r.stats.total) return false;
    if (f.problems && !(r.stats.declined || r.stats.noRate)) return false;
    if (f.pending && !Object.values(r.slots).flat().some(x => x.employee && x.status === 'pending' && !CONTRACTOR_RE.test(x.employee.name))) return false;   // есть неподтверждённые (жёлтые)
    if (f.q) {
      const hay = lower([r.title, r.league, r.city, r.sport, r.info, ...Object.values(r.slots).flat().map(s => s.employee && s.employee.name)].join(' '));
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }
  // если месяц целиком не загрузился из-за сети — грузим понедельно: ответы маленькие и не рвутся
  async function fetchBoard(q) {
    try { return await api('/api/board', { query: q }); }
    catch (e) {
      if (!e.network) throw e;
      const day = 864e5, parts = [];
      for (let d = new Date(q.from + 'T00:00:00Z'); iso(d) <= q.to; d = new Date(d.getTime() + 7 * day)) {
        const b = iso(new Date(d.getTime() + 6 * day));
        parts.push({ ...q, from: iso(d), to: b < q.to ? b : q.to });
      }
      const res = [];
      for (const pq of parts) res.push(await api('/api/board', { query: pq }));
      banner('Сеть нестабильна: доска загружена по неделям. Если так всегда — проверьте VPN, блокировщики или смените сеть.');
      return { days: res.flatMap(x => x.days), leagues: [...new Set(res.flatMap(x => x.leagues))].sort(), total: res.reduce((n, x) => n + x.total, 0),
        stale: res.some(x => x.stale), generatedAt: Math.min(...res.map(x => x.generatedAt || Date.now())) };
    }
  }
  let boardReq = 0, staleRetries = 0;
  async function loadBoard(silent, fresh) {
    const my = ++boardReq, month = S.month, all = S.all;
    const q = { ...range() }; if (all) q.all = '1'; if (fresh) q.fresh = '1';
    const data = await fetchBoard(q);
    if (my !== boardReq || month !== S.month || all !== S.all) return;   // пока ждали — переключили месяц: старый ответ выбрасываем
    lastBoardAt = Date.now();
    try { S.order = (await api('/api/order', { query: { ...range() } })).orders || {}; } catch (e) { /* порядок необязателен */ }
    try { const pl = await api('/api/plans', { query: { ...range() } }); S.plans = pl.plans || []; S.trips = {}; (pl.trips || []).forEach(k => { S.trips[k] = true; }); } catch (e) { /* черновики и паровозики необязательны */ }
    if (my !== boardReq || month !== S.month || all !== S.all) return;
    S.boardRaw = data; S.board = mergePlans(data); renderBoard();
    linkPlans();
    if (data.generatedAt) {
      const t = new Date(data.generatedAt).toLocaleTimeString('ru-RU');
      $('live').title = `Общая доска. Данные BMS от ${t}` + (data.meta ? ` · ${data.meta.items} записей, ${(data.meta.fetchMs / 1000).toFixed(1)} с на загрузку из BMS` : '');
    }
    // сервер отдал снимок и обновляет его в фоне — через пару секунд заберём свежий
    if (data.stale && staleRetries < 6) { staleRetries++; setTimeout(() => { if (month === S.month && S.tab === 'board' && !editingNow()) loadBoard(true); }, 4000); }
    else if (!data.stale) staleRetries = 0;
    if (!silent) poll(true);
  }

  // ---------- блочный вид: карточки мероприятий внутри дня, порядок можно менять перетаскиванием
  // раскладка дня: колонки блоков. Сохранённая раскладка — массив колонок [[id…],[id…]];
  // новые мероприятия и старый плоский порядок раскладываются «кирпичной кладкой» по самой короткой колонке
  const cardHeight = r => 3 + (r.contractor ? 2 : 0) + Object.values(r.slots).reduce((n, a) => n + a.length, 0) * (r.contractor ? 0.25 : 1);
  function layoutCols(date, rows, ncols) {
    const saved = S.order[date];
    const byId = new Map(rows.map(r => [r.eventServiceId, r]));
    const cols = [], seen = new Set();
    if (Array.isArray(saved) && saved.length && Array.isArray(saved[0])) {
      for (const c of saved) {
        const col = c.map(id => byId.get(id)).filter(Boolean);
        col.forEach(r => seen.add(r.eventServiceId));
        if (col.length) cols.push(col);
      }
    }
    let rest = rows.filter(r => !seen.has(r.eventServiceId));
    if (Array.isArray(saved) && saved.length && !Array.isArray(saved[0])) {       // старый плоский порядок
      const pos = new Map(saved.map((id, i) => [id, i]));
      rest = rest.map((r, i) => [r, i]).sort((x, y) => (pos.has(x[0].eventServiceId) ? pos.get(x[0].eventServiceId) : 1e6 + x[1]) - (pos.has(y[0].eventServiceId) ? pos.get(y[0].eventServiceId) : 1e6 + y[1])).map(x => x[0]);
    }
    const n = Math.max(1, ncols);
    const heights = cols.map(c => c.reduce((a, r) => a + cardHeight(r), 0));
    for (const r of rest) {
      if (cols.length < n) { cols.push([r]); heights.push(cardHeight(r)); continue; }
      const i = heights.indexOf(Math.min(...heights));
      cols[i].push(r); heights[i] += cardHeight(r);
    }
    return cols.filter(c => c.length);
  }
  let dragId = null, dragDate = null;
  async function saveLayout(date, cols) {
    S.order[date] = cols;
    try { await api('/api/order', { method: 'POST', body: { date, ids: cols } }); }
    catch (e) { toast('Не удалось сохранить раскладку: ' + e.message, true); }
  }
  function collectLayout(blocks) {
    return [...blocks.querySelectorAll('.bcol')].map(c => [...c.querySelectorAll(':scope > .bcard')].map(x => Number(x.dataset.es))).filter(a => a.length);
  }
  function dropInto(blocks, date, moving, col, ref, after) {
    if (ref) col.insertBefore(moving, after ? ref.nextSibling : ref); else col.append(moving);
    blocks.querySelectorAll('.bcol').forEach(c => { if (!c.querySelector('.bcard') && !c.classList.contains('newcol')) c.remove(); });
    saveLayout(date, collectLayout(blocks));
  }
  function blockCard(r, f) {
    const camIdx = {};
    const lines = [];
    const sameCon = k => r.contractor && k !== 'vr' && r.slots[k].length && r.slots[k].every(s => s.employee && s.employee.name === r.contractor.name && !draft[keyOf(r, s)]);
    let conShown = false;
    for (const [k, label] of COLS) {
      const sl = r.slots[k]; if (!sl.length) continue;
      if (sameCon(k)) {
        if (!conShown) { conShown = true; lines.push(h('div', { class: 'brow' }, h('span', { class: 'bl' }, 'Подрядчик'), h('div', { class: 'slot' }, h('span', { class: 'chip contractor' }, r.contractor.name)))); }
        continue;
      }
      sl.forEach((s, i) => lines.push(h('div', { class: 'brow' }, h('span', { class: 'bl' }, sl.length > 1 ? label + ' ' + (i + 1) : label), slotNode(r, s))));
    }
    const full = r.stats.filled >= r.stats.total;
    const canDrag = canEdit();
    const head = h('div', { class: 'bhead', draggable: canDrag ? 'true' : null, title: canDrag ? 'Перетащите, чтобы поменять порядок внутри даты' : '' },
      h('div', { class: 't' }, (canDrag ? '⠿ ' : ''), cancelTag(r), r.title || '—', tripBtn(r)),
      h('div', { class: 'm' }, metaLine(r)),
      infoNode(r),
      r.planned ? planBar(r) : h('div', { class: 'ids' }, 'мер. ' + r.eventId + ' · усл. ' + r.eventServiceId, h('span', { class: 'stat' + (full ? ' full' : '') }, ` ${r.stats.filled}/${r.stats.total}`)));
    const card = h('div', { class: 'bcard' + (r.cancelled ? ' cancelled' : '') + (r.planned ? ' planned' : ''), 'data-es': r.eventServiceId, 'data-date': r.date }, head, ...lines);
    if (canDrag) {
      head.addEventListener('dragstart', ev => { dragId = r.eventServiceId; dragDate = r.date; card.classList.add('dragging'); card.closest('.blocks').classList.add('dragmode'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(dragId)); } catch (e) {} });
      head.addEventListener('dragend', () => { card.classList.remove('dragging'); const bl = card.closest('.blocks'); if (bl) bl.classList.remove('dragmode'); document.querySelectorAll('.bcard.over-t,.bcard.over-b,.bcol.over').forEach(c => c.classList.remove('over-t', 'over-b', 'over')); dragId = null; });
      card.addEventListener('dragover', ev => {
        if (!dragId || dragDate !== r.date || dragId === r.eventServiceId) return;
        ev.preventDefault(); ev.stopPropagation();
        const rect = card.getBoundingClientRect(), top = ev.clientY < rect.top + rect.height / 2;
        card.classList.toggle('over-t', top); card.classList.toggle('over-b', !top);
      });
      card.addEventListener('dragleave', () => card.classList.remove('over-t', 'over-b'));
      card.addEventListener('drop', ev => {
        ev.preventDefault(); ev.stopPropagation();
        card.classList.remove('over-t', 'over-b');
        if (!dragId || dragDate !== r.date || dragId === r.eventServiceId) return;
        const blocks = card.closest('.blocks');
        const moving = blocks.querySelector(`.bcard[data-es="${dragId}"]`); if (!moving) return;
        const rect = card.getBoundingClientRect();
        dropInto(blocks, r.date, moving, card.parentNode, card, ev.clientY >= rect.top + rect.height / 2);
      });
    }
    return card;
  }
  function renderBlocks() {
    hidePop();
    const wy = window.scrollY, box = $('boardOut');
    const f = { q: lower($('q').value.trim()), league: $('league').value, gaps: $('onlyGaps').checked, problems: $('onlyProblems').checked, pending: $('onlyPending').checked };
    const sel = $('league'), cur = sel.value;
    if (sel.options.length - 1 !== S.board.leagues.length) {
      sel.replaceChildren(h('option', { value: '' }, 'Все лиги'), ...S.board.leagues.map(l => h('option', { value: l }, l)));
      sel.value = cur;
    }
    const out = []; let shown = 0; const stale = [];
    for (const day of S.board.days) {
      const rows = day.rows.filter(r => rowMatches(r, f));
      if (!rows.length) continue;
      shown += rows.length;
      const isCol = collapsed.has(day.date);
      out.push(h('div', { class: 'dayrow bday' + (isCol ? ' collapsed' : ''), title: isCol ? 'Развернуть день' : 'Свернуть день',
        onclick: () => { if (collapsed.has(day.date)) collapsed.delete(day.date); else collapsed.add(day.date); saveCollapsed(); renderBoard(); } },
      h('span', { class: 'tg' }, isCol ? '▸' : '▾'), ' ', fmtDay(day.date), ' · ', rows.length, dayNotifyBtn(rows)));
      if (isCol) continue;
      for (const r of rows) for (const k of Object.keys(r.slots)) for (const s of r.slots[k]) if (draft[keyOf(r, s)] && isStale(draft[keyOf(r, s)], s)) stale.push(keyOf(r, s));
      const ncols = Math.max(1, Math.floor(((box.clientWidth || window.innerWidth) + 10) / 280));
      const blocks = h('div', { class: 'blocks', 'data-date': day.date });
      const mkCol = (cls) => {
        const col = h('div', { class: 'bcol' + (cls ? ' ' + cls : '') });
        col.addEventListener('dragover', ev => { if (dragId && dragDate === day.date) { ev.preventDefault(); col.classList.add('over'); } });
        col.addEventListener('dragleave', ev => { if (ev.target === col) col.classList.remove('over'); });
        col.addEventListener('drop', ev => {
          ev.preventDefault(); col.classList.remove('over');
          if (!dragId || dragDate !== day.date) return;
          const moving = blocks.querySelector(`.bcard[data-es="${dragId}"]`); if (!moving) return;
          if (col.classList.contains('newcol')) { col.classList.remove('newcol'); col.append(moving); const nc = mkCol('newcol'); nc.append(h('span', { class: 'hint' }, '＋ новая колонка')); blocks.append(nc); blocks.querySelectorAll('.bcol').forEach(c => { if (!c.querySelector('.bcard') && !c.classList.contains('newcol')) c.remove(); }); saveLayout(day.date, collectLayout(blocks)); }
          else dropInto(blocks, day.date, moving, col, null, false);
        });
        return col;
      };
      for (const colRows of layoutCols(day.date, rows, ncols)) { const col = mkCol(); col.append(...colRows.map(r => blockCard(r, f))); blocks.append(col); }
      if (canEdit()) { const nc = mkCol('newcol'); nc.append(h('span', { class: 'hint' }, '＋ новая колонка')); blocks.append(nc); }
      out.push(blocks);
    }
    box.replaceChildren(shown ? h('div', { class: 'blockwrap' }, ...out) : h('p', { class: 'muted' }, 'Ничего не найдено за выбранный месяц.'));
    window.scrollTo(0, wy);
    if (stale.length && canEdit()) dropDrafts([...new Set(stale)]);
    updateBar();
  }

  function renderBoard() {
    if (S.view === 'blocks') return renderBlocks();
    hidePop();
    const wrapOld = document.querySelector('#boardOut .tablewrap');
    const sc = wrapOld ? [wrapOld.scrollLeft, wrapOld.scrollTop] : null, wy = window.scrollY;
    const f = { q: lower($('q').value.trim()), league: $('league').value, gaps: $('onlyGaps').checked, problems: $('onlyProblems').checked, pending: $('onlyPending').checked };
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
      h('td', { colspan: used.length + 2 }, h('span', { class: 'tg' }, isCol ? '▸' : '▾'), ' ', fmtDay(day.date), ' · ', rows.length, dayNotifyBtn(rows))));
      if (isCol) { shown += rows.length; continue; }
      for (const r of rows) {
        shown++;
        for (const k of Object.keys(r.slots)) for (const s of r.slots[k]) if (draft[keyOf(r, s)] && isStale(draft[keyOf(r, s)], s)) stale.push(keyOf(r, s));
        const full = r.stats.filled >= r.stats.total;
        tbody.append(h('tr', { class: (r.cancelled ? 'cancelled' : '') + (r.planned ? ' planned' : '') },
          h('td', { class: 'ev' },
            h('div', { class: 't' }, cancelTag(r), r.title || '—', tripBtn(r)),
            h('div', { class: 'm' }, metaLine(r)),
            infoNode(r),
            r.planned ? planBar(r) : h('div', { class: 'ids' }, h('span', { title: 'ID мероприятия' }, 'мер. ' + r.eventId), ' · ', h('span', { title: 'ID услуги' }, 'усл. ' + r.eventServiceId)),
            r.contractor ? h('span', { class: 'chip contractor' }, 'подрядчик ' + r.contractor.name) : null),
          ...used.map(([k]) => {
            const sl = r.slots[k];
            const one = r.contractor && k !== 'vr' && sl.length > 1 && sl.every(s => s.employee && s.employee.name === r.contractor.name && !draft[keyOf(r, s)]);
            if (!one) return h('td', { class: 'g' }, ...sl.map(s => slotNode(r, s)));
            return h('td', { class: 'g' }, h('div', { class: 'slot' }, h('span', { class: 'chip contractor', title: 'Все ' + sl.length + ' юнита — у подрядчика' }, sl[0].employee.name + ' ×' + sl.length)));
          }),
          h('td', { class: 'stat' + (full ? ' full' : '') }, r.planned ? '—' : `${r.stats.filled}/${r.stats.total}`, r.stats.declined ? ` · отказ ${r.stats.declined}` : '')));
      }
    }
    $('boardOut').replaceChildren(shown
      ? h('div', { class: 'tablewrap grid' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Мероприятие'), ...used.map(([, l]) => h('th', null, l)), h('th', null, 'Комплект'))), tbody))
      : h('p', { class: 'muted' }, 'Ничего не найдено за выбранный месяц.'));
    fitGrid();     // сначала высота окна таблицы — иначе scrollTop обрежется до 0
    const wn = document.querySelector('#boardOut .tablewrap');
    if (sc && wn) { wn.scrollLeft = sc[0]; wn.scrollTop = sc[1]; }
    window.scrollTo(0, wy);
    if (stale.length && canEdit()) dropDrafts([...new Set(stale)]);
    updateBar();
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
    } catch (e) {
      $('live').textContent = '● нет связи'; $('live').classList.add('off');
      const why = e && e.status ? `Сервер ответил ${e.status}: ${e.message}` : 'Браузер не достучался до сервера: ' + (e && e.message ? e.message : e) + ' (' + CFG.API_URL + ')';
      $('live').title = why;
      if (e && e.status === 403) banner(e.message);
      try { console.warn('poll failed:', why); } catch (x) { /* ok */ }
    }
    finally { polling = false; }
  }

  // ---------- отправка в BMS
  // шаг 1: выбор дат, которые синхронизируем с BMS
  function sendDraft() {
    const all = Object.entries(draft).filter(([k, d]) => !inflight.has(k) && d.eventServiceId > 0);   // черновики мероприятий без ID BMS не отправляются
    if (!all.length) return;
    const dates = [...new Set(all.map(([, d]) => d.date))].sort();
    const boxes = dates.map(dt => {
      const n = all.filter(([, d]) => d.date === dt).length;
      const cb = h('input', { type: 'checkbox' }); cb.checked = true; cb.dataset.date = dt;
      return [dt, n, cb];
    });
    const sum = h('div', { class: 'muted' });
    const upd = () => {
      const sel = boxes.filter(([, , c]) => c.checked);
      const n = sel.reduce((a, [, k]) => a + k, 0);
      sum.textContent = `Будет отправлено назначений: ${n}. В BMS они появятся со статусом «ожидает» (серым), со ставками и допуслугами.`;
      go.disabled = !n; go.textContent = `Отправить в BMS (${n})`;
    };
    const go = h('button', { class: 'primary', onclick: () => {
      const set = new Set(boxes.filter(([, , c]) => c.checked).map(([dt]) => dt));
      closeModal(); runSend(all.filter(([, d]) => set.has(d.date)));
    } }, 'Отправить в BMS');
    boxes.forEach(([, , c]) => c.addEventListener('change', upd));
    $('mTitle').textContent = 'Какие даты отправить в BMS?';
    $('mBody').replaceChildren(
      h('div', { style: 'margin-bottom:8px' },
        h('button', { onclick: () => { boxes.forEach(([, , c]) => c.checked = true); upd(); } }, 'Все'), ' ',
        h('button', { onclick: () => { boxes.forEach(([, , c]) => c.checked = false); upd(); } }, 'Ничего')),
      ...boxes.map(([dt, n, c]) => h('label', { style: 'display:block;padding:3px 0;cursor:pointer' }, c, ' ', fmtDay(dt), h('span', { class: 'muted' }, ` · назначений: ${n}`))),
      sum, h('div', { style: 'margin-top:10px' }, go));
    upd(); $('modal').hidden = false;
  }
  async function runSend(items) {
    if (!items.length) return;
    const odd = items.filter(([, d]) => d.state && d.state !== 'free').length;
    const repl = items.filter(([, d]) => d.replaceAssignmentId).length;
    if (odd || repl) { if (!confirm(`Отправить назначений: ${items.length}.` + (repl ? `\nЗамен: ${repl} (прежний исполнитель будет снят в BMS).` : '') + (odd ? `\nЗанятых / «не может»: ${odd}.` : ''))) return; }
    const btn = $('draftSend'); btn.disabled = true;
    const report = []; let i = 0;
    for (const [key, d] of items) {
      btn.textContent = `Отправка ${++i}/${items.length}…`;
      const label = `${fmtDay(d.date)} · ${d.title} · ${d.roleName}: ${d.employeeName}` + (d.prevName && d.replaceAssignmentId ? ` (вместо ${d.prevName})` : '') + (d.updateAssignmentId ? ' (изменение допуслуг)' : '') + (d.additionalNames && d.additionalNames.length ? ` [+${d.additionalNames.join(', ')}]` : '');
      try {
        const r = await api('/api/assign', { method: 'POST', body: { eventServiceId: d.eventServiceId, lineId: d.lineId, employeeId: d.employeeId, lineName: d.roleName, replaceAssignmentId: d.replaceAssignmentId || undefined, additionalIds: d.additionalIds || [], updateAssignmentId: d.updateAssignmentId || undefined, expenseId: d.expenseId || undefined, logistics: d.logistics || undefined } });
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
    if (!confirm('Удалить весь общий черновик? Он очистится у всех участников.\n(Составы мероприятий-черновиков без ID BMS останутся.)')) return;
    dropDrafts(Object.keys(draft).filter(k => draft[k].eventServiceId > 0)).then(() => syncCells());
  }
  function closeModal() { $('modal').hidden = true; }

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
  async function usersAct(kind, email, ask) {
    if (ask && !confirm(ask)) return;
    try { await api('/api/admin/users/' + kind, { method: 'POST', body: { email } }); toast(kind === 'approve' ? 'Доступ выдан: ' + email : 'Готово'); loadUsers(); }
    catch (e) { toast(e.message, true); }
  }
  async function loadUsers() {
    const d = await api('/api/admin/users');
    const reqs = Object.entries(d.requests || {}), users = Object.entries(d.users || {});
    const fmt = t => String(t || '').slice(0, 16).replace('T', ' ');
    const row = (cells, btns) => h('tr', null, ...cells.map(c => h('td', null, c)), h('td', null, ...btns));
    $('usersBox').replaceChildren(
      h('h3', null, 'Запросы на доступ' + (reqs.length ? ` (${reqs.length})` : '')),
      reqs.length ? h('table', { class: 'utable' }, ...reqs.map(([e, r]) => row([r.name || '—', e, fmt(r.at)], [
        h('button', { class: 'primary', onclick: () => usersAct('approve', e) }, 'Принять (админ)'), ' ',
        h('button', { onclick: () => usersAct('reject', e) }, 'Отклонить')])))
        : h('p', { class: 'muted' }, 'Новых запросов нет.'),
      h('h3', null, 'Пользователи с доступом'),
      h('table', { class: 'utable' },
        ...(d.owners || []).map(e => row(['Владелец', e, ''], [h('span', { class: 'muted' }, 'задан в настройках')])),
        ...users.map(([e, u]) => row([u.name || '—', e, 'принят ' + fmt(u.addedAt) + (u.addedBy ? ' · ' + u.addedBy : '')],
          [h('button', { onclick: () => usersAct('remove', e, 'Закрыть доступ для ' + e + '?') }, 'Закрыть доступ')]))));
  }
  async function loadAdmin() {
    loadUsers().catch(e => toast(e.message, true));
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
    $('addPlan').hidden = !canEdit();
    if (!S.month) { try { S.month = sessionStorage.getItem('bms_month'); } catch (e) { /* ok */ } }
    if (!S.month) S.month = curMonth();
    renderMonths(); showTab('board');
  }
  function bind() {
    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('reload').onclick = () => { candCache.clear(); refreshNow = true; reload(); };
    $('prev').onclick = () => setMonth(monthShift(S.month, -1)); $('next').onclick = () => setMonth(monthShift(S.month, 1));
    $('addUser').onclick = () => { const v = $('newUser').value.trim(); if (v) usersAct('approve', v).then(() => { $('newUser').value = ''; }); };
    const curTheme = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const paintTheme = () => { $('themeBtn').textContent = curTheme() === 'dark' ? '☀️' : '🌙'; $('themeBtn').title = curTheme() === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'; };
    $('themeBtn').onclick = () => { const n = curTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem('bms_theme', n); } catch (e) { /* ok */ } paintTheme(); };
    paintTheme();
    $('logout').onclick = logout; $('mClose').onclick = closeModal;
    $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
    ['q', 'league', 'onlyGaps', 'onlyProblems', 'onlyPending'].forEach(id => $(id).addEventListener('input', () => S.board && renderBoard()));
    $('allEvents').addEventListener('change', () => { S.all = $('allEvents').checked; S.board = S.boardRaw = null; reload(); });
    const setView = () => { $('viewToggle').textContent = S.view === 'blocks' ? '☷ Таблица' : '▦ Блоки'; };
    $('viewToggle').onclick = () => { S.view = S.view === 'blocks' ? 'table' : 'blocks'; try { localStorage.setItem('bms_view', S.view); } catch (e) {} setView(); if (S.board) renderBoard(); };
    setView();
    $('collapseAll').onclick = () => { (S.board ? S.board.days : []).forEach(d => collapsed.add(d.date)); saveCollapsed(); if (S.board) renderBoard(); };
    $('expandAll').onclick = () => { collapsed.clear(); saveCollapsed(); if (S.board) renderBoard(); };
    $('addPlan').onclick = () => openPlanModal(null);
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
