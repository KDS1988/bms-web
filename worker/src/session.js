/**
 * Durable Object — единственный владелец сессии BMS.
 *
 * Почему DO, а не просто KV: refresh-токен BMS ротируется при каждом обновлении.
 * Два параллельных запроса, обновляющие один и тот же токен, «сломают» сессию
 * (второй пришёл со старым токеном). DO обрабатывает это в одном месте и
 * склеивает параллельные обновления в одно.
 */
import { DurableObject } from 'cloudflare:workers';
import { bmsFetch } from './bms.js';
import { mergeDay, repairStudiosNovember28, STUDIOS_REPAIR_DATE } from './studios.js';
import { storedUserAccess } from './auth.js';
import { FhmError, fetchCalendarVenueAddress, loadFhmCalendar, verifyFhmKey } from './fhm.js';
import { readFhmCache, writeFhmCache, deleteFhmCache } from './fhm-cache.js';

export const LOGIN_REQUIRED = 'BMS_LOGIN_REQUIRED';

function jwtExpMs(jwt) {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

export class BmsSession extends DurableObject {
  #inflight = null;
  #lastRefreshAt = 0;
  #fhmFlight = null;

  async #load() {
    return (await this.ctx.storage.get('session')) || null;
  }

  async #refresh() {
    const s = await this.#load();
    if (!s || !s.refreshToken) throw new Error(LOGIN_REQUIRED);
    const r = await bmsFetch(null, 'users/token/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    if (!r.ok) throw new Error(`${LOGIN_REQUIRED}: refresh ${r.status}`);
    const d = await r.json();
    const next = {
      ...s,
      accessToken: d.access_token,
      accessExp: jwtExpMs(d.access_token) || Date.now() + 5 * 60 * 1000,
      refreshToken: d.refresh_token || s.refreshToken, // токен ротируется
    };
    await this.ctx.storage.put('session', next);
    this.#lastRefreshAt = Date.now();
    return next.accessToken;
  }

  /** force=true — токен отвергнут BMS (401); обновляем, но не чаще раза в 5 секунд. */
  async getAccessToken(force = false) {
    const s = await this.#load();
    if (s && s.accessToken && !force && s.accessExp - 60_000 > Date.now()) return s.accessToken;
    if (force && s && s.accessToken && Date.now() - this.#lastRefreshAt < 5000) return s.accessToken;
    if (!this.#inflight) {
      this.#inflight = this.#refresh().finally(() => { this.#inflight = null; });
    }
    return this.#inflight;
  }

  async requestOtp(phone) {
    const r = await bmsFetch(null, `notifications/user/send_otp?phone_number=${encodeURIComponent(phone)}`, {
      method: 'POST',
    });
    return { ok: r.ok, status: r.status, message: r.ok ? '' : (await r.text()).slice(0, 200) };
  }

  async login(phone, code, byEmail) {
    const r = await bmsFetch(null, 'users/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone_number: phone, otp_code: code }),
    });
    if (!r.ok) return { ok: false, message: (await r.text()).slice(0, 200) };
    const d = await r.json();
    await this.ctx.storage.put('session', {
      accessToken: d.access_token,
      accessExp: jwtExpMs(d.access_token) || Date.now() + 5 * 60 * 1000,
      refreshToken: d.refresh_token,
      phone, loginBy: byEmail, loginAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  async status() {
    const s = await this.#load();
    return s ? { loggedIn: true, phone: s.phone || '', loginBy: s.loginBy || '', loginAt: s.loginAt || '' } : { loggedIn: false };
  }

  // ---- общий черновик доски: его видят и меняют все участники
  async drafts(since) {
    const [v, bv] = await Promise.all([this.ctx.storage.get('dv'), this.ctx.storage.get('bv')]);
    const version = v || 0, boardVersion = bv || 0;
    if (since === version) return { version, boardVersion, unchanged: true };
    return { version, boardVersion, drafts: (await this.ctx.storage.get('drafts')) || {} };
  }

  async draftSet(key, rec) {
    const drafts = (await this.ctx.storage.get('drafts')) || {};
    drafts[key] = rec;
    await this.ctx.storage.put({ drafts, dv: ((await this.ctx.storage.get('dv')) || 0) + 1 });
  }

  async draftDelete(keys) {
    const drafts = (await this.ctx.storage.get('drafts')) || {};
    let changed = false;
    for (const k of keys === '*' ? Object.keys(drafts) : keys) if (k in drafts) { delete drafts[k]; changed = true; }
    if (changed) await this.ctx.storage.put({ drafts, dv: ((await this.ctx.storage.get('dv')) || 0) + 1 });
  }

  /** Сообщает всем, что данные в BMS изменились — клиенты перезагрузят доску. */
  async bumpBoard() {
    await this.ctx.storage.put({ bv: ((await this.ctx.storage.get('bv')) || 0) + 1, lw: Date.now() });
  }

  // Записи без role созданы до появления прав по разделам.
  async userAccess(email) {
    const user = (await this.ctx.storage.get('users'))?.[String(email).toLowerCase()];
    return storedUserAccess(user);
  }

  async requestAccess(email, name) {
    const e = String(email).toLowerCase();
    await this.ctx.storage.transaction(async txn => {
      if ((await txn.get('users'))?.[e]) return;
      const requests = (await txn.get('requests')) || {};
      requests[e] = { name: String(name || '').slice(0, 120), at: new Date().toISOString() };
      await txn.put('requests', requests);
    });
  }

  async usersList() {
    return { users: (await this.ctx.storage.get('users')) || {}, requests: (await this.ctx.storage.get('requests')) || {} };
  }

  async userSetAccess(email, access, by) {
    await this.ctx.storage.transaction(async txn => {
      const users = (await txn.get('users')) || {};
      const requests = (await txn.get('requests')) || {};
      const { name, addedAt, addedBy } = users[email] || {
        name: requests[email]?.name || '', addedAt: new Date().toISOString(), addedBy: by,
      };
      users[email] = { name, addedAt, addedBy, ...access };
      delete requests[email];
      await txn.put({ users, requests });
    });
  }

  async userReject(email) {
    await this.ctx.storage.transaction(async txn => {
      const requests = (await txn.get('requests')) || {};
      delete requests[email];
      await txn.put('requests', requests);
    });
  }

  async userRemove(email) {
    await this.ctx.storage.transaction(async txn => {
      const users = (await txn.get('users')) || {};
      delete users[email];
      await txn.put('users', users);
    });
  }

  // ---- порядок блоков внутри дня (общий для всех): { 'ГГГГ-ММ-ДД': [eventServiceId…] }
  async orderGet(from, to) {
    const all = (await this.ctx.storage.get('order')) || {};
    const out = {};
    for (const d of Object.keys(all)) if (d >= from && d <= to) out[d] = all[d];
    return out;
  }

  async orderSet(date, ids) {
    const all = (await this.ctx.storage.get('order')) || {};
    if (ids.length) all[date] = ids; else delete all[date];
    const keys = Object.keys(all).sort();
    while (keys.length > 500) delete all[keys.shift()];       // старые даты не копим
    await this.ctx.storage.put({ order: all, lw: Date.now(), bv: ((await this.ctx.storage.get('bv')) || 0) + 1 });
  }

  // ---- мероприятия-черновики (ещё нет в BMS); id растёт, в черновике ключ строится как «-id:sid»
  async plansGet(from, to) {
    const all = (await this.ctx.storage.get('plans')) || {};
    return Object.values(all).filter(p => p.date >= from && p.date <= to);
  }

  async planSave(id, plan, by) {
    const all = (await this.ctx.storage.get('plans')) || {};
    let seq = (await this.ctx.storage.get('planSeq')) || 0;
    if (id) { if (!all[id]) return null; } else id = ++seq;
    all[id] = { ...(all[id] || {}), ...plan, id, by, at: new Date().toISOString() };
    await this.ctx.storage.put({ plans: all, planSeq: seq, bv: ((await this.ctx.storage.get('bv')) || 0) + 1 });
    return all[id];
  }

  // ---- паровозик (командировка): ключ «e<id мероприятия>» или «p<id черновика>»
  async tripsGet(from, to) {
    const all = (await this.ctx.storage.get('trips')) || {};
    return Object.keys(all).filter(k => all[k].date >= from && all[k].date <= to);
  }

  async tripSet(key, date, on, by) {
    const all = (await this.ctx.storage.get('trips')) || {};
    if (on) all[key] = { date, by, at: new Date().toISOString() }; else delete all[key];
    const keys = Object.keys(all).sort((a, b) => all[a].date.localeCompare(all[b].date));
    while (keys.length > 3000) delete all[keys.shift()];
    await this.ctx.storage.put({ trips: all, bv: ((await this.ctx.storage.get('bv')) || 0) + 1 });
  }

  async planDelete(id) {
    const all = (await this.ctx.storage.get('plans')) || {};
    if (!all[id]) return;
    delete all[id];
    const trips = (await this.ctx.storage.get('trips')) || {};
    if (trips['p' + id]) { delete trips['p' + id]; await this.ctx.storage.put('trips', trips); }
    const drafts = (await this.ctx.storage.get('drafts')) || {};
    let changed = false;
    for (const k of Object.keys(drafts)) if (k.startsWith(`-${id}:`)) { delete drafts[k]; changed = true; }
    const put = { plans: all, bv: ((await this.ctx.storage.get('bv')) || 0) + 1 };
    if (changed) { put.drafts = drafts; put.dv = ((await this.ctx.storage.get('dv')) || 0) + 1; }
    await this.ctx.storage.put(put);
  }


  async fhmConfig() { return (await this.ctx.storage.get('fhmConfig')) || null; }

  async fhmConfigSet(config) { await this.ctx.storage.put('fhmConfig', config); }

  async fhmConnect(key) {
    const existing = await this.fhmConfig();
    if (existing?.key === key) return { configured: true };
    const retryAt = await this.ctx.storage.get('fhm-retry-at');
    if (retryAt > Date.now()) return { retryAt };
    if (this.#fhmFlight) return { busy: true };
    const request = (async () => {
      try {
        await verifyFhmKey(key);
        await this.fhmConfigSet({ key, revision: crypto.randomUUID() });
        return { configured: true };
      } catch (error) {
        const failure = await this.#fhmFailure(error);
        return { ...failure, invalid: error instanceof FhmError && [401, 403].includes(error.status) };
      }
    })();
    this.#fhmFlight = { key: null, request };
    try { return await request; }
    finally { this.#fhmFlight = null; }
  }

  async #fhmFailure(error) {
    const rateLimited = error instanceof FhmError && error.status === 429;
    const retryAt = rateLimited ? error.retryAt : Date.now() + 60_000;
    await this.ctx.storage.put('fhm-retry-at', retryAt);
    return {
      retryAt, rateLimited,
      error: error instanceof FhmError ? error.message : 'Не удалось обновить календарь ФХМ.',
    };
  }

  #refreshFhm(config, from, to, key) {
    if (this.#fhmFlight) return this.#fhmFlight.key === key
      ? this.#fhmFlight.request : Promise.resolve({ busy: true });
    const request = this.#downloadFhm(config, from, to, key).finally(() => { this.#fhmFlight = null; });
    this.#fhmFlight = { key, request };
    return request;
  }

  async #downloadFhm(config, from, to, key) {
    const storage = this.ctx.storage;
    const checkpointKey = key + ':partial';
    try {
      const retryAt = await storage.get('fhm-retry-at');
      if (retryAt > Date.now()) return { retryAt };
      const checkpoint = await readFhmCache(storage, checkpointKey);
      const progress = checkpoint && checkpoint.at + 6 * 3600000 > Date.now() ? checkpoint.value : null;
      const calendar = await loadFhmCalendar(config.key, from, to, { progress, pageInterval: 1100 });
      const snapshot = await writeFhmCache(storage, key, calendar);
      if (checkpoint) await deleteFhmCache(storage, checkpointKey);
      return { calendar: snapshot.value, updatedAt: snapshot.at };
    } catch (error) {
      const failure = await this.#fhmFailure(error);
      if (error instanceof FhmError && error.progress) {
        await writeFhmCache(storage, checkpointKey, error.progress);
      } else if (error instanceof FhmError && error.status === 400) {
        await deleteFhmCache(storage, checkpointKey);
      }
      return failure;
    }
  }

  async fhmCalendar(from, to, refresh) {
    const config = await this.fhmConfig();
    if (!config) return { configured: false };
    const key = `fhm-month:${config.revision}:${from}`;
    const [record, retryAt] = await Promise.all([
      readFhmCache(this.ctx.storage, key), this.ctx.storage.get('fhm-retry-at'),
    ]);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format();
    const ttl = (to < today ? 12 : 1) * 3600000;
    if (record) {
      const stale = Date.now() - record.at >= ttl;
      if (stale && refresh && !(retryAt > Date.now())) {
        this.ctx.waitUntil(this.#refreshFhm(config, from, to, key).catch(() => {}));
      }
      return { calendar: record.value, updatedAt: record.at, stale, retryAt: retryAt > Date.now() ? retryAt : null };
    }
    if (!refresh) return { configured: true };
    if (retryAt > Date.now()) return { retryAt };
    return this.#refreshFhm(config, from, to, key);
  }

  async fhmVenueAddresses(venues) {
    const keyOf = venue => 'fhm-venue:' + venue.venueId;
    const stored = await this.ctx.storage.get(venues.map(keyOf));
    const now = Date.now(), addresses = {}, writes = {}, missing = [];
    for (const venue of venues) {
      const record = stored.get(keyOf(venue));
      if (record && record.expires > now) {
        if (record.address) addresses[venue.venueId] = record.address;
      } else missing.push(venue);
    }
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(missing.slice(i, i + 3).map(async venue => {
        const address = (await fetchCalendarVenueAddress(venue)) ?? await fetchCalendarVenueAddress(venue);
        if (address === null) return;
        const ttl = address ? 7 * 86400000 : 3600000;
        writes[keyOf(venue)] = { address, expires: now + ttl };
        if (address) addresses[venue.venueId] = address;
      }));
    }
    if (Object.keys(writes).length) await this.ctx.storage.put(writes);
    return addresses;
  }

  async fhmCrews(dates) {
    const days = await this.ctx.storage.get(dates.map(date => 'fhm-crew:' + date));
    return Object.fromEntries([...days].map(([key, crews]) => [key.slice('fhm-crew:'.length), crews]));
  }

  async fhmCrewSet({ date, arena, field, value }) {
    const key = 'fhm-crew:' + date;
    await this.ctx.storage.transaction(async txn => {
      const arenas = (await txn.get(key)) || {};
      const crew = arenas[arena] || {};
      if (value) crew[field] = value;
      else delete crew[field];
      if (Object.keys(crew).length) arenas[arena] = crew;
      else delete arenas[arena];
      if (Object.keys(arenas).length) await txn.put(key, arenas);
      else await txn.delete(key);
    });
  }

  // ---- СТУДИИ: матчи по дням (ключ «sm:ГГГГ-ММ-ДД»), чтобы не упираться в лимит значения
  async studiosGet(from, to) {
    const keys = [];
    for (let d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z'); d <= end; d = new Date(d.getTime() + 86400000)) keys.push('sm:' + d.toISOString().slice(0, 10));
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const got = await this.ctx.storage.get(keys.slice(i, i + 100));
      for (const v of got.values()) out.push(...v);
    }
    const [src, last] = await Promise.all([this.ctx.storage.get('studiosSrc'), this.ctx.storage.get('studiosSync')]);
    return { matches: out, configured: !!(src && src.url), sync: last || null };
  }

  async studiosSrcGet() { return (await this.ctx.storage.get('studiosSrc')) || null; }
  async studiosSrcSet(src) { await this.ctx.storage.put('studiosSrc', src); }

  async #bumpStudios() { await this.ctx.storage.put('bv', ((await this.ctx.storage.get('bv')) || 0) + 1); }

  async studiosSyncApply(matches, minDate, by) {
    const byDate = new Map();
    for (const m of matches) (byDate.get(m.date) || byDate.set(m.date, []).get(m.date)).push(m);
    const repairKey = `studiosRepair:${STUDIOS_REPAIR_DATE}`;
    const [all, repaired] = await Promise.all([
      this.ctx.storage.list({ prefix: 'sm:' }), this.ctx.storage.get(repairKey),
    ]);
    const dates = new Set(byDate.keys());
    for (const k of all.keys()) { const d = k.slice(3); if (d >= minDate) dates.add(d); }
    const put = {}, del = [];
    let added = 0, repair = null;
    for (const d of dates) {
      const key = 'sm:' + d;
      const ex = all.get(key) || [];
      const incoming = byDate.get(d) || [];
      const corrected = d === STUDIOS_REPAIR_DATE && !repaired ? repairStudiosNovember28(ex, incoming) : null;
      const next = mergeDay(corrected || ex, incoming);
      added += next.filter(n => !ex.some(e => e.id === n.id)).length;
      if (corrected) repair = { [key]: next, [repairKey]: true };
      else if (next.length) put[key] = next;
      else if (ex.length) del.push(key);
    }
    if (repair) await this.ctx.storage.put(repair);
    const keys = Object.keys(put);
    for (let i = 0; i < keys.length; i += 100) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, put[k]])));
    for (let i = 0; i < del.length; i += 100) await this.ctx.storage.delete(del.slice(i, i + 100));
    const info = { at: new Date().toISOString(), by, rows: matches.length, added };
    await this.ctx.storage.put('studiosSync', info);
    await this.#bumpStudios();
    return info;
  }

  /** Правка (id есть) или добавление (id нет, manual) одного матча. */
  async studiosSave(id, patch, by) {
    if (id) {
      for (const [k, list] of await this.ctx.storage.list({ prefix: 'sm:' })) {
        const i = list.findIndex(m => m.id === id);
        if (i < 0) continue;
        const cur = list[i];
        const next = { ...cur, ...patch, by, at: new Date().toISOString(), ov: { ...(cur.ov || {}) } };
        for (const f of Object.keys(patch)) next.ov[f] = true;
        list.splice(i, 1);
        if (next.date === cur.date) { list.push(next); await this.ctx.storage.put(k, list); }
        else {
          if (list.length) await this.ctx.storage.put(k, list); else await this.ctx.storage.delete(k);
          const key2 = 'sm:' + next.date, l2 = (await this.ctx.storage.get(key2)) || [];
          l2.push(next); await this.ctx.storage.put(key2, l2);
        }
        await this.#bumpStudios();
        return next;
      }
      return null;
    }
    const seq = ((await this.ctx.storage.get('studioSeq')) || 0) + 1;
    const m = { studio: '', pc: '', project: '', t1: '', t2: '', vr: '', comm: '', status: '', support: '', engineer: '', tri: '', comment: '', scomment: '', ...patch, id: 'm' + seq, manual: true, by, at: new Date().toISOString() };
    const key = 'sm:' + m.date, list = (await this.ctx.storage.get(key)) || [];
    list.push(m);
    await this.ctx.storage.put({ [key]: list, studioSeq: seq });
    await this.#bumpStudios();
    return m;
  }

  async studiosDelete(id) {
    for (const [k, list] of await this.ctx.storage.list({ prefix: 'sm:' })) {
      const i = list.findIndex(m => m.id === id);
      if (i < 0) continue;
      const cur = list[i];
      if (cur.manual) list.splice(i, 1); else list[i] = { ...cur, hidden: true, ov: { ...(cur.ov || {}), hidden: true } };
      await this.ctx.storage.put(k, list);
      await this.#bumpStudios();
      return true;
    }
    return false;
  }


  // ---- история ВР (статистика) и ручные метки
  async vrGet() {
    const [stats, at, manual] = await Promise.all([this.ctx.storage.get('vrstats'), this.ctx.storage.get('vrstatsAt'), this.ctx.storage.get('vrlabels')]);
    return { stats: stats || {}, at: at || null, manual: manual || {} };
  }
  async vrStatsSet(stats) {
    await this.ctx.storage.put({ vrstats: stats, vrstatsAt: new Date().toISOString() });
  }
  async vrLabelSet(name, label, by) {
    const m = (await this.ctx.storage.get('vrlabels')) || {};
    if (label) m[name] = { label, by, at: new Date().toISOString() }; else delete m[name];
    await this.ctx.storage.put('vrlabels', m);
  }

  // ---- снимки доски (сжатый JSON): отдаём мгновенно, обновляем в фоне
  async snapGet(key) {
    const [v, lw] = await Promise.all([this.ctx.storage.get('snap:' + key), this.ctx.storage.get('lw')]);
    return v ? { at: v.at, data: v.data, lw: lw || 0 } : { lw: lw || 0 };
  }

  async snapPut(key, at, data) {
    await this.ctx.storage.put('snap:' + key, { at, data });
  }
}

