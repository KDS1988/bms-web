/**
 * Клиент BMS поверх fetch. Токен достаём через getToken(force) — на практике это
 * Durable Object (см. session.js), который сериализует обновление refresh-токена.
 * Все запросы к BMS ходят только отсюда.
 */

// BMS жил на двух доменах (vsporteru.ru и vsporte.ru): пробуем по очереди и запоминаем рабочий
export const BMS_HOSTS = [
  { api: 'https://bms-api.vsporteru.ru/api/v1/bms', origin: 'https://bms.vsporteru.ru' },
  { api: 'https://bms-api.vsporte.ru/api/v1/bms', origin: 'https://bms.vsporte.ru' },
];
let hostIdx = 0;
const ACCEPT = 'application/json, text/plain, */*';

/** fetch к BMS по относительному пути; при сетевом сбое или 52x/530 пробует другой домен. */
export async function bmsFetch(fetchImpl, path, init = {}) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  let lastErr, lastResp;
  for (let i = 0; i < BMS_HOSTS.length; i++) {
    const idx = (hostIdx + i) % BMS_HOSTS.length;
    const h = BMS_HOSTS[idx];
    try {
      const resp = await f(`${h.api}/${path}`, {
        ...init, headers: { accept: ACCEPT, origin: h.origin, referer: h.origin + '/', ...(init.headers || {}) },
      });
      if (resp.status >= 520 && resp.status <= 530 && i < BMS_HOSTS.length - 1) { lastResp = resp; continue; }
      hostIdx = idx;
      return resp;
    } catch (e) { lastErr = e; }
  }
  if (lastResp) return lastResp;
  throw lastErr;
}

// ВР: допуслуги из справочника (БК — графика бродкастер, рек — врезка рекламы) и фикс. логистика
export const VR_LINE_NAME = 'Выпускающий режиссер';
export const VR_ADDITIONAL_CATALOG_IDS = [8, 10];
export const VR_LOGISTICS = '📡 - Работает удаленно/не на площадке';

export class BmsError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'BmsError';
    this.status = status;
    this.body = body;
  }
}
export class AlreadyExistsError extends BmsError {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class BmsClient {
  /** @param getToken async (force:boolean) => accessToken */
  constructor(getToken, fetchImpl) {
    this.getToken = getToken;
    // fetch нельзя вызывать как метод объекта (Illegal invocation в Workers) — оборачиваем
    this.fetch = (...args) => (fetchImpl || globalThis.fetch)(...args);
  }

  async #request(method, path, { params, body } = {}) {
    const qs = params
      ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const rel = `${path}${qs}`;
    let force = false;
    let lastErr;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let resp;
      try {
        const token = await this.getToken(force);
        resp = await bmsFetch(this.fetch, rel, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        // сетевой сбой — повторяем (только если это не ошибка входа)
        if (e instanceof BmsError) throw e;
        lastErr = e;
        await sleep(400 * attempt);
        continue;
      }

      if (resp.status === 401 && !force) { force = true; attempt--; continue; }
      const text = await resp.text();
      if (resp.ok) return text ? JSON.parse(text) : null;

      // 5xx — транзиентные, повторяем только безопасные GET
      if (resp.status >= 500 && method === 'GET' && attempt < 3) {
        lastErr = new BmsError(`BMS ${method} ${path} -> ${resp.status}`, resp.status, text);
        await sleep(400 * attempt);
        continue;
      }
      if (resp.status === 400 && /already exists/i.test(text)) {
        throw new AlreadyExistsError('Такое назначение уже есть в BMS', 400, text);
      }
      throw new BmsError(`BMS ${method} ${path} -> ${resp.status}: ${text.slice(0, 300)}`, resp.status, text);
    }
    throw lastErr || new BmsError(`BMS ${method} ${path}: нет ответа`, 0, '');
  }

