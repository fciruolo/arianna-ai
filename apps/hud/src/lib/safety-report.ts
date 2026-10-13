/**
 * The safety reports of the catalog (D-196): Opus reads a role of the
 * catalog of agents, or a skill, once per version (choice of the user,
 * 2026-10-13: «non è relativo al catalogo stesso?»), and the report of an
 * agent is made of the reports of its role and its skills. Shown with the
 * role in the catalog, in «Nuovo agente → Dal catalogo» and above «Accendi».
 * Types and the Italian texts of the four states; turning the agent on stays
 * the user's choice, with one more confirmation when the report is not
 * «nessun problema».
 */

export type SafetyCategory = 'data' | 'external' | 'override' | 'permissions' | 'other';

export interface SafetyFinding {
  doc: string;
  docName: string;
  line: number;
  /** Empty when the words Opus quoted are not on the line (then `exact` is false). */
  quote: string;
  exact: boolean;
  severity: 'suspect' | 'unclear';
  category: SafetyCategory;
  title: string;
  explanation: string;
  lines: { n: number; text: string }[];
  carried?: true;
}

export type SafetyReason = 'unavailable' | 'quota' | 'blocked' | 'failed' | 'unreadable' | 'too-large';

export interface SafetyReport {
  state: 'ok' | 'warn' | 'unavailable';
  at: string;
  model: string;
  scope: 'whole' | 'changes';
  changes?: { added: number; removed: number };
  role: { path: string; commit: string };
  skills: { id: string; name: string }[];
  summary: string;
  findings: SafetyFinding[];
  discarded: number;
  reason?: { code: SafetyReason; message: string };
}

export type SafetyState = 'ok' | 'warn' | 'running' | 'unavailable';

/** One text of an agent (its role, or a skill) and where its own report stands. */
export interface SafetyPart {
  kind: 'role' | 'skill';
  id: string;
  name: string;
  state: SafetyState;
}

export interface SafetyView {
  state: SafetyState;
  report?: SafetyReport;
  running?: { since: string; scope: 'whole' | 'changes'; role: string; skills: number };
  /** For an agent: its role and each skill. */
  parts?: SafetyPart[];
}

export class SafetyApiError extends Error {
  override name = 'SafetyApiError';
}

/**
 * The report of a role or a skill opened: made the first time, once per
 * version (a POST: the core never starts a reading on a GET). With `redo`,
 * «Rifai il rapporto»; for an agent always that. The core reads again only
 * what has no report available.
 */
