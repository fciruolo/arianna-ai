/**
 * Impostazioni → Dispositivi (D-292, stage B): the Italian texts of the page,
 * pure and tested. The page itself is DevicesPage.vue.
 */

/** «Ultimo accesso»: relative while recent, then the date. */
export function lastSeenText(iso: string | null, now: number): string {
  if (iso === null) return 'mai';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'mai';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'adesso';
  if (minutes < 60) return minutes === 1 ? '1 minuto fa' : `${String(minutes)} minuti fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 ora fa' : `${String(hours)} ore fa`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? 'ieri' : `${String(days)} giorni fa`;
  return new Date(at).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** How long a code still lasts, «4:32»; null once expired. */
export function codeLeftText(expiresAt: string, now: number): string | null {
  const left = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (Number.isNaN(left) || left <= 0) return null;
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
}

/** The six digits in two groups of three, easier to read and to type. */
export function codeText(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The address the phone opens. */
export function phoneAddress(host: string): string {
  return `https://${host}`;
}
