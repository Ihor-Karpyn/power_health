import { notify, notifyOwner, type Ctx } from './env';
import { formatDuration, formatTime, localClock } from './format';
import type { TrackedDtek } from './dtek';
import { dtekForOutage, renderOff, type OffParts } from './outage-message';
import { nextOutageLine, outageScheduleLine } from './schedule';
import { inBackground, updatePinnedStatus } from './status-message';
import { getState, switchMode, updateState, type Mode, type State } from './state';

export type ReportKind = 'event' | 'heartbeat';

export interface Report {
  charging: boolean;
  /** Час на телефоні, коли стан зафіксовано (ms) */
  ts: number;
  battery: number | null;
  /**
   * Коли на телефоні востаннє змінилась зарядка (ms) — глобальна змінна MacroDroid `power_ts`, яку heartbeat
   * надсилає як `changed_at`. Дає точний час зміни, навіть якщо сама подія не дійшла (не було інтернету).
   */
  changedAt?: number | null;
}

const TRUE = new Set(['true', '1', 'on', 'yes', 'charging']);
const FALSE = new Set(['false', '0', 'off', 'no', 'discharging']);
const MAX_CLOCK_SKEW = 2 * 60_000;

/** Розбирає тіло запиту від MacroDroid. Поблажливо: рядки, секунди або мілісекунди. */
export function parseReport(body: unknown, now: number): Report | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;

  const rawCharging = typeof b.charging === 'string' ? b.charging.trim().toLowerCase() : b.charging;
  let charging: boolean;
  if (rawCharging === true || TRUE.has(String(rawCharging))) charging = true;
  else if (rawCharging === false || FALSE.has(String(rawCharging))) charging = false;
  else return { error: '"charging" must be true or false' };

  // Невалідний ts (наприклад, magic text не підставився) → беремо час сервера
  const ts = phoneTime(b.ts, now) ?? now;
  // changed_at необов'язковий: невалідний або пізніший за ts — ігноруємо
  const changed = phoneTime(b.changed_at, now);
  const changedAt = changed !== null && changed <= ts ? changed : null;

  const battery = Number.parseInt(String(b.battery), 10);
  return {
    charging,
    ts,
    battery: Number.isFinite(battery) && battery >= 0 && battery <= 100 ? battery : null,
    changedAt,
  };
}

/** Час з телефона: секунди або мс; невалідний або з майбутнього → null */
function phoneTime(value: unknown, now: number): number | null {
  let t = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(t) || t <= 0) return null;
  if (t < 1e11) t *= 1000; // секунди → мс
  if (t > now + MAX_CLOCK_SKEW) return null;
  return Math.round(t);
}

export type ReportResult = 'initialized' | 'changed' | 'blip' | 'unchanged' | 'stale' | 'paused' | 'test';

/** `raw` — тіло запиту як є: у тестовому режимі показуємо, що саме прислав макрос (опечатки в полях тощо) */
export async function handleReport(
  ctx: Ctx,
  report: Report,
  kind: ReportKind,
  raw?: Record<string, unknown>,
): Promise<ReportResult> {
  const s = await getState(ctx.db);
  if (s.test_since !== null) {
    // Тестовий режим: нічого не пишемо в базу і не шлемо в канал — лише розбір запиту власнику
    await notifyOwner(ctx, describeTestReport(ctx, s, report, kind, raw));
    return 'test';
  }
  const result = await applyReport(ctx, report, kind);
  if (result === 'initialized' || result === 'changed' || result === 'blip') {
    await inBackground(ctx, () => updatePinnedStatus(ctx));
  }
  return result;
}

