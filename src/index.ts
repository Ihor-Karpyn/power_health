import { handleUpdate, setupBot } from './bot';
import { runCron } from './cron';
import { handleReport, parseReport, type ReportKind } from './device';
import type { Ctx, Env } from './env';
import { createTelegram, type TgUpdate } from './telegram';

export function makeCtx(env: Env, exec?: { waitUntil(p: Promise<unknown>): void }): Ctx {
  return {
    env,
    db: env.DB,
    tg: createTelegram(env.BOT_TOKEN),
    http: fetch.bind(globalThis),
    now: Date.now,
    defer: exec ? (p) => exec.waitUntil(p) : undefined,
  };
}

const DEVICE_ROUTES: Record<string, ReportKind> = {
  '/device/event': 'event',
  '/device/heartbeat': 'heartbeat',
};

/** Порівняння секретів без витоку через час виконання */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function route(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const { env } = ctx;

  if (req.method === 'GET' && url.pathname === '/') return new Response('power-health ok');

  if (req.method === 'POST' && url.pathname === '/telegram') {
    if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token'), env.WEBHOOK_SECRET)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      await handleUpdate(ctx, (await req.json()) as TgUpdate);
    } catch (err) {
      // Відповідаємо 200, інакше Telegram повторюватиме той самий update без кінця
      console.error('update handling failed', err);
    }
    return new Response('ok');
  }

  const kind = DEVICE_ROUTES[url.pathname];
  if (req.method === 'POST' && kind) {
    if (!safeEqual(req.headers.get('x-device-key'), env.DEVICE_SECRET)) {
      return json({ error: 'forbidden' }, 403);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const report = parseReport(body, ctx.now());
    if ('error' in report) return json(report, 400);
    const result = await handleReport(ctx, report, kind);
    return json({ ok: true, result, charging: report.charging, ts: new Date(report.ts).toISOString() });
  }

  if (req.method === 'POST' && url.pathname === '/admin/setup') {
    if (!safeEqual(req.headers.get('authorization'), `Bearer ${env.WEBHOOK_SECRET}`)) {
      return json({ error: 'forbidden' }, 403);
    }
    return json({ ok: true, ...(await setupBot(ctx, url.origin)) });
  }

  return new Response('not found', { status: 404 });
}

export default {
  fetch: (req, env, exec) => route(req, makeCtx(env, exec)),
  async scheduled(_event, env) {
    await runCron(makeCtx(env));
  },
} satisfies ExportedHandler<Env>;
