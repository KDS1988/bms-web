/**
 * График персонала и кандидаты на роль. Порт логики staff-schedule из Apps Script,
 * но без таблицы: данные идут прямо в интерфейс.
 */
import { normalizeFio, eventTitle } from './board.js';

export function deptInfo(employee) {
  const jt = employee.user_job_titles && employee.user_job_titles[0];
  const title = jt && jt.job_title ? jt.job_title.name : '';
  const dept = jt && jt.job_title && jt.job_title.job_title_block && jt.job_title.job_title_block.unit
    ? jt.job_title.job_title_block.unit.name : '';
  return { title, dept };
}

export function dateRange(fromIso, toIso) {
  const out = [];
  const d = new Date(fromIso + 'T00:00:00Z');
  const end = new Date(toIso + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function assignmentLabel(a) {
  const es = a.event_service;
  const ev = es ? es.event : null;
  if (!ev) return es && es.service ? es.service.name : 'занят';
  const league = ev.league ? ev.league.short_name : '';
  const time = ev.start_time ? ev.start_time.substring(0, 5) : '';
  return [league, eventTitle(ev), time].filter(Boolean).join(' ');
}

/** Состояние одного дня сотрудника: free | busy | off (+ чем занят). */
export function dayState(day) {
  if (!day) return { state: 'free', items: [] };
  const items = (day.assignments || []).map(assignmentLabel);
  if (items.length) return { state: 'busy', items };
  if (day.is_dayoff) return { state: 'off', items: [] };
  return { state: 'free', items: [] };
}

/**
 * Сливает ответы по амплуа в список сотрудников: один сотрудник — одна строка,
 * у него список амплуа (с категорией) и состояние на каждую дату.
 * entriesByLine: [{ line:{id,name}, entries:[{employee, days}] }]
 */
export function buildStaff(entriesByLine, dates) {
  const byId = new Map();
  for (const { line, entries } of entriesByLine) {
    for (const entry of entries || []) {
      const emp = entry.employee;
      if (!emp) continue;
      let rec = byId.get(emp.id);
      if (!rec) {
        const { title, dept } = deptInfo(emp);
        const daysByDate = {};
        (entry.days || []).forEach(d => { daysByDate[d.date] = d; });
        const days = {};
        for (const d of dates) days[d] = dayState(daysByDate[d]);
        rec = {
          id: emp.id,
          name: normalizeFio(`${emp.last_name || ''} ${emp.first_name || ''} ${emp.middle_name || ''}`),
          phone: emp.phone_number || '',
          title, dept, lines: [], days,
        };
        byId.set(emp.id, rec);
      }
      const cat = (emp.user_line_categories || []).find(c => c.line && c.line.id === line.id);
      if (!rec.lines.some(l => l.id === line.id)) {
        rec.lines.push({ id: line.id, name: line.name, category: cat ? cat.category : '' });
      }
    }
  }
  const employees = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const lines = [...new Map(entriesByLine.map(e => [e.line.id, e.line.name])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { dates, lines, employees };
}

/** Кандидаты на конкретную роль и дату: свободные, затем занятые, затем «не может». */
export function buildCandidates(entries, date, lineId) {
  const rank = { free: 0, busy: 1, off: 2 };
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const emp = entry.employee;
    if (!emp || seen.has(emp.id)) continue;
    seen.add(emp.id);
    const day = (entry.days || []).find(d => d.date === date);
    const st = dayState(day);
    const cat = (emp.user_line_categories || []).find(c => c.line && c.line.id === lineId);
    out.push({
      id: emp.id,
      name: normalizeFio(`${emp.last_name || ''} ${emp.first_name || ''} ${emp.middle_name || ''}`),
      state: st.state,
      busyWith: st.items,
      category: cat ? cat.category || '' : '',
    });
  }
  out.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'ru'));
  return out;
}

/**
 * Кандидаты из users/user/employee_list (тот же запрос использует интерфейс BMS при назначении):
 * сервер уже отдаёт сотрудников выбранного амплуа на дату с флагами is_dayoff («не может») и is_assigned («занят»).
 */
export function buildCandidatesFromList(list, lineId) {
  const rank = { free: 0, busy: 1, off: 2 };
  const seen = new Set();
  const out = [];
  for (const emp of list || []) {
    if (!emp || seen.has(emp.id)) continue;
    seen.add(emp.id);
    const cat = (emp.user_line_categories || []).find(c => c.line && c.line.id === lineId);
    out.push({
      id: emp.id,
      name: normalizeFio(`${emp.last_name || ''} ${emp.first_name || ''} ${emp.middle_name || ''}`),
      state: emp.is_dayoff ? 'off' : (emp.is_assigned ? 'busy' : 'free'),
      busyWith: [],
      category: cat ? cat.category || '' : '',
    });
  }
  out.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name, 'ru'));
  return out;
}
