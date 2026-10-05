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
