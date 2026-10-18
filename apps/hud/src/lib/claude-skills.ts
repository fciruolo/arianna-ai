/**
 * The user's own skills of Claude Code in Impostazioni → Skill e stili
 * (D-255): the shapes the core gives (claude-skills.ts) and the texts of the
 * card. Each skill is private (L2) until the user marks it shareable (L1):
 * a private one reaches only the agents that work on this computer.
 */
import { ApiError } from './api.ts';
import { dayText } from './design-catalog.ts';
import { errorText } from './italian.ts';
import { skillLicenseText, type SkillSummary } from './skills-catalog.ts';

/** The id of the source of the user's own skills, as the core names it. */
export const CLAUDE_SOURCE = 'local/claude-code';

export interface ClaudeSkill {
  /** `local/claude-code/<slug>`. */
  id: string;
  slug: string;
  name: string;
  description: string;
  license: string | null;
  otherFiles: number;
  /** The text the card shows: sent back when the user marks it shareable. */
  sha256: string;
  label: 'L1' | 'L2';
}

export interface ClaudeSkillsStatus {
  imported: boolean;
  importedAt: string | null;
  skills: ClaudeSkill[];
  rejected: { path: string; reason: string }[];
}

export function isOwnSkill(skill: Pick<SkillSummary, 'source'>): boolean {
  return skill.source === CLAUDE_SOURCE;
}

/** The skills a Designer in the cloud may be given (the Studio, a Designer card): a private skill of the user's own is left out (D-255). */
export function cloudSkills<T extends Pick<SkillSummary, 'source'> & { label?: string }>(skills: readonly T[]): T[] {
  return skills.filter((skill) => !isOwnSkill(skill) || skill.label === 'L1');
}

/** The main button: «Importa» the first time, then «Aggiorna». */
export function importButtonText(status: ClaudeSkillsStatus | null, busy: boolean): string {
  if (busy) return 'Leggo la cartella…';
  return status?.imported === true ? 'Aggiorna' : 'Importa le mie skill';
}

/** One line under the title: how many, how many shareable, when. */
export function claudeSummaryText(status: ClaudeSkillsStatus): string {
  if (!status.imported) return 'Non ancora importate.';
  const total = status.skills.length;
  const shared = status.skills.filter((skill) => skill.label === 'L1').length;
  const day = dayText(status.importedAt);
  const count = total === 1 ? '1 skill' : `${String(total)} skill`;
  const sharedText = shared === 0 ? 'tutte private' : shared === total ? 'tutte condivisibili col cloud' : `${String(shared)} condivisibili col cloud`;
  return `${count} · ${total === 0 ? 'nessuna' : sharedText}${day === null ? '' : ` · copiate il ${day}`}`;
}

/** The label of a skill of the user's own as the page says it. */
export function claudeLabelText(label: 'L1' | 'L2'): string {
  return label === 'L1' ? 'Condivisibile: arriva anche agli agenti nel cloud (Claude, Codex)' : 'Privata: arriva solo agli agenti che lavorano su questo computer';
}

/** Under a skill in the pickers of an agent: the license for a catalog skill, the origin and the label for one of the user's own. */
export function skillOriginText(skill: Pick<SkillSummary, 'source' | 'license'> & { label?: string }): string {
  if (!isOwnSkill(skill)) return skillLicenseText(skill.license);
  return skill.label === 'L1' ? 'Tua, da Claude Code · condivisibile col cloud' : 'Tua, da Claude Code · privata: solo agenti su questo computer';
}

/** A folder left out at the import, in Italian (the reasons of the core are in English). */
export function rejectedText(item: { path: string; reason: string }): string {
  const reason = /symbolic link/.test(item.reason)
    ? 'collegamento simbolico, non letto'
    : /no SKILL\.md/.test(item.reason)
      ? 'senza SKILL.md'
      : /no frontmatter/.test(item.reason)
        ? 'SKILL.md senza intestazione (name, description)'
        : /larger than/.test(item.reason)
          ? 'SKILL.md troppo grande'
          : /unusual characters/.test(item.reason)
            ? 'nome con spazi o caratteri insoliti'
            : /same slug/.test(item.reason)
              ? 'stesso nome di un’altra skill'
              : 'non letta';
  return `${item.path}: ${reason}`;
}

const REFUSALS: [RegExp, string][] = [
  [/^no skills folder/, 'Non trovo la cartella skills nella configurazione di Claude Code.'],
  [/^the skills folder of Claude Code is a symbolic link/, 'La cartella skills di Claude Code è un collegamento simbolico: per prudenza non la leggo.'],
  [/^CLAUDE_CONFIG_DIR is not an absolute path/, 'CLAUDE_CONFIG_DIR non è un percorso assoluto.'],
  [/^your skills of Claude Code are being changed by another process/, 'Le tue skill sono occupate da un altro processo (per esempio pnpm skills:catalog): riprova.'],
  [/^more than .* skills/, 'Troppe skill nella cartella: non ho copiato nulla.'],
  [/^no such skill among yours/, 'Questa skill non c’è più: premi «Aggiorna».'],
  [/^the skill changed since you read it/, 'La skill è cambiata da quando l’hai letta: riaprila e rileggila prima di renderla condivisibile.'],
];

export function claudeErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) if (pattern.test(cause.message)) return text;
    if (cause.status === 404 && cause.message === 'not found') return 'Questa versione di Arianna non importa le skill di Claude Code: riavviala dopo l’aggiornamento.';
  }
  return errorText(cause);
}
