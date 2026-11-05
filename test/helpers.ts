import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Ctx, Env } from '../src/env';
import type { TgChat, TgUpdate, TgUser } from '../src/telegram';

// node:sqlite завантажуємо через require, щоб Vite не намагався його бандлити
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type SqliteDb = InstanceType<typeof DatabaseSync>;
type Value = string | number | null;

class Stmt {
  constructor(
    private db: SqliteDb,
    private sql: string,
    private params: Value[] = [],
  ) {}
  bind(...params: Value[]) {
    return new Stmt(this.db, this.sql, params);
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() {
    return this.runSync();
  }
  async first<T>() {
    return ((this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params) as T[], meta: {} };
  }
}

/** Мінімальна реалізація D1Database поверх SQLite у пам'яті з усіма міграціями */
export function createD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  const dir = join(import.meta.dirname, '..', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;
}

export const OWNER: TgUser = { id: 100, is_bot: false, first_name: 'Ihor' };
export const STRANGER: TgUser = { id: 300, is_bot: false, first_name: 'Stranger' };
export const CHANNEL = { id: -1009876543210, type: 'channel' as const, title: 'Світло вдома' };

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** 2026-11-05 10:00 за Києвом (UTC+2) */
export const T0 = Date.UTC(2026, 10, 5, 8, 0);

export interface TestCtx extends Ctx {
  calls: { method: string; params: Record<string, any> }[];
  /** Тексти повідомлень, надісланих у канал */
  sent(): string[];
  /** Тексти повідомлень, надісланих власнику в особисті */
  dm(): string[];
  /** Наступні виклики sendMessage у цей чат падатимуть */
  failSendTo(chatId: number | null): void;
  /** Статус власника в каналі, який повертає getChatMember */
  ownerStatus: string;
  /** Методи Telegram, які падатимуть */
  failing: Set<string>;
  /** Фейковий SvitloPulse: черга ("dtek-kem:20.1") → об'єкт group */
  groups: Record<string, Record<string, unknown>>;
  /** SvitloPulse не відповідає */
  scheduleDown: boolean;
  /** URL-и, які запитувались через http */
  fetched: string[];
  /** Фейковий сайт ДТЕК: вулиця → будинки (як у getHomeNum) */
  dtekStreets: Record<string, Record<string, Record<string, unknown>>>;
  /** Сайт ДТЕК не відповідає */
  dtekDown: boolean;
  /** Фейковий /history/plan: "dtek-kem:20.1|2026-11-06" → schedule */
  plans: Record<string, { status: string; slots: unknown[] | null }>;
  /** Метод Telegram → текст помилки, з якою він падатиме */
  failWith: Record<string, string>;
  clear(): void;
  advance(ms: number): void;
  setNow(ms: number): void;
}

export function createCtx(): TestCtx {
  let now = T0;
  let failingChat: number | null = null;
  const calls: TestCtx['calls'] = [];
  const env: Env = {
    DB: createD1(),
    BOT_TOKEN: 'token',
    DEVICE_SECRET: 'device-secret',
    WEBHOOK_SECRET: 'webhook-secret',
    OWNER_USER_ID: String(OWNER.id),
    TIMEZONE: 'Europe/Kyiv',
    OFFLINE_AFTER_MIN: '45',
    BLIP_MAX_MIN: '5',
    SCHEDULE_OPERATOR: 'dtek-kem',
    DTEK_SITE: 'https://www.dtek-kem.com.ua',
  };
  const textsTo = (chatId: number | string) =>
    calls
      // закріплене повідомлення зі станом (тихе) — не сповіщення
      .filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId && !c.params.disable_notification)
      .map((c) => c.params.text as string);
  const test: TestCtx = {
    ownerStatus: 'creator',
    failing: new Set(),
    groups: {},
    scheduleDown: false,
    fetched: [],
    dtekStreets: {},
    dtekDown: false,
    plans: {},
    failWith: {},
    http: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      test.fetched.push(url);
      if (url.startsWith('https://www.dtek-kem.com.ua/')) return fakeDtek(test, init);
      if (test.scheduleDown) throw new Error('network down');
      const plan = url.match(/\/history\/plan\/([^/]+)\/([^/?]+)\?date=([\d-]+)$/);
      if (plan) {
        const schedule = test.plans[`${plan[1]}:${plan[2]}|${plan[3]}`];
        return schedule
          ? Response.json({ schedule })
          : Response.json({ error: 'no schedule version for that moment' }, { status: 404 });
      }
      const m = url.match(/\/groups\/([^/]+)\/([^/?]+)$/);
      const group = m ? test.groups[`${decodeURIComponent(m[1]!)}:${decodeURIComponent(m[2]!)}`] : undefined;
      return group ? Response.json({ group }) : Response.json({ error: 'unknown group' }, { status: 404 });
    }) as typeof fetch,
    env,
    db: env.DB,
    tg: {
      async call(method, params) {
        if (method === 'sendMessage' && params.chat_id === failingChat) throw new Error('Forbidden');
        if (test.failing.has(method)) throw new Error(`${method} failed`);
        if (test.failWith[method]) throw new Error(test.failWith[method]);
        calls.push({ method, params });
        if (method === 'getChatMember') return { status: test.ownerStatus };
        if (method === 'sendMessage') return { message_id: 1000 + calls.length };
        return true;
      },
    },
    now: () => now,
    calls,
    sent: () => textsTo(CHANNEL.id),
    dm: () => textsTo(String(OWNER.id)),
    failSendTo: (chatId) => void (failingChat = chatId),
    clear: () => void calls.splice(0),
    advance: (ms) => void (now += ms),
    setNow: (ms) => void (now = ms),
  };
  return test;
}

