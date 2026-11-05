import type { Ctx } from './env';
import { fetchAddressOutage, dtekLines, matchesOutage, type TrackedDtek } from './dtek';
import { updateState, type State } from './state';

const DAY = 86_400_000;

/** Повідомлення «🔴 Світло зникло» по частинах — щоб перемалювати його, коли ДТЕК оновить дані */
export interface OffParts {
  main: string[];
  /** Рядок за графіком SvitloPulse; показуємо, лише поки немає даних ДТЕК */
  schedule: string | null;
  notes: string[];
}

export function renderOff(parts: OffParts, dtek: TrackedDtek | null, now: number, tz: string): string {
  const extra = dtek ? dtekLines(dtek, now, tz) : parts.schedule ? [parts.schedule] : [];
  return [...parts.main, ...extra, ...parts.notes].join('\n');
}

/** Дані ДТЕК для відключення, що почалось у `at`. null — адреса не задана, ДТЕК мовчить або недоступний. */
export async function dtekForOutage(ctx: Ctx, s: State, at: number): Promise<TrackedDtek | null> {
  if (!s.dtek_street || !s.dtek_house) return null;
  const res = await fetchAddressOutage(ctx, s.dtek_street, s.dtek_house);
  if (!res.ok || !res.outage || !matchesOutage(res.outage, at)) return null;
  return { ...res.outage, firstEnd: res.outage.end };
}

/**
 * Поки світла немає — перепитуємо ДТЕК (з cron) і редагуємо «🔴 Світло зникло»,
 * якщо ДТЕК зареєстрував відключення пізніше за нас або переніс час відновлення.
 */
export async function refreshOutageMessage(ctx: Ctx, s: State): Promise<void> {
  if (s.mode !== 'off' || s.mode_since === null || !s.off_parts) return;
  if (s.off_message_chat_id === null || s.off_message_id === null) return;
  if (!s.dtek_street || !s.dtek_house || ctx.now() - s.mode_since > DAY) return;

  const res = await fetchAddressOutage(ctx, s.dtek_street, s.dtek_house);
  if (!res.ok || !res.outage || !matchesOutage(res.outage, s.mode_since)) return;

  const prev = s.off_dtek ? (JSON.parse(s.off_dtek) as TrackedDtek) : null;
  if (prev && prev.reason === res.outage.reason && prev.end === res.outage.end) return;

  const tracked: TrackedDtek = { ...res.outage, firstEnd: prev?.firstEnd ?? res.outage.end };
  await updateState(ctx.db, { off_dtek: JSON.stringify(tracked) });
  try {
    await ctx.tg.call('editMessageText', {
      chat_id: s.off_message_chat_id,
      message_id: s.off_message_id,
      text: renderOff(JSON.parse(s.off_parts) as OffParts, tracked, ctx.now(), ctx.env.TIMEZONE),
    });
  } catch (err) {
    console.error('could not update the outage message', err);
  }
}
