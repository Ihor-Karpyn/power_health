import { beforeEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/bot';
import { runCron } from '../src/cron';
import { handleReport, parseReport, type ReportKind } from '../src/device';
import { formatDuration, formatEndTime, startOfDay } from '../src/format';
import { route } from '../src/index';
import { getState } from '../src/state';
import {
  CHANNEL,
  channelPost,
  createCtx,
  HOUR,
  membership,
  MIN,
  OWNER,
  privateMessage,
  STRANGER,
  T0,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
beforeEach(() => {
  ctx = createCtx();
});

/** Власник додає бота в канал і пише там /activate */
async function activateChannel() {
  await handleUpdate(ctx, membership(CHANNEL, OWNER, 'administrator'));
  await handleUpdate(ctx, channelPost('/activate', OWNER));
  ctx.clear();
}

/** Телефон повідомляє стан, зафіксований зараз */
const report = (charging: boolean, kind: ReportKind = 'event', ts = ctx.now()) =>
  handleReport(ctx, { charging, ts, battery: 80 }, kind);

/** Повідомлення від власника в особистий чат з ботом */
const command = (text: string, from = OWNER) => handleUpdate(ctx, privateMessage(from, text));

/** Запускає трекінг: світло є, лічильник з T0 */
async function startTracking() {
  await activateChannel();
  await report(true, 'heartbeat');
  ctx.clear();
}

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(30_000)).toBe('менше хвилини');
    expect(formatDuration(45 * MIN)).toBe('45 хв');
    expect(formatDuration(3 * HOUR + 12 * MIN)).toBe('3 год 12 хв');
    expect(formatDuration(26 * HOUR + 5 * MIN)).toBe('26 год 5 хв');
  });

  it('shows the end of the day as 24:00', () => {
    const now = T0; // 05.11 10:00
    const midnight = Date.UTC(2026, 10, 5, 22); // 06.11 00:00 за Києвом
    expect(formatEndTime(midnight, 'Europe/Kyiv', now)).toBe('24:00');
    expect(formatEndTime(midnight + 24 * HOUR, 'Europe/Kyiv', now)).toBe('06.11 24:00');
    expect(formatEndTime(midnight + 2 * HOUR, 'Europe/Kyiv', now)).toBe('06.11 02:00');
  });

  it('finds midnight in Kyiv, including across DST', () => {
    // 5 листопада: UTC+2 → північ = 22:00 UTC попереднього дня
    expect(new Date(startOfDay(T0, 'Europe/Kyiv')).toISOString()).toBe('2026-11-04T22:00:00.000Z');
    // 1 липня: UTC+3
    expect(new Date(startOfDay(Date.UTC(2026, 6, 1, 12), 'Europe/Kyiv')).toISOString()).toBe(
      '2026-06-30T21:00:00.000Z',
    );
  });
});

describe('parseReport', () => {
  const now = T0;
  it('accepts seconds, milliseconds and string booleans', () => {
    expect(parseReport({ charging: 'true', ts: String(now / 1000 - 60) }, now)).toEqual({
      charging: true,
      ts: now - 60_000,
      battery: null,
    });
    expect(parseReport({ charging: false, ts: now - 1000, battery: '57' }, now)).toEqual({
      charging: false,
      ts: now - 1000,
      battery: 57,
    });
  });

  it('falls back to server time for a missing, unresolved or future ts', () => {
    expect(parseReport({ charging: 1, ts: '{system_time}' }, now)).toMatchObject({ ts: now });
    expect(parseReport({ charging: 1 }, now)).toMatchObject({ ts: now });
    expect(parseReport({ charging: 1, ts: now + HOUR }, now)).toMatchObject({ ts: now });
  });

  it('rejects an unknown charging value', () => {
    expect(parseReport({ charging: 'maybe' }, now)).toHaveProperty('error');
    expect(parseReport(null, now)).toHaveProperty('error');
  });
});

describe('power events', () => {
  it('announces the initial state', async () => {
    await activateChannel();
    expect(await report(true, 'heartbeat')).toBe('initialized');
    expect(ctx.sent()).toEqual(['📡 Детектор підключено. Зараз світло є 🟢']);
  });

  it('reports outages with exact time and duration', async () => {
    await startTracking();
    ctx.advance(2 * HOUR);
    expect(await report(false)).toBe('changed');
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 12:00\nСвітло було: ≈ 2 год']);

    ctx.clear();
    ctx.advance(3 * HOUR + 15 * MIN);
    await report(true);
    expect(ctx.sent()).toEqual(["🟢 Світло з'явилось о 15:15\nСвітла не було: 3 год 15 хв"]);
  });

  it('uses the phone timestamp, so a delayed event still gets the right duration', async () => {
    await startTracking();
    ctx.advance(HOUR);
    await report(false);
    ctx.clear();
    const backAt = ctx.now() + 2 * HOUR;
    ctx.advance(2 * HOUR + 10 * MIN); // запит дійшов на 10 хв пізніше
    await report(true, 'event', backAt);
    expect(ctx.sent()[0]).toContain('Світла не було: 2 год');
  });

  it('ignores retries of the same event and out-of-order reports', async () => {
    await startTracking();
    ctx.advance(HOUR);
    const offAt = ctx.now();
    await report(false, 'event', offAt);
    ctx.clear();
    expect(await report(false, 'event', offAt)).toBe('stale');
    expect(await report(true, 'heartbeat', offAt - MIN)).toBe('stale');
    expect(ctx.sent()).toEqual([]);
    expect((await getState(ctx.db)).mode).toBe('off');
  });

  it('recovers a lost event from the heartbeat and marks it as approximate', async () => {
    await startTracking();
    ctx.advance(15 * MIN);
    await report(true, 'heartbeat');
    ctx.advance(15 * MIN);
    // подія «зарядку відключено» загубилась, heartbeat каже: не заряджається
    expect(await report(false, 'heartbeat')).toBe('changed');
    expect(ctx.sent()).toEqual([
      '🔴 Світло зникло приблизно між 10:15 і 10:30\nСвітло було: ≈ 30 хв\nℹ️ Подія з телефона не дійшла, стан відновлено з heartbeat',
    ]);
  });

  it('stays quiet when a heartbeat confirms the current state', async () => {
    await startTracking();
    ctx.advance(15 * MIN);
    expect(await report(true, 'heartbeat')).toBe('unchanged');
    expect(ctx.sent()).toEqual([]);
  });
});

