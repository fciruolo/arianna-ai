/**
 * The marks of a card proposed from the catalog of agents (D-079), in a
 * module of their own: `user.ts` reads them to recognise a third party's
 * card, and `agency.ts` checks its proposals with `user.ts`, so neither
 * imports the other in a cycle.
 */

/** The first source suggested, and the repository of the cards proposed before the catalog. */
export const AGENCY_REPOSITORY = 'https://github.com/msitarzewski/agency-agents';

/** The first line of a card proposed from the catalog: such a card stays at L0, its prompt is a third party's (D-119, tappa T3b). */
export const AGENCY_CARD_MARK = '# Proposed from the catalog of agents (D-079)';

/** The first line of the cards proposed by `pnpm agency:import`, before the catalog (2026-10-05 to 2026-10-13): still a third party's card. */
export const LEGACY_AGENCY_CARD_MARK = '# Proposed by pnpm agency:import (D-079)';

/** Every first line a card of a third party may start with. */
export const THIRD_PARTY_CARD_MARKS: readonly string[] = [AGENCY_CARD_MARK, LEGACY_AGENCY_CARD_MARK];

/** The provenance line of a proposal: `# Source: <page>, commit <40 hex>, file <path>`. */
const SOURCE_LINE = /^# Source: \S+, commit [0-9a-f]{7,40}, file /;

/**
 * Whether one comment line of a card's header says its prompt is a third
 * party's: a mark (new or old), the old command, the old repository, or the
 * provenance line of a proposal. Any one of them is enough: a card whose
 * first line was removed by hand still holds a third party's prompt.
 */
export function isThirdPartyLine(line: string): boolean {
  return THIRD_PARTY_CARD_MARKS.some((mark) => line.startsWith(mark)) || line.includes('pnpm agency:import') || line.includes(AGENCY_REPOSITORY) || SOURCE_LINE.test(line);
}
