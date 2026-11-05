import type { Ctx } from './env';
import { bar, formatDuration, formatEndTime, formatTime, localClock, localDate, zonedMidnight } from './format';

/** Відкритий API SvitloPulse: графіки операторів + ознака аварійних відключень. Без ключа. */
const API = 'https://svitlopulse.andrewboyko.name/api/v1';
const TIMEOUT_MS = 4000;
/** Світло могло зникнути трохи раніше за початок інтервалу в графіку */
const EARLY_TOLERANCE = 15 * 60_000;

export interface Interval {
  start: string;
  end: string;
  kind: string;
}

export interface GroupInfo {
  key: string;
  state: string;
  class: string;
  plan_status?: string;
  restore_at?: string;
  today?: Interval[];
  tomorrow?: Interval[];
  /** Кеш: графік на завтра ще не опублікований (рахується лише за потреби) */
  tomorrow_pending?: boolean;
}

export type GroupResult = { ok: true; group: GroupInfo } | { ok: false; notFound: boolean };

/** "20.1" → "<SCHEDULE_OPERATOR>:20.1"; "dtek-krem:3.1" лишається як є */
export function normalizeGroupKey(ctx: Ctx, input: string): string | null {
  const value = input.trim().toLowerCase();
  const m = value.match(/^(?:([a-z0-9-]+):)?(\d{1,2}\.\d)$/);
  if (!m) return null;
  return `${m[1] ?? ctx.env.SCHEDULE_OPERATOR ?? 'dtek-kem'}:${m[2]}`;
}

