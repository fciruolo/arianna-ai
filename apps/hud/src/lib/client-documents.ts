import { ApiError } from './api.ts';
import { errorText } from './italian.ts';

/**
 * The documents of a client (I-16 tappa C2, D-171): the types of
 * `/api/clients/:id/documents`, the words of each kind, the filters of the
 * list, the checks done before sending a file (the core checks the bytes
 * again) and the errors. Private (L2): the files stay in the folder of the
 * client on this computer.
 */

export const DOCUMENT_KINDS = ['contract', 'signed_quote', 'nda', 'order', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface ClientDocument {
  id: string;
  kind: DocumentKind;
  otherType: string | null;
  name: string;
  project: string | null;
  documentOn: string | null;
  expiresOn: string | null;
  extension: string;
  mediaType: string;
  sizeBytes: number;
  preview: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface DocumentForm {
  name: string;
  kind: DocumentKind;
  otherType: string | null;
  project: string | null;
  documentOn: string | null;
  expiresOn: string | null;
}

export const KIND_TEXT: Record<DocumentKind, string> = { contract: 'Contratto', signed_quote: 'Preventivo firmato', nda: 'NDA', order: 'Ordine', other: 'Altro' };
const KIND_PLURAL: Record<DocumentKind, string> = { contract: 'Contratti', signed_quote: 'Preventivi firmati', nda: 'NDA', order: 'Ordini', other: 'Altri' };

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'txt', 'csv', 'md'] as const;

/** The type a document shows: the kind, or the free type of an other one. */
export function typeText(document: Pick<ClientDocument, 'kind' | 'otherType'>): string {
  return document.kind === 'other' && document.otherType !== null ? document.otherType : KIND_TEXT[document.kind];
}

export type KindFilter = DocumentKind | 'all';

/** The chips over the list: all, then each kind present, with the count of the documents not archived. */
export function kindChips(documents: readonly ClientDocument[]): { id: KindFilter; text: string; count: number }[] {
  const live = documents.filter((document) => document.archivedAt === null);
  const chips: { id: KindFilter; text: string; count: number }[] = [{ id: 'all', text: 'Tutti', count: live.length }];
  for (const kind of DOCUMENT_KINDS) {
    const count = live.filter((document) => document.kind === kind).length;
    if (count > 0) chips.push({ id: kind, text: KIND_PLURAL[kind], count });
  }
  return chips;
}

/** The list for the chip, the search (name, type, project) and the archived switch, newest first as the core sends it. */
export function filterDocuments(documents: readonly ClientDocument[], kind: KindFilter, query: string, archived: boolean): ClientDocument[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  return documents.filter((document) => {
    if ((document.archivedAt !== null) !== archived) return false;
    if (kind !== 'all' && document.kind !== kind) return false;
    const haystack = `${document.name} ${typeText(document)} ${document.project ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** "412 KB", "1,2 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** The due date in words, against today: "scade il 31/12/2026", "scaduto il …"; null without one. */
export function expiryText(expiresOn: string | null, today: string): { text: string; past: boolean; soon: boolean } | null {
  if (expiresOn === null) return null;
  const [year, month, day] = expiresOn.split('-');
  const shown = `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
  const past = expiresOn < today;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 30);
  return { text: `${past ? 'scaduto il' : 'scade il'} ${shown}`, past, soon: !past && expiresOn <= limit.toISOString().slice(0, 10) };
}

/** What is wrong with a file before sending it; null when it may go. */
export function documentFileProblem(file: { name: string; size: number }): string | null {
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(file.name)?.[1]?.toLowerCase();
  if (extension === undefined || !(DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) return 'Questo tipo di file non si può aggiungere: PDF, immagini, documenti di Office o di testo.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'Il file è troppo grande: al più 25 MB.';
  return null;
}

/** The address of the file of a document, for the preview (PDF and images) and the download. */
export function documentFileUrl(clientId: string, documentId: string): string {
  return `/api/clients/${encodeURIComponent(clientId)}/documents/${encodeURIComponent(documentId)}/file`;
}

export function documentErrorText(cause: unknown): string {
  if (!(cause instanceof ApiError)) return errorText(cause);
  if (cause.status === 413 || /25 MB/.test(cause.message)) return 'Il file è troppo grande: al più 25 MB.';
  if (/must be one of/.test(cause.message)) return 'Il file non è di un tipo ammesso, o non è quello che dice il suo nome.';
  if (/needs its type/.test(cause.message)) return 'Per un documento “Altro” scrivi il tipo (per esempio brochure).';
  if (/not one of the client/.test(cause.message)) return 'Il progetto non è più del cliente: ricarica la pagina.';
  if (/changed on disk/.test(cause.message)) return 'Il file è cambiato sul disco dopo il caricamento: per sicurezza non lo apro.';
  if (/file of the document is missing/.test(cause.message)) return 'Il file non è più nella cartella del cliente.';
  if (/macOS only/.test(cause.message)) return 'Aprire con le app del computer funziona solo sul Mac.';
  if (/archived/.test(cause.message)) return /client/.test(cause.message) ? 'Il cliente è archiviato: ripristinalo prima.' : 'Il documento è archiviato: ripristinalo prima di cambiarlo.';
  if (/must be YYYY-MM-DD/.test(cause.message)) return 'La data non è valida.';
  if (cause.status === 404) return 'Il documento non c’è più: ricarico.';
  return errorText(cause);
}