export async function redoSafetyReport(target: { agent: string } | { role: string } | { skill: string }, redo = true): Promise<SafetyView> {
  const [path, body] =
    'agent' in target
      ? [`/api/agents/${encodeURIComponent(target.agent)}/safety`, {}]
      : 'role' in target
        ? ['/api/agents-catalog/agent/safety', { id: target.role, ...(redo ? { redo: true } : {}) }]
        : ['/api/skills-catalog/skill/safety', { id: target.skill, ...(redo ? { redo: true } : {}) }];
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as { safety?: SafetyView; error?: string };
  if (!response.ok || data.safety === undefined) throw new SafetyApiError(typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data.safety;
}

/** The pill in the head of the agent. */
export function safetyPill(safety: SafetyView): { text: string; tone: 'ok' | 'warn' | 'plain' } {
  if (safety.state === 'ok') return { text: '✓ Rapporto: nessun problema', tone: 'ok' };
  if (safety.state === 'warn') return { text: `● Rapporto: ${String(safety.report?.findings.length ?? 0)} da guardare`, tone: 'warn' };
  if (safety.state === 'running') return { text: 'Rapporto in corso…', tone: 'plain' };
  return { text: 'Senza rapporto', tone: 'plain' };
}

/** The dot beside the name in the list: only a report with something to look at. */
export function safetyDot(safety: SafetyView | undefined): boolean {
  return safety?.state === 'warn';
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** «oggi alle 20:14», «ieri alle 9:05», «il 12/10 alle 18:00». */
export function whenText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${String(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `oggi alle ${time}`;
  if (days === 1) return `ieri alle ${time}`;
  return `il ${pad(at.getDate())}/${pad(at.getMonth() + 1)} alle ${time}`;
}

const MODEL_NAME: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet' };

/** The file of a role without its folders. */
const fileOf = (path: string): string => path.split('/').at(-1) ?? path;

/** What was read: «ruolo x.md (commit 4bce55a) e 1 skill: nome». */
export function readText(role: { path: string; commit?: string }, skills: readonly { name: string }[] | number): string {
  const count = typeof skills === 'number' ? skills : skills.length;
  const names = typeof skills === 'number' ? '' : `: ${skills.map((skill) => skill.name).join(', ')}`;
  // The report of a skill alone (opened in Skill e stili): no role.
  if (role.path === '') return count === 0 ? 'il testo' : typeof skills === 'number' ? `${String(count)} skill` : `skill${names}`;
  const commit = role.commit === undefined || role.commit === '' ? '' : ` (commit ${role.commit.slice(0, 7)})`;
  return `ruolo ${fileOf(role.path)}${commit}${count === 0 ? '' : ` e ${String(count)} skill${names}`}`;
}

/**
 * The texts of an agent whose report is not there yet: «la skill commit è
 * ancora in lettura», shown under a report already made of the others.
 */
export function pendingPartsText(parts: readonly SafetyPart[] | undefined): string {
  const name = (part: SafetyPart): string => (part.kind === 'role' ? 'il ruolo' : `la skill ${part.name}`);
  const running = (parts ?? []).filter((part) => part.state === 'running').map(name);
  const missing = (parts ?? []).filter((part) => part.state === 'unavailable').map(name);
  const lines: string[] = [];
  if (running.length > 0) lines.push(`${running.join(', ')}: ancora in lettura`);
  if (missing.length > 0) lines.push(`${missing.join(', ')}: senza rapporto`);
  return lines.join(' · ');
}

/** The line under the title of a report. */
export function metaText(report: SafetyReport, now: Date = new Date()): string {
  const who = `Letto da ${MODEL_NAME[report.model] ?? report.model} ${whenText(report.at, now)}`;
  if (report.scope === 'changes') {
    const changes = report.changes === undefined ? '' : ` (+${String(report.changes.added)} −${String(report.changes.removed)})`;
    return `${who}, dopo la riadozione · solo le righe cambiate rispetto alla versione di prima${changes}`;
  }
  return `${who} · ${readText(report.role, report.skills)}`;
}

/** Why there is no report, in words. */
export function reasonText(code: SafetyReason | undefined): string {
  switch (code) {
    case 'unavailable':
      return 'Claude non è abilitato in Impostazioni → Claude e Codex';
    case 'quota':
      return 'Claude è senza quota: il rapporto riparte da solo dopo il reset';
    case 'blocked':
      return 'Il gateway ha fermato la richiesta';
    case 'unreadable':
      return 'La risposta di Opus non si leggeva';
    case 'too-large':
      return 'Il testo del ruolo e delle skill è troppo lungo per un rapporto';
    default:
      return 'Claude non ha risposto';
  }
}

/** Whether the report comes back by itself when Claude is available again. */
export function retriesByItself(code: SafetyReason | undefined): boolean {
  return code === 'unavailable' || code === 'quota';
}

const CHECKS: { category: SafetyCategory; ok: string; ko: string }[] = [
  { category: 'data', ok: 'Niente richieste di dati o file', ko: 'Richieste di dati o file' },
  { category: 'external', ok: 'Niente indirizzi o servizi esterni', ko: 'Indirizzi o servizi esterni' },
  { category: 'override', ok: 'Niente ordini nascosti o in altre lingue', ko: 'Ordini che cambiano le regole' },
  { category: 'permissions', ok: 'Niente richieste di permessi in più', ko: 'Richieste di permessi in più' },
];

/** The checks of a report, the ones with findings first; one more for the skills when there are some. */
export function checkRows(report: SafetyReport): { text: string; ok: boolean }[] {
  const flagged = new Set(report.findings.map((finding) => finding.category));
  const rows = CHECKS.map((check) => (flagged.has(check.category) ? { text: check.ko, ok: false } : { text: check.ok, ok: true }));
  if (flagged.has('other')) rows.push({ text: 'Altro da guardare', ok: false });
  if (report.skills.length > 0) {
    const skills = report.findings.some((finding) => finding.doc !== 'role');
    rows.push(skills ? { text: 'Skill assegnate: da guardare', ok: false } : { text: 'Skill assegnate: nessun problema', ok: true });
  }
  return [...rows.filter((row) => !row.ok), ...rows.filter((row) => row.ok)];
}

export function severityText(severity: SafetyFinding['severity']): string {
  return severity === 'suspect' ? 'Sospetto' : 'Da capire';
}

/** «riga 40 del ruolo», «riga 3 della skill scrittura-commit». */
export function whereText(finding: SafetyFinding): string {
  const where = finding.doc === 'role' ? `riga ${String(finding.line)} del ruolo` : `riga ${String(finding.line)} della skill ${finding.docName}`;
  return finding.carried === true ? `${where} · dal rapporto di prima` : where;
}

/** A line split around the words quoted, for the highlight; the whole line when they are not in it. */
export function highlight(text: string, quote: string): { before: string; mark: string; after: string } {
  const at = quote === '' ? -1 : text.indexOf(quote);
  if (at < 0) return { before: text, mark: '', after: '' };
  return { before: text.slice(0, at), mark: quote, after: text.slice(at + quote.length) };
}

const SEES: Record<string, string> = { L0: 'solo dati pubblici (L0)', L1: 'dati di lavoro (L1)' };

/** The line beside «Accendi». */
export function gateText(maxLabel: string): string {
  return `L’agente vedrà al massimo ${SEES[maxLabel] ?? maxLabel} con i permessi che hai scelto.`;
}

/**
 * What turning the agent on asks first: nothing with «nessun problema»;
 * otherwise one more confirmation, never a block.
 */
export function activationAsk(safety: SafetyView | undefined, where: 'agent' | 'new' = 'agent'): { title: string; text: string; action: string } | undefined {
  if (safety === undefined || safety.state === 'ok') return undefined;
  if (safety.state === 'warn') {
    const count = safety.report?.findings.length ?? 0;
    return {
      title: 'Accendere lo stesso?',
      text: `Il rapporto di Opus ha ${count === 1 ? '1 punto' : `${String(count)} punti`} da guardare. Se li hai letti e ti va bene così, l’agente si accende con i permessi che hai scelto; puoi spegnerlo quando vuoi.`,
      action: 'Accendi lo stesso',
    };
  }
  if (safety.state === 'running') {
    return {
      title: 'Accendere senza aspettare il rapporto?',
      text: 'Opus sta ancora leggendo il testo. Se lo accendi ora, il rapporto arriva lo stesso e lo trovi qui: se segnala qualcosa, puoi spegnerlo.',
      action: 'Accendi senza aspettare',
    };
  }
  return {
    title: 'Accendere senza rapporto?',
    text: `Nessuno ha controllato il testo di questo ruolo: leggilo tu ${where === 'new' ? 'al passo 1 («Cosa fa»)' : 'in «Scheda e prompt»'} prima di accenderlo.`,
    action: 'Accendi senza rapporto',
  };
}
