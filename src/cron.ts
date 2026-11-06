import { notify, notifyOwner, type Ctx } from './env';
import { formatDuration, localClock, localDate, zonedMidnight } from './format';
import { getState, updateState, type State } from './state';
import { refreshOutageMessage } from './outage-message';
import { fetchGroup, fetchPlan, isEmergency, midnightNote, offIntervals, tomorrowText, warningText, type GroupInfo } from './schedule';
import { updatePinnedStatus } from './status-message';
import { monthlyReport, weeklyReport } from './stats';

const HOUR = 3_600_000;
const FIRST_PAUSE_REMINDER = 1 * HOUR;
const NEXT_PAUSE_REMINDER = 3 * HOUR;
/** О котрій (за місцевим часом) надсилати звіти */
const REPORT_HOUR = 10;
/** За скільки попереджати про відключення за графіком */
const WARN_BEFORE = 30 * 60_000;
/** З котрої години надсилати графік на завтра (ДТЕК публікує його ввечері) */
const TOMORROW_HOUR = 22;

export async function runCron(ctx: Ctx): Promise<void> {
  const { db, env } = ctx;
  const now = ctx.now();
  const s = await getState(db);
  const offlineAfter = Number(env.OFFLINE_AFTER_MIN || 45) * 60_000;

  if (
    (s.mode === 'on' || s.mode === 'off') &&
    !s.detector_offline &&
    s.last_seen !== null &&
    now - s.last_seen > offlineAfter
  ) {
    // Без повідомлень (ні в канал, ні власнику) — стан видно внизу закріпленого повідомлення
    await updateState(db, { detector_offline: 1 });
  }

  if (s.mode === 'paused' && s.mode_since !== null) {
    const due =
      s.pause_reminded_at === null
        ? now - s.mode_since >= FIRST_PAUSE_REMINDER
        : now - s.pause_reminded_at >= NEXT_PAUSE_REMINDER;
    if (due) {
      await updateState(db, { pause_reminded_at: now });
      await notifyOwner(
        ctx,
        `⏸ Трекінг на паузі вже ${formatDuration(now - s.mode_since)}.\n` +
          'Коли телефон знову буде на зарядці — /resume',
      );
    }
  }

  await refreshOutageMessage(ctx, s);
  await sendScheduledReports(ctx, s);

  // Графік черги — один запит на весь прогін cron
  const fresh = await getState(db);
  let group: GroupInfo | null = null;
  if (fresh.schedule_group) {
    const res = await fetchGroup(ctx, fresh.schedule_group);
    group = res.ok ? res.group : null;
  }
  await refreshWarning(ctx, fresh, group);
  await warnUpcomingOutage(ctx, fresh, group);
  await sendTomorrowSchedule(ctx, fresh);
  await updatePinnedStatus(ctx, group);
}

/** «⏰ О 21:30 відключення за графіком» — один раз на кожен інтервал, лише коли світло є */
async function warnUpcomingOutage(ctx: Ctx, s: State, g: GroupInfo | null): Promise<void> {
  if (!g || s.mode !== 'on' || isEmergency(g)) return;
  const now = ctx.now();
  const next = offIntervals(g).find((i) => i.start > now && i.start - now <= WARN_BEFORE);
  if (!next || s.warned_outage_start === next.start) return;
  const text = warningText(next, now, ctx.env.TIMEZONE, await midnightNote(ctx, g, next.end));
  await updateState(ctx.db, { warned_outage_start: next.start });
  const sent = await notify(ctx, text);
  await updateState(ctx.db, {
    warn_message_chat_id: sent?.chat_id ?? null,
    warn_message_id: sent?.message_id ?? null,
    warn_sent_at: now,
    warn_text: text,
  });
}

/**
 * Попередження могло піти, коли графіка на завтра ще не було («до 24:00, можливо й довше»).
 * Щойно графік з'явиться і інтервал подовжиться — редагуємо попередження.
 */
async function refreshWarning(ctx: Ctx, s: State, g: GroupInfo | null): Promise<void> {
  if (!g || s.warn_message_id === null || s.warn_message_chat_id === null) return;
  if (s.warned_outage_start === null || s.warn_sent_at === null) return;
  const interval = offIntervals(g).find((i) => i.start === s.warned_outage_start);
  if (!interval || ctx.now() >= interval.end) return;
  const text = warningText(interval, s.warn_sent_at, ctx.env.TIMEZONE, await midnightNote(ctx, g, interval.end));
  if (text === s.warn_text) return;
  await updateState(ctx.db, { warn_text: text });
  try {
    await ctx.tg.call('editMessageText', { chat_id: s.warn_message_chat_id, message_id: s.warn_message_id, text });
  } catch (err) {
    console.error('could not update the warning', err);
  }
}

/** Графік на завтра — з 22:00, щойно оператор його опублікує (до кінця доби), один раз */
async function sendTomorrowSchedule(ctx: Ctx, s: State): Promise<void> {
  if (!s.schedule_group) return;
  const tz = ctx.env.TIMEZONE;
  const t = localClock(ctx.now(), tz);
  if (t.hour < TOMORROW_HOUR) return;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  if (s.tomorrow_sent_date === today) return;

  const tomorrow = localDate(zonedMidnight(t.year, t.month, t.day + 1, tz) + 12 * 3_600_000, tz);
  const date = `${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}`;
  const plan = await fetchPlan(ctx, s.schedule_group, date);
  if (plan.status !== 'published') return; // ще не опублікували — спробуємо за 5 хв
  await updateState(ctx.db, { tomorrow_sent_date: today });
  await notify(ctx, tomorrowText(plan.slots, `${pad(tomorrow.day)}.${pad(tomorrow.month)}`, s.schedule_group, tz));
}

/**
 * Тижневий звіт — у понеділок, місячний — 1-го числа, о REPORT_HOUR за місцевим часом.
 * Cron спрацьовує кожні 5 хв; дата останнього звіту в базі гарантує, що звіт прийде один раз.
 */
async function sendScheduledReports(ctx: Ctx, s: State): Promise<void> {
  const now = ctx.now();
  const t = localClock(now, ctx.env.TIMEZONE);
  if (t.hour < REPORT_HOUR) return;
  const today = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;

  if (t.weekday === 1 && s.last_weekly_report !== today) {
    await updateState(ctx.db, { last_weekly_report: today });
    const text = await weeklyReport(ctx);
    if (text) await notify(ctx, text, { html: true });
  }
  if (t.day === 1 && s.last_monthly_report !== today) {
    await updateState(ctx.db, { last_monthly_report: today });
    const text = await monthlyReport(ctx);
    if (text) await notify(ctx, text, { html: true });
  }
}
