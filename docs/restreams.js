(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const LABELS = {
    protocol: 'Протокол', address: 'Hostname / URL', port: 'Порт', key: 'Ключ', passphrase: 'Passphrase',
    login: 'Логин', password: 'Пароль', link: 'Ссылка на трансляцию',
  };
  const SETUP = {
    studio: 'Студия', pc: 'ПК', format: 'Формат', airStart: 'Начало эфира', airEnd: 'Конец эфира',
    round: 'Тур', production: 'Производство', brief: 'ТЗ для бригады', manager: 'Менеджер',
    vr: 'ВР', graphics: 'Графика', cabin: 'Кабинка', commentator1: 'Комментатор 1', commentator2: 'Комментатор 2',
  };

  let app, data, request = 0, account = 0;
  const pending = new Set();
  const savedDuringLoad = new Map();

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function detailList(values, labels) {
    const list = el('dl', null, 'restream-details');
    for (const [key, label] of Object.entries(labels)) {
      if (!values[key]) continue;
      list.append(el('dt', label), el('dd', values[key]));
    }
    return list;
  }

  function showStream(row, recipient) {
    const stream = row.streams[recipient.id];
    const box = el('div');
    box.append(el('p', row.title, 'muted'), detailList(stream.params, LABELS));
    if (stream.missing.length) {
      const fields = stream.missing.map(key => LABELS[key]).join(', ');
      box.append(el('p', 'Нужно заполнить: ' + fields, 'restream-notice'));
    }
    if (stream.ambiguous) box.append(el('p', 'В справочнике несколько разных записей с этим ID.', 'restream-notice'));
    app.openModal(recipient.label, box);
  }

  function streamKey(row, recipient) { return row.eventServiceId + ':' + recipient.id; }

  async function save(row, recipient, needed, select) {
    const current = account;
    const period = data.period;
    const key = streamKey(row, recipient);
    pending.add(key);
    select.disabled = true;
    try {
      const result = await app.api('/api/restreams', {
        method: 'POST', query: period, body: { eventServiceId: row.eventServiceId, recipient: recipient.id, needed },
      });
      if (current !== account) return;
      if (!data) savedDuringLoad.set(key, result.stream);
      const visible = data?.rows.find(item => item.eventServiceId === row.eventServiceId);
      if (visible) visible.streams[recipient.id] = result.stream;
      app.toast('Сохранено');
    } catch (error) {
      if (current === account) app.toast(error.message, true);
    } finally {
      if (current === account) {
        pending.delete(key);
        if (data) render();
      }
    }
  }

  function streamCell(row, recipient) {
    const cell = el('td', null, 'restream-cell');
    const stream = row.streams[recipient.id];
    if (app.canEdit() && !row.cancelled) {
      const select = el('select');
      select.setAttribute('aria-label', recipient.label + ' · ' + row.title + ' · ' + row.eventId);
      const empty = new Option('—', '');
      empty.disabled = true;
      select.append(empty, new Option('Да', 'yes'), new Option('Нет', 'no'));
      select.value = stream.needed === null ? '' : (stream.needed ? 'yes' : 'no');
      select.disabled = pending.has(streamKey(row, recipient));
      select.onchange = () => save(row, recipient, select.value === 'yes', select);
      cell.append(select);
    } else {
      cell.append(el('span', stream.needed === null ? '—' : (stream.needed ? 'Да' : 'Нет')));
    }
    if (stream.needed) {
      const missing = stream.missing.length > 0;
      const button = el('button', missing ? 'Нужны данные' : 'Параметры', missing ? 'restream-incomplete' : 'restream-ready');
      button.title = row.title + ' · ' + recipient.label;
      button.onclick = () => showStream(row, recipient);
      cell.append(button);
    }
    return cell;
  }

  function render() {
    if (!data) return;
    const query = $('restreamSearch').value.toLowerCase().trim();
    const incomplete = row => Object.values(row.streams).some(s => s.needed && s.missing.length);
    const rows = data.rows.filter(row =>
      (!query || [row.title, row.league, row.eventId].some(s => String(s).toLowerCase().includes(query))) &&
      (!$('restreamMissing').checked || incomplete(row)));
    $('restreamStatus').textContent = 'Услуги: ' + rows.length + ' из ' + data.rows.length;
    const out = $('restreamOut');
    if (!rows.length) {
      out.replaceChildren(el('p', data.rows.length ? 'По фильтрам ничего не найдено.' : 'За выбранный месяц в БМС нет услуг «Ретрансляция».', 'muted'));
      return;
    }
    const wrap = el('div', null, 'tablewrap restream-table');
    wrap.tabIndex = 0;
    wrap.setAttribute('aria-label', 'Таблица потоков');
    const table = el('table');
    const head = table.createTHead().insertRow();
    for (const label of ['Мероприятие', ...data.recipients.map(r => r.label), 'ID мероприятия']) {
      const th = el('th', label);
      th.scope = 'col';
      head.append(th);
    }
    const list = table.createTBody();
    for (const row of rows) {
      const tr = list.insertRow();
      const event = el('th', null, 'restream-event');
      event.scope = 'row';
      event.append(el('strong', row.title || 'Мероприятие ' + row.eventId));
      const day = row.date.split('-').reverse().join('.');
      event.append(el('div', [day, [row.start, row.end].filter(Boolean).join('–'), row.league].filter(Boolean).join(' · '), 'muted'));
      if (row.cancelled) event.append(el('div', row.status || 'Отменено', 'restream-incomplete'));
      if (row.city || row.info || Object.keys(row.setup).length) {
        const details = el('details');
        details.append(el('summary', 'Данные мероприятия'), el('div', [row.city, row.info].filter(Boolean).join(' · ')), detailList(row.setup, SETUP));
        event.append(details);
      }
      tr.append(event, ...data.recipients.map(recipient => streamCell(row, recipient)), el('td', row.eventId));
    }
    const previous = out.firstElementChild;
    wrap.append(table);
    out.replaceChildren(wrap);
    if (previous) {
      wrap.scrollLeft = previous.scrollLeft;
      wrap.scrollTop = previous.scrollTop;
    }
  }

  async function load({ period, fresh }) {
    const token = ++request;
    data = null;
    savedDuringLoad.clear();
    $('restreamStatus').textContent = 'Загружаю услуги из БМС…';
    $('restreamNotice').hidden = true;
    $('restreamOut').replaceChildren();
    try {
      const result = await app.api('/api/restreams', { query: { ...period, ...(fresh ? { fresh: '1' } : {}) } });
      if (token !== request) return;
      for (const row of result.rows) {
        for (const recipient of result.recipients) {
          const updated = savedDuringLoad.get(streamKey(row, recipient));
          if (updated) row.streams[recipient.id] = updated;
        }
      }
      savedDuringLoad.clear();
      data = { ...result, period };
      $('restreamNotice').textContent = result.notice || '';
      $('restreamNotice').hidden = !result.notice;
      render();
    } catch (error) {
      if (token === request) {
        $('restreamStatus').textContent = 'Загрузка не удалась';
        throw error;
      }
    }
  }

  async function settings() {
    const current = account;
    try {
      const config = await app.api('/api/restreams/config');
      if (current !== account) return;
      const box = el('form', null, 'restream-config');
      const url = el('input');
      url.type = 'url';
      url.value = config.url;
      url.placeholder = 'https://script.google.com/macros/s/…/exec';
      const key = el('input');
      key.type = 'password';
      key.autocomplete = 'off';
      key.placeholder = 'Для нового источника или смены ключа';
      const rules = el('textarea');
      rules.rows = 10;
      rules.spellcheck = false;
      rules.value = JSON.stringify(config.rules, null, 2);
      const field = (label, input) => { const wrapper = el('label', label); wrapper.append(input); return wrapper; };
      const help = el('details');
      help.append(el('summary', 'Формат правил'), el('p', 'Первое подходящее правило получателя используется, когда в справочнике нет готовых параметров. Поля отбора: eventId, league, home, studio. Пустой отбор применяется ко всем событиям.'));
      help.append(el('pre', JSON.stringify([{ recipient: 'rtmp', match: { league: 'Название лиги' }, params: {
        protocol: 'RTMP', address: 'rtmp://ingest.example.com/live/', key: '{eventId}_{ddmmyyyy}',
      } }], null, 2)));
      if (data) help.append(el('p', data.recipients.map(r => r.id + ' — ' + r.label).join(' · ')));
      const submit = el('button', 'Сохранить', 'primary');
      submit.type = 'submit';
      const error = el('p', null, 'err');
      error.setAttribute('role', 'alert');
      box.append(field('Ссылка на экспорт Google Sheets', url), field('Ключ источника', key), field('Правила потоков (JSON)', rules), help, submit, error);
      box.onsubmit = async ev => {
        ev.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          let parsed;
          try { parsed = JSON.parse(rules.value); } catch { throw new Error('Проверьте синтаксис JSON.'); }
          await app.api('/api/restreams/config', { method: 'POST', body: { url: url.value, key: key.value, rules: parsed } });
          if (current !== account) return;
          app.closeModal();
          app.toast('Настройки сохранены');
          if (data) await load({ period: data.period, fresh: true });
        } catch (e) {
          if (box.isConnected) error.textContent = e.message;
          else if (current === account) app.toast(e.message, true);
        } finally {
          submit.disabled = false;
        }
      };
      app.openModal('Источники и правила потоков', box);
    } catch (error) { if (current === account) app.toast(error.message, true); }
  }

  window.Restreams = {
    init(context) {
      app = context;
      $('restreamSearch').oninput = render;
      $('restreamMissing').onchange = render;
      $('restreamSettings').hidden = !context.admin;
      $('restreamSettings').onclick = settings;
    },
    clear() {
      request++;
      account++;
      pending.clear();
      savedDuringLoad.clear();
      data = null;
      $('restreamOut').replaceChildren();
      $('restreamNotice').hidden = true;
      $('restreamStatus').textContent = '';
      $('restreamSearch').value = '';
      $('restreamMissing').checked = false;
      app?.closeModal();
      $('mBody').replaceChildren();
    },
    load,
  };
})();