let nextId = 1;
/** Повідомлення боту в особистий чат */
export function privateMessage(from: TgUser, text: string): TgUpdate {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, chat: { id: from.id, type: 'private' }, from, text } };
}

/** Допис у канал. from є лише тоді, коли Telegram показує автора. */
export function channelPost(text: string, from?: TgUser): TgUpdate {
  const id = nextId++;
  return { update_id: id, channel_post: { message_id: id, chat: CHANNEL, text, ...(from ? { from } : {}) } };
}

/** Бота додали в чат / прибрали з нього */
export function membership(chat: TgChat, from: TgUser, status: string): TgUpdate {
  return { update_id: nextId++, my_chat_member: { chat, from, new_chat_member: { status } } };
}

const DTEK_TOKEN = 'kQ7xV2pLr9sTzw3YbN8mHc4dJf6gEa1u';

/** Сайт ДТЕК: /ua/ajax з CSRF Yii2 — 400 + cookie без токена, 400 з неправильним токеном */
function fakeDtek(test: TestCtx, init?: RequestInit): Response {
  if (test.dtekDown) throw new Error('DTEK down');
  const headers = new Headers(init?.headers);
  const masked = headers.get('X-CSRF-Token');
  const cookieOk = (headers.get('Cookie') ?? '').includes('_csrf-dtek-kem=');
  const unmasked = masked ? unmask(masked) : null;
  if (!cookieOk || unmasked !== DTEK_TOKEN) {
    const serialized = `a:2:{i:0;s:14:"_csrf-dtek-kem";i:1;s:${DTEK_TOKEN.length}:"${DTEK_TOKEN}";}`;
    return new Response('Bad Request', {
      status: 400,
      headers: [
        ['Set-Cookie', `_csrf-dtek-kem=abc123${encodeURIComponent(serialized)}; path=/; HttpOnly`],
        ['Set-Cookie', 'visid_incap_1=x; path=/'],
      ],
    });
  }
  const form = new URLSearchParams(String(init?.body ?? ''));
  if (form.get('method') === 'getStreets') return Response.json({ result: true, streets: Object.keys(test.dtekStreets) });
  const houses = test.dtekStreets[form.get('data[0][value]') ?? ''];
  return Response.json(houses ? { result: true, data: houses } : { result: false, text: 'Error' });
}

function unmask(masked: string): string {
  const bin = Buffer.from(masked, 'base64url');
  const half = bin.length / 2;
  return Buffer.from(Array.from(bin.subarray(half), (b: number, i: number) => b ^ bin[i]!)).toString();
}
