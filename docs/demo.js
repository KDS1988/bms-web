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
            const st = !has ? '' : (rnd() > 0.35 ? 'appointed' : rnd() > 0.2 ? 'pending' : 'declined');
            const rate = has ? rnd() > 0.1 : null;
            total++; if (has) filled++; if (st === 'appointed') acc++; if (st === 'declined') dec++; if (has && !rate) noRate++;
            slots[g].push({
              lineId: id * 10 + total, roleId: GROUPS.indexOf(g) + 1, roleName: ROLES[g], badges: g === 'gfx' && rnd() > .5 ? ['GTZp'] : [],
              employee: has ? { id: 1 + Math.floor(rnd() * 9), name: NAMES[Math.floor(rnd() * NAMES.length)] } : null,
              status: st, hasRate: rate, logistics: g === 'vr' && has ? '📡 - Работает удаленно/не на площадке' : null,
            });
          }
        });
        const h = 12 + Math.floor(rnd() * 8);
        rows.push({
          eventServiceId: id, eventId: id, date: iso(d), start: h + ':00', end: (h + 3) + ':00',
          league: rnd() > .5 ? 'КХЛ' : 'РПЛ', title: t[0] + ' — ' + t[1], service: 'Прямая трансляция',
          cancelled: false, serviceStatus: '', additional: [], slots, contractor: null,
          stats: { total, filled, accepted: acc, declined: dec, noRate, cameras: 3, camerasFilled: slots.cam.filter(s => s.employee).length },
        });
        id++;
      }
    }
    return rows;
  }

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
    if (path === '/api/assign') return { assignmentId: 1, rate: 'ok' };
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