async function applyReport(ctx: Ctx, report: Report, kind: ReportKind): Promise<ReportResult> {
  const { db, env } = ctx;
  const now = ctx.now();
  const s = await getState(db);
  // Телефон довго мовчав (розрядився, не було мережі) — тоді точного моменту зміни не знаємо
  const offlineAfter = Number(env.OFFLINE_AFTER_MIN || 45) * 60_000;
  const wasOffline = s.detector_offline === 1 || (s.last_seen !== null && now - s.last_seen > offlineAfter);

  // Повтори тієї самої події та запити, що прийшли не по порядку, стан не змінюють
  const fresh = s.phone_ts === null || report.ts > s.phone_ts;
  const fields: Partial<State> = { last_seen: now, detector_offline: 0 };
  if (fresh) {
    fields.phone_charging = report.charging ? 1 : 0;
    fields.phone_ts = report.ts;
    fields.battery = report.battery ?? s.battery;
  }
  await updateState(db, fields);

  let result: ReportResult;
  const want: Mode = report.charging ? 'on' : 'off';
  if (!fresh) {
    result = 'stale';
  } else if (s.mode === 'paused') {
    result = 'paused';
  } else if (s.mode === null || s.mode_since === null) {
    await switchMode(db, want, report.ts, { approx: true });
    result = 'initialized';
  } else if (s.mode !== want) {
    // Heartbeat приніс час зміни з телефона, новіший за все, що ми знаємо, — це точний момент, а не оцінка
    const changedAt =
      report.changedAt != null && report.changedAt > (s.phone_ts ?? 0) && report.changedAt >= s.mode_since
        ? report.changedAt
        : null;
    const exact = kind === 'event' || changedAt !== null;
    const at = changedAt ?? Math.max(report.ts, s.mode_since);
    const blipMax = Number(env.BLIP_MAX_MIN || 5) * 60_000;
    if (at - s.mode_since < blipMax && (await eraseBlip(ctx, s))) {
      return 'blip';
    }
    await switchMode(db, want, at, { approx: !exact });

    const tz = env.TIMEZONE;
    const windowFrom = Math.max(s.phone_ts ?? s.mode_since, s.mode_since);
    // Детектор був офлайн — показуємо час, коли він повернувся (а не вікно «між … і …» на кілька годин)
    const when =
      exact || wasOffline
        ? `о ${formatTime(at, tz, now)}`
        : `приблизно між ${formatTime(windowFrom, tz, now)} і ${formatTime(at, tz, now)}`;
    const approx = !exact || s.mode_since_approx === 1 ? '≈ ' : '';
    const notes = exact
      ? []
      : wasOffline
        ? ['ℹ️ Детектор був без зв\'язку, тож це час, коли він повернувся']
        : ['ℹ️ Подія з телефона не дійшла, стан відновлено з heartbeat'];
    const duration = `${approx}${formatDuration(at - s.mode_since)}`;

    if (want === 'off') {
      // Графік і ДТЕК — паралельно, щоб не затримувати сповіщення
      const [schedule, dtek] = await Promise.all([outageScheduleLine(ctx, at), dtekForOutage(ctx, s, at)]);
      const parts: OffParts = { main: [`🔴 Світло зникло ${when}`, `Світло було: ${duration}`], schedule, notes };
      const sent = await notify(ctx, renderOff(parts, dtek, now, tz));
      await updateState(db, {
        off_message_chat_id: sent?.chat_id ?? null,
        off_message_id: sent?.message_id ?? null,
        on_message_chat_id: null,
        on_message_id: null,
        off_parts: JSON.stringify(parts),
        off_dtek: dtek ? JSON.stringify(dtek) : null,
      });
    } else {
      const lines = [`🟢 Світло з'явилось ${when}`, `Світла не було: ${duration}`];
      const next = await nextOutageLine(ctx, at);
      if (next) lines.push(next);
      const promised = s.off_dtek ? (JSON.parse(s.off_dtek) as TrackedDtek) : null;
      if (promised?.end) lines.push(`🕦 ДТЕК обіцяв до ${formatTime(promised.end, tz, now)}`);
      lines.push(...notes);
      const sent = await notify(ctx, lines.join('\n'));
      // off_* не чистимо: якщо світло знову зникне за кілька хвилин, відключення продовжиться з тим самим повідомленням
      await updateState(db, { on_message_chat_id: sent?.chat_id ?? null, on_message_id: sent?.message_id ?? null });
    }
    result = 'changed';
  } else {
    result = 'unchanged';
  }
  return result;
}

/**
 * Коротке «блимання» в будь-який бік — поточний період (s.mode) триває менше BLIP_MAX_MIN:
 * - світло зникло й одразу з'явилось → видаляємо «🔴 Світло зникло», не пишемо «з'явилось»;
 * - світло з'явилось і одразу зникло → видаляємо «🟢 Світло з'явилось», не пишемо «зникло».
 * Короткий період прибираємо з історії, попередній продовжується, ніби нічого не було.
 * Повертає false, якщо стерти не вдалось (немає попереднього періоду протилежного типу — напр. після
 * паузи чи на старті, — або не вдалося видалити повідомлення) — тоді обробляємо як звичайну зміну.
 */
