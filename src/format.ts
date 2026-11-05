const MIN = 60_000;

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / MIN);
  if (totalMin < 1) return 'менше хвилини';
  // Без днів: «33 год 12 хв» читається простіше, ніж «1 д 9 год»
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} год`);
  if (m) parts.push(`${m} хв`);
  return parts.join(' ');
}

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;

function zonedParts(ms: number, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out = {} as Parts;
  for (const p of fmt.formatToParts(ms)) {
    if (p.type in { year: 1, month: 1, day: 1, hour: 1, minute: 1, second: 1 }) {
      out[p.type as keyof Parts] = p.value;
    }
  }
  return out;
}

/** «14:32», або «03.11 14:32», якщо це не сьогодні */
export function formatTime(ms: number, tz: string, now: number): string {
  const p = zonedParts(ms, tz);
  const n = zonedParts(now, tz);
  const hm = `${p.hour}:${p.minute}`;
  const sameDay = p.year === n.year && p.month === n.month && p.day === n.day;
  return sameDay ? hm : `${p.day}.${p.month} ${hm}`;
}

function tzOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Кінець інтервалу: північ показуємо як «24:00» попередньої доби, а не «00:00» наступної.
 * «24:00» сьогоднішньої доби — без дати, інакше «dd.mm 24:00».
 */
export function formatEndTime(ms: number, tz: string, now: number): string {
  const p = zonedParts(ms, tz);
  if (p.hour !== '00' || p.minute !== '00') return formatTime(ms, tz, now);
  const day = formatTime(ms - 60_000, tz, now); // 23:59 попередньої доби
  return day.includes('.') ? `${day.split(' ')[0]} 24:00` : '24:00';
}

/** Календарна дата в часовому поясі (month — 1..12) */
export function localDate(ms: number, tz: string): { year: number; month: number; day: number } {
  const p = zonedParts(ms, tz);
  return { year: +p.year, month: +p.month, day: +p.day };
}

/** Місцевий час: дата, година і день тижня (0 — неділя, 1 — понеділок) */
export function localClock(ms: number, tz: string) {
  const p = zonedParts(ms, tz);
  const year = +p.year;
  const month = +p.month;
  const day = +p.day;
  return { year, month, day, hour: +p.hour, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/**
 * 00:00 вказаної дати в часовому поясі, в ms UTC.
 * Переповнення працює як у Date.UTC: day = 0 — останній день попереднього місяця, month = 0 — грудень минулого року.
 */
export function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  const guess = midnightAsUtc - tzOffset(midnightAsUtc, tz);
  return midnightAsUtc - tzOffset(guess, tz);
}

/** Початок поточної доби (00:00) у вказаному часовому поясі, в ms UTC */
export function startOfDay(ms: number, tz: string): number {
  const d = localDate(ms, tz);
  return zonedMidnight(d.year, d.month, d.day, tz);
}

/**
 * Шкала «■■■■■■■■□□» для відсотка (0–100). Окремі квадрати, а не «█», щоб поділки не зливались
 * у суцільну смугу і їх можна було порахувати.
 */
export function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '■'.repeat(filled) + '□'.repeat(10 - filled);
}

/** Тривалість як «год:хв» для таблиць: «4:30», «16:05» */
export function hoursMinutes(ms: number): string {
  const totalMin = Math.round(Math.max(0, ms) / 60_000);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** Екранування для parse_mode HTML */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
