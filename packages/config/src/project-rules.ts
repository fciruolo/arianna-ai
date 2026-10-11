import { PROJECT_NAME } from './projects.ts';
import { asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * The rules of the projects (I-14, D-174): `[project_rules]` of arianna.toml.
 * `template` is the common model the user writes once in Settings; a line of
 * `[project_rules.projects]` gives a project its own rules instead (an empty
 * text: no rules for that project). Free text of the user, L1 by declaration
 * like a persona (D-107): Arianna puts it at the head of every delegation on
 * the project (an item marked `[solo Claude Code]` or `[solo Codex]` only to that executor, D-181), and it passes the gateway.
 * Written only by the user (Settings, the page Progetti, by hand), never by an
 * agent. A project not in the list follows the template.
 */
export interface ProjectRules {
  template?: string;
  /** Project name → its own rules. */
  projects: Record<string, string>;
}

export const MAX_PROJECT_RULES = 4000;

function rulesText(value: unknown, where: string): string {
  // An empty text is meaningful: a project with no rules.
  if (typeof value !== 'string') throw new ConfigError(`${where}: expected a string`);
  const text = value;
  if (text.length > MAX_PROJECT_RULES) throw new ConfigError(`${where}: at most ${String(MAX_PROJECT_RULES)} characters`);
  // Tabs and line breaks are text; any other control character is not.
  if (/[\p{Cc}--[\t\n\r]]/v.test(text)) throw new ConfigError(`${where}: no control characters`);
  return text;
}

export function parseProjectRules(value: unknown): ProjectRules {
  if (value === undefined) return { projects: {} };
  const table = asTable(value, 'project_rules');
  onlyKeys(table, ['template', 'projects'], 'project_rules');
  const projects: Record<string, string> = {};
  if (table.projects !== undefined) {
    for (const [name, text] of Object.entries(asTable(table.projects, 'project_rules.projects'))) {
      // A project name, as in [[project]]: `__proto__` and the like never match.
      if (!PROJECT_NAME.test(name)) throw new ConfigError('project_rules.projects: a project name is lowercase letters, digits and dashes');
      projects[name] = rulesText(text, `project_rules.projects.${name}`);
    }
  }
  return { ...(table.template === undefined ? {} : { template: rulesText(table.template, 'project_rules.template') }), projects };
}

/**
 * The rules a delegation on `project` reads: its own when it has a line, the
 * template otherwise; undefined when there is no text (blank included).
 */
export function rulesOfProject(rules: ProjectRules, project: string): string | undefined {
  const text = Object.hasOwn(rules.projects, project) ? rules.projects[project] : rules.template;
  return text === undefined || text.trim() === '' ? undefined : text.trim();
}

/** Who reads a rule (I-14, D-181): both executors, or only one. */
export type RuleAudience = 'both' | 'claude' | 'codex';

/**
 * A rule: a line at the margin (up to three spaces), with or without a list
 * marker (`- `, `* `, `+ `, `1. `), that is not a heading.
 * The chat reads the same marks with a copy of these rules
 * (apps/hud/src/lib/rule-audience.ts): change both together.
 */
const RULE_ITEM = /^( {0,3})((?:[-*+]|\d{1,3}[.)])[ \t]+)?(?!#)(\S.*)$/;
/** The mark at the head of an item that keeps it for one executor: `[solo Claude Code]`, `[solo Codex]`. */
const RULE_MARK = /^\[solo (claude code|codex)\][ \t]*/i;
/** A fenced code block opens or closes: its lines are text, never rules. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The audience of the text of one list item, and the item without its mark. */
export function ruleAudience(item: string): { audience: RuleAudience; text: string } {
  const mark = RULE_MARK.exec(item);
  if (mark === null) return { audience: 'both', text: item };
  return { audience: mark[1]?.toLowerCase() === 'codex' ? 'codex' : 'claude', text: item.slice(mark[0].length) };
}

/** One line of the rules as the two readers walk them: a rule, a line that belongs to the rule above, or other text. */
export type RuleLine = { kind: 'rule'; audience: RuleAudience; text: string } | { kind: 'inside' } | { kind: 'text' };

/**
 * The lines of the rules, classified (D-181): each line at the margin is a
 * rule, a list item or not; the lines indented under it (sub-items, more
 * text, a code block) are inside it and follow it; headings, blank lines and
 * a fenced code block outside any rule are text. Line breaks CRLF or LF.
 */
export function ruleLines(text: string): { line: string; is: RuleLine }[] {
  const out: { line: string; is: RuleLine }[] = [];
  let open: number | undefined;
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (fence !== undefined) {
      out.push({ line, is: open === undefined ? { kind: 'text' } : { kind: 'inside' } });
      if (line.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    const width = line.length - line.trimStart().length;
    const opening = FENCE.exec(line);
    if (open !== undefined && (line.trim() === '' || width > open)) {
      if (opening !== null && line.trim() !== '') fence = (opening[1] ?? '```').slice(0, 3);
      out.push({ line, is: { kind: 'inside' } });
      continue;
    }
    open = undefined;
    if (opening !== null) {
      fence = (opening[1] ?? '```').slice(0, 3);
      out.push({ line, is: { kind: 'text' } });
      continue;
    }
    const item = RULE_ITEM.exec(line);
    if (item === null) {
      out.push({ line, is: { kind: 'text' } });
      continue;
    }
    open = (item[1] ?? '').length;
    const { audience, text: rest } = ruleAudience(item[3] ?? '');
    out.push({ line: `${item[1] ?? ''}${item[2] ?? ''}${rest}`, is: { kind: 'rule', audience, text: rest } });
  }
  return out;
}

/**
 * The rules as one executor reads them (D-181): the items marked for the other
 * one left out, with everything under them; the marks removed. Every other
 * line (headings, paragraphs, code blocks) is for both. Undefined when nothing
 * is left.
 */
export function rulesFor(text: string, executor: 'claude' | 'codex'): string | undefined {
  const kept: string[] = [];
  let skipping = false;
  for (const { line, is } of ruleLines(text)) {
    if (is.kind === 'rule') skipping = is.audience !== 'both' && is.audience !== executor;
    else if (is.kind === 'text') skipping = false;
    // A blank line inside a left-out rule is kept: the lines collapse below.
    if (!skipping || line.trim() === '') kept.push(line);
  }
  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return result === '' ? undefined : result;
}
