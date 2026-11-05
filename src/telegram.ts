export interface Telegram {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function createTelegram(token: string): Telegram {
  return {
    async call(method, params) {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
      if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
      return data.result;
    },
  };
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** Підпис автора в каналі (якщо в каналі увімкнено підписи) */
  author_signature?: string;
  /** Службове «повідомлення закріплено» */
  pinned_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  my_chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { status: string } };
}

export function userName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
}
