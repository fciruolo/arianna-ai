/**
 * Who reads each rule of a project (I-14, D-181): every item of a list at the
 * top level is one rule, for both executors unless it starts with the mark
 * `[solo Claude Code]` or `[solo Codex]`. The same marks the core reads in
 * `rulesFor` of @arianna/config: the delegation and the export leave an item
 * out for the other executor. The mark is plain text in the rules, so the
 * template of Settings can use it too.
 */

export type RuleAudience = 'both' | 'claude' | 'codex';

export const AUDIENCE_TEXT: Record<RuleAudience, string> = {
  both: 'Entrambi',
  claude: 'Solo Claude Code',
  codex: 'Solo Codex',
};

const MARK_TEXT: Record<Exclude<RuleAudience, 'both'>, string> = { claude: '[solo Claude Code] ', codex: '[solo Codex] ' };

// The same rules as `ruleLines` of packages/config/src/project-rules.ts: change both together.
const RULE_ITEM = /^( {0,3})([-*+]|\d{1,3}[.)])([ \t]+)(.*)$/;
const RULE_MARK = /^\[solo (claude code|codex)\][ \t]*/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface RuleItem {
  /** The line of the item in the text, from 0. */
  line: number;
  /** The rule without its mark. */
  text: string;
  audience: RuleAudience;
}

/**
 * The rules of a text: its top-level list items, each with who reads it. The
 * lines indented under an item (sub-items too) belong to it and follow it; a
 * fenced code block is never a rule.
 */
export function ruleItems(text: string): RuleItem[] {
  const items: RuleItem[] = [];
  let open: number | undefined;
  let fence: string | undefined;
  for (const [line, value] of text.split(/\r?\n/).entries()) {
    if (fence !== undefined) {
      if (value.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    const width = value.length - value.trimStart().length;
    const opening = FENCE.exec(value);
    if (open !== undefined && (value.trim() === '' || width > open)) {
      if (opening !== null && value.trim() !== '') fence = (opening[1] ?? '```').slice(0, 3);
      continue;
    }
    open = undefined;
    if (opening !== null) {
      fence = (opening[1] ?? '```').slice(0, 3);
      continue;
    }
    const item = RULE_ITEM.exec(value);
    if (item === null) continue;
    open = (item[1] ?? '').length;
    const rest = item[4] ?? '';
    const mark = RULE_MARK.exec(rest);
    if (mark === null) items.push({ line, text: rest, audience: 'both' });
    else items.push({ line, text: rest.slice(mark[0].length), audience: mark[1]?.toLowerCase() === 'codex' ? 'codex' : 'claude' });
  }
  return items;
}

/** The text with the item at `line` for `audience`: its mark written, changed or removed; anything else as it was. */
export function withAudience(text: string, line: number, audience: RuleAudience): string {
  const lines = text.split('\n');
  const raw = lines[line] ?? '';
  // A CRLF text keeps its line ends.
  const end = raw.endsWith('\r') ? '\r' : '';
  const item = RULE_ITEM.exec(end === '' ? raw : raw.slice(0, -1));
  if (item === null) return text;
  const rest = (item[4] ?? '').replace(RULE_MARK, '');
  lines[line] = `${item[1] ?? ''}${item[2] ?? ''}${item[3] ?? ''}${audience === 'both' ? '' : MARK_TEXT[audience]}${rest}${end}`;
  return lines.join('\n');
}
