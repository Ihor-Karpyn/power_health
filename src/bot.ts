import { notifyOwner, type Ctx } from './env';
import { formatDuration, formatTime } from './format';
import { getState, updateState } from './state';
import { fetchAddressOutage, fetchStreet, fetchStreets, findHouseKey, lineOf, linesOf, storedLines, toOutage, type DtekOutage } from './dtek';
import { describeGroup, fetchGroup, loadConfiguredGroup, normalizeGroupKey } from './schedule';
import { statsText } from './stats';
import { inBackground, updatePinnedStatus } from './status-message';
import { type TgChat, type TgMessage, type TgUpdate, type TgUser } from './telegram';

const COMMANDS = [
  { command: 'status', description: 'Що зараз зі світлом' },
  { command: 'stats', description: 'Статистика: 7 днів і 12 місяців' },
  { command: 'teststart', description: 'Тест макросів: запити телефона не пишуться, а приходять сюди' },
  { command: 'teststop', description: 'Вимкнути тестовий режим' },
  { command: 'address', description: 'Адреса для даних ДТЕК, напр. /address вул. Хрещатик, 1' },
  { command: 'queue', description: 'Черга для графіка відключень, напр. /queue 20.1' },
  { command: 'help', description: 'Список команд' },
];

const isOwner = (ctx: Ctx, user: TgUser | undefined) => !!user && String(user.id) === ctx.env.OWNER_USER_ID;

const ACTIVATE_HINT =
  'Щоб я надсилав сповіщення в канал:\n' +
  '1. Додай мене в канал адміністратором з правом публікувати (і бажано видаляти) повідомлення.\n' +
  '2. Напиши в самому каналі /activate';

/**
 * Керування — лише в особистому чаті з власником.
 * Сповіщення — лише в канал, де власник написав /activate.
 */
export async function handleUpdate(ctx: Ctx, update: TgUpdate): Promise<void> {
  if (update.channel_post) return onChannelPost(ctx, update.channel_post);
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    return onMembershipChange(ctx, m.chat, m.from, m.new_chat_member.status);
  }

  const msg = update.message;
  if (!msg) return;
  if (msg.chat.type !== 'private') {
    await leave(ctx, msg.chat.id);
    return;
  }
  if (!isOwner(ctx, msg.from)) {
    console.log(`ignored message from user ${msg.from?.id}`);
    return;
  }

  const parsed = msg.text?.match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  if (!parsed) return;
  const reply = (text: string) => notifyOwner(ctx, text);
  const arg = msg.text!.slice(parsed[0].length).trim();

  switch (parsed[1]!.toLowerCase()) {
    case 'status':
      return reply(await statusText(ctx));
    case 'stats':
      return notifyOwner(ctx, await statsText(ctx), { html: true });
    case 'teststart':
      return reply(await testStart(ctx));
    case 'teststop':
      return reply(await testStop(ctx));
    case 'address':
      return reply(await address(ctx, arg));
    case 'queue':
      return reply(await queue(ctx, arg));
    case 'activate':
      return reply(ACTIVATE_HINT);
    default:
      return reply(helpText());
  }
}

async function onMembershipChange(ctx: Ctx, chat: TgChat, by: TgUser, status: string): Promise<void> {
  if (chat.type === 'private') return; // власник заблокував або розблокував бота
  const joined = status === 'administrator' || status === 'member';

  if (chat.type !== 'channel') {
    if (joined) await leave(ctx, chat.id); // групи боту не потрібні
    return;
  }

  const s = await getState(ctx.db);
  const title = chat.title ?? String(chat.id);

  if (joined) {
    if (!isOwner(ctx, by)) {
      await leave(ctx, chat.id);
      return;
    }
    if (s.channel_id === chat.id) return; // наприклад, змінились права в уже активному каналі
    await notifyOwner(
      ctx,
      `Мене додали в канал «${title}».\nНапиши в цьому каналі /activate, щоб я надсилав туди сповіщення про світло.`,
    );
    return;
  }

  if (s.channel_id === chat.id) {
    await updateState(ctx.db, { channel_id: null, channel_title: null });
    await notifyOwner(
      ctx,
      `⚠️ Мене прибрали з каналу «${title}», сповіщення зараз нікуди не надсилаються.\n` +
        'Додай мене в канал адміністратором і напиши там /activate',
    );
  }
}

