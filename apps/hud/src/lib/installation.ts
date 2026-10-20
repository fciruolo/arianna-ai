/**
 * What this installation is (D-098, from `GET /api/installation` of D-089):
 * development or production. The page says it always, in the top bar, and
 * the tab of a development installation starts with "[DEV]", so the two
 * installations open side by side are never confused.
 */
export type InstallationMode = 'development' | 'production';

export interface InstallationInfo {
  mode: InstallationMode;
  /** The name of the ARIANNA_HOME folder, never its full path. */
  home: string;
  /** The short commit, or null when it cannot be read. */
  version: string | null;
}

export const MODE_BADGE: Record<InstallationMode, string> = { development: 'SVILUPPO', production: 'PRODUZIONE' };

export const MODE_HINT: Record<InstallationMode, string> = {
  development: 'Installazione di sviluppo: solo dati finti, password di sviluppo',
  production: 'Installazione di produzione: i dati veri',
};

export const DEV_PREFIX = '[DEV] ';

/** The tab title with the mark of a development installation; unchanged in production or while unknown. */
export function markTitle(title: string, mode: InstallationMode | undefined): string {
  const plain = title.startsWith(DEV_PREFIX) ? title.slice(DEV_PREFIX.length) : title;
  return mode === 'development' ? `${DEV_PREFIX}${plain}` : plain;
}

/** The answer of the core checked: anything unexpected is no answer (the badge waits). */
export function parseInstallation(value: unknown): InstallationInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = (value as { installation?: unknown }).installation;
  if (typeof record !== 'object' || record === null) return undefined;
  const { mode, home, version } = record as Record<string, unknown>;
  if (mode !== 'development' && mode !== 'production') return undefined;
  if (typeof home !== 'string') return undefined;
  if (version !== null && typeof version !== 'string') return undefined;
  return { mode, home, version };
}

/*
 * «Pronta per i dati veri» (D-192, `/api/installation/readiness`): the core
 * answers closed ids and outcomes, never a detail; the names and what to do
 * are written here, for a person who does not read code.
 */
export const READINESS_IDS = ['passwords', 'default-passwords', 'events', 'folders', 'models', 'memory', 'model-log', 'model-server', 'programs', 'voice', 'projects', 'other'] as const;
export type ReadinessId = (typeof READINESS_IDS)[number];

export interface ReadinessCheck {
  id: ReadinessId;
  ok: boolean;
}

export interface ReadinessReport {
  ready: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
  /** The last `pnpm arianna:doctor` in a terminal: the checks that need the owner of the database. */
  terminal: { at: string; ok: boolean; stale: boolean } | null;
}

const KNOWN = new Set<string>(READINESS_IDS);

/**
 * The answer checked: `null` before the first check, `undefined` for anything
 * unexpected. An id this page does not know counts under `other`, so a check
 * that fails is never hidden.
 */
export function parseReadiness(value: unknown): ReadinessReport | null | undefined {
  if (typeof value !== 'object' || value === null || !('readiness' in value)) return undefined;
  const report = value.readiness;
  if (report === null) return null;
  if (typeof report !== 'object') return undefined;
  const { ready, checkedAt, checks, terminal } = report as Record<string, unknown>;
  if (typeof ready !== 'boolean' || typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt)) || !Array.isArray(checks)) return undefined;
  const groups = new Map<ReadinessId, boolean>();
  for (const check of checks as unknown[]) {
    if (typeof check !== 'object' || check === null) return undefined;
    const { id, ok } = check as Record<string, unknown>;
    if (typeof id !== 'string' || typeof ok !== 'boolean') return undefined;
    const known: ReadinessId = KNOWN.has(id) ? (id as ReadinessId) : 'other';
    groups.set(known, (groups.get(known) ?? true) && ok);
  }
  let last: ReadinessReport['terminal'] = null;
  if (terminal !== null) {
    if (typeof terminal !== 'object') return undefined;
    const { at, ok, stale } = terminal as Record<string, unknown>;
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof ok !== 'boolean' || typeof stale !== 'boolean') return undefined;
    last = { at, ok, stale };
  }
  const list = READINESS_IDS.filter((id) => groups.has(id)).map((id) => ({ id, ok: groups.get(id) === true }));
  // Ready only as the core says and as the list shows: one failing group is enough to say no.
  return { ready: ready && list.every((check) => check.ok) && last?.ok === true && !last.stale, checkedAt, checks: list, terminal: last };
}

