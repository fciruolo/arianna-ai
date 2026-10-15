import type { CodexError } from '@arianna/executors';

/** Below this a run that ended without saying why "stopped at once": a refused login or plan, not a long piece of work. */
const AT_ONCE_MS = 60_000;

const seconds = (ms: number): string => {
  const value = Math.max(1, Math.round(ms / 1000));
  if (value >= 120) return `${String(Math.round(value / 60))} minuti`;
  return value === 1 ? '1 secondo' : `${String(value)} secondi`;
};

/**
 * Why a run of Codex failed, as the chat shows it (D-064): what happened and
 * what to do, in Italian. Written from the kind, the HTTP status and the
 * duration only: the binary's own words never reach the chat, they may quote
 * the brief.
 */
export function codexFailureText(error: Pick<CodexError, 'kind' | 'apiStatus' | 'durationMs' | 'exitCode'>): string {
  const after = error.durationMs === undefined ? '' : error.durationMs < AT_ONCE_MS ? ` subito (dopo ${seconds(error.durationMs)})` : ` dopo ${seconds(error.durationMs)}`;
  switch (error.kind) {
    case 'auth':
      return 'Codex non è collegato all\'account ChatGPT (accesso mancante o scaduto): lancia `codex login` nel terminale, poi riprova.';
    case 'plan':
      return 'L\'abbonamento ChatGPT non permette questo modello di Codex: controlla il piano su chatgpt.com, oppure scegli un altro modello per Codex in Impostazioni → Modelli.';
    case 'execution':
      // A status that is not the login's: the service gave a reason, the login is not the first thing to check.
      if (error.apiStatus !== undefined) {
        return `Codex si è fermato${after} per un errore ${String(error.apiStatus)} del servizio: riprova più tardi; se si ripete, prova un altro modello per Codex in Impostazioni → Modelli.`;
      }
      return `Codex si è fermato${after} senza dire perché: prova \`codex login status\` nel terminale per vedere se è collegato.`;
    case 'exit':
      return `Codex si è fermato${after} senza finire il lavoro e senza dire perché: prova \`codex login status\` nel terminale per vedere se è collegato.`;
    case 'spawn':
      return 'Codex non si avvia: controlla nel terminale che il comando `codex` sia installato (`codex --version`).';
    case 'timeout':
      return 'Codex non ha finito entro il tempo massimo del passo: il lavoro è stato fermato.';
    case 'max-turns':
      return 'Codex ha superato il numero massimo di comandi per un passo: il lavoro è stato fermato.';
    case 'profile':
      return 'Codex ha fatto qualcosa che il profilo di confinamento non permette (uno strumento o una sessione non previsti): il lavoro è stato fermato.';
    case 'bad-output':
      return 'Codex ha risposto in un formato che Arianna non riconosce (forse una versione diversa del programma): il lavoro è stato fermato.';
    case 'not-enabled':
      return 'Codex è spento: si accende in Impostazioni → Claude e Codex.';
    case 'cancelled':
      return 'Codex è stato fermato prima di finire.';
    case 'workspace':
      return 'Codex non è partito: la cartella di lavoro preparata per lui non c\'era più o era cambiata.';
    case 'handler':
      return 'Codex è stato fermato: Arianna non è riuscita a registrare quello che stava facendo.';
    default:
      return `Codex non è partito (${error.kind}).`;
  }
}