/** /activate у каналі: перевіряємо, що це власник, і робимо канал активним */
async function onChannelPost(ctx: Ctx, post: TgMessage): Promise<void> {
  // Прибираємо службове «бот закріпив повідомлення», щоб не засмічувати канал
  if (post.pinned_message) {
    const s = await getState(ctx.db);
    if (post.chat.id === s.channel_id && post.pinned_message.message_id === s.status_message_id) {
      try {
        await ctx.tg.call('deleteMessage', { chat_id: post.chat.id, message_id: post.message_id });
      } catch (err) {
        console.log('cannot delete the "pinned" service message', err);
      }
    }
    return;
  }
  if (!post.text || !/^\/activate(?:@\w+)?\s*$/i.test(post.text)) return;
  const channel = post.chat;
  const title = channel.title ?? String(channel.id);
  if (!(await isOwnersPost(ctx, post))) {
    console.warn(`/activate in channel ${channel.id} was not posted by the owner, ignored`);
    return;
  }

  try {
    await ctx.tg.call('sendMessage', { chat_id: channel.id, text: '✅ Тепер тут будуть сповіщення про світло' });
  } catch (err) {
    console.error('test post to channel failed', err);
    await notifyOwner(
      ctx,
      `⛔ Не можу писати в канал «${title}». Дай мені право «Публікувати повідомлення» і повтори /activate`,
    );
    return;
  }
  // Прибираємо саму команду з каналу, щоб підписники її не бачили
  try {
    await ctx.tg.call('deleteMessage', { chat_id: channel.id, message_id: post.message_id });
  } catch {
    console.log('cannot delete /activate post: the bot lacks the "Delete messages" right');
  }

  const prev = (await getState(ctx.db)).channel_title;
  await updateState(ctx.db, { channel_id: channel.id, channel_title: title });
  await inBackground(ctx, () => updatePinnedStatus(ctx));
  await notifyOwner(
    ctx,
    prev && prev !== title
      ? `✅ Сповіщення тепер ідуть у канал «${title}» (замість «${prev}»)`
      : `✅ Сповіщення тепер ідуть у канал «${title}»`,
  );
}

/**
 * Якщо Telegram показує автора допису — це має бути власник.
 * Якщо допис від імені каналу (автора не видно) — власник має бути творцем каналу.
 */
async function isOwnersPost(ctx: Ctx, post: TgMessage): Promise<boolean> {
  if (post.from) return isOwner(ctx, post.from);
  try {
    const member = (await ctx.tg.call('getChatMember', {
      chat_id: post.chat.id,
      user_id: Number(ctx.env.OWNER_USER_ID),
    })) as { status: string };
    return member.status === 'creator';
  } catch (err) {
    console.error('getChatMember failed', err);
    return false;
  }
}

