/**
 * Чистая логика доски: превращает сырой ответ BMS (projects/assignment_table/technical)
 * в готовую для интерфейса модель. Порт логики из Apps Script (isTargetItem_,
 * classifyLines_, roleSortRank_, executorName_, executorStatus_). Без сети и
 * без зависимостей от Workers — поэтому покрывается обычными тестами.
 */

export const TARGET_SERVICES = ['Прямая трансляция', 'Студия'];
// Категории, которые целиком пропускаем (однокамерные ХЛТР и ФХМ)
export const EXCLUDED_LEAGUES = ['ХЛТР', 'ФХМ'];
export const CONTRACTOR_RE = /^(ИП|СЗ|АНО|ООО|ОГАУ)(\s|$)/i;

/** Колонки таблицы в порядке показа. `test` проверяется сверху вниз, первое совпадение побеждает
 *  (специфичные виды режиссёра раньше общего «Режиссер»). */
export const ROLE_GROUPS = [
  { key: 'vr',     label: 'ВР',     test: n => n.includes('Выпускающий режиссер') },
  { key: 'prod',   label: 'Прод',   test: n => n.includes('Продюсер') },
  { key: 'replay', label: 'Повт',   test: n => n.includes('Режиссер повторов') },
  { key: 'gfx',    label: 'Титры',  test: n => n.includes('Режиссер графики') },
  { key: 'sound',  label: 'Звук',   test: n => n.includes('Звукорежиссер') },
  { key: 'dir',    label: 'Реж',    test: n => n.includes('Режиссер') },
  { key: 'eng',    label: 'Инж',    test: n => n.includes('Инженер') },
  { key: 'cam',    label: 'Опер',   test: n => n.includes('Видеооператор') },
];
/** Порядок колонок в интерфейсе (отличается от порядка проверки выше). */
export const COLUMN_ORDER = ['vr', 'prod', 'dir', 'replay', 'gfx', 'sound', 'eng', 'cam', 'other'];

