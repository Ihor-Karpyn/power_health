import { notifyOwner, type Ctx } from './env';
import type { TrackedDtek } from './dtek';
import { formatDuration, formatEndTime, formatTime } from './format';
import { fetchGroup, isEmergency, offIntervals, type GroupInfo } from './schedule';
import { getState, updateState, type State } from './state';

/**
 * Закріплене в каналі повідомлення «що зараз»: бот редагує його раз на 5 хв (cron)
 * і одразу після зміни стану. Якщо його видалили — створює нове.
 */
export function renderStatus(s: State, g: GroupInfo | null, now: number, tz: string): string {
  const lines: string[] = [];
  const since = s.mode_since;
  const span = since !== null
    ? `${s.mode_since_approx ? '≈ ' : ''}${formatDuration(now - since)} (з ${formatTime(since, tz, now)})`
    : '';

  if (s.mode === 'on') lines.push(`🟢 Світло є ${span}`);
  else if (s.mode === 'off') lines.push(`🔴 Світла немає ${span}`);
  else if (s.mode === 'paused') lines.push('⏸ Трекінг на паузі');
  else lines.push('❔ Стан ще невідомий');

  if (s.detector_offline && s.last_seen !== null) {
    lines.push(`⚠️ Детектор не на зв'язку з ${formatTime(s.last_seen, tz, now)}`);
  }

  if (s.mode === 'off') {
    const dtek = s.off_dtek ? (JSON.parse(s.off_dtek) as TrackedDtek) : null;
    const planned = g && !isEmergency(g) ? offIntervals(g).find((i) => i.start <= now && now < i.end) : undefined;
    if (dtek?.end) lines.push(`🕦 ДТЕК: відновлення до ${formatTime(dtek.end, tz, now)}`);
    else if (planned) lines.push(`📅 За графіком: до ${formatEndTime(planned.end, tz, now)}`);
    else if (g && isEmergency(g)) lines.push('⚠️ Аварійні відключення, графік не діє');
  } else if (s.mode === 'on' && g) {
    const next = offIntervals(g).find((i) => i.start > now);
    if (isEmergency(g)) lines.push('⚠️ Аварійні відключення, графік не діє');
    else if (next) lines.push(`📅 Наступне відключення: ${formatTime(next.start, tz, now)}–${formatEndTime(next.end, tz, now)}`);
    else if ((g.tomorrow ?? []).length === 0) lines.push('📅 Сьогодні більше відключень за графіком немає');
    else lines.push('📅 Відключень за графіком не заплановано');
  }

  lines.push(`🕐 Оновлено ${formatTime(now, tz, now)}`);
  return lines.join('\n');
}

const isNotFound = (err: unknown) => /not found|message_id_invalid/i.test(String((err as Error)?.message ?? err));

/** g === undefined — завантажити графік самостійно */
export async function updatePinnedStatus(ctx: Ctx, group?: GroupInfo | null): Promise<void> {
  const s = await getState(ctx.db);
  if (s.channel_id === null) return;
  let g = group ?? null;
  if (group === undefined && s.schedule_group) {
    const res = await fetchGroup(ctx, s.schedule_group);
    g = res.ok ? res.group : null;
  }
  const text = renderStatus(s, g, ctx.now(), ctx.env.TIMEZONE);

  if (s.status_message_id !== null && s.status_message_chat_id === s.channel_id) {
    if (text === s.status_text) return;
    try {
      await ctx.tg.call('editMessageText', { chat_id: s.channel_id, message_id: s.status_message_id, text });
      await updateState(ctx.db, { status_text: text });
      return;
    } catch (err) {
      if (!isNotFound(err)) {
        console.error('status message edit failed', err);
        return;
      }
      // повідомлення видалили — створимо нове нижче
    }
  }

  let sent: { message_id: number };
  try {
    sent = (await ctx.tg.call('sendMessage', {
      chat_id: s.channel_id,
      text,
      disable_notification: true,
    })) as { message_id: number };
  } catch (err) {
    console.error('status message send failed', err);
    return;
  }
  await updateState(ctx.db, { status_message_chat_id: s.channel_id, status_message_id: sent.message_id, status_text: text });
  try {
    await ctx.tg.call('pinChatMessage', { chat_id: s.channel_id, message_id: sent.message_id, disable_notification: true });
  } catch (err) {
    console.error('pin failed', err);
    if (!s.status_pin_warned) {
      await updateState(ctx.db, { status_pin_warned: 1 });
      await notifyOwner(
        ctx,
        '📌 Не можу закріпити повідомлення зі станом у каналі. Дай мені право «Редагувати повідомлення інших» ' +
          '(у каналах воно відповідає за закріплення), і я закріплю його під час наступного оновлення.',
      );
    }
  }
}

/** Запустити у фоні (після відповіді на запит), якщо платформа це вміє; інакше дочекатися */
export async function inBackground(ctx: Ctx, task: () => Promise<void>): Promise<void> {
  const run = () => task().catch((err) => console.error('background task failed', err));
  if (ctx.defer) ctx.defer(run());
  else await run();
}
