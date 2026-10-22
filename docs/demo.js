// Демо-режим (?demo=1): тестовые данные без сервера. Формат ответов = формату Worker.
(function () {
  const iso = d => d.toISOString().slice(0, 10);
  const add = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  const NAMES = ['Иванов Иван', 'Петров Пётр', 'Сидоров Алексей', 'Козлов Дмитрий', 'Морозов Сергей', 'Волков Андрей', 'Новиков Артём', 'Фёдоров Максим', 'ИП Громов', 'Белов Кирилл'];
  const GROUPS = ['vr', 'prod', 'dir', 'replay', 'gfx', 'sound', 'eng', 'cam', 'other'];
  const ROLES = { vr: 'Выпускающий режиссер', prod: 'Продюсер', dir: 'Режиссер', replay: 'Режиссер повторов', gfx: 'Режиссер графики', sound: 'Звукорежиссер', eng: 'Инженер', cam: 'Видеооператор', other: 'Прочее' };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const TEAMS = [['Локомотив', 'Динамо'], ['ЦСКА', 'Спартак'], ['Зенит', 'Краснодар'], ['СКА', 'Авангард'], ['Ак Барс', 'Салават Юлаев']];

  function makeRows(from, to) {
    const rows = []; let id = 1000;
    for (let d = new Date(from + 'T00:00:00Z'); iso(d) <= to; d = add(d, 1)) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const t = TEAMS[Math.floor(rnd() * TEAMS.length)];
        const slots = {}; let total = 0, filled = 0, acc = 0, dec = 0, noRate = 0;
        GROUPS.forEach(g => {
          const cnt = g === 'cam' ? 3 : g === 'other' ? 0 : 1;
          slots[g] = [];
          for (let k = 0; k < cnt; k++) {
            const has = rnd() > 0.28;
            const st = !has ? '' : (rnd() > 0.35 ? 'appointed' : rnd() > 0.2 ? 'pending' : rnd() > 0.4 ? 'not_appointed' : 'declined');
            const rate = has ? rnd() > 0.1 : null;
            total++; if (has) filled++; if (st === 'appointed') acc++; if (st === 'declined') dec++; if (has && !rate) noRate++;
            slots[g].push({
              lineId: id * 10 + total, assignmentId: has ? id * 100 + total : null, roleId: GROUPS.indexOf(g) + 1, roleName: ROLES[g], badges: g === 'gfx' && rnd() > .5 ? ['GTZp'] : [],
              employee: has ? { id: 1 + Math.floor(rnd() * 9), name: NAMES[Math.floor(rnd() * NAMES.length)] } : null,
              status: st, hasRate: rate, logistics: g === 'vr' && has ? '📡 - Работает удаленно/не на площадке' : null,
            });
          }
        });
        const h = 12 + Math.floor(rnd() * 8);
        rows.push({
          eventServiceId: id, eventId: id, date: iso(d), start: h + ':00', end: (h + 3) + ':00',
          league: rnd() > .5 ? 'КХЛ' : 'РПЛ', title: t[0] + ' — ' + t[1], service: 'Прямая трансляция',
          cancelled: i === 1 && id % 3 === 0, serviceStatus: i === 1 && id % 3 === 0 ? 'Отменена' : 'Подтверждена', city: ['Москва', 'Казань', 'Омск'][id % 3], sport: 'Хоккей', info: id % 2 ? 'Матч регулярного чемпионата, 1/8 финала' : '', additional: ['МОБ'], additionalServices: [{ id: 11, short: 'МОБ', name: 'Мобильная бригада' }, { id: 12, short: 'ЗАЯВ', name: 'Заявка' }, { id: 13, short: 'ФЛЕШ', name: 'Флеш-интервью' }], slots, contractor: null,
          stats: { total, filled, accepted: acc, declined: dec, noRate, cameras: 3, camerasFilled: slots.cam.filter(s => s.employee).length },
        });
        id++;
      }
    }
    return rows;
  }

  let dv = 1; const dstore = {}; const ostore = {}; const plans = []; let pseq = 0; const tstore = {}; const smatches = []; let sseq = 0;
  window.DEMO = function (path, opts, q) {
    if (path === '/api/me') return { user: { email: 'demo@example.com', name: 'Демо-пользователь', role: 'admin' } };
    if (path === '/api/board') {
      const rows = makeRows(q.from, q.to), days = [];
      rows.forEach(r => { let d = days.find(x => x.date === r.date); if (!d) days.push(d = { date: r.date, rows: [] }); d.rows.push(r); });
      return { days, leagues: ['КХЛ', 'РПЛ'], total: rows.length };
    }
    if (path === '/api/staff') {
      const dates = []; for (let d = new Date(q.from + 'T00:00:00Z'); iso(d) <= q.to; d = add(d, 1)) dates.push(iso(d));
      const employees = NAMES.map((n, i) => {
        const days = {}; dates.forEach(dt => { const r = rnd(); days[dt] = r > .6 ? { state: 'busy', items: ['КХЛ ' + TEAMS[i % 5].join(' — ') + ' 18:00'] } : r > .45 ? { state: 'off', items: [] } : { state: 'free', items: [] }; });
        return { id: i + 1, name: n, phone: '', title: '', dept: '', lines: [{ id: i % 8 + 1, name: Object.values(ROLES)[i % 8], category: 'A' }], days };
      });
      return { dates, lines: Object.values(ROLES).slice(0, 8).map((n, i) => ({ id: i + 1, name: n })), employees };
    }
    if (path === '/api/employees') {
      return { candidates: NAMES.map((n, i) => ({ id: i + 1, name: n, state: ['free', 'free', 'busy', 'off'][i % 4], busyWith: i % 4 === 2 ? ['КХЛ Динамо — ЦСКА 19:00'] : [], category: 'A' })).sort((a, b) => ({ free: 0, busy: 1, off: 2 }[a.state] - { free: 0, busy: 1, off: 2 }[b.state])) };
    }
    if (path === '/api/admin/users') return { owners: ['demo@example.com'], users: { 'ivan@example.com': { name: 'Иван', addedAt: '2026-10-10T10:00:00', addedBy: 'demo' } }, requests: { 'petr@example.com': { name: 'Пётр Сидоров', at: '2026-10-17T20:00:00' } } };
    if (path.startsWith('/api/admin/users/')) return { ok: true };
    if (path === '/api/lines') return { lines: Object.entries(ROLES).map(([g, n], i) => ({ id: i + 1, name: n, group: g })) };
    if (path === '/api/studios/vr') return { at: new Date().toISOString(), vrs: [
      { name: 'Кармен Клещевич', n: 410, bad: 8, first: '2025-09-01', last: '2026-10-20', proj: { 'КХЛ_ПАК': 200, 'Junior Hockey': 90 }, auto: 'опытный', manual: '', label: 'опытный' },
      { name: 'Роман Губайдулин', n: 120, bad: 15, first: '2025-09-01', last: '2026-10-19', proj: { 'НСФЛ': 60 }, auto: 'нестабильный', manual: '', label: 'нестабильный' },
      { name: 'Новый Человек', n: 4, bad: 0, first: '2026-10-01', last: '2026-10-19', proj: {}, auto: 'новичок', manual: '', label: 'новичок' },
      { name: 'Ольга Моисеева', n: 300, bad: 2, first: '2025-09-01', last: '2026-10-21', proj: { 'Рестрим КП Беларусь': 150, 'КХЛ_ПАК': 40 }, auto: 'опытный', manual: '', label: 'опытный' }] };
    if (path === '/api/studios/vr/label') return { ok: true };
    if (path === '/api/studios/history/sync') return { rows: 6000, vrs: 4 };
    if (path === '/api/studios/source') return { configured: true, url: 'https://script.google.com/macros/s/DEMO/exec' };
    if (path === '/api/studios/sync') return { rows: 12, added: 0 };
    if (path === '/api/studios/delete') { const i = smatches.findIndex(m => m.id === opts.body.id); if (i >= 0) smatches.splice(i, 1); return { ok: true }; }
    if (path === '/api/studios') {
      if ((opts.method || 'GET') === 'GET') {
        if (!smatches.length) {
          const P = [['КХЛ_ПАК', 'Адмирал', 'Барыс'], ['КХЛ_ПАК', 'Салават Юлаев', 'Ак Барс'], ['Junior Hockey', 'Омские Ястребы', 'Мамонты Югры'], ['Рестрим КП Беларусь', 'WTA 1000 Индиан-Уэллс', ''], ['НСФЛ', 'Мурмаши', 'Раменки']];
          for (let d = new Date(q.from + 'T00:00:00Z'), k = 0; iso(d) <= q.to; d = add(d, 1)) for (let i = 0; i < 6; i++, k++) {
            const p = P[(k + i) % P.length], st = 10 * 60 + i * 50 + (k % 3) * 20, en = st + 120;
            const f = n => String(Math.floor(n / 60) % 24).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
            smatches.push({ id: 's' + k, studio: 'Калужская', pc: String(1 + (i % 4)).padStart(2, '0'), date: iso(d), start: f(st), end: f(en), project: p[0], t1: p[1], t2: p[2], vr: ['Кармен Клещевич', 'Роман Губайдулин', ''][i % 3], eventId: i === 0 ? 1000 + k % 5 : null, comm: i % 2 ? 'со стадиона' : '', status: '', support: '', engineer: '', tri: '', comment: '', scomment: '' });
          }
        }
        return { matches: smatches.filter(m => m.date >= q.from && m.date <= q.to), configured: true, sync: { at: new Date().toISOString(), by: 'демо', rows: 0, added: 0 } };
      }
      const b = opts.body;
      if (b.id) { const m = smatches.find(x => x.id === b.id); Object.assign(m, b); return { match: m }; }
      const m = { id: 'm' + (++sseq), manual: true, status: '', support: '', engineer: '', tri: '', comment: '', scomment: '', ...b }; smatches.push(m); return { match: m };
    }
    if (path === '/api/notify') return { sent: opts.body.ids, failed: [] };
    if (path === '/api/trips') { if (opts.body.on) tstore[opts.body.key] = 1; else delete tstore[opts.body.key]; return { ok: true }; }
    if (path === '/api/plans' && (opts.method || 'GET') === 'GET') return { plans: plans.filter(p => p.date >= q.from && p.date <= q.to), trips: Object.keys(tstore) };
    if (path === '/api/plans') { const b = opts.body; const i = plans.findIndex(p => p.id === b.id); const rec = { ...b, id: b.id || ++pseq, by: 'Демо' }; if (i >= 0) plans[i] = rec; else plans.push(rec); return { plan: rec }; }
    if (path === '/api/plans/delete') { const i = plans.findIndex(p => p.id === opts.body.id); if (i >= 0) plans.splice(i, 1); Object.keys(dstore).forEach(k => { if (k.startsWith('-' + opts.body.id + ':')) delete dstore[k]; }); dv++; return { ok: true }; }
    if (path === '/api/order') { if ((opts.method || 'GET') === 'POST') { ostore[opts.body.date] = opts.body.ids; return { ok: true }; } return { orders: ostore }; }
    if (path === '/api/draft') {
      if ((opts.method || 'GET') === 'GET') return q && q.since !== undefined && Number(q.since) === dv ? { version: dv, boardVersion: 0, unchanged: true } : { version: dv, boardVersion: 0, drafts: dstore };
      dstore[opts.body.eventServiceId + ':' + opts.body.lineId] = { ...opts.body, by: 'Коллега' }; dv++; return { ok: true };
    }
    if (path === '/api/draft/delete') { (opts.body.all ? Object.keys(dstore) : opts.body.keys).forEach(k => delete dstore[k]); dv++; return { ok: true }; }
    if (path === '/api/assign') { delete dstore[opts.body.eventServiceId + ':' + opts.body.lineId]; dv++; return { assignmentId: 1, rate: 'ok' }; }
    if (path === '/api/rates/missing') {
      const rows = makeRows(q.from, q.to), out = [];
      rows.forEach(r => GROUPS.forEach(g => r.slots[g].forEach(s => { if (s.employee && !s.hasRate) out.push({ date: r.date, title: r.title, role: s.roleName, employee: s.employee.name, eventServiceId: r.eventServiceId, lineId: s.lineId }); })));
      return { missing: out };
    }
    if (path === '/api/rates/fix') return { fixed: [], failed: [] };
    if (path === '/api/admin/bms/status') return { loggedIn: true, phone: '7900•••', loginBy: 'demo', loginAt: new Date().toISOString() };
    return {};
  };
})();
