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

  // ---- пользователи, принятые администратором (все — с правами admin), и запросы на доступ
  async userRole(email) {
    const users = (await this.ctx.storage.get('users')) || {};
    return users[String(email).toLowerCase()] ? 'admin' : null;
  }

  async requestAccess(email, name) {
    const e = String(email).toLowerCase();
    const users = (await this.ctx.storage.get('users')) || {};
    if (users[e]) return;
    const reqs = (await this.ctx.storage.get('requests')) || {};
    reqs[e] = { name: String(name || '').slice(0, 120), at: new Date().toISOString() };
    await this.ctx.storage.put('requests', reqs);
  }

  async usersList() {
    return { users: (await this.ctx.storage.get('users')) || {}, requests: (await this.ctx.storage.get('requests')) || {} };
  }

  async userApprove(email, by) {
    const e = String(email).toLowerCase();
    const users = (await this.ctx.storage.get('users')) || {};
    const reqs = (await this.ctx.storage.get('requests')) || {};
    users[e] = { name: (reqs[e] && reqs[e].name) || '', addedAt: new Date().toISOString(), addedBy: by };
    delete reqs[e];
    await this.ctx.storage.put({ users, requests: reqs });
  }

  async userReject(email) {
    const reqs = (await this.ctx.storage.get('requests')) || {};
    delete reqs[String(email).toLowerCase()];
    await this.ctx.storage.put('requests', reqs);
  }

  async userRemove(email) {
    const users = (await this.ctx.storage.get('users')) || {};
    delete users[String(email).toLowerCase()];
    await this.ctx.storage.put('users', users);
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

  async planDelete(id) {
    const all = (await this.ctx.storage.get('plans')) || {};
    if (!all[id]) return;
    delete all[id];
    const drafts = (await this.ctx.storage.get('drafts')) || {};
    let changed = false;
    for (const k of Object.keys(drafts)) if (k.startsWith(`-${id}:`)) { delete drafts[k]; changed = true; }
    const put = { plans: all, bv: ((await this.ctx.storage.get('bv')) || 0) + 1 };
    if (changed) { put.drafts = drafts; put.dv = ((await this.ctx.storage.get('dv')) || 0) + 1; }
    await this.ctx.storage.put(put);
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

