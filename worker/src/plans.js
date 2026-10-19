/**
 * Мероприятия-черновики: событие, которое уже известно, но ещё не заведено в BMS.
 * Живёт на доске (в общем хранилище). Когда мероприятие появится в BMS, в нём
 * прописывают его ID, и интерфейс переносит вписанных людей в настоящий блок.
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const SERVICES = ['Прямая трансляция', 'Студия'];
const GROUPS = ['vr', 'prod', 'dir', 'replay', 'gfx', 'sound', 'eng', 'cam', 'other'];

export function sanitizePlan(b) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const title = str(b.title, 160);
  if (!title) return { error: 'Укажите название мероприятия' };
  if (!ISO.test(str(b.date, 10))) return { error: 'Укажите дату' };
  const slots = [];
  const seen = new Set();
  for (const s of (Array.isArray(b.slots) ? b.slots : []).slice(0, 60)) {
    const sid = Number(s && s.sid), roleId = Number(s && s.roleId);
    if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(roleId) || roleId <= 0 || seen.has(sid)) continue;
    seen.add(sid);
    slots.push({ sid, roleId, roleName: str(s.roleName, 80), group: GROUPS.includes(s.group) ? s.group : 'other' });
  }
  if (!slots.length) return { error: 'Выберите хотя бы одну роль' };
  const bmsId = Number(b.bmsId);
  const time = v => (TIME.test(str(v, 5)) ? str(v, 5) : '');
  return {
    plan: {
      date: str(b.date, 10), start: time(b.start), end: time(b.end),
      league: str(b.league, 40), city: str(b.city, 60), sport: str(b.sport, 40), info: str(b.info, 200), title, service: SERVICES.includes(b.service) ? b.service : SERVICES[0],
      bmsId: Number.isInteger(bmsId) && bmsId > 0 ? bmsId : null,
      slots,
    },
  };
}

/** Какая строка BMS соответствует мероприятию-черновику: сначала по ID услуги, затем по ID мероприятия. */
export function findBmsRow(plan, rows) {
  if (!plan.bmsId) return null;
  const byService = rows.find(r => r.eventServiceId === plan.bmsId);
  if (byService) return byService;
  const byEvent = rows.filter(r => r.eventId === plan.bmsId);
  return byEvent.find(r => r.service === plan.service) || byEvent[0] || null;
}
