// Чистая логика вкладки «СТУДИИ»: время, пересечения, подсчёт ВР. Без DOM — проверяется тестами.
(function (root) {
  const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
  /** Интервал матча в минутах от начала его даты; конец раньше начала = переход через полночь. */
  function span(m) {
    const s = toMin(m.start); let e = toMin(m.end);
    if (s == null || e == null) return null;
    if (e <= s) e += 1440;
    return [s, e];
  }
  const alive = m => m.status !== 'отмена';

  /** Пересекаются ли два матча (tol — допустимый нахлёст в минутах). */
  function overlap(a, b, tol) {
    const x = span(a), y = span(b);
    if (!x || !y) return false;
    return Math.min(x[1], y[1]) - Math.max(x[0], y[0]) > (tol || 0);
  }

  /** Матчи, с которыми конфликтует m на том же ПК той же студии в тот же день. */
  function pcConflicts(m, all, tol) {
    if (!m.pc || !m.studio || !alive(m)) return [];
    return all.filter(o => o.id !== m.id && alive(o) && o.date === m.date && o.studio === m.studio && o.pc === m.pc && overlap(m, o, tol));
  }

  /**
   * Может ли ВР, у которого уже есть матчи list, взять матч m.
   * cfg.pause — пауза между матчами (мин); cfg.cap — сколько матчей одного проекта можно вести одновременно (1 = параллели нет).
   * Параллель возможна только внутри одного проекта.
   */
  function canTake(list, m, cfg) {
    const sm = span(m); if (!sm) return true;
    let par = 0;
    for (const x of list) {
      if (x.id === m.id || !alive(x) || x.date !== m.date) continue;
      const sx = span(x); if (!sx) continue;
      const ov = Math.min(sx[1], sm[1]) - Math.max(sx[0], sm[0]) > 0;
      if (ov) {
        const same = x.project && x.project === m.project;
        if (!(same && cfg.cap > 1)) return false;
        par++;
      } else {
        const gap = sm[0] >= sx[1] ? sm[0] - sx[1] : sx[0] - sm[1];
        if (gap < cfg.pause) return false;
      }
    }
    return par + 1 <= cfg.cap;
  }

  /** Минимальное число ВР на день (жадно по началу матча) + раскладка. */
  function minVr(matches, cfg) {
    const list = matches.filter(alive).slice().sort((a, b) => (span(a) || [0])[0] - (span(b) || [0])[0]);
    const bins = [];
    for (const m of list) {
      if (!span(m)) continue;
      const b = bins.find(bin => canTake(bin, m, cfg));
      if (b) b.push(m); else bins.push([m]);
    }
    return { count: bins.length, bins };
  }

  // ПК по студиям: с кабинками для комментаторов и без них («со стадиона»)
  const PC_POOLS = {
    'Калужская': { cabin: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '17'], plain: ['12', '13', '14', '15', '16', '19', '20'] },
    'Сходненская': { cabin: ['21'], plain: [] },
  };
  /**
   * Нужна ли кабинка. Столбец «кабинка» источника: «нет» — не нужна, «да» — нужна.
   * Иначе: комментатор не проставлен — его ещё не назначили, кабинка нужна; «со стадиона» — не нужна.
   */
  function needsCabin(m) {
    const cab = String(m.cabin || '').trim().toLowerCase();
    if (cab === 'нет') return false;
    if (cab === 'да') return true;
    const c = String(m.comm || '').trim().toLowerCase();
    return !c.startsWith('со стадион');
  }
  /**
   * Черновик расстановки ПК для матчей без ПК. Занятые ПК не трогаем.
   * Возвращает { assign: {id: pc}, miss: [match] }.
   */
  function planPcs(all, targets, tol) {
    const assign = {}, miss = [];
    const work = all.map(m => ({ ...m }));
    const byId = new Map(work.map(m => [m.id, m]));
    const todo = targets.filter(m => alive(m) && !m.pc && PC_POOLS[m.studio] && span(m)).map(m => byId.get(m.id))
      .sort((a, b) => a.date.localeCompare(b.date) || span(a)[0] - span(b)[0]);
    for (const m of todo) {
      const pool = PC_POOLS[m.studio][needsCabin(m) ? 'cabin' : 'plain'];
      const free = pool.filter(pc => !work.some(o => o.id !== m.id && alive(o) && o.date === m.date && o.studio === m.studio && o.pc === pc && overlap(m, o, tol)));
      if (!free.length) { miss.push(m); continue; }
      // тот же проект в этот день — стараемся на том же ПК
      const same = free.find(pc => work.some(o => o.date === m.date && o.studio === m.studio && o.pc === pc && o.project && o.project === m.project));
      m.pc = same || free[0]; assign[m.id] = m.pc;
    }
    return { assign, miss };
  }

  /**
   * Черновик расстановки ВР для матчей без ВР.
   * info: { today: 'ГГГГ-ММ-ДД', vrs: { имя: { n, last, label, proj: {проект: число} } } }
   * Правила: жёсткие — пауза/параллель (canTake); мягкие — опыт в проекте, метка, повторное использование
   * уже занятых в этот день ВР (меньше людей), равномерность.
   */
  function planVrs(all, targets, info, cfg) {
    const assign = {}, miss = [];
    const active = Object.keys(info.vrs).filter(n => {
      const e = info.vrs[n]; return e.n > 0 && (new Date(info.today) - new Date(e.last)) / 86400000 <= 120;
    });
    const load = new Map();                           // 'дата|имя' → матчи
    const key = (d, n) => d + '|' + n;
    for (const m of all) if (m.vr && alive(m)) { const k = key(m.date, m.vr); (load.get(k) || load.set(k, []).get(k)).push(m); }
    const todo = targets.filter(m => alive(m) && !m.vr && span(m)).slice().sort((a, b) => a.date.localeCompare(b.date) || span(a)[0] - span(b)[0]);
    for (const m of todo) {
      const names = new Set(active);
      for (const k of load.keys()) if (k.startsWith(m.date + '|')) names.add(k.slice(11));
      let best = null, bestScore = -Infinity;
      for (const n of [...names].sort()) {
        const list = load.get(key(m.date, n)) || [];
        if (!canTake(list, m, cfg)) continue;
        const e = info.vrs[n] || { n: 0, proj: {}, label: 'новичок' };
        const exp = (e.proj && e.proj[m.project]) || 0;
        let sc = Math.min(Math.log2(1 + exp) * 3, 12);
        if (e.label === 'опытный') sc += 2; else if (e.label === 'нестабильный') sc -= 2; else sc -= 3;
        if (!exp) sc -= e.label === 'новичок' ? 6 : 2;
        if (list.length) { sc += 4; if (list.some(x => x.project === m.project)) sc += 3; }
        sc -= Math.max(0, list.length - 3) * 1.5;
        if (sc > bestScore) { bestScore = sc; best = n; }
      }
      if (!best) { miss.push(m); continue; }
      assign[m.id] = best;
      const k = key(m.date, best); (load.get(k) || load.set(k, []).get(k)).push({ ...m, vr: best });
    }
    return { assign, miss };
  }

  const api = { planVrs, PC_POOLS, needsCabin, planPcs, toMin, span, overlap, pcConflicts, canTake, minVr, alive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StudiosCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
