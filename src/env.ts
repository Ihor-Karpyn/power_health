import type { Telegram } from './telegram';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  /** Ключ, який телефон надсилає в заголовку X-Device-Key */
  DEVICE_SECRET: string;
  /** secret_token webhook'а Telegram + ключ для POST /admin/setup */
  WEBHOOK_SECRET: string;
  /** Єдина людина, яка може керувати ботом */
  OWNER_USER_ID: string;
  TIMEZONE: string;
  OFFLINE_AFTER_MIN: string;
  /** Відключення, коротші за стільки хвилин, стираються з історії та каналу */
  BLIP_MAX_MIN: string;
  /** Оператор за замовчуванням для /queue 20.1 (SvitloPulse operator id) */
  SCHEDULE_OPERATOR: string;
  /** Сайт ДТЕК для /address (Київ — dtek-kem) */
  DTEK_SITE: string;
}

/** Усе, що потрібно обробникам. В тестах підміняємо tg і now. */
export interface Ctx {
  env: Env;
  db: D1Database;
  tg: Telegram;
  /** fetch для зовнішніх API; в тестах підміняється */
  http: typeof fetch;
  now: () => number;
  /** Дочекатися промісу вже після відповіді (Workers ctx.waitUntil); у тестах відсутнє */
  defer?: (p: Promise<unknown>) => void;
}

export interface SentMessage {
  chat_id: number;
  message_id: number;
}

async function send(ctx: Ctx, chatId: number | string, text: string): Promise<SentMessage | null> {
  try {
    const msg = (await ctx.tg.call('sendMessage', { chat_id: chatId, text })) as { message_id?: number } | null;
    return msg?.message_id != null ? { chat_id: Number(chatId), message_id: msg.message_id } : null;
  } catch (err) {
    console.error(`sendMessage to ${chatId} failed`, err);
    return null;
  }
}

/** Сповіщення в активований канал. Поки канал не активовано, нікуди не шлемо. */
export async function notify(ctx: Ctx, text: string): Promise<SentMessage | null> {
  const row = await ctx.db
    .prepare('SELECT channel_id FROM state WHERE id = 1')
    .first<{ channel_id: number | null }>();
  if (row?.channel_id == null) {
    console.log('no channel activated, notification skipped:', text);
    return null;
  }
  return send(ctx, row.channel_id, text);
}

/** Службові повідомлення власнику в особистий чат з ботом */
export async function notifyOwner(ctx: Ctx, text: string): Promise<void> {
  await send(ctx, ctx.env.OWNER_USER_ID, text);
}
