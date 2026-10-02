import { asArray, asTable, asVaultRef, ConfigError, onlyKeys } from './validate.ts';

/** The Telegram channel (task 1.15, D-044). Absent: the channel is off. */
export interface TelegramConfig {
  /** `vault://name` of the bot token: the value never sits in this file. */
  token: string;
  /**
   * Ids of the private chats the bot talks to (the user's own). Changing it is
   * a privacy setting: only the user edits it, never an agent.
   */
  chats: number[];
}

export function parseTelegram(value: unknown): TelegramConfig | undefined {
  if (value === undefined) return undefined;
  const telegram = asTable(value, 'telegram');
  onlyKeys(telegram, ['token', 'chats'], 'telegram');
  const token = asVaultRef(telegram.token, 'telegram.token');
  const chats = asArray(telegram.chats, 'telegram.chats').map((item, index) => {
    // The id of a private chat is the user's id: a positive integer.
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw new ConfigError(`telegram.chats[${String(index)}]: expected the positive id of a private chat`);
    }
    return item;
  });
  if (chats.length === 0) throw new ConfigError('telegram.chats: list at least one chat, or remove [telegram]');
  if (new Set(chats).size !== chats.length) throw new ConfigError('telegram.chats: an id is listed twice');
  return { token, chats };
}