async function eraseBlip(ctx: Ctx, s: State): Promise<boolean> {
  const { db } = ctx;
  if (s.mode !== 'on' && s.mode !== 'off') return false;
  const short = s.mode;
  const outer = short === 'off' ? 'on' : 'off';
  const prev = await db
    .prepare('SELECT id, start_ts, start_approx FROM periods WHERE kind = ? AND end_ts = ? ORDER BY id DESC LIMIT 1')
    .bind(outer, s.mode_since)
    .first<{ id: number; start_ts: number; start_approx: number }>();
  if (!prev) return false;

  const [chatId, messageId] =
    short === 'off' ? [s.off_message_chat_id, s.off_message_id] : [s.on_message_chat_id, s.on_message_id];
  if (chatId !== null && messageId !== null) {
    try {
      await ctx.tg.call('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (err) {
      console.error('could not delete the blip message, keeping it as a normal change', err);
      return false;
    }
  }

  // Стерли коротке відключення — його повідомлення більше немає; стерли коротке «світло є» — відключення
  // продовжується, тож off_* (повідомлення, дані ДТЕК) лишаються.
  const clear =
    short === 'off'
      ? 'off_message_chat_id = NULL, off_message_id = NULL, off_parts = NULL, off_dtek = NULL'
      : 'on_message_chat_id = NULL, on_message_id = NULL';
  await db.batch([
    db.prepare('DELETE FROM periods WHERE kind = ? AND end_ts IS NULL').bind(short),
    db.prepare('UPDATE periods SET end_ts = NULL, end_approx = 0 WHERE id = ?').bind(prev.id),
    db
      .prepare(`UPDATE state SET mode = ?, mode_since = ?, mode_since_approx = ?, ${clear} WHERE id = 1`)
      .bind(outer, prev.start_ts, prev.start_approx),
  ]);
  return true;
}

/** «13:05:12» за місцевим часом */
function hms(ms: number, tz: string): string {
  const t = localClock(ms, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.hour)}:${p(new Date(ms).getUTCMinutes())}:${p(new Date(ms).getUTCSeconds())}`;
}

/**
 * Лог запиту в тестовому режимі: що прислав телефон і що сервер зробив би (без жодних змін у базі).
 * Логіка передбачення повторює applyReport/eraseBlip у спрощеному вигляді.
 */
export function describeTestReport(
  ctx: Ctx,
  s: State,
  r: Report,
  kind: ReportKind,
  raw?: Record<string, unknown>,
): string {
  const tz = ctx.env.TIMEZONE;
  const lines = [
    `🧪 ${kind === 'event' ? 'Подія живлення' : 'Heartbeat'} · ${hms(ctx.now(), tz)}`,
    `Зарядка: ${r.charging ? 'є' : 'немає'}${r.battery !== null ? ` · 🔋 ${r.battery}%` : ''}`,
    `ts: ${hms(r.ts, tz)}`,
  ];

  if (kind === 'heartbeat') {
    const rawChanged = raw?.changed_at;
    if (rawChanged === undefined) {
      const typo = raw && Object.keys(raw).find((k) => k !== 'changed_at' && /^ch.*_at$/.test(k));
      lines.push(`changed_at: немає поля${typo ? ` (є «${typo}» — опечатка?)` : ''}`);
    } else if (r.changedAt == null) {
      lines.push(`changed_at: не розпізнано або пізніше за ts — «${String(rawChanged)}»`);
    } else {
      lines.push(`changed_at: ${hms(r.changedAt, tz)}`);
    }
  }

  lines.push(predict(ctx, s, r, kind));
  return lines.join('\n');
}

function predict(ctx: Ctx, s: State, r: Report, kind: ReportKind): string {
  const tz = ctx.env.TIMEZONE;
  const word = (m: Mode) => (m === 'on' ? 'світло є' : 'світла немає');
  if (s.phone_ts !== null && r.ts <= s.phone_ts) return '→ застарілий запит (не новіший за останній звіт) — проігнорував би';
  const want: Mode = r.charging ? 'on' : 'off';
  if (s.mode === null || s.mode_since === null) return `→ почав би трекінг: ${word(want)}`;
  if (s.mode === want) return `→ без змін (${word(want)} і так)`;

  const changedAt =
    r.changedAt != null && r.changedAt > (s.phone_ts ?? 0) && r.changedAt >= s.mode_since ? r.changedAt : null;
  const at = changedAt ?? Math.max(r.ts, s.mode_since);
  const what = want === 'on' ? "світло з'явилось" : 'світло зникло';
  const blipMax = Number(ctx.env.BLIP_MAX_MIN || 5) * 60_000;
  if (at - s.mode_since < blipMax) return `→ ${what} о ${hms(at, tz)} — блимання (< 5 хв), стер би його`;
  const how =
    kind === 'event' ? 'точно' : changedAt !== null ? 'точно, з changed_at' : 'приблизно — без придатного changed_at';
  return `→ ${what} о ${hms(at, tz)} (${how})`;
}