describe('short blips', () => {
  /** id повідомлення «світло зникло», яке бот опублікував у канал */
  const lastChannelMessageId = () =>
    ctx.calls.findLast((c) => c.method === 'sendMessage' && c.params.chat_id === CHANNEL.id)!;

  async function outage(minutes: number) {
    await startTracking();
    ctx.advance(HOUR);
    await report(false);
    const offCallIndex = ctx.calls.indexOf(lastChannelMessageId());
    ctx.advance(minutes * MIN);
    const result = await report(true);
    return { result, offMessageId: 1000 + offCallIndex + 1 };
  }

  it('erases an outage shorter than 5 minutes: deletes the message, sends nothing, keeps no history', async () => {
    const { result, offMessageId } = await outage(4);
    expect(result).toBe('blip');
    expect(ctx.calls.find((c) => c.method === 'deleteMessage')).toEqual({
      method: 'deleteMessage',
      params: { chat_id: CHANNEL.id, message_id: offMessageId },
    });
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 11:00\nСвітло було: ≈ 1 год']); // лише видалене

    const s = await getState(ctx.db);
    expect(s).toMatchObject({ mode: 'on', mode_since: T0, off_message_id: null });

    // Наступне справжнє відключення рахує «світло було» від початку, без блимання
    ctx.clear();
    ctx.advance(2 * HOUR);
    await report(false);
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 13:04\nСвітло було: ≈ 3 год 4 хв']);

    ctx.clear();
    ctx.advance(MIN);
    await command('/stats');
    expect(ctx.dm()[0]).toContain('🔴 Без світла 1 хв, відключень: 1');
  });

  it('keeps outages of 5 minutes or longer', async () => {
    const { result } = await outage(5);
    expect(result).toBe('changed');
    expect(ctx.sent().at(-1)).toBe("🟢 Світло з'явилось о 11:05\nСвітла не було: 5 хв");
    expect(ctx.calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('keeps the outage if the message cannot be deleted', async () => {
    ctx.failing.add('deleteMessage');
    const { result } = await outage(2);
    expect(result).toBe('changed');
    expect(ctx.sent().at(-1)).toBe("🟢 Світло з'явилось о 11:02\nСвітла не було: 2 хв");
  });

  it('erases a short outage right after /resume as well', async () => {
    await startTracking();
    await command('/pause');
    ctx.advance(10 * MIN);
    await report(true);
    await command('/resume');
    ctx.advance(MIN);
    await report(false);
    ctx.advance(2 * MIN);
    expect(await report(true)).toBe('blip');
  });

  it('keeps a short outage when there was no "light on" period before it', async () => {
    await activateChannel();
    await report(false, 'heartbeat'); // детектор підключили, коли світла не було
    ctx.advance(2 * MIN);
    expect(await report(true)).toBe('changed');
    expect(ctx.sent().at(-1)).toMatch(/^🟢 Світло з'явилось о 10:02/);
  });
});

describe('detector watchdog (cron)', () => {
  it('alerts once when the phone goes silent and announces its return', async () => {
    await startTracking();
    ctx.advance(40 * MIN);
    await runCron(ctx);
    expect(ctx.sent()).toEqual([]);

    ctx.advance(10 * MIN);
    await runCron(ctx);
    ctx.advance(5 * MIN);
    await runCron(ctx);
    expect(ctx.sent()).toHaveLength(1);
    expect(ctx.sent()[0]).toMatch(/^⚠️ Детектор не на зв'язку вже 50 хв \(останній сигнал о 10:00\)/);

    ctx.clear();
    await report(true, 'heartbeat');
    expect(ctx.sent()).toEqual(["✅ Детектор знову на зв'язку (мовчав 55 хв)"]);
  });

  it('a phone that died during an outage reports the return of power approximately', async () => {
    await startTracking();
    ctx.advance(HOUR);
    await report(false);
    ctx.advance(10 * HOUR); // телефон розрядився
    await runCron(ctx);
    ctx.clear();
    ctx.advance(2 * HOUR);
    await report(true, 'heartbeat'); // увімкнувся після появи світла
    const [back, power] = ctx.sent();
    expect(back).toMatch(/^✅ Детектор знову на зв'язку/);
    expect(power).toMatch(/^🟢 Світло з'явилось приблизно між 11:00 і 23:00\nСвітла не було: ≈ 12 год/);
  });
});

describe('channel activation', () => {
  it('sends nothing anywhere until a channel is activated', async () => {
    await report(true, 'heartbeat');
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.calls).toEqual([]);
    await command('/status');
    expect(ctx.dm()[0]).toContain('📢 Канал не активовано');
  });

  it('tells the owner to post /activate in the channel after being added', async () => {
    await handleUpdate(ctx, membership(CHANNEL, OWNER, 'administrator'));
    expect(ctx.dm()).toEqual([
      'Мене додали в канал «Світло вдома».\nНапиши в цьому каналі /activate, щоб я надсилав туди сповіщення про світло.',
    ]);
    ctx.clear();
    await command('/activate');
    expect(ctx.dm()[0]).toContain('Напиши в самому каналі /activate');
  });

  it('activates on /activate posted by the owner and removes the command post', async () => {
    const post = channelPost('/activate', OWNER);
    await handleUpdate(ctx, post);
    expect(ctx.sent()).toEqual(['✅ Тепер тут будуть сповіщення про світло']);
    expect(ctx.calls.find((c) => c.method === 'deleteMessage')?.params).toEqual({
      chat_id: CHANNEL.id,
      message_id: post.channel_post!.message_id,
    });
    expect(ctx.dm()).toEqual(['✅ Сповіщення тепер ідуть у канал «Світло вдома»']);

    ctx.clear();
    await report(true, 'heartbeat');
    expect(ctx.sent()).toEqual(['📡 Детектор підключено. Зараз світло є 🟢']);
  });

  it('activates an anonymous post only if the owner created the channel', async () => {
    ctx.ownerStatus = 'administrator';
    await handleUpdate(ctx, channelPost('/activate'));
    expect(ctx.calls.map((c) => c.method)).toEqual(['getChatMember']);
    expect((await getState(ctx.db)).channel_id).toBeNull();

    ctx.ownerStatus = 'creator';
    await handleUpdate(ctx, channelPost('/activate'));
    expect((await getState(ctx.db)).channel_id).toBe(CHANNEL.id);
  });

  it('ignores /activate from anyone else and ordinary posts', async () => {
    await handleUpdate(ctx, channelPost('/activate', STRANGER));
    await handleUpdate(ctx, channelPost('Привіт, підписники', OWNER));
    expect(ctx.calls).toEqual([]);
    expect((await getState(ctx.db)).channel_id).toBeNull();
  });

  it('does not activate a channel it cannot post to', async () => {
    ctx.failSendTo(CHANNEL.id);
    await handleUpdate(ctx, channelPost('/activate', OWNER));
    expect(ctx.dm()[0]).toMatch(/^⛔ Не можу писати в канал «Світло вдома»/);
    expect((await getState(ctx.db)).channel_id).toBeNull();
  });

  it('leaves channels added by anyone else, and any groups', async () => {
    const foreign = { id: -100555, type: 'channel' as const, title: 'Чужий' };
    await handleUpdate(ctx, membership(foreign, STRANGER, 'administrator'));
    await handleUpdate(ctx, membership({ id: -777, type: 'group' }, OWNER, 'member'));
    expect(ctx.calls.map((c) => [c.method, c.params.chat_id])).toEqual([
      ['leaveChat', -100555],
      ['leaveChat', -777],
    ]);
  });

  it('warns the owner when removed from the active channel', async () => {
    await activateChannel();
    await handleUpdate(ctx, membership(CHANNEL, OWNER, 'left'));
    expect(ctx.dm()[0]).toMatch(/^⚠️ Мене прибрали з каналу «Світло вдома»/);
    ctx.clear();
    await report(true, 'heartbeat');
    expect(ctx.sent()).toEqual([]);
  });
});

describe('bot access', () => {
  it('ignores everyone except the owner', async () => {
    await command('/status', STRANGER);
    await command('/pause', STRANGER);
    await command('/resume', STRANGER);
    expect(ctx.calls).toEqual([]);
  });

  it('leaves a group when it receives a message there', async () => {
    await handleUpdate(ctx, {
      update_id: 1,
      message: { message_id: 1, chat: { id: -555, type: 'supergroup' }, from: OWNER, text: '/status' },
    });
    expect(ctx.calls.map((c) => c.method)).toEqual(['leaveChat']);
  });

  it('understands /cmd@botname and answers unknown commands with help', async () => {
    await command('/status@Ihor_power_health_bot');
    await command('/whatever');
    expect(ctx.dm()).toHaveLength(2);
    expect(ctx.dm()[1]).toMatch(/^Команди:/);
  });
});

describe('pause / resume', () => {
  it('stops recording and notifications while paused', async () => {
    await startTracking();
    ctx.advance(HOUR);
    await command('/pause');
    expect(ctx.dm()[0]).toMatch(/^⏸ Трекінг на паузі/);
    ctx.clear();

    ctx.advance(MIN);
    expect(await report(false)).toBe('paused');
    ctx.advance(50 * MIN); // поза паузою тут уже був би «детектор не на зв'язку»
    await runCron(ctx);
    expect(ctx.sent()).toEqual([]);
  });

  it('refuses to resume until the phone is charging again', async () => {
    await startTracking();
    await command('/pause');
    ctx.advance(MIN);
    await report(false);
    ctx.clear();

    await command('/resume');
    expect(ctx.dm()).toEqual(['🔌 Телефон зараз не на зарядці. Підключи його і повтори /resume']);

    ctx.clear();
    ctx.advance(30 * MIN);
    await report(true);
    await command('/resume');
    expect(ctx.dm()).toEqual(['▶️ Трекінг відновлено (пауза тривала 31 хв). Світло є 🟢']);
    expect((await getState(ctx.db)).mode).toBe('on');

    ctx.clear();
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 11:31\nСвітло було: 1 год']);
  });

  it('reminds the owner after 1 hour and then every 3 hours', async () => {
    await startTracking();
    await command('/pause');
    ctx.clear();
    const remindersAt: number[] = [];
    for (let t = 5; t <= 8 * 60; t += 5) {
      ctx.setNow(T0 + t * MIN);
      await runCron(ctx);
      if (ctx.dm().length > remindersAt.length) remindersAt.push(t);
    }
    expect(remindersAt).toEqual([60, 240, 420]);
    expect(ctx.sent()).toEqual([]);
    expect(ctx.dm()[0]).toBe('⏸ Трекінг на паузі вже 1 год.\nКоли телефон знову буде на зарядці — /resume');
  });

  it('excludes the pause from statistics', async () => {
    await startTracking();
    ctx.advance(HOUR);
    await report(false);
    ctx.advance(30 * MIN);
    await report(true);
    ctx.advance(30 * MIN);
    await command('/pause');
    ctx.advance(HOUR);
    await report(true, 'heartbeat');
    await command('/resume');
    ctx.clear();

    await command('/stats');
    const text = ctx.dm()[0]!;
    // пауза не входить у відсоток: 1 год 30 хв світла з 2 год відстеженого часу
    expect(text).toContain('💡 Світло було 75% часу');
    expect(text).toContain('🔴 Без світла 30 хв, відключень: 1');
    expect(text).toContain('⏸ На паузі: 1 год');
  });
});

describe('/stats', () => {
  /** Час за Києвом: до 25.10.2026 04:00 — UTC+3, після — UTC+2 */
  const kyiv = (month: number, day: number, hour = 0) =>
    Date.UTC(2026, month - 1, day, hour) - (month < 10 || (month === 10 && (day < 25 || (day === 25 && hour < 4))) ? 3 : 2) * HOUR;

  async function period(kind: 'on' | 'off' | 'paused', start: number, end: number | null) {
    await ctx.db.prepare('INSERT INTO periods (kind, start_ts, end_ts) VALUES (?, ?, ?)').bind(kind, start, end).run();
  }

  async function stats() {
    await command('/stats');
    // таблиці — у <pre>, тому повідомлення має йти з parse_mode HTML
    expect(ctx.calls.find((c) => c.method === 'sendMessage')?.params.parse_mode).toBe('HTML');
    return ctx.dm()[0]!;
  }

  it('says there is no data yet', async () => {
    expect(await stats()).toBe(
      '📊 Останні 7 днів\nДаних немає\n\n📅 Останні 12 місяців\n↑ / ↓ — світла більше / менше, ніж у попередньому місяці\nДаних немає',
    );
  });

  it('shows days and months, skipping the ones without data', async () => {
    // Вересень: 5 днів світла, потім 5 днів без світла одним шматком
    await period('on', kyiv(9, 10), kyiv(9, 15));
    await period('off', kyiv(9, 15), kyiv(9, 20));
    // Попередній тиждень: 25 жовтня (доба з переходом на зимовий час, 25 год) — світло весь день
    await period('on', kyiv(10, 25), kyiv(10, 26));
    // Цей тиждень
    await period('on', kyiv(11, 3), kyiv(11, 3, 6));
    await period('off', kyiv(11, 3, 6), kyiv(11, 3, 10));
    await period('on', kyiv(11, 3, 10), kyiv(11, 4, 20));
    await period('off', kyiv(11, 4, 20), kyiv(11, 5, 2));
    await period('on', kyiv(11, 5, 2), null);
    // зараз T0 = 05.11 10:00

    expect(await stats()).toBe(
      [
        '📊 Останні 7 днів',
        '💡 Світло було 83% часу',
        '🔴 Без світла 10 год, відключень: 2',
        '⏱ В середньому 5 год, найдовше 6 год',
        '📉 Світла менше, ніж за попередні 7 днів: 83% проти 100%',
        '',
        'По днях: % часу зі світлом · без світла год:хв × відключень',
        '<pre>Вт 03.11 ■■■■■■■■□□  83%   4:00 ×1',
        'Ср 04.11 ■■■■■■■■□□  83%   4:00 ×1',
        'Чт 05.11 ■■■■■■■■□□  80%   2:00 ×1</pre>',
        'Чт 05.11 — сьогодні, до 10:00',
        '',
        '📅 Останні 12 місяців',
        '↑ / ↓ — світла більше / менше, ніж у попередньому місяці',
        '<pre>Вер 2026 ■■■■■□□□□□  50%',
        'Жов 2026 ■■■■■■■■■■ 100% ↑',
        'Лис 2026 ■■■■■■■■□□  83% ↓</pre>',
        '',
        'Без світла на добу · відключень · найдовше:',
        'Вер 2026: ~12 год на добу · 1 відкл. (0,1/добу) · найдовше 120 год (дані за 10 дн.)',
        'Жов 2026: без відключень (дані за 1 дн.)',
        'Лис 2026: ~4 год 8 хв на добу · 2 відкл. (0,8/добу) · найдовше 6 год (дані за 2 дн.)',
      ].join('\n'),
    );
  });

  it('crosses the year boundary for the monthly view', async () => {
    ctx.setNow(Date.UTC(2027, 0, 10, 10));
    await period('on', Date.UTC(2026, 11, 1), Date.UTC(2026, 11, 2));
    await period('on', Date.UTC(2027, 0, 9), null);
    const text = await stats();
    expect(text).toContain('Гру 2026');
    expect(text).toContain('Січ 2027');
  });
});

describe('outage schedule (SvitloPulse)', () => {
  const KEY = 'dtek-kem:20.1';
  /** Інтервал за Києвом (листопад, UTC+2): day — число листопада */
  const iv = (day: number, from: string, toDay: number, to: string, kind = 'off') => ({
    start: `2026-11-${String(day).padStart(2, '0')}T${from}:00+02:00`,
    end: `2026-11-${String(toDay).padStart(2, '0')}T${to}:00+02:00`,
    kind,
  });
  const planned = (today: object[], tomorrow: object[] = []) => ({
    key: KEY,
    state: 'off',
    class: 'planned',
    plan_status: 'applies',
    today,
    tomorrow,
  });

  async function setQueue(arg = '20.1') {
    await command(`/queue ${arg}`);
    const reply = ctx.dm().at(-1)!;
    ctx.clear();
    ctx.fetched.length = 0;
    return reply;
  }

  beforeEach(async () => {
    ctx.groups[KEY] = planned([iv(5, '11:00', 5, '18:30'), iv(5, '21:30', 6, '00:00')], [iv(6, '00:00', 6, '02:00')]);
  });

  it('does not call the API until a queue is set', async () => {
    await startTracking();
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.fetched).toEqual([]);
    expect(ctx.sent()[0]).not.toContain('📅');
  });

  it('adds the planned restore time to the outage message', async () => {
    await startTracking();
    expect(await setQueue()).toBe('✅ Черга dtek-kem:20.1\nЗараз: наступне відключення 11:00–18:30');
    ctx.advance(HOUR + 3 * MIN); // 11:03
    await report(false);
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 11:03\nСвітло було: ≈ 1 год 3 хв\n📅 За графіком: до 18:30 (ще ~7 год 27 хв)']);
    expect(ctx.fetched[0]).toBe('https://svitlopulse.andrewboyko.name/api/v1/groups/dtek-kem/20.1');
  });

  it('tolerates the outage starting a bit before the scheduled interval', async () => {
    await startTracking();
    await setQueue();
    ctx.advance(50 * MIN); // 10:50, за графіком з 11:00
    await report(false);
    expect(ctx.sent()[0]).toContain('📅 За графіком: до 18:30');
  });

  it('joins intervals across midnight', async () => {
    await startTracking();
    await setQueue();
    ctx.setNow(Date.UTC(2026, 10, 5, 19, 35)); // 21:35 за Києвом
    await report(false);
    expect(ctx.sent()[0]).toContain('📅 За графіком: до 06.11 02:00 (ще ~4 год 25 хв)');
  });

  it('says when the schedule does not apply because of emergency outages', async () => {
    ctx.groups[KEY] = { key: KEY, state: 'off', class: 'emergency', plan_status: 'emergency', today: [], tomorrow: [] };
    await startTracking();
    await setQueue();
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.sent()[0]).toContain('⚠️ Аварійне відключення: графік не діє, час відновлення невідомий');
  });

  it('marks outages that are not in the schedule', async () => {
    await startTracking();
    await setQueue();
    ctx.advance(9 * HOUR); // 19:00 — за графіком світло є
    await report(false);
    expect(ctx.sent()[0]).toContain('ℹ️ Відключення поза графіком');
  });

  it('sends the outage message without schedule when SvitloPulse is down', async () => {
    await startTracking();
    await setQueue();
    ctx.scheduleDown = true;
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.sent()).toEqual(['🔴 Світло зникло о 11:00\nСвітло було: ≈ 1 год']);
  });

  it("shows the next scheduled outage when power returns", async () => {
    await startTracking();
    await setQueue();
    ctx.advance(HOUR);
    await report(false);
    ctx.clear();
    ctx.setNow(Date.UTC(2026, 10, 5, 16, 25)); // 18:25
    await report(true);
    expect(ctx.sent()).toEqual([
      "🟢 Світло з'явилось о 18:25\nСвітла не було: 7 год 25 хв\n📅 Наступне відключення за графіком: 21:30–06.11 02:00",
    ]);
  });

  it('/queue validates, shows and clears the queue', async () => {
    expect(await setQueue('')).toMatch(/^Черга не задана/);
    expect(await setQueue('abc')).toMatch(/^Не розумію чергу/);
    expect(await setQueue('99.1')).toBe('⛔ Черги dtek-kem:99.1 немає в SvitloPulse. Перевір номер у застосунку YASNO/ДТЕК');
    ctx.scheduleDown = true;
    expect(await setQueue('20.1')).toBe('⛔ SvitloPulse зараз не відповідає, спробуй трохи пізніше');
    ctx.scheduleDown = false;
    ctx.groups['dtek-krem:3.1'] = planned([]);
    expect(await setQueue('DTEK-KREM:3.1')).toBe('✅ Черга dtek-krem:3.1\nЗараз: відключень за графіком не заплановано');
    expect(await setQueue('')).toMatch(/^📅 Черга: dtek-krem:3\.1/);
    expect(await setQueue('off')).toMatch(/^📅 Графік вимкнено/);
    expect((await getState(ctx.db)).schedule_group).toBeNull();
  });

  it('/status shows the schedule for the queue', async () => {
    await startTracking();
    await setQueue();
    ctx.advance(2 * HOUR); // 12:00, за графіком без світла до 18:30
    await command('/status');
    expect(ctx.dm()[0]).toContain('📅 Черга dtek-kem:20.1: за графіком світла немає до 18:30');
  });
});

describe('DTEK address data', () => {
  const STREET = 'вул. Кониського Олександра';
  const STABILIZATION = 'Стабілізаційне відключення (Згідно графіку погодинних відключень)';
  const house = (sub_type = '', start = '', end = '') => ({
    sub_type,
    start_date: start,
    end_date: end,
    type: sub_type ? '2' : '',
    sub_type_reason: ['GPV20.1'],
    voluntarily: null,
    cek: null,
  });
  const setHouse = (h: ReturnType<typeof house>) => (ctx.dtekStreets[STREET]!['70/72'] = h);

  async function setAddress(arg = `${STREET}, 70/72`) {
    await command(`/address ${arg}`);
    const reply = ctx.dm().at(-1)!;
    ctx.clear();
    return reply;
  }
  /** Правки повідомлення «світло зникло» (без закріпленого статусу) */
  const edits = () =>
    ctx.calls
      .filter((c) => c.method === 'editMessageText' && String(c.params.text).startsWith('🔴 Світло зникло'))
      .map((c) => c.params.text as string);

  beforeEach(() => {
    ctx.dtekStreets = { [STREET]: { '70/72': house(), '74А': house(), '76/78': house() }, 'вул. Хрещатик': {} };
  });

  it('/address accepts 70-72, sets the queue from DTEK and shows the current state', async () => {
    expect(await setAddress(`${STREET}, 70-72`)).toBe(
      `✅ Адреса: ${STREET}, 70/72\n📅 Черга 20.1 — для графіка вона задана автоматично (/queue)\nЗараз ДТЕК відключень за адресою не повідомляє`,
    );
    expect(await getState(ctx.db)).toMatchObject({ dtek_street: STREET, dtek_house: '70/72', schedule_group: 'dtek-kem:20.1' });
  });

  it('/address suggests streets and houses when they are not found', async () => {
    expect(await setAddress('Кониського, 70/72')).toBe(
      `⛔ ДТЕК не знає вулицю «Кониського». Можливо, одна з цих:\n${STREET}`,
    );
    expect(await setAddress(`${STREET}, 7`)).toBe('⛔ Будинку «7» на цій вулиці в ДТЕК немає. Схожі: 70/72, 74А, 76/78');
    expect(await setAddress('без коми')).toMatch(/^Не бачу номера будинку/);
    ctx.dtekDown = true;
    expect(await setAddress()).toBe('⛔ Сайт ДТЕК зараз не відповідає, спробуй трохи пізніше');
    expect((await getState(ctx.db)).dtek_street).toBeNull();
  });

  it('adds the DTEK reason and restore time to the outage message', async () => {
    await startTracking();
    await setAddress();
    setHouse(house(STABILIZATION, '11:03 05.11.2026', '18:30 05.11.2026'));
    ctx.advance(63 * MIN); // 11:03
    await report(false);
    expect(ctx.sent()).toEqual([
      `🔴 Світло зникло о 11:03\nСвітло було: ≈ 1 год 3 хв\n⚡️ ДТЕК: ${STABILIZATION}\n🕦 Орієнтовне відновлення: до 18:30`,
    ]);

    ctx.clear();
    ctx.setNow(Date.UTC(2026, 10, 5, 16, 10)); // 18:10
    await report(true);
    expect(ctx.sent()[0]).toBe("🟢 Світло з'явилось о 18:10\nСвітла не було: 7 год 7 хв\n🕦 ДТЕК обіцяв до 18:30");
  });

  it('updates the outage message when DTEK reports it later or moves the restore time', async () => {
    ctx.groups['dtek-kem:20.1'] = {
      key: 'dtek-kem:20.1', state: 'off', class: 'planned', plan_status: 'applies',
      today: [{ start: '2026-11-05T11:00:00+02:00', end: '2026-11-05T18:30:00+02:00', kind: 'off' }],
    };
    await startTracking();
    await setAddress(); // черга 20.1 підставилась сама
    ctx.advance(63 * MIN);
    await report(false); // ДТЕК ще нічого не знає — показуємо графік
    expect(ctx.sent()[0]).toContain('📅 За графіком: до 18:30');

    ctx.clear();
    ctx.advance(5 * MIN);
    await runCron(ctx);
    expect(edits()).toEqual([]); // ДТЕК досі мовчить

    setHouse(house(STABILIZATION, '11:03 05.11.2026', '18:30 05.11.2026'));
    ctx.advance(5 * MIN);
    await runCron(ctx);
    expect(edits()).toEqual([
      `🔴 Світло зникло о 11:03\nСвітло було: ≈ 1 год 3 хв\n⚡️ ДТЕК: ${STABILIZATION}\n🕦 Орієнтовне відновлення: до 18:30`,
    ]);

    ctx.clear();
    ctx.advance(5 * MIN);
    await runCron(ctx);
    expect(edits()).toEqual([]); // нічого не змінилось — не редагуємо

    setHouse(house('Аварійне відключення', '11:03 05.11.2026', '19:30 05.11.2026'));
    ctx.advance(5 * MIN);
    await runCron(ctx);
    expect(edits()[0]).toContain('⚡️ ДТЕК: Аварійне відключення\n🕦 Орієнтовне відновлення: до 19:30 (було 18:30)');
  });

  it('ignores a DTEK record left from an earlier outage', async () => {
    await startTracking();
    await setAddress();
    setHouse(house(STABILIZATION, '05:00 05.11.2026', '08:00 05.11.2026'));
    ctx.advance(63 * MIN);
    await report(false);
    expect(ctx.sent()[0]).not.toContain('ДТЕК');
  });

  it('sends the outage message without DTEK data when the site is down', async () => {
    await startTracking();
    await setAddress();
    ctx.dtekDown = true;
    ctx.advance(HOUR);
    await report(false);
    expect(ctx.sent()).toHaveLength(1);
    expect(ctx.sent()[0]).not.toContain('ДТЕК');
  });

  it('/status shows what DTEK reports for the address', async () => {
    await setAddress();
    setHouse(house(STABILIZATION, '11:03 05.11.2026', '18:30 05.11.2026'));
    ctx.fetched.length = 0;
    await command('/status');
    expect(ctx.dm()[0]).toContain(`⚡️ ДТЕК: ${STABILIZATION}, відновлення до 18:30`);
  });
});

describe('channel extras: warnings, tomorrow schedule, pinned status', () => {
  const KEY = 'dtek-kem:20.1';
  const at = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh - 2, mm); // Київ, листопад (UTC+2)
  const slot = (from: string, to: string, day = 5, toDay = day) => ({
    start: `2026-11-0${day}T${from}:00+02:00`,
    end: `2026-11-0${toDay}T${to}:00+02:00`,
    kind: 'off',
  });
  async function cronAt(utc: number) {
    ctx.setNow(utc);
    // телефон справний і на зв'язку — інакше cron слушно скаже «детектор не на зв'язку»
    await ctx.db.prepare('UPDATE state SET last_seen = ? WHERE id = 1').bind(utc).run();
    ctx.clear();
    await runCron(ctx);
  }
  const pinnedTexts = () =>
    ctx.calls
      .filter((c) => (c.method === 'sendMessage' && c.params.disable_notification) || (c.method === 'editMessageText' && !String(c.params.text).startsWith('🔴 Світло зникло')))
      .map((c) => c.params.text as string);

  beforeEach(async () => {
    ctx.groups[KEY] = {
      key: KEY, state: 'on', class: 'planned', plan_status: 'applies',
      today: [slot('11:00', '18:30'), slot('21:30', '00:00', 5, 6)],
      tomorrow: [slot('00:00', '02:00', 6)],
    };
    await startTracking();
    await command('/queue 20.1');
  });

  describe('warning before a scheduled outage', () => {
    it('warns once, about 30 minutes before', async () => {
      await cronAt(at(5, 10, 25));
      expect(ctx.sent()).toEqual([]);
      await cronAt(at(5, 10, 30));
      expect(ctx.sent()).toEqual(['⏰ О 11:00 відключення за графіком, до 18:30 (через ~30 хв)']);
      await cronAt(at(5, 10, 35));
      expect(ctx.sent()).toEqual([]);
    });

    it('joins intervals across midnight', async () => {
      await cronAt(at(5, 21, 5));
      expect(ctx.sent()).toEqual(['⏰ О 21:30 відключення за графіком, до 06.11 02:00 (через ~25 хв)']);
    });

    it("updates the warning once tomorrow's schedule is published", async () => {
      // о 21:00 графіка на завтра ще немає: інтервал обривається опівночі
      ctx.groups[KEY] = { ...ctx.groups[KEY], tomorrow: [] };
      await cronAt(at(5, 21, 5));
      expect(ctx.sent()).toEqual([
        '⏰ О 21:30 відключення за графіком, до 24:00 (через ~25 хв)\nℹ️ Можливо, й довше: графік на завтра ще не опублікований',
      ]);
      const warningId = (await getState(ctx.db)).warn_message_id;

      await cronAt(at(5, 21, 10)); // досі не опубліковано — не редагуємо
      expect(ctx.calls.filter((c) => c.method === 'editMessageText' && String(c.params.text).startsWith('⏰'))).toEqual([]);

      // ДТЕК опублікував графік: відключення триває до 04:30
      ctx.groups[KEY] = { ...ctx.groups[KEY], tomorrow: [slot('00:00', '04:30', 6)] };
      await cronAt(at(5, 21, 20));
      expect(ctx.calls.find((c) => c.method === 'editMessageText' && String(c.params.text).startsWith('⏰'))?.params).toEqual({
        chat_id: CHANNEL.id,
        message_id: warningId,
        text: '⏰ О 21:30 відключення за графіком, до 06.11 04:30 (через ~25 хв)',
      });
      expect(ctx.sent()).toEqual([]); // нового повідомлення немає — лише редагування
    });

    it('says "до 24:00" without a note when tomorrow is published without outages', async () => {
      ctx.groups[KEY] = { ...ctx.groups[KEY], tomorrow: [] };
      ctx.plans[`${KEY}|2026-11-06`] = { status: 'applies', slots: [] };
      await cronAt(at(5, 21, 5));
      expect(ctx.sent()).toEqual(['⏰ О 21:30 відключення за графіком, до 24:00 (через ~25 хв)']);
    });

    it('notes an unpublished tomorrow in the outage message', async () => {
      ctx.groups[KEY] = { ...ctx.groups[KEY], tomorrow: [] };
      ctx.setNow(at(5, 21, 57));
      await report(false);
      expect(ctx.sent().at(-1)).toContain('📅 За графіком: до 24:00 (ще ~2 год 3 хв), графік на завтра ще не опублікований');
    });

    it('stays quiet when power is already off or during emergency outages', async () => {
      ctx.setNow(at(5, 10, 20));
      await report(false);
      await cronAt(at(5, 10, 30));
      expect(ctx.sent()).toEqual([]);

      ctx.groups[KEY] = { ...ctx.groups[KEY], class: 'emergency', plan_status: 'emergency' };
      await report(true);
      await cronAt(at(5, 21, 5));
      expect(ctx.sent()).toEqual([]);
    });
  });

  describe("tomorrow's schedule at 22:00", () => {
    const tomorrow = { status: 'applies', slots: [slot('02:00', '08:30', 6), slot('11:00', '18:30', 6), slot('21:30', '00:00', 6, 7)] };

    it('sends it from 22:00 as soon as it is published, once', async () => {
      ctx.plans[`${KEY}|2026-11-06`] = tomorrow;
      await cronAt(at(5, 21, 55));
      expect(ctx.sent()).toEqual([]);
      expect(ctx.fetched.some((u) => u.includes('/history/plan/'))).toBe(false);

      await cronAt(at(5, 22, 0));
      expect(ctx.sent()).toEqual([
        [
          '📅 Графік на завтра, 06.11 (черга 20.1)',
          '🔴 02:00–08:30 (6 год 30 хв)',
          '🔴 11:00–18:30 (7 год 30 хв)',
          '🔴 21:30–24:00 (2 год 30 хв)',
          'Без світла за графіком: 16 год 30 хв',
        ].join('\n'),
      ]);
      await cronAt(at(5, 22, 5));
      expect(ctx.sent()).toEqual([]);
    });

    it('waits until the schedule is published', async () => {
      await cronAt(at(5, 22, 0));
      expect(ctx.sent()).toEqual([]);
      ctx.plans[`${KEY}|2026-11-06`] = tomorrow;
      await cronAt(at(5, 22, 40));
      expect(ctx.sent()[0]).toMatch(/^📅 Графік на завтра, 06\.11/);
    });

    it('says when no outages are planned and skips emergency mode', async () => {
      ctx.plans[`${KEY}|2026-11-06`] = { status: 'emergency', slots: null };
      await cronAt(at(5, 22, 0));
      expect(ctx.sent()).toEqual([]);
      ctx.plans[`${KEY}|2026-11-06`] = { status: 'applies', slots: [] };
      await cronAt(at(5, 22, 5));
      expect(ctx.sent()).toEqual([
        '📅 Графік на завтра, 06.11 (черга 20.1)\nВідключень за графіком не заплановано 🎉',
      ]);
    });
  });

  describe('pinned status message', () => {
    it('is created silently, pinned, and edited as the state changes', async () => {
      await updateStateForTest({ status_message_id: null }); // створене при старті трекінгу — перевіримо створення заново
      await cronAt(at(5, 10, 5));
      const created = ctx.calls.find((c) => c.method === 'sendMessage' && c.params.disable_notification)!;
      expect(created.params.text).toBe('🟢 Світло є ≈ 5 хв (з 10:00)\n📅 Наступне відключення: 11:00–18:30\n🕐 Оновлено 10:05');
      expect(ctx.calls.find((c) => c.method === 'pinChatMessage')?.params).toMatchObject({ chat_id: CHANNEL.id, disable_notification: true });

      ctx.clear();
      ctx.setNow(at(5, 11, 3));
      await report(false);
      expect(pinnedTexts()).toEqual(['🔴 Світла немає менше хвилини (з 11:03)\n📅 За графіком: до 18:30\n🕐 Оновлено 11:03']);
      expect(ctx.calls.filter((c) => c.method === 'sendMessage' && c.params.disable_notification)).toEqual([]); // редагується, не нове

      await cronAt(at(5, 11, 3)); // нічого не змінилось — не редагуємо
      expect(pinnedTexts()).toEqual([]);
    });

    it('is recreated when someone deletes it', async () => {
      await cronAt(at(5, 10, 5));
      ctx.failWith.editMessageText = 'Telegram editMessageText failed: Bad Request: message to edit not found';
      await cronAt(at(5, 10, 10));
      expect(ctx.calls.filter((c) => c.method === 'pinChatMessage')).toHaveLength(1);
    });

    it('tells the owner once when it cannot pin', async () => {
      ctx.failing.add('pinChatMessage');
      await updateStateForTest({ status_message_id: null });
      await cronAt(at(5, 10, 5));
      expect(ctx.dm()[0]).toMatch(/^📌 Не можу закріпити повідомлення/);
      await updateStateForTest({ status_message_id: null });
      await cronAt(at(5, 10, 10));
      expect(ctx.dm()).toEqual([]);
    });

    it('removes the "message pinned" service post', async () => {
      await cronAt(at(5, 10, 5));
      const statusId = (await getState(ctx.db)).status_message_id!;
      ctx.clear();
      await handleUpdate(ctx, {
        update_id: 999,
        channel_post: { message_id: 555, chat: CHANNEL, pinned_message: { message_id: statusId, chat: CHANNEL } },
      });
      expect(ctx.calls).toEqual([{ method: 'deleteMessage', params: { chat_id: CHANNEL.id, message_id: 555 } }]);
    });

    it('shows the DTEK restore time while power is off', async () => {
      ctx.dtekStreets = { 'вул. Кониського Олександра': { '70/72': { sub_type: 'Аварійне відключення', start_date: '11:03 05.11.2026', end_date: '19:00 05.11.2026', sub_type_reason: ['GPV20.1'] } } };
      await command('/address вул. Кониського Олександра, 70/72');
      ctx.setNow(at(5, 11, 3));
      await report(false);
      await cronAt(at(5, 11, 30));
      expect(pinnedTexts().at(-1)).toBe('🔴 Світла немає 27 хв (з 11:03)\n🕦 ДТЕК: відновлення до 19:00\n🕐 Оновлено 11:30');
    });
  });

  const updateStateForTest = (fields: Record<string, unknown>) =>
    ctx.db.prepare(`UPDATE state SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = 1`).bind(...(Object.values(fields) as (number | null)[])).run();
});

describe('scheduled reports', () => {
  async function period(kind: 'on' | 'off', start: number, end: number | null) {
    await ctx.db.prepare('INSERT INTO periods (kind, start_ts, end_ts) VALUES (?, ?, ?)').bind(kind, start, end).run();
  }
  /** Запускає cron у вказаний момент (UTC) і повертає, що потрапило в канал */
  async function cronAt(utc: number) {
    ctx.clear();
    ctx.setNow(utc);
    await runCron(ctx);
    return ctx.sent();
  }
  // Листопад: Київ = UTC+2
  const kyivNov = (day: number, hour = 0, min = 0) => Date.UTC(2026, 10, day, hour - 2, min);

  beforeEach(async () => {
    await activateChannel();
    // Минулий тиждень 02.11–08.11 і трохи понеділка 09.11
    await period('on', kyivNov(2), kyivNov(4, 8));
    await period('off', kyivNov(4, 8), kyivNov(4, 14));
    await period('on', kyivNov(4, 14), null);
  });

  it('sends the weekly report on Monday at 10:00 Kyiv time, once', async () => {
    expect(await cronAt(kyivNov(9, 9, 55))).toEqual([]);
    const [report] = await cronAt(kyivNov(9, 10, 0));
    expect(await cronAt(kyivNov(9, 10, 5))).toEqual([]);
    expect(await cronAt(kyivNov(9, 18, 0))).toEqual([]);

    expect(report).toMatch(/^🗓 Тиждень 02\.11 – 08\.11\n💡 Світло було 96% часу\n🔴 Без світла 6 год, відключень: 1/);
    expect(report).toContain('<pre>Пн 02.11 ■■■■■■■■■■ 100%\n');
    expect(report).toContain('\nСр 04.11 ■■■■■■■■□□  75%   6:00 ×1\n');
    expect(report).toContain('\nНд 08.11 ■■■■■■■■■■ 100%</pre>');
    expect(report).not.toContain('09.11'); // поточний понеділок у звіт не потрапляє
    expect(report).not.toContain('сьогодні');
  });

  it('uses Kyiv time in summer too (UTC+3)', async () => {
    await period('on', Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 6));
    expect(await cronAt(Date.UTC(2026, 6, 6, 6, 55))).toEqual([]); // 09:55 за Києвом
    expect(await cronAt(Date.UTC(2026, 6, 6, 7, 0))).toHaveLength(1); // 10:00 за Києвом
  });

  it('does not send anything on other days', async () => {
    expect(await cronAt(kyivNov(10, 10, 0))).toEqual([]); // вівторок
  });

  it('skips the weekly report when there is no data for the past week', async () => {
    expect(await cronAt(Date.UTC(2026, 9, 26, 8, 0))).toEqual([]); // понеділок 26.10, даних ще немає
  });

  it('sends the monthly report on the 1st at 10:00 with completed months only', async () => {
    const dec1 = Date.UTC(2026, 11, 1, 8, 0); // 01.12 10:00 за Києвом
    const [report] = await cronAt(dec1);
    expect(await cronAt(dec1 + 5 * MIN)).toEqual([]);

    expect(report).toMatch(/^🗓 Підсумки місяця: листопад 2026\n\n📅 Останні 12 місяців/);
    // дані за 29 із 30 днів — позначку «дані за N дн.» ставимо, лише коли бракує більше доби
    expect(report).toContain('<pre>Лис 2026 ■■■■■■■■■■  99%</pre>');
    expect(report).toContain('Лис 2026: ~12 хв на добу · 1 відкл. (&lt;0,1/добу) · найдовше 6 год');
    expect(report).not.toContain('Гру 2026');
  });
});

describe('HTTP routes', () => {
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    route(
      new Request(`https://power-health.example.workers.dev${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      ctx,
    );

  it('rejects device requests without the key', async () => {
    const res = await post('/device/event', { charging: true }, { 'x-device-key': 'wrong' });
    expect(res.status).toBe(403);
  });

  it('accepts device events with the key', async () => {
    const res = await post('/device/event', { charging: true, ts: T0 / 1000 }, { 'x-device-key': 'device-secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: 'initialized', charging: true, ts: '2026-11-05T08:00:00.000Z' });
  });

  it('rejects telegram updates without the webhook secret', async () => {
    const update = privateMessage(OWNER, '/status');
    expect((await post('/telegram', update, {})).status).toBe(403);
    expect(ctx.calls).toEqual([]);
    expect((await post('/telegram', update, { 'x-telegram-bot-api-secret-token': 'webhook-secret' })).status).toBe(
      200,
    );
    expect(ctx.dm()).toHaveLength(1);
  });

  it('configures the webhook via /admin/setup', async () => {
    expect((await post('/admin/setup', {}, {})).status).toBe(403);
    const res = await post('/admin/setup', {}, { authorization: 'Bearer webhook-secret' });
    expect(res.status).toBe(200);
    expect(ctx.calls.find((c) => c.method === 'setWebhook')?.params).toMatchObject({
      url: 'https://power-health.example.workers.dev/telegram',
      secret_token: 'webhook-secret',
    });
    expect(ctx.calls.find((c) => c.method === 'setMyCommands')?.params.scope).toEqual({
      type: 'chat',
      chat_id: String(OWNER.id),
    });
  });
});
