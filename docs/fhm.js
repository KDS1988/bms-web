(function () {
  'use strict';
  const { h, api, range, fmtDay, S, canEdit, toast } = window.APP;
  const $ = id => document.getElementById(id);
  const STATUS = {
    scheduled: ['Запланирован', ''], live: ['Идёт', 'appointed'], finished: ['Завершён', ''],
    postponed: ['Перенесён', 'pending'], cancelled: ['Отменён', 'declined'],
  };
  const HEADERS = ['Время (МСК)', 'Хозяева', 'Гости', 'Арена', 'Группа / тур', 'Статус'];
  const CREW_FIELDS = [['director', 'Реж'], ['operator', 'Опер'], ['stat', 'Стат'], ['commentator', 'Коммент']];
  const SCHEDULE_FIELDS = ['Начало', 'Конец', ...CREW_FIELDS.map(([, label]) => label)];
  const collapsed = { calendar: new Set(), schedule: new Set() };
  let calendar = null, period = null, view = 'calendar', crews = {};
  let request = 0;

  function dayLabel(date) { return date ? fmtDay(date) : 'Дата уточняется'; }

  function dayButton(date, text) {
    const state = collapsed[view], closed = state.has(date);
    return h('button', {
      type: 'button', 'aria-expanded': String(!closed), 'data-fhm-day': date,
      class: 'fhm-day-toggle', onclick: () => {
        if (closed) state.delete(date); else state.add(date);
        render();
        const button = [...$('fhmOut').querySelectorAll('[data-fhm-day]')].find(node => node.dataset.fhmDay === date);
        button?.focus({ preventScroll: true });
      },
    }, h('span', { 'aria-hidden': 'true' }, closed ? '▸' : '▾'), ' ', text);
  }

  function calendarContent(matches) {
    const days = new Map();
    for (const match of matches) {
      if (!days.has(match.date)) days.set(match.date, []);
      days.get(match.date).push(match);
    }
    return [...days].map(([date, items]) => {
      const rows = collapsed.calendar.has(date) ? null : items.map(match => {
        const [label, cls] = STATUS[match.status] || ['—', ''];
        return h('tr', null,
          h('td', null, match.time || '—'),
          h('td', null, match.home || '—'), h('td', null, match.away || '—'),
          h('td', null, match.venue || '—'),
          h('td', null, [match.group, match.tour].filter(Boolean).join(' · ') || '—'),
          h('td', null, h('span', { class: 'chip ' + cls }, label)));
      });
      return h('section', { class: 'fhm-day' },
        dayButton(date, `${dayLabel(date)} · матчей: ${items.length}`),
        rows ? h('div', { class: 'tablewrap fhm-table' },
          h('table', { 'aria-label': 'Матчи ФХМ · ' + dayLabel(date) },
            h('colgroup', null, ['13%', '20%', '20%', '24%', '13%', '10%'].map(width => h('col', { style: 'width:' + width }))),
            h('thead', null, h('tr', null, HEADERS.map(title => h('th', { scope: 'col' }, title)))),
            h('tbody', null, rows))) : null);
    });
  }

  const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', timeZone: 'UTC' });
  const DATE = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const MONTH = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  async function saveCrew(input, date, arena, field) {
    const session = S.token, value = input.value;
    const before = crews[date]?.[arena]?.[field] || '';
    if (value === before) return;
    input.disabled = true;
    try {
      const result = await api('/api/fhm/crew', { method: 'POST', body: { date, arena, field, value } });
      if (session === S.token) {
        input.value = result.value;
        const day = crews[date] ||= {};
        const crew = day[arena] ||= {};
        crew[field] = result.value;
      }
    } catch (e) {
      if (session === S.token) { input.value = before; toast(e.message, true); }
    } finally {
      input.disabled = false;
    }
  }

  function crewCell(arena, date, [field, label]) {
    const value = crews[date]?.[arena.key]?.[field] || '';
    const editable = canEdit() && arena.editable;
    return h('td', { class: 'fhm-crew-cell', title: value || null }, editable
      ? h('input', { type: 'text', value, maxlength: 80,
        'aria-label': `${label} · ${arena.name} · ${DATE.format(new Date(date))}`,
        onchange: event => saveCrew(event.currentTarget, date, arena.key, field),
        onkeydown: event => { if (event.key === 'Enter') event.currentTarget.blur(); },
      })
      : value);
  }

  function scheduleContent(schedule) {
    const { dates, rows, totals } = schedule;
    if (!rows.length) return h('p', { class: 'muted' }, 'Нет матчей для расписания.');
    const days = dates.map(date => ({
      date, closed: collapsed.schedule.has(date), total: totals.get(date),
    }));
    return h('div', { class: 'tablewrap fhm-schedule-wrap', tabindex: 0 },
      h('table', {
        class: 'fhm-schedule', 'aria-label': 'Расписание арен ФХМ',
        style: `--fhm-days: ${days.length}; --fhm-expanded: ${days.filter(day => !day.closed).length}`,
      },
        h('colgroup', null, h('col', { class: 'fhm-col-arena' }), h('col', { class: 'fhm-col-location' }), h('col', { class: 'fhm-col-total' })),
        days.map(day => h('colgroup', null, h('col', { class: 'fhm-col-count' }),
          day.closed ? null : SCHEDULE_FIELDS.map((_, i) => h('col', { class: i < 2 ? 'fhm-col-time' : 'fhm-col-crew' })))),
        h('thead', null,
          h('tr', { class: 'fhm-schedule-days' },
            h('th', { class: 'fhm-pin fhm-pin-arena', scope: 'col', rowspan: 2 }, 'Арена'),
            h('th', { class: 'fhm-pin fhm-pin-location', scope: 'col', rowspan: 2 }, 'Локация'),
            h('th', { class: 'fhm-pin fhm-pin-total', scope: 'col', rowspan: 2 }, 'Кол-во матчей'),
            days.map(({ date, closed, total }) => h('th', {
              class: 'fhm-day-start', scope: 'colgroup', colspan: closed ? 1 : 1 + SCHEDULE_FIELDS.length,
            }, dayButton(date, DATE.format(new Date(date))),
            !closed ? h('span', { class: 'fhm-weekday' }, WEEKDAY.format(new Date(date))) : null,
            h('small', { title: 'Одна бригада на строку арены с матчами' }, `Матчей: ${total?.matches || 0} · Бригад: ${total?.crews || 0}`)))),
          h('tr', { class: 'fhm-schedule-fields' }, days.flatMap(day => [
            h('th', { class: 'fhm-day-start', scope: 'col' }, 'Матчей'),
            ...(day.closed ? [] : SCHEDULE_FIELDS.map(label => h('th', { scope: 'col' }, label))),
          ]))),
        h('tbody', null, rows.map(arena => h('tr', null,
          h('th', { class: 'fhm-pin fhm-pin-arena', scope: 'row', title: arena.name }, arena.name || 'Арена уточняется'),
          h('td', { class: 'fhm-pin fhm-pin-location', title: arena.location }, arena.location || '—'),
          h('td', { class: 'fhm-pin fhm-pin-total' }, arena.count),
          days.flatMap(({ date, closed }) => {
            const day = arena.days.get(date);
            const count = h('td', { class: 'fhm-day-start fhm-count' }, day?.count || 0);
            if (closed) return [count];
            if (!day) return [count, ...SCHEDULE_FIELDS.map(() => h('td', { class: 'fhm-empty' }))];
            const end = window.FhmSchedule.endTime(day.finish);
            return [count, h('td', null, day.start), h('td', {
              title: day.finish >= 1440 ? 'Следующий день' : null,
            }, end), ...CREW_FIELDS.map(field => crewCell(arena, date, field))];
          }))))));
  }

  function setView(value) {
    view = value;
    document.querySelectorAll('[data-fhm-view]').forEach(button => {
      const active = button.dataset.fhmView === view;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function allDays(closed) {
    if (!calendar) return;
    const dates = view === 'schedule' ? window.FhmSchedule.buildSchedule([], period).dates : calendar.map(match => match.date);
    if (closed) dates.forEach(date => collapsed[view].add(date));
    else dates.forEach(date => collapsed[view].delete(date));
    render();
  }

  function render() {
    if (!calendar) return;
    const query = $('fhmSearch').value.trim().toLocaleLowerCase('ru');
    const matches = query ? calendar.filter(match => [match.home, match.away, match.venue, match.group, match.tour, match.location, match.year]
      .some(value => String(value ?? '').toLocaleLowerCase('ru').includes(query))) : calendar;
    const out = $('fhmOut');
    const schedule = view === 'schedule' ? window.FhmSchedule.buildSchedule(matches, period) : null;
    $('fhmCollapse').disabled = $('fhmExpand').disabled = schedule ? !schedule.rows.length : !matches.length;
    if (schedule) {
      $('fhmStatus').textContent = MONTH.format(new Date(period.from)) + ' · арен: ' + schedule.rows.length;
      const old = out.querySelector('.fhm-schedule-wrap');
      out.replaceChildren(scheduleContent(schedule));
      const wrap = out.querySelector('.fhm-schedule-wrap');
      if (old && wrap) { wrap.scrollLeft = old.scrollLeft; wrap.scrollTop = old.scrollTop; }
      return;
    }
    $('fhmStatus').textContent = query ? `Матчей: ${matches.length} из ${calendar.length}` : `Матчей: ${matches.length}`;
    out.replaceChildren(...(matches.length ? calendarContent(matches) : [
      h('p', { class: 'muted' }, calendar.length ? 'По запросу матчей нет.' : 'В выбранном месяце матчей нет.'),
    ]));
  }

  async function load() {
    const current = ++request;
    calendar = null;
    period = range();
    $('fhmCollapse').disabled = $('fhmExpand').disabled = true;
    $('fhmStatus').textContent = 'Загружаю календарь…';
    $('fhmOut').replaceChildren();
    try {
      const data = await api('/api/fhm/calendar', { query: period });
      if (current !== request || S.tab !== 'fhm') return;
      calendar = data.matches;
      crews = data.crews || {};
      render();
    } catch (e) {
      if (current !== request || S.tab !== 'fhm') return;
      $('fhmStatus').textContent = '';
      const adminButton = e.code === 'fhm_not_configured' && S.user?.role === 'admin'
        ? h('button', { onclick: () => document.querySelector('#tab-admin').click() }, 'Перейти в админку') : null;
      $('fhmOut').replaceChildren(h('p', { class: 'muted' }, e.message), ...(adminButton ? [adminButton] : []));
    }
  }

  async function loadConfig() {
    const session = S.token;
    const status = $('fhmConfigStatus');
    try {
      const result = await api('/api/admin/fhm');
      if (session === S.token) status.textContent = result.configured ? 'Подключено' : 'Введите ключ для подключения календаря.';
    } catch (e) {
      if (session === S.token) status.textContent = e.message;
    }
  }

  async function saveConfig(event) {
    event.preventDefault();
    const field = $('fhmKey'), button = event.currentTarget.querySelector('button'), status = $('fhmConfigStatus');
    const session = S.token;
    button.disabled = true;
    status.textContent = 'Проверяю ключ…';
    try {
      await api('/api/admin/fhm', { method: 'POST', body: { key: field.value } });
      if (session === S.token) {
        field.value = '';
        status.textContent = 'Подключено';
      }
    } catch (e) {
      if (session === S.token) status.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }

  document.querySelectorAll('[data-fhm-view]').forEach(button => {
    button.addEventListener('click', () => setView(button.dataset.fhmView));
  });
  $('fhmCollapse').addEventListener('click', () => allDays(true));
  $('fhmExpand').addEventListener('click', () => allDays(false));
  $('fhmSearch').addEventListener('input', render);
  $('fhmConfigForm').addEventListener('submit', saveConfig);
  window.FhmCalendar = {
    load, loadConfig,
    clear() {
      request++;
      calendar = null;
      period = null;
      crews = {};
      collapsed.calendar.clear();
      collapsed.schedule.clear();
      setView('calendar');
      $('fhmCollapse').disabled = $('fhmExpand').disabled = true;
      $('fhmKey').value = '';
      $('fhmSearch').value = '';
      $('fhmStatus').textContent = '';
      $('fhmConfigStatus').textContent = '';
      $('fhmOut').replaceChildren();
    },
  };
})();
