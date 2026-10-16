/**
 * Images and files attached in the chat (D-247, idea 9 of OpenWork): what
 * the field takes before anything is uploaded, the same rules the core
 * checks again (apps/core/src/attachments.ts). Every attachment is Privato
 * (L2) and goes only into a private conversation answered on the Mac: in a
 * conversation where Claude or ChatGPT may answer the chat says so when the
 * file is pasted, and nothing leaves. Pure functions, no Vue.
 */

/** Largest image: 10 MB, as the core. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Largest text file: 256 KiB, as the core. */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Attachments of one message at most. */
export const MAX_ATTACHMENTS = 4;
/** An image larger than this on its longest side is made smaller before it leaves the page (D-247): the vision model reads it faster. */
export const MAX_IMAGE_SIDE = 2048;

export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXTENSIONS: readonly string[] = ['txt', 'text', 'md', 'markdown', 'csv', 'json'];

export type { AttachmentInfo } from './types.ts';

/** What decides whether a conversation takes attachments. */
export interface AttachmentPlace {
  mode: string;
  incognito?: boolean | undefined;
  secretary?: boolean | undefined;
  agent: string | null;
  origin?: string | undefined;
  sideOf?: string | null | undefined;
  archivedAt?: string | null | undefined;
}

/**
 * Why this conversation takes no attachment, in Italian; undefined when it
 * takes them. The same rule as the core: only a private conversation of the
 * user with Arianna or the local model.
 */
export function attachmentPlaceProblem(place: AttachmentPlace): string | undefined {
  if (place.mode !== 'private') return 'Gli allegati restano sul Mac: qui potrebbero leggerli Claude o ChatGPT. Allegali in una conversazione privata.';
  if (place.incognito === true) return 'In incognito non si allega niente: non resterebbe nulla della conversazione.';
  if ((place.origin ?? 'user') !== 'user' || place.secretary === true || (place.sideOf ?? null) !== null || (place.agent !== null && place.agent !== 'local-chat')) {
    return 'Gli allegati vanno solo in una conversazione privata con Arianna o con il modello locale.';
  }
  if ((place.archivedAt ?? null) !== null) return 'La conversazione è archiviata: ripristinala per allegare.';
  return undefined;
}

/** The kind of a file the field takes, by its type or the extension of its name; undefined when refused. */
export function attachmentKind(file: { name: string; type: string }): 'image' | 'text' | undefined {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (file.type === 'image/svg+xml') return undefined;
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(file.name)?.[1]?.toLowerCase();
  return extension !== undefined && TEXT_EXTENSIONS.includes(extension) ? 'text' : undefined;
}

/** Why a file cannot be attached, in Italian; undefined when the field takes it. `count` is how many are already in the field. */
export function attachmentFileProblem(file: { name: string; type: string; size: number }, count: number): string | undefined {
  if (count >= MAX_ATTACHMENTS) return `Al massimo ${String(MAX_ATTACHMENTS)} allegati per messaggio.`;
  const kind = attachmentKind(file);
  if (kind === undefined) return `«${file.name}» non si può allegare: solo immagini PNG, JPEG, WebP o GIF e testi .txt, .md, .csv o .json.`;
  if (file.size === 0) return `«${file.name}» è vuoto.`;
  if (kind === 'text' && file.size > MAX_TEXT_BYTES) return `«${file.name}» supera 256 KiB: un testo più lungo va in una nota.`;
  // An image larger than the limit may still fit once made smaller: refused only when it cannot be (a GIF).
  if (kind === 'image' && file.size > MAX_IMAGE_BYTES && file.type === 'image/gif') return `«${file.name}» supera 10 MB.`;
  return undefined;
}

/** The text of a message that carries only attachments: the core wants a text, and the chat shows it. */
export function attachmentsBody(text: string, names: readonly string[]): string {
  if (text.trim() !== '' || names.length === 0) return text;
  return names.length === 1 ? `Allegato: ${names[0] ?? ''}` : `Allegati: ${names.join(', ')}`;
}

/** Where the chat reads the bytes of an attachment: an image is shown sandboxed, a text file downloaded. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

/** The size as people read it. */
export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** The size of an image made smaller to fit MAX_IMAGE_SIDE, keeping its shape; the same when it already fits. */
export function fittedSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const side = Math.max(width, height);
  if (side <= max || side === 0) return { width, height };
  const scale = max / side;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
