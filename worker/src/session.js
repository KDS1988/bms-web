/**
 * Durable Object — единственный владелец сессии BMS.
 *
 * Почему DO, а не просто KV: refresh-токен BMS ротируется при каждом обновлении.
 * Два параллельных запроса, обновляющие один и тот же токен, «сломают» сессию
 * (второй пришёл со старым токеном). DO обрабатывает это в одном месте и
 * склеивает параллельные обновления в одно.
 */
import { DurableObject } from 'cloudflare:workers';

const BASE = 'https://bms-api.vsporte.ru/api/v1/bms';
const H = { origin: 'https://bms.vsporte.ru', referer: 'https://bms.vsporte.ru/' };
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
    const r = await fetch(`${BASE}/users/token/refresh`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
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
    const r = await fetch(`${BASE}/notifications/user/send_otp?phone_number=${encodeURIComponent(phone)}`, {
      method: 'POST', headers: H,
    });
    return { ok: r.ok, status: r.status, message: r.ok ? '' : (await r.text()).slice(0, 200) };
  }

  async login(phone, code, byEmail) {
    const r = await fetch(`${BASE}/users/token`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
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
}