export function normalizeFio(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function roleGroupKey(lineName) {
  const name = lineName || '';
  const g = ROLE_GROUPS.find(r => r.test(name));
  return g ? g.key : 'other';
}

export function isTargetItem(item) {
  if (!item || !item.service || !TARGET_SERVICES.includes(item.service.name)) return false;
  const league = item.event && item.event.league ? item.event.league.short_name : null;
  if (league && EXCLUDED_LEAGUES.includes(league)) return false;
  return true;
}

export function eventTitle(event) {
  if (event.home_team && event.away_team) return `${event.home_team.name} — ${event.away_team.name}`;
  if (event.home_team) return event.home_team.name;
  return event.additional_info || event.event_description || '';
}

function executorOf(line) {
  const at = line.assignment_technical;
  if (at && at.employee) {
    const e = at.employee;
    return { id: e.id, name: normalizeFio(`${e.last_name || ''} ${e.first_name || ''}`) };
  }
  if (line.assignment_contractor && line.assignment_contractor.contractor) {
    return { id: null, name: normalizeFio(line.assignment_contractor.contractor.name) };
  }
  return null;
}

function statusOf(line) {
  const at = line.assignment_technical;
  return at && at.employee ? (at.status || 'pending') : '';
}

function badgesFor(item, groupKey) {
  if (groupKey !== 'gfx') return [];
  return (item.additional_services || [])
    .map(x => x.additional_service && x.additional_service.short_name)
    .filter(sn => sn === 'GTZp' || sn === 'БК');
}

function toSlot(line, item, groupKey) {
  const ex = executorOf(line);
  const at = line.assignment_technical;
  return {
    lineId: line.id,
    assignmentId: at && at.employee ? at.id : null,
    roleId: line.line ? line.line.id : null,
    roleName: line.line ? line.line.name : '',
    badges: badgesFor(item, groupKey),
    employee: ex,
    status: statusOf(line),
    // true/false только когда человек реально назначен; null — слот пуст
    hasRate: at && at.employee ? !!at.expense_assignment_technical : null,
    logistics: at && at.logistics ? at.logistics : null,
    expenseId: at && at.expense_assignment_technical ? at.expense_assignment_technical.id || null : null,
    // допуслуги, уже стоящие у назначения (id справочника): link-id из назначения -> услуга
    additionalIds: at && at.employee ? (at.event_service_additional_service_list || [])
      .map(lid => (item.additional_services || []).find(x => x.id === lid))
      .filter(x => x && x.additional_service).map(x => x.additional_service.id) : [],
  };
}

/** Строка доски для одной услуги мероприятия. */
export function buildRow(item) {
  const ev = item.event || {};
  const slotsByGroup = {};
  for (const key of COLUMN_ORDER) slotsByGroup[key] = [];

  for (const line of item.event_service_lines || []) {
    const key = roleGroupKey(line.line ? line.line.name : '');
    slotsByGroup[key].push(toSlot(line, item, key));
  }

  // Подрядчик: вся техническая часть (без ВР) закрыта одним ИП/СЗ/АНО/ООО/ОГАУ
  const techSlots = COLUMN_ORDER.filter(k => k !== 'vr').flatMap(k => slotsByGroup[k]);
  const names = [...new Set(techSlots.map(s => s.employee && s.employee.name).filter(Boolean))];
  let contractor = null;
  if (names.length === 1 && CONTRACTOR_RE.test(names[0])) {
    const filled = techSlots.filter(s => s.employee);
    const statuses = filled.map(s => s.status).filter(Boolean);
    let status = 'pending';
    if (statuses.includes('declined')) status = 'declined';
    else if (statuses.length && statuses.every(s => s === 'appointed')) status = 'appointed';
    contractor = { name: names[0], status, slots: filled.length };
  }

  const allSlots = Object.values(slotsByGroup).flat();
  const filled = allSlots.filter(s => s.employee).length;

  return {
    eventServiceId: item.id,
    eventId: ev.id,
    date: ev.date,
    start: ev.start_time ? ev.start_time.substring(0, 5) : '',
    end: ev.end_time ? ev.end_time.substring(0, 5) : '',
    league: ev.league ? ev.league.short_name : '',
    title: eventTitle(ev),
    service: item.service ? item.service.name : '',
    cancelled: !!(item.service_status && String(item.service_status).indexOf('Отмен') === 0),
    serviceStatus: item.service_status || '',
    // доп.услуги, доступные в этой услуге мероприятия: id из справочника + короткое/полное название
    additionalServices: (item.additional_services || [])
      .filter(x => x && x.additional_service && x.additional_service.id != null)
      .map(x => ({ id: x.additional_service.id, short: x.additional_service.short_name || x.additional_service.name || '', name: x.additional_service.name || '' })),
    additional: (item.additional_services || [])
      .map(x => x.additional_service && x.additional_service.short_name).filter(Boolean),
    slots: slotsByGroup,
    contractor,
    stats: {
      total: allSlots.length,
      filled,
      accepted: allSlots.filter(s => s.status === 'appointed').length,
      declined: allSlots.filter(s => s.status === 'declined').length,
      noRate: allSlots.filter(s => s.employee && s.hasRate === false).length,
      cameras: slotsByGroup.cam.length,
      camerasFilled: slotsByGroup.cam.filter(s => s.employee).length,
    },
  };
}

/** Вся доска: отфильтрованные услуги, сгруппированные по дням, внутри дня по времени. */
/** all=true — не фильтровать по услугам и лигам (все мероприятия, что есть в BMS). */
export function buildBoard(items, { all = false } = {}) {
  const rows = items.filter(i => i && i.event && (all || isTargetItem(i))).map(buildRow);
  rows.sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') ||
    (a.start || '').localeCompare(b.start || '') ||
    (a.eventId || 0) - (b.eventId || 0) ||
    a.service.localeCompare(b.service));

  const days = [];
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) {
      const d = { date: r.date, rows: [] };
      byDate.set(r.date, d);
      days.push(d);
    }
    byDate.get(r.date).rows.push(r);
  }
  const leagues = [...new Set(rows.map(r => r.league).filter(Boolean))].sort();
  return { days, leagues, total: rows.length };
}
