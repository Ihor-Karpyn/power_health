import type { Ctx } from './env';
import { formatDuration, formatTime, localDate, zonedMidnight } from './format';
import { loadPeriods, summarize, type Period, type Summary } from './state';

const DAY = 86_400_000;
const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
const MONTHS_FULL = [
  'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень',
];
/** Різниця в % світла, яку вважаємо «так само» */
const SAME_PCT = 2;

const tracked = (s: Summary) => s.on + s.off;
const lightPct = (s: Summary) => Math.round((100 * s.on) / tracked(s));
const pad2 = (n: number) => String(n).padStart(2, '0');
const perDay = (n: number) => (n < 0.05 ? '<0,1' : n.toFixed(1).replace('.', ','));

function bar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/** dd.mm для доби, що починається в dayStart */
function dayLabel(dayStart: number, tz: string): string {
  const d = localDate(dayStart + DAY / 2, tz);
  return `${pad2(d.day)}.${pad2(d.month)}`;
}

/** Дата з середини місяця — щоб назва не залежала від часового поясу */
const monthOf = (monthStart: number) => new Date(monthStart + 15 * DAY);

type Sum = (from: number, to: number) => Summary;

function summer(periods: Period[], now: number): Sum {
  return (from, to) => summarize(periods, from, to, now);
}

/**
 * Тиждень: dayStarts[0] — останній день (закінчується в end), dayStarts[13] — початок попереднього тижня.
 * Відсотки рахуються від часу, коли трекінг працював: пауза і час без даних не враховуються.
 */
function weekLines(opts: {
  title: string;
  versus: string;
  dayStarts: number[];
  end: number;
  sum: Sum;
  now: number;
  tz: string;
}): string[] | null {
  const { dayStarts, end, sum, now, tz } = opts;
  const week = sum(dayStarts[6]!, end);
  if (tracked(week) === 0) return null;

  const lines = [opts.title];
  const pct = lightPct(week);
  lines.push(`💡 Світло було ${pct}% часу`);
  if (week.offCount > 0) {
    lines.push(`🔴 Без світла ${formatDuration(week.off)}, відключень: ${week.offCount}`);
    lines.push(
      `⏱ В середньому ${formatDuration(week.off / week.offCount)}, найдовше ${formatDuration(week.longestOff)}`,
    );
  } else {
    lines.push('🔴 Відключень не було');
  }
  if (week.paused > 0) lines.push(`⏸ На паузі: ${formatDuration(week.paused)}`);

  const prev = sum(dayStarts[13]!, dayStarts[6]!);
  if (tracked(prev) > 0) {
    const prevPct = lightPct(prev);
    if (pct - prevPct >= SAME_PCT) lines.push(`📈 Світла більше, ніж ${opts.versus}: ${pct}% проти ${prevPct}%`);
    else if (prevPct - pct >= SAME_PCT) lines.push(`📉 Світла менше, ніж ${opts.versus}: ${pct}% проти ${prevPct}%`);
    else lines.push(`➖ Приблизно як ${opts.versus} (${prevPct}%)`);
  }

  lines.push('', 'По днях:');
  for (let i = 6; i >= 0; i--) {
    const from = dayStarts[i]!;
    const to = i === 0 ? end : dayStarts[i - 1]!;
    const s = sum(from, to);
    if (tracked(s) === 0) continue;
    const weekday = WEEKDAYS[new Date(from + DAY / 2).getUTCDay()];
    const partial = to === now ? ` (до ${formatTime(now, tz, now)})` : '';
    const detail = s.offCount > 0 ? `${s.offCount} відкл., без світла ${formatDuration(s.off)}` : 'без відключень';
    lines.push(`${weekday} ${dayLabel(from, tz)}${partial}  ${bar(lightPct(s))} ${lightPct(s)}% · ${detail}`);
  }
  return lines;
}

