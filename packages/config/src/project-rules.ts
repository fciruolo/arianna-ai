import { PROJECT_NAME } from './projects.ts';
import { asTable, ConfigError, onlyKeys } from './validate.ts';

/**
 * The rules of the projects (I-14, D-174): `[project_rules]` of arianna.toml.
 * `template` is the common model the user writes once in Settings; a line of
 * `[project_rules.projects]` gives a project its own rules instead (an empty
 * text: no rules for that project). Free text of the user, L1 by declaration
 * like a persona (D-107): Arianna puts it at the head of every delegation on
 * the project, the same for Claude and for Codex, and it passes the gateway.
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
