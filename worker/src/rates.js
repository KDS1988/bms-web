/** Поиск и доначисление недостающих ставок (порт fixMissingRates из Apps Script). */
import { postExpense } from './bms.js';
import { eventTitle, normalizeFio } from './board.js';

/** Назначения с реальным исполнителем, но без записи о ставке. */
export function findMissingRates(items) {
  const found = [];
  for (const item of items) {
    for (const line of item.event_service_lines || []) {
      const at = line.assignment_technical;
      if (!at || !at.employee) continue;
      if (at.expense_assignment_technical) continue;
      found.push({
        date: item.event && item.event.date,
        title: item.event ? eventTitle(item.event) : '',
        role: line.line ? line.line.name : '',
        employee: normalizeFio(`${at.employee.last_name || ''} ${at.employee.first_name || ''}`),
        eventServiceId: item.id,
        lineId: line.id,
        assignmentId: at.id,
        employeeId: at.employee.id,
        logistics: at.logistics || null,
      });
    }
  }
  return found;
}

/** Доначисляет ставки пачкой (по 4 параллельно, чтобы не душить BMS). */
export async function fixRates(client, list) {
  const fixed = [];
  const failed = [];
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try {
        await postExpense(client, {
          eventServiceId: m.eventServiceId, lineId: m.lineId, assignmentId: m.assignmentId,
          employeeId: m.employeeId, logistics: m.logistics,
        });
        fixed.push(m);
      } catch (e) {
        failed.push({ ...m, error: String(e.message || e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return { fixed, failed };
}
