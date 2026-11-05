import type { Ctx } from './env';
import { formatTime, zonedMidnight } from './format';

/**
 * Дані ДТЕК по конкретній адресі: причина відключення і орієнтовний час відновлення —
 * те саме, що показує сторінка «Відключення» на сайті і пише бот ДТЕК.
 *
 * Сторінки сайту закриті антиботом Incapsula, але сама сторінка бере дані POST-запитом
 * на /ua/ajax, і його антибот не перевіряє. Потрібен лише CSRF-токен Yii2: перший POST
 * без токена отримує 400 і cookie з токеном, далі токен іде маскованим у X-CSRF-Token.
 * Механізм описаний у github.com/NetZhizni/ha-dtek-krem-outages (api.py).
 */

const TIMEOUT_MS = 4000;
const USER_AGENT = 'Mozilla/5.0 (compatible; power-health/1.0; personal outage notifier)';
/** Запис ДТЕК, що почався набагато раніше за наше відключення, — це старе відключення */
const MAX_START_DRIFT = 60 * 60_000;

export interface DtekOutage {
  reason: string;
  start: number | null;
  end: number | null;
}

interface RawHouse {
  sub_type?: string;
  start_date?: string;
  end_date?: string;
  sub_type_reason?: string[];
}

class DtekSession {
  private cookie = '';
  private token: string | null = null;

  constructor(private ctx: Ctx) {}

  private get base(): string {
    return (this.ctx.env.DTEK_SITE || 'https://www.dtek-kem.com.ua').replace(/\/$/, '');
  }

  private async post(form: Record<string, string>, token: string | null) {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: this.base,
      Referer: `${this.base}/ua/shutdowns`,
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (token) headers['X-CSRF-Token'] = maskToken(token);
    const res = await this.ctx.http(`${this.base}/ua/ajax`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!;
      const name = pair.split('=')[0]!;
      this.cookie = [...this.cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), pair].join('; ');
      if (name.startsWith('_csrf')) this.token = extractToken(pair.slice(name.length + 1)) ?? this.token;
    }
    return { status: res.status, text: await res.text() };
  }

  /** POST з CSRF-токеном; без токена спершу отримуємо його (сервер відповідає 400 і ставить cookie) */
  async ajax(form: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.token) await this.post({ method: 'getHomeNum' }, null);
    if (!this.token) throw new Error('DTEK did not issue a CSRF token');
    const res = await this.post(form, this.token);
    if (res.text.includes('_Incapsula_Resource')) throw new Error('DTEK answered with the anti-bot challenge');
    if (res.status !== 200) throw new Error(`DTEK HTTP ${res.status}`);
    return JSON.parse(res.text) as Record<string, unknown>;
  }
}

/** Yii2 Security::maskToken: base64url(mask + (mask XOR token)) */
export function maskToken(token: string): string {
  const raw = new TextEncoder().encode(token);
  const mask = crypto.getRandomValues(new Uint8Array(raw.length));
  const out = new Uint8Array(raw.length * 2);
  out.set(mask);
  out.set(raw.map((b, i) => b ^ mask[i]!), raw.length);
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Cookie Yii2 підписаний, але не зашифрований: усередині PHP-серіалізований токен */
function extractToken(cookieValue: string): string | null {
  return decodeURIComponent(cookieValue).match(/i:1;s:\d+:"([^"]+)"/)?.[1] ?? null;
}

export type StreetResult = { ok: true; houses: Record<string, RawHouse> } | { ok: false; notFound: boolean };

export async function fetchStreet(ctx: Ctx, street: string): Promise<StreetResult> {
  try {
    const j = await new DtekSession(ctx).ajax({
      method: 'getHomeNum',
      'data[0][name]': 'street',
      'data[0][value]': street,
      'data[1][name]': 'updateFact',
      'data[1][value]': '',
    });
    if (j.result !== true) return { ok: false, notFound: true };
    const data = j.data;
    return { ok: true, houses: data && typeof data === 'object' ? (data as Record<string, RawHouse>) : {} };
  } catch (err) {
    console.error(`DTEK fetch for "${street}" failed`, err);
    return { ok: false, notFound: false };
  }
}

/** Усі вулиці з сайту ДТЕК (для підказок, коли назву написано неточно) */
export async function fetchStreets(ctx: Ctx): Promise<string[] | null> {
  try {
    const j = await new DtekSession(ctx).ajax({ method: 'getStreets' });
    const s = j.streets;
    if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
    if (s && typeof s === 'object') return Object.values(s).flat().filter((x): x is string => typeof x === 'string');
    return null;
  } catch (err) {
    console.error('DTEK getStreets failed', err);
    return null;
  }
}

const normHouse = (h: string) => h.toLowerCase().replace(/\s+/g, '').replace(/[-–]/g, '/');

/** «70-72» знаходить «70/72»; регістр і пробіли не важливі */
export function findHouseKey(houses: Record<string, unknown>, house: string): string | null {
  const want = normHouse(house);
  return Object.keys(houses).find((k) => normHouse(k) === want) ?? null;
}

/** "HH:MM dd.mm.YYYY" за Києвом → ms */
export function parseDtekDate(value: string | undefined, tz: string): number | null {
  const m = value?.trim().match(/^(\d{1,2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, hh, mm, dd, mo, yyyy] = m.map(Number) as number[];
  return zonedMidnight(yyyy!, mo!, dd!, tz) + (hh! * 60 + mm!) * 60_000;
}

export function toOutage(raw: RawHouse | undefined, tz: string): DtekOutage | null {
  const reason = raw?.sub_type?.trim();
  if (!reason) return null;
  return { reason, start: parseDtekDate(raw!.start_date, tz), end: parseDtekDate(raw!.end_date, tz) };
}

/** "GPV20.1" з запису будинку → "20.1" */
export function groupOf(raw: RawHouse | undefined): string | null {
  return raw?.sub_type_reason?.map((g) => g.match(/(\d{1,2}\.\d)/)?.[1]).find(Boolean) ?? null;
}

export type ConfiguredOutage = { ok: true; outage: DtekOutage | null } | { ok: false };

/** Поточне відключення за адресою з /address. null — ДТЕК нічого не повідомляє. */
export async function fetchAddressOutage(ctx: Ctx, street: string, house: string): Promise<ConfiguredOutage> {
  const res = await fetchStreet(ctx, street);
  if (!res.ok) return { ok: false };
  const key = findHouseKey(res.houses, house);
  return { ok: true, outage: key ? toOutage(res.houses[key], ctx.env.TIMEZONE) : null };
}

/** Відключення ДТЕК, що відповідає нашому (почалось у `at`); старі записи відкидаємо */
export function matchesOutage(o: DtekOutage, at: number): boolean {
  return o.start === null || o.start >= at - MAX_START_DRIFT;
}

export interface TrackedDtek extends DtekOutage {
  /** Перший час відновлення, який повідомив ДТЕК — щоб показати, якщо його перенесли */
  firstEnd: number | null;
}

export function dtekLines(o: TrackedDtek, now: number, tz: string): string[] {
  const lines = [`⚡️ ДТЕК: ${o.reason}`];
  if (o.end === null) {
    lines.push('🕦 Час відновлення ДТЕК ще не повідомив');
  } else {
    const moved = o.firstEnd !== null && o.firstEnd !== o.end ? ` (було ${formatTime(o.firstEnd, tz, now)})` : '';
    lines.push(`🕦 Орієнтовне відновлення: до ${formatTime(o.end, tz, now)}${moved}`);
  }
  return lines;
}