/** Each check in plain words: its name, a line when it passes, what to do when it does not. */
export const READINESS_TEXT: Record<ReadinessId, { title: string; ok: string; fix: string }> = {
  passwords: {
    title: 'Password vere nella cassaforte',
    ok: 'Lunghe e prese dalla cassaforte.',
    fix: 'Il database usa ancora le password di sviluppo, scritte nel codice e note a tutti, o una password è troppo corta. Mettine due nuove e lunghe nella cassaforte con pnpm vault:edit, poi riavvia Arianna.',
  },
  'default-passwords': {
    title: 'Le password di sviluppo non aprono il database',
    ok: 'Rifiutate.',
    fix: 'Oggi lo aprono ancora. Si sistema quando metti le password vere ed esegui pnpm db:migrate.',
  },
  events: {
    title: 'Registro degli eventi integro',
    ok: 'Nessun evento cambiato o tolto.',
    fix: 'Il registro degli eventi non torna o non si legge. Non mettere dati veri: esegui pnpm arianna:doctor nel Terminale per i dettagli.',
  },
  folders: {
    title: 'Cartelle dei dati private',
    ok: 'Solo il tuo utente del Mac le legge.',
    fix: 'Manca una cartella dei dati, o altri utenti del Mac possono leggerla. Esegui pnpm arianna:install: le crea e le rende private.',
  },
  models: {
    title: 'Modelli scaricati',
    ok: 'Tutti quelli scelti in Modelli.',
    fix: 'Manca almeno un modello fra quelli scelti. Scaricalo da Modelli, oppure con pnpm arianna:models pull.',
  },
  memory: {
    title: 'Memoria sufficiente',
    ok: 'I modelli scelti stanno nella memoria del Mac.',
    fix: 'I modelli scelti, insieme, chiedono più memoria di quella del Mac. Scegline di più piccoli in Modelli.',
  },
  'model-log': {
    title: 'Il server dei modelli non scrive i tuoi testi nel suo registro',
    ok: 'Livello di registro senza testi.',
    fix: 'Il comando del server dei modelli non dice --log-level info, quindi potrebbe scrivere nel suo registro quello che chiedi. Aggiungilo in Server dei modelli, Avanzate.',
  },
  'model-server': {
    title: 'Il server dei modelli risponde solo ad Arianna',
    ok: 'Chiave di Arianna, impostazioni nella cartella dei dati.',
    fix: 'Il comando del server dei modelli non dice --base-path data/omlx, contiene --api-key, --mcp-config o un proxy, oppure le sue impostazioni saltano la chiave, rispondono senza chiave, usano un proxy, server MCP, il cluster o Splash. Correggilo in Server dei modelli, Avanzate; pnpm arianna:doctor dice cosa.',
  },
  programs: {
    title: 'Programmi necessari',
    ok: 'Node.js, pnpm, Docker acceso, sops e age.',
    fix: 'Manca un programma, o Docker è spento. Esegui pnpm arianna:doctor nel Terminale per sapere quale; se lì c’è tutto, riavvia Arianna dal Terminale.',
  },
  voice: {
    title: 'Ambiente della voce',
    ok: 'Pronto.',
    fix: 'Manca l’ambiente della voce: esegui pnpm voice:sync.',
  },
  projects: {
    title: 'Cartelle dei progetti',
    ok: 'Tutte raggiungibili.',
    fix: 'La cartella di un progetto non c’è più o non è un repository git. Controlla in Progetti; i dettagli con pnpm arianna:doctor nel Terminale.',
  },
  other: {
    title: 'Altri controlli',
    ok: 'A posto.',
    fix: 'Un controllo che questa pagina non conosce non è passato: esegui pnpm arianna:doctor nel Terminale per i dettagli.',
  },
};

export const TERMINAL_TITLE = 'Database aggiornato e con permessi minimi';

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** «oggi alle 10:12», «ieri alle 18:02», «il 12 ottobre alle 18:40», in the time of this browser. */
export function whenText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `oggi alle ${time}`;
  if (days === 1) return `ieri alle ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${String(at.getFullYear())}`;
  return `il ${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ''}${year} alle ${time}`;
}

/** What the terminal's doctor said, in plain words. */
export function terminalText(terminal: ReadinessReport['terminal'], now: Date = new Date()): string {
  if (terminal === null) return 'Lo controlla solo il Terminale, che non l’ha ancora fatto: apri il Terminale nella cartella di Arianna e scrivi pnpm arianna:doctor.';
  const when = whenText(terminal.at, now);
  if (terminal.stale) return `Da rifare: l’ultimo controllo del Terminale, ${when}, è di prima dell’ultimo aggiornamento del database. Esegui di nuovo pnpm arianna:doctor nel Terminale.`;
  return terminal.ok
    ? `Lo controlla solo il Terminale: ultimo esito a posto, ${when}.`
    : `Lo controlla solo il Terminale: l’ultimo esito, ${when}, non era a posto. Esegui pnpm arianna:doctor e correggi quello che segnala.`;
}

export interface ReadinessRow {
  key: string;
  title: string;
  text: string;
  tone: 'ok' | 'missing' | 'terminal';
}

/** The rows of the page: what is missing first (the terminal last among them), then what passed. */
export function readinessRows(report: ReadinessReport, now: Date = new Date()): { missing: ReadinessRow[]; passed: ReadinessRow[] } {
  const row = (check: ReadinessCheck): ReadinessRow => ({
    key: check.id,
    title: READINESS_TEXT[check.id].title,
    text: check.ok ? READINESS_TEXT[check.id].ok : READINESS_TEXT[check.id].fix,
    tone: check.ok ? 'ok' : 'missing',
  });
  const terminal: ReadinessRow = { key: 'terminal', title: TERMINAL_TITLE, text: terminalText(report.terminal, now), tone: report.terminal?.ok === true && !report.terminal.stale ? 'ok' : 'terminal' };
  const missing = report.checks.filter((check) => !check.ok).map(row);
  const passed = report.checks.filter((check) => check.ok).map(row);
  if (terminal.tone === 'ok') passed.push(terminal);
  else missing.push(terminal);
  return { missing, passed };
}

/** «Manca 1 cosa», «Mancano 3 cose». */
export function missingText(count: number): string {
  return count === 1 ? 'Manca 1 cosa' : `Mancano ${String(count)} cose`;
}