/** Місяці: monthStarts[0] — останній місяць (закінчується в end), [11] — найстаріший */
function monthLines(monthStarts: number[], end: number, sum: Sum): string[] | null {
  const lines = ['📅 Останні 12 місяців', '↑ / ↓ — світла більше / менше, ніж у попередньому місяці'];
  let prevPct: number | null = null;

  for (let i = 11; i >= 0; i--) {
    const from = monthStarts[i]!;
    const to = i === 0 ? end : monthStarts[i - 1]!;
    const s = sum(from, to);
    if (tracked(s) === 0) continue;

    const pct = lightPct(s);
    const days = tracked(s) / DAY;
    const mid = monthOf(from);
    let label = `${MONTHS[mid.getUTCMonth()]} ${mid.getUTCFullYear()}`;
    if (days < (to - from) / DAY - 1) label += ` (дані за ${Math.max(1, Math.round(days))} дн.)`;

    let arrow = '';
    if (prevPct !== null) arrow = pct - prevPct >= SAME_PCT ? ' ↑' : prevPct - pct >= SAME_PCT ? ' ↓' : ' =';
    prevPct = pct;

    lines.push(
      '',
      label,
      `${bar(pct)} ${pct}%${arrow}`,
      s.offCount > 0
        ? `без світла ~${formatDuration(s.off / days)} на добу · ${s.offCount} відкл. (${perDay(s.offCount / days)}/добу) · найдовше ${formatDuration(s.longestOff)}`
        : 'без відключень',
    );
  }
  return prevPct === null ? null : lines;
}

/** Початки 14 діб, починаючи з доби lastDayOffset днів тому (0 — сьогодні) */
function dayStartsFrom(ctx: Ctx, lastDayOffset: number): number[] {
  const tz = ctx.env.TIMEZONE;
  const t = localDate(ctx.now(), tz);
  return Array.from({ length: 14 }, (_, i) => zonedMidnight(t.year, t.month, t.day - lastDayOffset - i, tz));
}

/** Початки 12 місяців, починаючи з місяця lastMonthOffset місяців тому (0 — поточний) */
function monthStartsFrom(ctx: Ctx, lastMonthOffset: number): number[] {
  const tz = ctx.env.TIMEZONE;
  const t = localDate(ctx.now(), tz);
  return Array.from({ length: 12 }, (_, i) => zonedMidnight(t.year, t.month - lastMonthOffset - i, 1, tz));
}

/** /stats: останні 7 днів (включно з сьогодні) і 12 місяців (включно з поточним) */
export async function statsText(ctx: Ctx): Promise<string> {
  const now = ctx.now();
  const tz = ctx.env.TIMEZONE;
  const dayStarts = dayStartsFrom(ctx, 0);
  const monthStarts = monthStartsFrom(ctx, 0);
  const sum = summer(await loadPeriods(ctx.db, Math.min(dayStarts[13]!, monthStarts[11]!), now), now);

  const week = weekLines({
    title: '📊 Останні 7 днів',
    versus: 'за попередні 7 днів',
    dayStarts,
    end: now,
    sum,
    now,
    tz,
  }) ?? ['📊 Останні 7 днів', 'Даних немає'];
  const months = monthLines(monthStarts, now, sum) ?? [
    '📅 Останні 12 місяців',
    '↑ / ↓ — світла більше / менше, ніж у попередньому місяці',
    'Даних немає',
  ];
  return [...week, '', ...months].join('\n');
}

/** Звіт у понеділок: повний минулий тиждень Пн–Нд. null — якщо даних немає. */
export async function weeklyReport(ctx: Ctx): Promise<string | null> {
  const now = ctx.now();
  const tz = ctx.env.TIMEZONE;
  const dayStarts = dayStartsFrom(ctx, 1); // [0] — вчора (неділя)
  const todayStart = dayStartsFrom(ctx, 0)[0]!; // кінець тижня, не DAY від початку неділі: доба буває 23/25 год
  const sum = summer(await loadPeriods(ctx.db, dayStarts[13]!, todayStart), now);
  const title = `🗓 Тиждень ${dayLabel(dayStarts[6]!, tz)} – ${dayLabel(dayStarts[0]!, tz)}`;
  const lines = weekLines({ title, versus: 'попереднього тижня', dayStarts, end: todayStart, sum, now, tz });
  return lines?.join('\n') ?? null;
}

/** Звіт 1-го числа: 12 завершених місяців, останній — щойно завершений. null — якщо даних немає. */
export async function monthlyReport(ctx: Ctx): Promise<string | null> {
  const now = ctx.now();
  const monthStarts = monthStartsFrom(ctx, 1); // [0] — минулий місяць
  const thisMonthStart = monthStartsFrom(ctx, 0)[0]!;
  const sum = summer(await loadPeriods(ctx.db, monthStarts[11]!, thisMonthStart), now);
  const lines = monthLines(monthStarts, thisMonthStart, sum);
  if (!lines) return null;
  const mid = monthOf(monthStarts[0]!);
  return [`🗓 Підсумки місяця: ${MONTHS_FULL[mid.getUTCMonth()]} ${mid.getUTCFullYear()}`, '', ...lines].join('\n');
}