/** Налаштовує webhook і меню команд. Викликається через POST /admin/setup. */
export async function setupBot(ctx: Ctx, workerOrigin: string): Promise<Record<string, unknown>> {
  const { env, tg } = ctx;
  await tg.call('setWebhook', {
    url: `${workerOrigin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'channel_post', 'my_chat_member'],
    drop_pending_updates: true,
  });
  // Меню команд показуємо лише у чаті власника
  await tg.call('deleteMyCommands', {});
  let commands = 'ok';
  try {
    await tg.call('setMyCommands', { commands: COMMANDS, scope: { type: 'chat', chat_id: env.OWNER_USER_ID } });
  } catch (err) {
    commands = `failed (спершу напиши боту /start): ${(err as Error).message}`;
  }
  return { webhook: `${workerOrigin}/telegram`, commands };
}

async function leave(ctx: Ctx, chatId: number): Promise<void> {
  console.warn(`leaving foreign chat ${chatId}`);
  try {
    await ctx.tg.call('leaveChat', { chat_id: chatId });
  } catch (err) {
    console.error('leaveChat failed', err);
  }
}

function helpText(): string {
  return ['Команди:', ...COMMANDS.map((c) => `/${c.command} — ${c.description}`), '', ACTIVATE_HINT].join('\n');
}

async function statusText(ctx: Ctx): Promise<string> {
  const { env } = ctx;
  const now = ctx.now();
  const s = await getState(ctx.db);
  const tz = env.TIMEZONE;
  const lines: string[] = [];

  if (s.mode === null || s.mode_since === null) {
    lines.push('❔ Стан ще невідомий: телефон ще нічого не надсилав');
  } else {
    const approx = s.mode_since_approx ? '≈ ' : '';
    const span = `${approx}${formatDuration(now - s.mode_since)} (з ${formatTime(s.mode_since, tz, now)})`;
    if (s.mode === 'on') lines.push(`🟢 Світло є ${span}`);
    else if (s.mode === 'off') lines.push(`🔴 Світла немає ${span}`);
    else lines.push(`⏸ Трекінг на паузі ${span}`);
  }

  if (s.last_seen === null) {
    lines.push("📱 Телефон ще не виходив на зв'язок");
  } else {
    const charging = s.phone_charging ? 'на зарядці' : 'не на зарядці';
    const battery = s.battery !== null ? `, ${s.battery}%` : '';
    lines.push(`📱 Телефон: ${charging}${battery}, на зв'язку ${formatDuration(now - s.last_seen)} тому`);
  }
  if (s.detector_offline) lines.push("⚠️ Детектор не на зв'язку, дані можуть бути застарілими");
  if (s.dtek_street && s.dtek_house) {
    const res = await fetchAddressOutage(ctx, s.dtek_street, s.dtek_house, lineOf(s.schedule_group));
    lines.push(
      !res.ok
        ? '⚡️ ДТЕК зараз не відповідає'
        : res.outage
          ? `⚡️ ДТЕК: ${describeDtek(res.outage, now, tz)}`
          : '⚡️ ДТЕК: відключень за адресою немає',
    );
    const known = storedLines((await getState(ctx.db)).house_lines);
    const mine = lineOf(s.schedule_group);
    if (known.length > 1) lines.push(`🏠 Будинок: лінії ${known.join(', ')} · твоя: ${mine ?? 'не вказана (/queue)'}`);
  }
  if (s.schedule_group) {
    const g = await loadConfiguredGroup(ctx);
    lines.push(`📅 Черга ${s.schedule_group}: ${g ? describeGroup(g, now, tz) : 'графік зараз недоступний'}`);
  }
  lines.push(
    s.channel_id !== null
      ? `📢 Канал: «${s.channel_title}»`
      : '📢 Канал не активовано: сповіщення нікуди не йдуть. Напиши /activate у своєму каналі',
  );
  return lines.join('\n');
}

/**
 * Тестовий режим: стан і поточне відключення не чіпаємо, запити телефона не застосовуються —
 * лише дублюються власнику з розбором. Після /testStop перший heartbeat (з changed_at) відновить стан.
 */
async function testStart(ctx: Ctx): Promise<string> {
  const now = ctx.now();
  const s = await getState(ctx.db);
  if (s.test_since !== null) return `🧪 Тестовий режим уже увімкнено з ${formatTime(s.test_since, ctx.env.TIMEZONE, now)}`;
  await updateState(ctx.db, { test_since: now, test_reminded_at: null });
  return (
    '🧪 Тестовий режим увімкнено.\n' +
    'Запити телефона не записуються і не йдуть у канал — я пересилатиму їх сюди з розбором. ' +
    'Поточний стан і відключення не змінюються.\nВимкнути: /testStop'
  );
}

async function testStop(ctx: Ctx): Promise<string> {
  const now = ctx.now();
  const s = await getState(ctx.db);
  if (s.test_since === null) return 'Тестовий режим і так вимкнено';
  await updateState(ctx.db, { test_since: null, test_reminded_at: null });
  return (
    `✅ Тестовий режим вимкнено (тривав ${formatDuration(now - s.test_since)}).\n` +
    'Наступний запит телефона оновить стан як звичайно; heartbeat із changed_at — з точним часом зміни.'
  );
}

async function queue(ctx: Ctx, arg: string): Promise<string> {
  const s = await getState(ctx.db);
  if (!arg) {
    return s.schedule_group
      ? `📅 Черга: ${s.schedule_group}\nЗмінити: /queue 20.1, вимкнути графік: /queue off`
      : 'Черга не задана. Напиши свою чергу з застосунку YASNO/ДТЕК, наприклад: /queue 20.1';
  }
  if (arg.toLowerCase() === 'off') {
    await updateState(ctx.db, { schedule_group: null });
    return '📅 Графік вимкнено: у повідомленнях більше не буде часу за графіком';
  }

  const key = normalizeGroupKey(ctx, arg);
  if (!key) return 'Не розумію чергу. Приклад: /queue 20.1 або /queue dtek-krem:3.1';
  const res = await fetchGroup(ctx, key);
  if (!res.ok) {
    return res.notFound
      ? `⛔ Черги ${key} немає в SvitloPulse. Перевір номер у застосунку YASNO/ДТЕК`
      : '⛔ SvitloPulse зараз не відповідає, спробуй трохи пізніше';
  }
  await updateState(ctx.db, { schedule_group: key });
  return `✅ Черга ${key}\nЗараз: ${describeGroup(res.group, ctx.now(), ctx.env.TIMEZONE)}`;
}

function describeDtek(o: DtekOutage, now: number, tz: string): string {
  const reason = `${o.line ? `(лінія ${o.line}) ` : ''}${o.reason}`;
  return o.end !== null ? `${reason}, відновлення до ${formatTime(o.end, tz, now)}` : reason;
}

const ADDRESS_HINT = 'Напиши адресу так, як на сайті ДТЕК: /address вул. Кониського Олександра, 70/72';

async function address(ctx: Ctx, arg: string): Promise<string> {
  const s = await getState(ctx.db);
  if (!arg) {
    return s.dtek_street && s.dtek_house
      ? `⚡️ Адреса: ${s.dtek_street}, ${s.dtek_house}\nЗмінити: /address <вулиця>, <будинок>, вимкнути: /address off`
      : `Адреса не задана. ${ADDRESS_HINT}`;
  }
  if (arg.toLowerCase() === 'off') {
    await updateState(ctx.db, { dtek_street: null, dtek_house: null });
    return '⚡️ Дані ДТЕК вимкнено';
  }

  const comma = arg.lastIndexOf(',');
  if (comma < 0) return `Не бачу номера будинку. ${ADDRESS_HINT}`;
  const street = arg.slice(0, comma).trim();
  const house = arg.slice(comma + 1).trim();
  if (!street || !house) return `Не бачу вулиці або будинку. ${ADDRESS_HINT}`;

  const res = await fetchStreet(ctx, street);
  if (!res.ok) {
    if (!res.notFound) return '⛔ Сайт ДТЕК зараз не відповідає, спробуй трохи пізніше';
    const suggestions = await suggestStreets(ctx, street);
    return suggestions.length
      ? `⛔ ДТЕК не знає вулицю «${street}». Можливо, одна з цих:\n${suggestions.join('\n')}`
      : `⛔ ДТЕК не знає вулицю «${street}». ${ADDRESS_HINT}`;
  }

  const key = findHouseKey(res.houses, house);
  if (!key) {
    const lead = house.match(/^\d+/)?.[0];
    const similar = Object.keys(res.houses).filter((k) => lead && k.startsWith(lead)).slice(0, 10);
    return `⛔ Будинку «${house}» на цій вулиці в ДТЕК немає.${similar.length ? ` Схожі: ${similar.join(', ')}` : ''}`;
  }

  // Нова адреса — лінії збираємо заново
  const houseLines = linesOf(res.houses[key]);
  const fields: Parameters<typeof updateState>[1] = {
    dtek_street: street,
    dtek_house: key,
    house_lines: houseLines.length ? JSON.stringify(houseLines) : null,
  };
  const mine = lineOf(s.schedule_group);
  let groupNote = '';
  if (houseLines.length > 1) {
    // Не вгадуємо: квартира може бути на будь-якій з ліній
    groupNote =
      mine && houseLines.includes(mine)
        ? `\n🏠 У будинку кілька ліній: ${houseLines.join(', ')} · твоя (з /queue): ${mine}`
        : `\n🏠 У будинку кілька ліній: ${houseLines.join(', ')}. Вкажи свою: ${houseLines.map((l) => `/queue ${l}`).join(' або ')}`;
  } else if (houseLines.length === 1 && !s.schedule_group) {
    fields.schedule_group = `${ctx.env.SCHEDULE_OPERATOR || 'dtek-kem'}:${houseLines[0]}`;
    groupNote = `\n📅 Черга ${houseLines[0]} — для графіка вона задана автоматично (/queue)`;
  } else if (houseLines.length === 1 && mine && mine !== houseLines[0]) {
    groupNote = `\n⚠️ ДТЕК зараз показує для будинку лінію ${houseLines[0]}, а в /queue — ${mine}. Перевір, яка твоя`;
  }
  await updateState(ctx.db, fields);
  const outage = toOutage(res.houses[key], ctx.env.TIMEZONE);
  const now = ctx.now();
  return (
    `✅ Адреса: ${street}, ${key}${groupNote}\n` +
    (outage ? `Зараз: ${describeDtek(outage, now, ctx.env.TIMEZONE)}` : 'Зараз ДТЕК відключень за адресою не повідомляє')
  );
}

/** Вулиці ДТЕК, у назві яких є всі слова з запиту (без «вул.», «пров.» тощо) */
async function suggestStreets(ctx: Ctx, input: string): Promise<string[]> {
  const words = input
    .toLowerCase()
    .split(/[\s.,]+/)
    .filter((w) => w.length >= 3 && !['вул', 'вулиця', 'пров', 'просп', 'бульв', 'пл'].includes(w));
  if (!words.length) return [];
  const streets = (await fetchStreets(ctx)) ?? [];
  return streets.filter((st) => words.every((w) => st.toLowerCase().includes(w))).slice(0, 5);
}
