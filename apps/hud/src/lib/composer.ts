/**
 * The richer composer of the chat (D-231, idea 13 of OpenWork): the unsent
 * text of each conversation kept in this browser only, the keys that switch
 * the model of the conversation among those its selector admits, and the
 * entries of the «+» menu. Pure functions, no Vue.
 */

// --- Drafts: the unsent text of a conversation (D-231) ---------------------

/**
 * One key per conversation in localStorage. Only the text and when it was
 * last written: never the label, the title or anything else of the
 * conversation. Nothing of it goes to the core.
 */
export const DRAFT_PREFIX = 'arianna.draft.';
/** A draft untouched for a week is dropped. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The field's own limit (`maxlength` of the composer). */
export const DRAFT_MAX = 16000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * A conversation keeps a draft only when it is of work and not incognito
 * (D-136): nothing of an incognito one is saved, not even in the browser, and
 * a private one keeps none either (choice of the user of 2026-10-16, D-231):
 * its text could hold private data, in clear in the browser's profile.
 */
export function keepsDraft(conversation: { incognito?: boolean | undefined; mode?: string | undefined }): boolean {
  return conversation.incognito !== true && conversation.mode !== 'private';
}

function draftKey(conversationId: string): string | undefined {
  return UUID.test(conversationId) ? DRAFT_PREFIX + conversationId.toLowerCase() : undefined;
}

/** The text of a stored value, or undefined when it is malformed or older than a week. */
function readValue(raw: string | null, now: number): string | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return undefined;
    if (text.trim() === '' || text.length > DRAFT_MAX) return undefined;
    if (now - at > DRAFT_TTL_MS) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** The draft of a conversation, '' when there is none; an expired or malformed one is removed. */
export function loadDraft(storage: DraftStorage | undefined, conversationId: string, now: number): string {
  const key = draftKey(conversationId);
  if (storage === undefined || key === undefined) return '';
  try {
    const raw = storage.getItem(key);
    const text = readValue(raw, now);
    if (text === undefined && raw !== null) storage.removeItem(key);
    return text ?? '';
  } catch {
    return '';
  }
}

/** Keeps the text of a conversation; an empty one (or only spaces) removes the draft. */
export function saveDraft(storage: DraftStorage | undefined, conversationId: string, text: string, now: number): void {
  const key = draftKey(conversationId);
  if (storage === undefined || key === undefined) return;
  try {
    if (text.trim() === '') storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ text: text.slice(0, DRAFT_MAX), at: now }));
  } catch {
    // Full or blocked storage: the text stays in the field until the page is left.
  }
}

/** The message left, or the conversation is gone: its draft too. */
export function removeDraft(storage: DraftStorage | undefined, conversationId: string): void {
  const key = draftKey(conversationId);
  if (storage === undefined || key === undefined) return;
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage: it expires by itself.
  }
}

/** Removes the drafts older than a week or malformed, of every conversation; returns how many went. */
export function pruneDrafts(storage: DraftStorage | undefined, now: number): number {
  if (storage === undefined) return 0;
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(DRAFT_PREFIX)) continue;
      if (!UUID.test(key.slice(DRAFT_PREFIX.length)) || readValue(storage.getItem(key), now) === undefined) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return stale.length;
  } catch {
    return 0;
  }
}

/**
 * The draft of the field of one chat as it moves from conversation to
 * conversation (D-231): `open` gives the text of the one opened and keeps the
 * one left, `write` keeps the text a moment after the last key (`flush` at
 * once: on leaving the page), `forget` drops it when the conversation turns
 * out incognito. Each call names its conversation, so the order of Vue's
 * watchers never moves a text into another conversation.
 */
export interface DraftKeeper {
  open(conversationId: string, keeps: boolean): string;
  write(conversationId: string, text: string): void;
  flush(): void;
  forget(conversationId: string): void;
}

export const DRAFT_WRITE_MS = 400;