export async function fetchGroup(ctx: Ctx, key: string): Promise<GroupResult> {
  const [operator, group] = key.split(':');
  try {
    const res = await ctx.http(`${API}/groups/${encodeURIComponent(operator!)}/${encodeURIComponent(group!)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { group?: GroupInfo };
    if (!body.group) throw new Error('no group in response');
    return { ok: true, group: body.group };
  } catch (err) {
    console.error(`schedule fetch for ${key} failed`, err);
    return { ok: false, notFound: false };
  }
}

export const isEmergency = (g: GroupInfo) => g.class === 'emergency' || g.plan_status === 'emergency';

/** Інтервали «світла немає» за графіком (сьогодні + завтра), суміжні склеєні (21:30–00:00 + 00:00–02:00) */
export function offIntervals(g: GroupInfo): { start: number; end: number }[] {
  return mergeOff([...(g.today ?? []), ...(g.tomorrow ?? [])]);
}

function mergeOff(slots: Interval[]): { start: number; end: number }[] {
  const list = slots
    .filter((i) => i.kind === 'off' || i.kind === 'maybe')
    .map((i) => ({ start: Date.parse(i.start), end: Date.parse(i.end) }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const i of list) {
    const last = merged.at(-1);
    if (last && i.start <= last.end + 60_000) last.end = Math.max(last.end, i.end);
    else merged.push({ ...i });
  }
  return merged;
}

export async function loadConfiguredGroup(ctx: Ctx): Promise<GroupInfo | null> {
  const row = await ctx.db
    .prepare('SELECT schedule_group FROM state WHERE id = 1')
    .first<{ schedule_group: string | null }>();
  if (!row?.schedule_group) return null;
  const res = await fetchGroup(ctx, row.schedule_group);
  return res.ok ? res.group : null;
}

/** YYYY-MM-DD завтрашньої дати за місцевим часом */
function tomorrowDate(now: number, tz: string): string {
  const t = localDate(now, tz);
  const d = localDate(zonedMidnight(t.year, t.month, t.day + 1, tz) + 12 * 3_600_000, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.year}-${p(d.month)}-${p(d.day)}`;
}

/**
 * Чи ще не опублікований графік на завтра. Порожній `tomorrow` у /groups неоднозначний
 * («не опубліковано» або «відключень немає»), тож перепитуємо /history/plan — лише раз на об'єкт.
 */
export async function tomorrowPending(ctx: Ctx, g: GroupInfo): Promise<boolean> {
  if ((g.tomorrow ?? []).length > 0) return false;
  if (g.tomorrow_pending === undefined) {
    const plan = await fetchPlan(ctx, g.key, tomorrowDate(ctx.now(), ctx.env.TIMEZONE));
    g.tomorrow_pending = plan.status !== 'published';
  }
  return g.tomorrow_pending;
}

/**
 * Інтервал, що закінчується сьогоднішньою північчю, може тривати й завтра — якщо графік на завтра
 * ще не опублікований, кажемо про це. Повертає текст примітки або null.
 */
export async function midnightNote(ctx: Ctx, g: GroupInfo, end: number): Promise<string | null> {
  const tz = ctx.env.TIMEZONE;
  const t = localDate(ctx.now(), tz);
  if (end !== zonedMidnight(t.year, t.month, t.day + 1, tz)) return null;
  return (await tomorrowPending(ctx, g)) ? 'графік на завтра ще не опублікований' : null;
}

/** Рядок для «🔴 Світло зникло»: до котрої за графіком. null — якщо черга не задана або API недоступний. */
export async function outageScheduleLine(ctx: Ctx, at: number): Promise<string | null> {
  const g = await loadConfiguredGroup(ctx);
  if (!g) return null;
  if (isEmergency(g)) return '⚠️ Аварійне відключення: графік не діє, час відновлення невідомий';

  const now = ctx.now();
  const tz = ctx.env.TIMEZONE;
  const current = offIntervals(g).find((i) => i.start - EARLY_TOLERANCE <= at && at < i.end);
  const end = current?.end ?? (g.state === 'off' && g.restore_at ? Date.parse(g.restore_at) : null);
  if (end !== null && Number.isFinite(end) && end > now) {
    const note = await midnightNote(ctx, g, end);
    return `📅 За графіком: до ${formatEndTime(end, tz, now)} (ще ~${formatDuration(end - now)})${note ? `, ${note}` : ''}`;
  }
  if (g.plan_status === 'applies') return 'ℹ️ Відключення поза графіком';
  return null;
}

/** Рядок для «🟢 Світло з'явилось»: наступне відключення за графіком */
export async function nextOutageLine(ctx: Ctx, at: number): Promise<string | null> {
  const g = await loadConfiguredGroup(ctx);
  if (!g || isEmergency(g)) return null;
  const next = offIntervals(g).find((i) => i.start > at);
  if (!next) return null;
  const tz = ctx.env.TIMEZONE;
  const now = ctx.now();
  const note = await midnightNote(ctx, g, next.end);
  return `📅 Наступне відключення за графіком: ${formatTime(next.start, tz, now)}–${formatEndTime(next.end, tz, now)}${note ? ` (${note})` : ''}`;
}

/** Короткий опис стану черги для /status і /queue */
export function describeGroup(g: GroupInfo, now: number, tz: string): string {
  if (isEmergency(g)) return '⚠️ аварійні відключення, графік не діє';
  const intervals = offIntervals(g);
  const current = intervals.find((i) => i.start <= now && now < i.end);
  if (current) return `за графіком світла немає до ${formatEndTime(current.end, tz, now)}`;
  const next = intervals.find((i) => i.start > now);
  if (next) return `наступне відключення ${formatTime(next.start, tz, now)}–${formatEndTime(next.end, tz, now)}`;
  return 'відключень за графіком не заплановано';
}

export type PlanResult =
  | { status: 'published'; slots: Interval[] }
  | { status: 'not_published' | 'emergency' | 'error' };

/** Графік черги на дату (YYYY-MM-DD) у тому вигляді, як його опублікував оператор */
export async function fetchPlan(ctx: Ctx, key: string, date: string): Promise<PlanResult> {
  const [operator, group] = key.split(':');
  try {
    const res = await ctx.http(
      `${API}/history/plan/${encodeURIComponent(operator!)}/${encodeURIComponent(group!)}?date=${date}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (res.status === 404) return { status: 'not_published' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { schedule?: { status?: string; slots?: Interval[] | null } };
    const status = body.schedule?.status;
    if (status === 'applies') return { status: 'published', slots: body.schedule?.slots ?? [] };
    if (status === 'emergency') return { status: 'emergency' };
    return { status: 'not_published' };
  } catch (err) {
    console.error(`plan fetch for ${key} ${date} failed`, err);
    return { status: 'error' };
  }
}

/** «HH:MM»; кінець доби показуємо як 24:00, а не 00:00 наступного дня */
function hm(ms: number, tz: string, isEnd = false): string {
  const t = localClock(ms, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  const minute = new Date(ms).getUTCMinutes();
  if (isEnd && t.hour === 0 && minute === 0) return '24:00';
  return `${p(t.hour)}:${p(minute)}`;
}

/**
 * Повідомлення «графік на завтра». [dayStart, dayEnd) — межі доби (23/25 год у дні переходу на літній/зимовий час),
 * від них рахується відсоток часу зі світлом — як шкала в статистиці.
 */
export function tomorrowText(
  slots: Interval[],
  dateLabel: string,
  group: string,
  tz: string,
  dayStart: number,
  dayEnd: number,
): string {
  const off = mergeOff(slots);
  const title = `📅 Графік на завтра, ${dateLabel} (черга ${group.split(':')[1] ?? group})`;
  const total = off.reduce((sum, i) => sum + Math.max(0, Math.min(i.end, dayEnd) - Math.max(i.start, dayStart)), 0);
  const pct = Math.round((100 * (dayEnd - dayStart - total)) / (dayEnd - dayStart));
  const scale = `${bar(pct)} ${pct}% часу зі світлом`;
  if (off.length === 0) return `${title}\n${scale}\nВідключень за графіком не заплановано 🎉`;
  return [
    title,
    scale,
    ...off.map((i) => `🔴 ${hm(i.start, tz)}–${hm(i.end, tz, true)} (${formatDuration(i.end - i.start)})`),
    `Без світла за графіком: ${formatDuration(total)}`,
  ].join('\n');
}

/**
 * Попередження перед відключенням за графіком. `sentAt` — момент надсилання: від нього «через ~N хв»,
 * щоб під час редагування (коли з'явився графік на завтра) ця частина не змінювалась.
 */
export function warningText(next: { start: number; end: number }, sentAt: number, tz: string, note: string | null): string {
  const main = `⏰ О ${formatTime(next.start, tz, sentAt)} відключення за графіком, до ${formatEndTime(next.end, tz, sentAt)} (через ~${formatDuration(next.start - sentAt)})`;
  return note ? `${main}\nℹ️ Можливо, й довше: ${note}` : main;
}
