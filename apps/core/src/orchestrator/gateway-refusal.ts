import type { Sql } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import { moveTask, type Task } from '../tasks.ts';
import { loadDelegations } from './delegations.ts';

/**
 * A brief the gateway refused in the direct chat with an agent (D-250): there
 * is no other way there, so the task does not wait for the user, who would
 * find nothing to do. Arianna writes in the chat why, in Italian, by the kind
 * of the rule and never with a word of the brief, and the task ends.
 */

const REFUSED = /^(?:error: [^:]+: )?the gateway refused the brief \((.*)\)$/s;

/** The reason of the gateway, from the result of a delegation it refused; undefined for any other end. */
export function gatewayRefusalOf(result: string | null | undefined): string | undefined {
  return typeof result === 'string' ? REFUSED.exec(result)?.[1] : undefined;
}

// What the second scanner may find (Rizzo-PII), in Italian; any other kind is «un dato personale».
const PII_KIND_TEXT: Record<string, string> = {
  FULLNAME: 'un nome di persona',
  ADDRESS: 'un indirizzo',
  EMAIL: 'un indirizzo email',
  TELEPHONENUM: 'un numero di telefono',
};

/** Where the message did not go: «a Claude», «a Codex», «al modello locale». */
function towards(executor: string | null): string {
  if (executor === 'claude') return 'a Claude';
  if (executor === 'codex') return 'a Codex';
  if (executor === 'local') return 'al modello locale';
  return 'all’agente';
}

/** Where to look: the brief carries the rules and the notes of the project too. */
const WHERE = 'Se è nel tuo messaggio, toglilo e riscrivilo; se non c’è, è nelle regole o nelle note del progetto che lo accompagnano.';

/** Why, in Italian, from the reason of the gateway: its fixed words, never the content. */
function why(reason: string): string {
  const pii = /^second scanner found personal data: (.*)$/.exec(reason);
  if (pii !== null) {
    const kinds = (pii[1] ?? '').split(', ');
    const found = kinds.length === 1 ? (PII_KIND_TEXT[kinds[0] ?? ''] ?? 'un dato personale') : 'dei dati personali';
    return `il controllo dei dati personali ha trovato ${found}. ${WHERE}`;
  }
  if (reason.startsWith('second check not available')) return 'il controllo dei dati personali non ha risposto. Riprova fra poco.';
  if (reason.startsWith('scanner matched: ')) return `c’è un dato riservato (un IBAN, un codice fiscale, un numero di carta, una chiave o un token). ${WHERE}`;
  if (reason.startsWith('payload contains the value of ')) return `c’è il valore di un segreto del vault. ${WHERE}`;
  if (reason.startsWith('finance data') || reason.startsWith('the session has read finance data')) return 'i dati delle finanze non escono mai da questo computer.';
  if (reason.startsWith('L3 never leaves')) return 'contiene dati segreti, che non escono mai dal vault.';
  if (reason.startsWith('the session has read ') || /cannot go to a cloud target/.test(reason)) {
    return 'questa conversazione ha letto dati privati, che restano su questo computer. Per lavorare con il cloud apri una conversazione nuova.';
  }
  return 'il gateway l’ha fermato.';
}

/** Arianna's message in the chat for a brief the gateway refused (D-250). */
export function gatewayRefusalReply(reason: string, executor: string | null): string {
  return `Non ho mandato il messaggio ${towards(executor)}: ${why(reason)}`;
}

/**
 * The wait of a direct chat left by a brief the gateway refused, before D-250:
 * `<agent> could not answer: the gateway refused the brief (…)`.
 */
const LEFT_WAITING = /^[a-z0-9][a-z0-9_-]* could not answer: (the gateway refused the brief \(.*\))$/s;

/**
 * The tasks of a direct chat that wait for the user only because the gateway
 * refused their brief (before D-250): closed as done with Arianna's message,
 * as a new one ends. Run at the start of the core; returns how many it closed.
 * A task with a pending approval, or of a deleted conversation, is not touched.
 */
export async function closeRefusedDirectWaits(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string; reason: string; evidence: Task['evidence'] }[]>`
    SELECT t.id::text, t.waiting_reason AS reason, t.evidence FROM tasks t
      JOIN conversations c ON c.id = t.conversation_id
    WHERE t.status = 'waiting_user' AND c.agent = t.assignee AND c.purged_at IS NULL
      AND t.waiting_reason LIKE '% could not answer: the gateway refused the brief (%'
      AND NOT EXISTS (SELECT FROM approvals a WHERE a.task_id = t.id AND a.state = 'pending')
    ORDER BY t.created_at, t.id`;
  let closed = 0;
  for (const row of rows) {
    const reason = gatewayRefusalOf(LEFT_WAITING.exec(row.reason)?.[1]);
    if (reason === undefined) continue;
    const executor = (await loadDelegations(sql, row.id)).at(-1)?.executor ?? null;
    const body = gatewayRefusalReply(reason, executor);
    try {
      // The message and the move in one transaction, on the task locked and still waiting: a user who
      // answered meanwhile (the wait closed, D-109) leaves no message behind. A fixed text of ours,
      // with the kinds of the rule only, as the line of closeSupersededWaits: no gateway towards the chat.
      const done = await sql.begin(async (tx) => {
        const [task] = await tx<{ conversationId: string; label: string }[]>`
          SELECT conversation_id::text AS "conversationId", effective_label::text AS label FROM tasks
          WHERE id = ${row.id} AND status = 'waiting_user' AND waiting_reason = ${row.reason} FOR UPDATE`;
        if (task === undefined) return false;
        const [message] = await tx<{ id: string }[]>`
          INSERT INTO messages (conversation_id, role, channel, label, body, task_id)
          VALUES (${task.conversationId}, 'assistant', 'web', ${task.label}::privacy_label, ${body}, ${row.id})
          RETURNING id::text`;
        if (message === undefined) throw new Error('INSERT INTO messages returned no row');
        await appendEvent(tx, { kind: 'message.created', taskId: row.id, label: 'L0', payload: { conversationId: task.conversationId, messageId: message.id, role: 'assistant' } });
        await moveTask(tx, row.id, 'done', { cause: 'executor', from: ['waiting_user'], evidence: [...row.evidence, { kind: 'message', ref: message.id }] });
        return true;
      });
      if (done) closed += 1;
    } catch {
      // A conversation archived or gone meanwhile: the task stays as it is, with nothing written.
    }
  }
  return closed;
}