export interface DraftTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export function draftKeeper(storage: DraftStorage | undefined, now: () => number, timers: DraftTimers): DraftKeeper {
  /** The conversations that keep no draft (incognito), as far as this page knows. */
  const kept = new Map<string, boolean>();
  /** What storage holds for each conversation opened, so that opening one never rewrites it. */
  const stored = new Map<string, string>();
  let pending: { conversationId: string; text: string } | undefined;
  let handle: unknown;

  function flush(): void {
    if (pending === undefined) return;
    const { conversationId, text } = pending;
    pending = undefined;
    timers.clear(handle);
    if (kept.get(conversationId) !== true || stored.get(conversationId) === text) return;
    stored.set(conversationId, text);
    saveDraft(storage, conversationId, text, now());
  }

  return {
    open(conversationId, keeps) {
      flush();
      kept.set(conversationId, keeps);
      const text = keeps ? loadDraft(storage, conversationId, now()) : '';
      stored.set(conversationId, text);
      return text;
    },
    write(conversationId, text) {
      if (kept.get(conversationId) !== true) return;
      if (pending !== undefined && pending.conversationId !== conversationId) flush();
      pending = { conversationId, text };
      timers.clear(handle);
      handle = timers.set(flush, DRAFT_WRITE_MS);
    },
    flush,
    forget(conversationId) {
      kept.set(conversationId, false);
      if (pending?.conversationId === conversationId) pending = undefined;
      stored.delete(conversationId);
      removeDraft(storage, conversationId);
    },
  };
}

/**
 * A message the core refused after the page moved on (another conversation
 * open, or a field not empty): it is kept as the draft of its conversation,
 * unless that one already has a draft or keeps none. True when it was kept.
 */
export function keepRefused(storage: DraftStorage | undefined, conversationId: string, body: string, keeps: boolean, now: number): boolean {
  if (!keeps || body.trim() === '' || loadDraft(storage, conversationId, now) !== '') return false;
  saveDraft(storage, conversationId, body, now);
  return loadDraft(storage, conversationId, now) !== '';
}

// --- Keys for the models (D-231) --------------------------------------------

/**
 * The keys that choose the model of the conversation: on the Mac ⌃0…⌃9
 * (Control, which neither Chrome nor Safari use with a digit, and which types
 * no character: ⌥ with a digit types `~`, `` ` ``, «» on the Italian layout,
 * ⌘ with a digit switches the browser's tabs); elsewhere Alt+Maiusc with the
 * digit (Ctrl and Alt with a digit switch tabs there). By the physical key
 * (`code`), so the Shift of a layout does not change it.
 */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** The digit of a model key, or undefined for any other key. */
export function modelDigit(event: KeyLike, mac: boolean): number | undefined {
  if (event.isComposing === true) return undefined;
  const modifiers = mac ? event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey : event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
  if (!modifiers) return undefined;
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  return match === null ? undefined : Number(match[1]);
}

/** The key of a digit as the menu shows it. */
export function modelKeyText(digit: number, mac: boolean): string {
  return mac ? `⌃${String(digit)}` : `Alt+Maiusc+${String(digit)}`;
}

/**
 * What a digit chooses among the entries of the selector: 0 the automatic
 * choice (null), 1…9 the selector's models in its order. Undefined when the
 * selector has no entry there: the key never reaches a model the selector
 * does not show (the core checks again, D-055, D-111d).
 */
export function modelForDigit(digit: number, selectable: readonly { model: string }[]): { model: string | null } | undefined {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return undefined;
  if (digit === 0) return { model: null };
  const entry = selectable[digit - 1];
  return entry === undefined ? undefined : { model: entry.model };
}

// --- The «+» menu (D-231) ---------------------------------------------------

export type PlusAction = 'commands' | 'mention' | 'attach' | 'file' | 'session' | 'save' | 'model';

