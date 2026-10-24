/**
 * Texts of the settings page in plain words (D-192): what stays on the Mac,
 * what Claude and Codex receive, the local servers by name and state. Pure:
 * the page shows them, the tests check them.
 */
export { labelWord } from './labels.ts';
import type { Label } from './types.ts';
import type { LocalServerStatus, ProjectValues } from './settings.ts';

/**
 * «Cosa resta sempre sul Mac» (D-192): a fixed summary of the grades in plain
 * words, written by hand; the rules themselves live in config/labels.toml
 * (by folder and source) and in packages/policy, changed only by hand.
 */
export const KEEP_ON_MAC: readonly { data: string; label: Label; meaning: string }[] = [
  { data: 'Password, chiavi, IBAN, documenti d’identità', label: 'L3', meaning: 'Non escono mai, verso nessuno, nemmeno se lo approvi.' },
  { data: 'Finanze, clienti, note private, la voce delle chiamate', label: 'L2', meaning: 'Restano sul Mac. Esce solo un testo che approvi tu, una volta.' },
  { data: 'Tutto ciò che non ha un grado', label: 'L2', meaning: 'Nel dubbio, resta sul Mac come Privato.' },
  { data: 'Progetti Interni, regole dei progetti, testi degli agenti', label: 'L1', meaning: 'Possono andare a Claude e Codex per un lavoro.' },
  { data: 'Progetti Pubblici, ricerche su Hugging Face', label: 'L0', meaning: 'Possono uscire.' },
];

/** What never leaves the Mac, said in the confirmation of the exits. */
export const NEVER_OUT = 'Finanze, clienti, password e chiavi, la voce delle chiamate. Una nota privata esce solo se la approvi tu, una alla volta, mai da qui.';

/** The two cloud helpers, with the subscription they use. */
export const EXECUTOR_CARD: Record<string, { title: string; plan: string; company: string }> = {
  claude: { title: 'Claude Code', plan: 'abbonamento Claude', company: 'Anthropic' },
  codex: { title: 'Codex', plan: 'abbonamento ChatGPT', company: 'OpenAI' },
};

/** What a cloud helper receives (on) or would receive (off): the request, the files of the projects, the rules. */
export function executorReceives(on: boolean, projects: readonly ProjectValues[]): string {
  const names = projects.map((project) => project.name);
  const files = names.length === 0 ? 'nessun progetto, finché non ne aggiungi uno in Progetti' : `i file dei progetti ${names.join(', ')}`;
  return `${on ? 'Riceve' : 'Riceverebbe'}: la richiesta del lavoro, ${files}, le regole dei progetti.`;
}

/** The name of a local server as the user knows it; an unknown id stays as it is. */
export function serverName(id: string): string {
  if (id === 'omlx') return 'oMLX · modelli sul Mac';
  if (id === 'voice') return 'Voce';
  if (id === 'ollama') return 'Ollama';
  return id;
}

export type ServerTone = 'ok' | 'warn' | 'danger' | 'muted';

/** The state of a local server as a pill, and who starts it. */
export function serverStatus(server: LocalServerStatus): { text: string; tone: ServerTone; who: string } {
  const who = !server.managed ? 'solo controllato da Arianna' : server.adopted ? 'acceso a mano, fuori da Arianna' : 'avviato da Arianna';
  switch (server.state) {
    case 'up':
      return { text: 'Acceso', tone: 'ok', who };
    case 'starting':
      return { text: 'In avvio', tone: 'warn', who };
    case 'restarting':
      return { text: 'In riavvio', tone: 'warn', who };
    case 'down':
      return { text: 'Non risponde', tone: 'danger', who };
    case 'failed':
      return { text: 'Guasto', tone: 'danger', who };
    case 'stopped':
      return { text: 'Spento', tone: 'muted', who };
    default:
      return { text: 'Fermo', tone: 'muted', who };
  }
}

/** Why Arianna cannot restart a server, or undefined when it can. */
export function restartBlocker(server: LocalServerStatus): string | undefined {
  if (!server.managed) return 'Senza comando di avvio Arianna lo controlla soltanto: si riavvia da dove l’hai aperto.';
  if (server.adopted) return 'Era già acceso prima di Arianna: riavvialo da dove l’hai aperto.';
  return undefined;
}

/** A server that should answer and does not: the red box says what stops working. */
export function serverDown(server: LocalServerStatus): string | undefined {
  if (server.state !== 'down' && server.state !== 'failed') return undefined;
  const what = server.id === 'voice' ? 'le chiamate non partono' : 'i modelli sul Mac non rispondono';
  // D-263: the core did not start it, because it could not turn off the Hugging Face cache in its settings.
  if (server.refused === 'omlx-settings-unreadable') {
    return `${serverName(server.id)} non è partito: il suo file settings.json nella cartella dei dati non si legge (o è un collegamento), quindi Arianna non può spegnere la cache di Hugging Face. Correggilo o toglilo, poi Riavvia; il controllo pnpm arianna:doctor dice cosa non va.`;
  }
  if (server.refused !== undefined) {
    return `${serverName(server.id)} non è partito: Arianna non riesce a scrivere il suo settings.json nella cartella dei dati per spegnere la cache di Hugging Face. Controlla i permessi della cartella, poi Riavvia.`;
  }
  return `${serverName(server.id)} non risponde: ${what}. Riavvialo; se torna a fermarsi, guarda le ultime righe del registro.`;
}
