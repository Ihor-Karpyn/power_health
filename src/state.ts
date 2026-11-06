export type Mode = 'on' | 'off' | 'paused';

export interface State {
  mode: Mode | null;
  mode_since: number | null;
  mode_since_approx: number;
  paused_by: string | null;
  pause_reminded_at: number | null;
  phone_charging: number | null;
  phone_ts: number | null;
  battery: number | null;
  last_seen: number | null;
  detector_offline: number;
  channel_id: number | null;
  channel_title: string | null;
  off_message_chat_id: number | null;
  off_message_id: number | null;
  last_weekly_report: string | null;
  last_monthly_report: string | null;
  schedule_group: string | null;
  dtek_street: string | null;
  dtek_house: string | null;
  off_parts: string | null;
  off_dtek: string | null;
  warned_outage_start: number | null;
  tomorrow_sent_date: string | null;
  status_message_chat_id: number | null;
  status_message_id: number | null;
  status_text: string | null;
  status_pin_warned: number;
  warn_message_chat_id: number | null;
  warn_message_id: number | null;
  warn_sent_at: number | null;
  warn_text: string | null;
  on_message_chat_id: number | null;
  on_message_id: number | null;
  /** Тестовий режим увімкнено (ms) — запити телефона не застосовуються */
  test_since: number | null;
  test_reminded_at: number | null;
}

export async function getState(db: D1Database): Promise<State> {
  const row = await db.prepare('SELECT * FROM state WHERE id = 1').first<State>();
  if (!row) throw new Error('state row is missing: run the D1 migrations');
  return row;
}

export async function updateState(db: D1Database, fields: Partial<State>): Promise<void> {
  const keys = Object.keys(fields) as (keyof State)[];
  if (keys.length === 0) return;
  await db
    .prepare(`UPDATE state SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`)
    .bind(...keys.map((k) => fields[k] ?? null))
    .run();
}

/** Закриває поточний період і відкриває новий — атомарно. */
export async function switchMode(
  db: D1Database,
  mode: Mode,
  at: number,
  opts: { approx?: boolean; pausedBy?: string } = {},
): Promise<void> {
  const approx = opts.approx ? 1 : 0;
  await db.batch([
    db.prepare('UPDATE periods SET end_ts = ?, end_approx = ? WHERE end_ts IS NULL').bind(at, approx),
    db.prepare('INSERT INTO periods (kind, start_ts, start_approx) VALUES (?, ?, ?)').bind(mode, at, approx),
    db
      .prepare(
        'UPDATE state SET mode = ?, mode_since = ?, mode_since_approx = ?, paused_by = ?, pause_reminded_at = NULL WHERE id = 1',
      )
      .bind(mode, at, approx, opts.pausedBy ?? null),
  ]);
}

export interface Summary {
  off: number;
  offCount: number;
  longestOff: number;
  on: number;
  paused: number;
}

export interface Period {
  kind: Mode;
  start_ts: number;
  end_ts: number | null;
}

/** Усі періоди, що перетинаються з [from, to) — одним запитом */
export async function loadPeriods(db: D1Database, from: number, to: number): Promise<Period[]> {
  const { results } = await db
    .prepare('SELECT kind, start_ts, end_ts FROM periods WHERE start_ts < ? AND (end_ts IS NULL OR end_ts > ?)')
    .bind(to, from)
    .all<Period>();
  return results;
}

/** Скільки часу у вікні [from, to) світло було / не було / стояла пауза */
export function summarize(periods: Period[], from: number, to: number, now: number): Summary {
  const s: Summary = { off: 0, offCount: 0, longestOff: 0, on: 0, paused: 0 };
  for (const p of periods) {
    const end = p.end_ts ?? now;
    const clipped = Math.min(end, to) - Math.max(p.start_ts, from);
    if (clipped <= 0) continue;
    if (p.kind === 'off') {
      s.off += clipped;
      s.offCount += 1;
      s.longestOff = Math.max(s.longestOff, end - p.start_ts);
    } else if (p.kind === 'on') {
      s.on += clipped;
    } else {
      s.paused += clipped;
    }
  }
  return s;
}