export interface PlusEntry {
  id: string;
  action: PlusAction;
  text: string;
  /** A short line under or beside the text. */
  hint?: string;
  /** The keys that do the same from the field. */
  keys?: string;
  disabled?: boolean;
  /** For a model: the model (null: automatic) and whether it is the current one. */
  model?: string | null;
  checked?: boolean;
}

export interface PlusOptions {
  /** The text in the field: «/» and «@» open their menus only on an empty field, never over what is written. */
  draft: string;
  /** A conversation with Arianna where «@» reaches agents (D-107, tappa B2). */
  mention: boolean;
  /** The project whose Private notes may leave once (D-187), or null. */
  attachProject: string | null;
  /**
   * «Allega file» (D-247): images and text files read on the Mac only. `problem` says in Italian why this
   * conversation takes none (the entry is shown off, with a short reason); absent, the entry is left out.
   */
  file?: { problem?: string | undefined } | undefined;
  /** «Nuova sessione» of the Designer (D-185). */
  session: boolean;
  sessionBusy?: boolean;
  /** «Salva in inbox» of the whole conversation (D-131): not in incognito, not without messages. */
  save: boolean;
  saved?: boolean;
  /** The selector of the conversation, when it has one: its automatic entry and its models, with the key texts. */
  selector?: { autoText: string; models: readonly { model: string; text: string }[]; selected: string | null } | undefined;
  mac: boolean;
}

/** The entries of the «+» menu, in order; what does not apply here is left out. */
export function plusEntries(options: PlusOptions): PlusEntry[] {
  const empty = options.draft.trim() === '';
  const entries: PlusEntry[] = [
    { id: 'commands', action: 'commands', text: 'Comandi', keys: '/', ...(empty ? {} : { hint: 'a campo vuoto', disabled: true }) },
  ];
  if (options.mention) entries.push({ id: 'mention', action: 'mention', text: 'Chiama un agente', keys: '@', ...(empty ? {} : { hint: 'a campo vuoto', disabled: true }) });
  if (options.file !== undefined) {
    entries.push(
      options.file.problem === undefined
        ? { id: 'file', action: 'file', text: 'Allega file', hint: 'immagine o testo, letto solo sul Mac', keys: options.mac ? '⌘V' : 'Ctrl+V' }
        : { id: 'file', action: 'file', text: 'Allega file', hint: 'solo in una chat privata', disabled: true },
    );
  }
  if (options.attachProject !== null) entries.push({ id: 'attach', action: 'attach', text: 'Allega nota privata', hint: `di ${options.attachProject}, con la master password` });
  if (options.session) entries.push({ id: 'session', action: 'session', text: 'Nuova sessione', hint: 'il Designer riparte da un riassunto', ...(options.sessionBusy === true ? { disabled: true } : {}) });
  if (options.save) entries.push({ id: 'save', action: 'save', text: options.saved === true ? 'Aggiorna in inbox' : 'Salva in inbox', hint: 'tutta la conversazione, come nota Privata' });
  const selector = options.selector;
  if (selector !== undefined) {
    entries.push({ id: 'model-auto', action: 'model', text: selector.autoText, model: null, checked: selector.selected === null, keys: modelKeyText(0, options.mac) });
    selector.models.forEach((entry, index) => {
      entries.push({
        id: `model-${entry.model}`,
        action: 'model',
        text: entry.text,
        model: entry.model,
        checked: selector.selected === entry.model,
        ...(index < 9 ? { keys: modelKeyText(index + 1, options.mac) } : {}),
      });
    });
  }
  return entries;
}

/** The next entry that can be chosen, from `index` by `delta` (±1), wrapping; -1 when none can. */
export function nextEnabled(entries: readonly PlusEntry[], index: number, delta: number): number {
  const count = entries.length;
  const start = index < 0 || index >= count ? (delta > 0 ? -1 : count) : index;
  for (let step = 1; step <= count; step++) {
    const at = (((start + delta * step) % count) + count) % count;
    if (entries[at]?.disabled !== true) return at;
  }
  return -1;
}
