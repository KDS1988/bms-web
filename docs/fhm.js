(function () {
  'use strict';
  const { h, api, range, fmtDay, S } = window.APP;
  const $ = id => document.getElementById(id);
  const STATUS = {
    scheduled: ['Запланирован', ''], live: ['Идёт', 'appointed'], finished: ['Завершён', ''],
    postponed: ['Перенесён', 'pending'], cancelled: ['Отменён', 'declined'],
  };
  const HEADERS = ['Время (МСК)', 'Хозяева', 'Гости', 'Арена', 'Группа / тур', 'Статус'];
  let calendar = null;
  let request = 0;

  function render() {
    if (!calendar) return;
    const query = $('fhmSearch').value.trim().toLocaleLowerCase('ru');
    const matches = calendar.filter(match => [match.home, match.away, match.venue, match.group, match.tour]
      .some(value => value.toLocaleLowerCase('ru').includes(query)));
    $('fhmStatus').textContent = query ? `Матчей: ${matches.length} из ${calendar.length}` : `Матчей: ${matches.length}`;
    if (!matches.length) {
      $('fhmOut').replaceChildren(h('p', { class: 'muted' }, calendar.length ? 'По запросу матчей нет.' : 'В выбранном месяце матчей нет.'));
      return;
    }
    const rows = [];
    let date = null;
    for (const match of matches) {
      if (match.date !== date) {
        date = match.date;
        rows.push(h('tr', { class: 'fhm-day' }, h('th', { colspan: HEADERS.length }, date ? fmtDay(date) : 'Дата уточняется')));
      }
      const [label, cls] = STATUS[match.status] || ['—', ''];
      rows.push(h('tr', null,
        h('td', null, match.time || '—'),
        h('td', null, match.home || '—'), h('td', null, match.away || '—'),
        h('td', null, match.venue || '—'),
        h('td', null, [match.group, match.tour].filter(Boolean).join(' · ') || '—'),
        h('td', null, h('span', { class: 'chip ' + cls }, label))));
    }
    const wrap = h('div', { class: 'tablewrap fhm-table', tabindex: 0, 'aria-label': 'Матчи ФХМ' },
      h('table', null, h('thead', null, h('tr', null, HEADERS.map(title => h('th', { scope: 'col' }, title)))),
        h('tbody', null, rows)));
    $('fhmOut').replaceChildren(wrap);
  }

  async function load() {
    const current = ++request;
    calendar = null;
    $('fhmStatus').textContent = 'Загружаю календарь…';
    $('fhmOut').replaceChildren();
    try {
      const data = await api('/api/fhm/calendar', { query: range() });
      if (current !== request || S.tab !== 'fhm') return;
      calendar = data.matches;
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

  $('fhmSearch').addEventListener('input', render);
  $('fhmConfigForm').addEventListener('submit', saveConfig);
  window.FhmCalendar = {
    load, loadConfig,
    clear() {
      request++;
      calendar = null;
      $('fhmKey').value = '';
      $('fhmSearch').value = '';
      $('fhmStatus').textContent = '';
      $('fhmConfigStatus').textContent = '';
      $('fhmOut').replaceChildren();
    },
  };
})();
