/**
 * "Novità": the register of the versions as the page shows it. Pure: the
 * dates in Italian, the order of the versions, the tone of each section.
 */
import type { ChangelogVersion } from './types.ts';

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] as const;

/** `2026-10-05` → "5 ottobre 2026"; anything else is returned as it is. */
export function italianDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (month === undefined || day < 1 || day > 31) return date;
  return `${String(day)} ${month} ${match[1] ?? ''}`;
}

/** Negative when `a` comes before `b` (SemVer X.Y.Z). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The most recent first: "Non rilasciato", then the versions from the highest. */
export function orderVersions(versions: readonly ChangelogVersion[]): ChangelogVersion[] {
  return [...versions].sort((a, b) => {
    if (a.version === null || b.version === null) return a.version === null ? (b.version === null ? 0 : -1) : 1;
    return compareVersions(b.version, a.version);
  });
}

/** The title of a version: "0.1.1", or "Non rilasciato". */
export function versionTitle(version: ChangelogVersion): string {
  return version.version ?? 'Non rilasciato';
}

/** The date of a version in Italian, or null. */
export function versionDate(version: ChangelogVersion): string | null {
  return version.date === null ? null : italianDate(version.date);
}

export type SectionTone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

const TONES: Record<string, SectionTone> = {
  aggiunto: 'ok',
  corretto: 'info',
  sicurezza: 'warn',
  rimosso: 'danger',
  cambiato: 'neutral',
};

/** The colour of a section: Aggiunto green, Corretto blue, Sicurezza amber, Rimosso red, the others neutral. */
export function sectionTone(title: string): SectionTone {
  return TONES[title.trim().toLowerCase()] ?? 'neutral';
}

/** "Versione 0.1.1", or null when nothing is released yet. */
export function currentText(current: string | null): string | null {
  return current === null ? null : `Versione ${current}`;
}

/** What the page says about lines the core did not understand, or null. */
export function skippedText(skipped: number): string | null {
  if (skipped <= 0) return null;
  return skipped === 1 ? 'Una riga di CHANGELOG.md non è stata capita ed è saltata.' : `${String(skipped)} righe di CHANGELOG.md non sono state capite e sono saltate.`;
}