  get(path, params) { return this.#request('GET', path, { params }); }
  post(path, body) { return this.#request('POST', path, { body }); }
  put(path, body) { return this.#request('PUT', path, { body }); }
  delete(path) { return this.#request('DELETE', path); }
}

/** Все назначения за период: первая страница, остальные — параллельно. */
export async function fetchAssignments(client, dateFrom, dateTo) {
  const q = page => ({
    page, size: 100, order_by: '+date,start_time,id', date__gte: dateFrom, date__lte: dateTo,
  });
  const first = await client.get('projects/assignment_table/technical', q(1));
  let items = first.items || [];
  const pages = first.pages || 1;
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => client.get('projects/assignment_table/technical', q(i + 2)))
    );
    for (const p of rest) items = items.concat(p.items || []);
  }
  return items;
}

/** Link-записи доп.услуг: именно их id ждёт назначение, а не id из справочника. */
export async function additionalLinkIds(client, eventServiceId, catalogIds) {
  if (!catalogIds.length) return [];
  const records = await client.get(`projects/event_service_additional_service/${eventServiceId}`);
  if (!Array.isArray(records)) return [];
  return records.filter(r => r && catalogIds.includes(r.additional_service_id)).map(r => r.id);
}
export const vrAdditionalServiceLinkIds = (client, eventServiceId) =>
  additionalLinkIds(client, eventServiceId, VR_ADDITIONAL_CATALOG_IDS);

/** Запись расхода (ставки): без неё назначение остаётся «без денег». line_manual_rate:null — автоматический расчёт. */
export async function postExpense(client, { eventServiceId, lineId, assignmentId, employeeId, logistics, additionalServiceIds = [], expenseId = null }) {
  const base = {
    event_service_id: eventServiceId,
    event_service_line_id: lineId,
    assignment_technical_id: assignmentId,
    assignment_creative_id: null,
    assignment_video_id: null,
    assignment_data_sport_id: null,
    employee_id: employeeId,
    line_manual_rate: null,
    logistics: logistics || null,
    bonus: null,
    bonus_comment: null,
    penalty: null,
    penalty_comment: null,
    comment: '',
  };
  if (!expenseId) {
    // новая ставка: BMS сам считает тариф по id допуслуг справочника
    return client.post('accounting/expense/assignment/technical', { ...base, additional_service_ids: additionalServiceIds, event_service_video_task_list: [] });
  }
  // существующая ставка: как в интерфейсе BMS — пересчёт тарифа, затем PUT с id тарифов
  const calc = await client.post('accounting/expense/assignment/technical/pre_calculate_rate', {
    additional_service_ids: additionalServiceIds, employee_id: employeeId,
    event_service_id: eventServiceId, event_service_line_id: lineId, logistics: logistics || null,
  });
  return client.put(`accounting/expense/assignment/technical/${expenseId}`, {
    ...base,
    line_rate_id: calc && calc.line_rate ? calc.line_rate.id : null,
    logistics_rate_id: calc && calc.logistics_rate ? calc.logistics_rate.id : null,
    additional_service_rate_list: ((calc && calc.additional_service_rate_list) || []).map(r => r.id),
  });
}

/**
 * Двухшаговое назначение: (1) создаём назначение, (2) создаём запись ставки.
 * Если шаг 2 не удался — НЕ глотаем молча: возвращаем rate:'failed', чтобы
 * интерфейс показал предупреждение, а ставку можно было доначислить кнопкой «Ставки».
 */
export async function assignEmployee(client, { eventServiceId, lineId, employeeId, isVr, additionalIds = [] }) {
  let logistics = null;
  const wanted = new Set(additionalIds.map(Number).filter(Number.isInteger));
  if (isVr) {                       // ВР всегда: удалённая логистика + БК и рек
    logistics = VR_LOGISTICS;
    VR_ADDITIONAL_CATALOG_IDS.forEach(i => wanted.add(i));
  }
  const additional = await additionalLinkIds(client, eventServiceId, [...wanted]);

  const assignment = await client.post('projects/assignment/technical', {
    comment: '',
    dismantling: false,
    employee_id: employeeId,
    event_service_additional_service_list: additional,
    event_service_id: eventServiceId,
    event_service_line_id: lineId,
    installation: false,
    logistics,
    event_service_video_task_list: [],
  });

  try {
    await postExpense(client, { eventServiceId, lineId, assignmentId: assignment.id, employeeId, logistics, additionalServiceIds: [...wanted] });
    return { assignmentId: assignment.id, rate: 'ok', additionalServiceIds: additional, additionalRequested: wanted.size, additionalApplied: additional.length };
  } catch (e) {
    return { assignmentId: assignment.id, rate: 'failed', rateError: String(e.message || e), additionalServiceIds: additional, additionalRequested: wanted.size, additionalApplied: additional.length };
  }
}

/**
 * Изменить допуслуги у уже существующего назначения (тот же человек): PUT назначения
 * с новым списком link-id, затем обновление ставки с учётом допуслуг. Так делает сам BMS.
 */
export async function updateAssignment(client, { assignmentId, eventServiceId, lineId, employeeId, additionalIds = [], logistics = null, expenseId = null }) {
  const wanted = new Set(additionalIds.map(Number).filter(Number.isInteger));
  const additional = await additionalLinkIds(client, eventServiceId, [...wanted]);
  await client.put(`projects/assignment/technical/${assignmentId}`, {
    comment: '',
    dismantling: false,
    employee_id: employeeId,
    event_service_additional_service_list: additional,
    event_service_id: eventServiceId,
    event_service_line_id: lineId,
    installation: false,
    logistics: logistics || null,
    is_traveling: false,
    travel_route: null,
    event_service_video_task_list: [],
  });
  try {
    await postExpense(client, { eventServiceId, lineId, assignmentId, employeeId, logistics, additionalServiceIds: [...wanted], expenseId });
    return { assignmentId, rate: 'ok', additionalApplied: additional.length, additionalRequested: wanted.size, updated: true };
  } catch (e) {
    return { assignmentId, rate: 'failed', rateError: String(e.message || e), additionalApplied: additional.length, additionalRequested: wanted.size, updated: true };
  }
}
