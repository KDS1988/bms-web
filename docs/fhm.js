(function () {
  'use strict';
  const { h, api, range, fmtDay, S, canView, canEdit, toast } = window.APP;
  const $ = id => document.getElementById(id);
  const STATUS = {
    scheduled: ['Запланирован', ''], live: ['Идёт', 'appointed'], finished: ['Завершён', ''],
    postponed: ['Перенесён', 'pending'], cancelled: ['Отменён', 'declined'],
  };
  const HEADERS = ['Время', 'Тур', 'Группа', 'Год рождения', 'Матч', 'Арена', 'Адрес', 'Статус', 'ID BMS'];
  const CALENDAR_WIDTHS = [7, 8, 10, 10, 23, 17, 11, 9, 5];
  const Schedule = window.FhmSchedule;
  const { CREW_FIELDS } = Schedule;
  const SCHEDULE_FIELDS = [['start', 'Начало'], ['finish', 'Конец'], ...CREW_FIELDS];
  const DEFAULT_SORT = { field: 'name', date: '', direction: 1 };
  const collapsed = { calendar: new Set(), schedule: new Set() };
  let calendar = null, period = null, view = 'calendar', crews = {};
  let bmsIds = {}, bmsStatus = '', calendarStatus = '';
  let request = 0, selectedDay = '', sort = DEFAULT_SORT;

  function dayLabel(date) { return date ? fmtDay(date) : 'Дата уточняется'; }

  function dayButton(date, text) {
    const state = collapsed[view], closed = state.has(date);
    return h('button', {
      type: 'button', 'aria-expanded': String(!closed), 'data-fhm-day': date,
      class: 'fhm-day-toggle', onclick: () => {
        if (closed) {
          state.delete(date);
          if (view === 'schedule') selectedDay = date;
        } else state.add(date);
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
        const years = match.year || [...new Set([match.homeYear, match.awayYear].filter(Boolean))].join(' / ');
        const title = match.home || match.away ? (match.home || '—') + ' - ' + (match.away || '—') : '—';
        return h('tr', null,
          h('td', { title: 'Московское время' }, match.time || '—'),
          h('td', null, match.tour || '—'),
          h('td', null, match.group || '—'),
          h('td', null, years || '—'),
          h('td', null, title),
          h('td', null, match.venue || '—'),
          h('td', null, match.location || '—'),
          h('td', null, h('span', { class: 'chip ' + cls }, label)),
          h('td', null, bmsIds[match.id] || '—'));
      });
      return h('section', { class: 'fhm-day' },
        dayButton(date, `${dayLabel(date)} · матчей: ${items.length}`),
        rows ? h('div', { class: 'tablewrap fhm-table' },
          h('table', { 'aria-label': 'Матчи ФХМ · ' + dayLabel(date) },
            h('colgroup', null, CALENDAR_WIDTHS.map(width => h('col', { style: 'width:' + width + '%' }))),
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
        input.parentElement.title = result.value;
        const hidesCompleted = date === selectedDay && $('fhmScheduleFilter').value === 'incomplete' && Schedule.crewComplete(crew);
        const affectsSort = sort.date === date && sort.field === field && !document.activeElement?.matches('.fhm-crew-cell input');
        if (view === 'schedule' && (hidesCompleted || affectsSort)) render();
      }
    } catch (e) {
      if (session === S.token) { input.value = before; toast(e.message, true); }
    } finally {
      input.disabled = false;
    }
  }

  function crewCell(arena, date, [field, label]) {
    const value = crews[date]?.[arena.key]?.[field] || '';
    const editable = canEdit('fhm-schedule') && arena.editable;
    return h('td', { class: 'fhm-crew-cell', title: value || null }, editable
      ? h('input', { type: 'text', value, maxlength: 80,
        'aria-label': `${label} · ${arena.name} · ${DATE.format(new Date(date))}`,
        onchange: event => saveCrew(event.currentTarget, date, arena.key, field),
        onkeydown: event => { if (event.key === 'Enter') event.currentTarget.blur(); },
      })
      : value);
  }

  function sortHeader(label, field, date = '', attrs = {}) {
    const active = sort.field === field && sort.date === date;
    return h('th', { scope: 'col', ...attrs, 'aria-sort': active ? (sort.direction === 1 ? 'ascending' : 'descending') : null },
      h('button', { class: 'fhm-sort', type: 'button', onclick: event => {
        sort = { field, date, direction: active ? -sort.direction : (field === 'count' ? -1 : 1) };
        const buttonIndex = [...$('fhmOut').querySelectorAll('.fhm-sort')].indexOf(event.currentTarget);
        render();
        $('fhmOut').querySelectorAll('.fhm-sort')[buttonIndex]?.focus({ preventScroll: true });
      } }, label, ' ', h('span', { 'aria-hidden': 'true' }, active ? (sort.direction === 1 ? '↑' : '↓') : '↕')));
  }

  function selectScheduleDay(date) {
    selectedDay = date;
    if (date) collapsed.schedule.delete(date);
    render();
    if (!date) return;
    const wrap = $('fhmOut').querySelector('.fhm-schedule-wrap');
    const target = wrap?.querySelector(`[data-fhm-day="${date}"]`);
    if (target) {
      const pinned = wrap.querySelector('.fhm-pin-total').getBoundingClientRect().right;
      wrap.scrollLeft += target.getBoundingClientRect().left - pinned - 9;
    }
  }

  function scheduleContent(schedule) {
    const { dates, rows, totals } = schedule;
    if (!rows.length) return h('p', { class: 'muted' }, $('fhmScheduleFilter').value === 'incomplete' && selectedDay
      ? 'На выбранный день нет арен с незаполненной бригадой.'
      : 'Нет матчей для расписания.');
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
            sortHeader('Арена', 'name', '', { class: 'fhm-pin fhm-pin-arena', rowspan: 2 }),
            h('th', { class: 'fhm-pin fhm-pin-location', scope: 'col', rowspan: 2 }, 'Локация'),
            sortHeader('Кол-во матчей', 'count', '', { class: 'fhm-pin fhm-pin-total', rowspan: 2 }),
            days.map(({ date, closed, total }) => h('th', {
              class: date === selectedDay ? 'fhm-day-start fhm-selected-day' : 'fhm-day-start', scope: 'colgroup', colspan: closed ? 1 : 1 + SCHEDULE_FIELDS.length,
            }, dayButton(date, DATE.format(new Date(date))),
            !closed ? h('span', { class: 'fhm-weekday' }, WEEKDAY.format(new Date(date))) : null,
            h('small', { title: 'Одна бригада на строку арены с матчами' }, `Матчей: ${total?.matches || 0} · Бригад: ${total?.crews || 0}`)))),
          h('tr', { class: 'fhm-schedule-fields' }, days.flatMap(day => [
            sortHeader('Матчей', 'count', day.date, { class: 'fhm-day-start' }),
            ...(day.closed ? [] : SCHEDULE_FIELDS.map(([field, label]) => sortHeader(label, field, day.date))),
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
            const end = Schedule.endTime(day.finish);
            return [count, h('td', null, day.start), h('td', {
              title: day.finish >= 1440 ? 'Следующий день' : null,
            }, end), ...CREW_FIELDS.map(field => crewCell(arena, date, field))];
          }))))));
  }

  function setView(value) {
    view = value;
    $('fhmScheduleDayLabel').hidden = $('fhmScheduleFilterLabel').hidden = view !== 'schedule';
    document.querySelectorAll('[data-fhm-view]').forEach(button => {
      const active = button.dataset.fhmView === view;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function applyAccess() {
    document.querySelectorAll('[data-fhm-view]').forEach(button => {
      button.hidden = !canView('fhm-' + button.dataset.fhmView);
    });
    if (!canView('fhm-' + view)) {
      calendar = null;
      setView(canView('fhm-calendar') ? 'calendar' : 'schedule');
    }
  }

  function allDays(closed) {
    if (!calendar) return;
    const dates = view === 'schedule' ? Schedule.buildSchedule([], period).dates : calendar.map(match => match.date);
    if (closed) dates.forEach(date => collapsed[view].add(date));
    else dates.forEach(date => collapsed[view].delete(date));
    render();
  }

  function render() {
    if (!calendar) return;
    const query = $('fhmSearch').value.trim().toLocaleLowerCase('ru');
    const matches = query ? calendar.filter(match => [match.home, match.away, match.venue, match.group, match.tour, match.location, match.year, bmsIds[match.id]]
      .some(value => String(value ?? '').toLocaleLowerCase('ru').includes(query))) : calendar;
    const out = $('fhmOut');
    const schedule = view === 'schedule' ? Schedule.buildSchedule(matches, period) : null;
    $('fhmCollapse').disabled = $('fhmExpand').disabled = schedule ? !schedule.rows.length : !matches.length;
    if (schedule) {
      const day = $('fhmScheduleDay');
      if (!schedule.dates.includes(selectedDay)) selectedDay = '';
      if (sort.date && !schedule.dates.includes(sort.date)) sort = DEFAULT_SORT;
      if (day.dataset.month !== period.from) {
        day.dataset.month = period.from;
        day.replaceChildren(h('option', { value: '' }, 'Весь месяц'),
          ...schedule.dates.map(date => h('option', { value: date }, dayLabel(date))));
      }
      day.value = selectedDay;
      const filter = $('fhmScheduleFilter');
      filter.disabled = !selectedDay;
      const rows = Schedule.arrangeRows(schedule.rows, crews, { day: selectedDay, mode: filter.value, sort });
      $('fhmStatus').textContent = withStatus((selectedDay ? dayLabel(selectedDay) : MONTH.format(new Date(period.from))) + ' · арен: ' + rows.length);
      const old = out.querySelector('.fhm-schedule-wrap');
      out.replaceChildren(scheduleContent({ ...schedule, rows }));
      const wrap = out.querySelector('.fhm-schedule-wrap');
      if (old && wrap) { wrap.scrollLeft = old.scrollLeft; wrap.scrollTop = old.scrollTop; }
      return;
    }
    const count = query ? `Матчей: ${matches.length} из ${calendar.length}` : `Матчей: ${matches.length}`;
    $('fhmStatus').textContent = withStatus(bmsStatus ? count + ' · ' + bmsStatus : count);
    out.replaceChildren(...(matches.length ? calendarContent(matches) : [
      h('p', { class: 'muted' }, calendar.length ? 'По запросу матчей нет.' : 'В выбранном месяце матчей нет.'),
    ]));
  }

  async function loadBmsIds(current, query) {
    try {
      const data = await api('/api/fhm/bms-ids', { query });
      if (current !== request) return;
      bmsIds = data.ids || {};
      bmsStatus = data.available ? '' : 'Сверка ID БМС недоступна';
    } catch {
      if (current !== request) return;
      bmsStatus = 'Сверка ID БМС недоступна';
    }
    if (S.tab === 'fhm' && view === 'calendar') render();
  }

  const UPDATE_TIME = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const updateTime = value => UPDATE_TIME.format(new Date(value)) + ' МСК';
  const deferred = retryAt => retryAt ? ' · повтор после ' + updateTime(retryAt) : '';
  const withStatus = text => [text, calendarStatus].filter(Boolean).join(' · ');

  async function load() {
    const current = ++request;
    calendar = null;
    bmsIds = {};
    bmsStatus = '';
    calendarStatus = '';
    period = range();
    $('fhmCollapse').disabled = $('fhmExpand').disabled = true;
    $('fhmStatus').textContent = 'Загружаю календарь…';
    $('fhmOut').replaceChildren();
    try {
      const path = canView('fhm-calendar') ? '/api/fhm/calendar' : '/api/fhm/schedule';
      const data = await api(path, { query: period });
      if (current !== request || S.tab !== 'fhm') return;
      calendar = data.matches;
      crews = data.crews || {};
      if (data.stale && data.updatedAt) calendarStatus = 'Сохранённые данные от ' + updateTime(data.updatedAt) + deferred(data.retryAt);
      if (calendar.length && canView('fhm-calendar')) {
        bmsStatus = 'Сверяю ID БМС…';
        void loadBmsIds(current, period);
      }
      render();
    } catch (e) {
      if (current !== request || S.tab !== 'fhm') return;
      $('fhmStatus').textContent = '';
      const adminButton = e.code === 'fhm_not_configured' && S.user?.role === 'admin'
        ? h('button', { onclick: () => document.querySelector('#tab-admin').click() }, 'Перейти в админку') : null;
      $('fhmOut').replaceChildren(h('p', { class: 'muted' }, e.message + deferred(e.retryAt)), ...(adminButton ? [adminButton] : []));
    }
  }

  async function loadConfig() {
    const session = S.token;
    const status = $('fhmConfigStatus');
    try {
      const result = await api('/api/admin/fhm');
      if (session === S.token) status.textContent = result.configured ? 'Подключено' : 'Введите ключ для подключения календаря.';
    } catch (e) {
      if (session === S.token) status.textContent = e.message + deferred(e.retryAt);
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
      if (session === S.token) status.textContent = e.message + deferred(e.retryAt);
    } finally {
      button.disabled = false;
    }
  }

  document.querySelectorAll('[data-fhm-view]').forEach(button => {
    button.addEventListener('click', () => { if (canView('fhm-' + button.dataset.fhmView)) setView(button.dataset.fhmView); });
  });
  $('fhmScheduleDay').addEventListener('change', event => selectScheduleDay(event.currentTarget.value));
  $('fhmScheduleFilter').addEventListener('change', render);
  $('fhmCollapse').addEventListener('click', () => allDays(true));
  $('fhmExpand').addEventListener('click', () => allDays(false));
  $('fhmSearch').addEventListener('input', render);
  $('fhmConfigForm').addEventListener('submit', saveConfig);
  window.FhmCalendar = {
    load, loadConfig, applyAccess,
    clear() {
      request++;
      calendar = null;
      bmsIds = {};
      bmsStatus = '';
      calendarStatus = '';
      period = null;
      crews = {};
      selectedDay = '';
      sort = DEFAULT_SORT;
      $('fhmScheduleFilter').value = 'all';
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
