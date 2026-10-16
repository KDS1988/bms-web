/**
 * Клиент BMS поверх fetch. Токен достаём через getToken(force) — на практике это
 * Durable Object (см. session.js), который сериализует обновление refresh-токена.
 * Все запросы к BMS ходят только отсюда.
 */

export const BMS_BASE = 'https://bms-api.vsporteru.ru/api/v1/bms';
const BMS_HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://bms.vsporteru.ru',
  referer: 'https://bms.vsporteru.ru/',
};

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
    const url = `${BMS_BASE}/${path}${qs}`;
    let force = false;
    let lastErr;

    for (let attempt = 1; attempt <= 3; attempt++) {
      let resp;
      try {
        const token = await this.getToken(force);
        resp = await this.fetch(url, {
          method,
          headers: {
            ...BMS_HEADERS,
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

/** Link-записи доп.услуг ВР (БК/рек) — именно их id ждёт назначение, а не id из справочника. */
export async function vrAdditionalServiceLinkIds(client, eventServiceId) {
  const records = await client.get(`projects/event_service_additional_service/${eventServiceId}`);
  if (!Array.isArray(records)) return [];
  return records.filter(r => r && VR_ADDITIONAL_CATALOG_IDS.includes(r.additional_service_id)).map(r => r.id);
}

/** Запись расхода (ставки): без неё назначение остаётся «без денег». line_manual_rate:null — автоматический расчёт. */
export function postExpense(client, { eventServiceId, lineId, assignmentId, employeeId, logistics }) {
  return client.post('accounting/expense/assignment/technical', {
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
    event_service_video_task_list: [],
  });
}

/**
 * Двухшаговое назначение: (1) создаём назначение, (2) создаём запись ставки.
 * Если шаг 2 не удался — НЕ глотаем молча: возвращаем rate:'failed', чтобы
 * интерфейс показал предупреждение, а ставку можно было доначислить кнопкой «Ставки».
 */
export async function assignEmployee(client, { eventServiceId, lineId, employeeId, isVr }) {
  let additional = [];
  let logistics = null;
  if (isVr) {
    logistics = VR_LOGISTICS;
    additional = await vrAdditionalServiceLinkIds(client, eventServiceId);
  }

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
    await postExpense(client, { eventServiceId, lineId, assignmentId: assignment.id, employeeId, logistics });
    return { assignmentId: assignment.id, rate: 'ok', additionalServiceIds: additional };
  } catch (e) {
    return { assignmentId: assignment.id, rate: 'failed', rateError: String(e.message || e), additionalServiceIds: additional };
  }
}
