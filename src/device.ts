import { notify, type Ctx } from './env';
import { formatDuration, formatTime } from './format';
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

export type ReportResult = 'initialized' | 'changed' | 'blip' | 'unchanged' | 'stale' | 'paused';

export async function handleReport(ctx: Ctx, report: Report, kind: ReportKind): Promise<ReportResult> {
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
    if (want === 'on' && at - s.mode_since < blipMax && (await eraseBlip(ctx, s))) {
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
      await notify(ctx, lines.join('\n'));
      await updateState(db, { off_message_chat_id: null, off_message_id: null, off_parts: null, off_dtek: null });
    }
    result = 'changed';
  } else {
    result = 'unchanged';
  }
  return result;
}

/**
 * Коротке «блимання»: світло зникло і з'явилось за кілька хвилин.
 * Видаляємо «🔴 Світло зникло» з каналу і склеюємо відключення з попереднім періодом
 * «світло є», ніби його й не було. Повертає false, якщо стерти не вдалось —
 * тоді відключення обробляється як звичайне.
 */
async function eraseBlip(ctx: Ctx, s: State): Promise<boolean> {
  const { db } = ctx;
  const prev = await db
    .prepare("SELECT id, start_ts, start_approx FROM periods WHERE kind = 'on' AND end_ts = ? ORDER BY id DESC LIMIT 1")
    .bind(s.mode_since)
    .first<{ id: number; start_ts: number; start_approx: number }>();
  if (!prev) return false; // перед відключенням не було періоду «світло є» (наприклад, після паузи)

  if (s.off_message_chat_id !== null && s.off_message_id !== null) {
    try {
      await ctx.tg.call('deleteMessage', { chat_id: s.off_message_chat_id, message_id: s.off_message_id });
    } catch (err) {
      console.error('could not delete the outage message, keeping the outage', err);
      return false;
    }
  }

  await db.batch([
    db.prepare("DELETE FROM periods WHERE kind = 'off' AND end_ts IS NULL"),
    db.prepare('UPDATE periods SET end_ts = NULL, end_approx = 0 WHERE id = ?').bind(prev.id),
    db
      .prepare(
        "UPDATE state SET mode = 'on', mode_since = ?, mode_since_approx = ?, off_message_chat_id = NULL, off_message_id = NULL, off_parts = NULL, off_dtek = NULL WHERE id = 1",
      )
      .bind(prev.start_ts, prev.start_approx),
  ]);
  return true;
}
