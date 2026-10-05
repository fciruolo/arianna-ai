/**
 * The marks of the agency-agents importer (D-079), in a module of their own:
 * `user.ts` reads them to recognise a third party's card, and `agency.ts`
 * checks its proposals with `user.ts`, so neither imports the other in a cycle.
 */

export const AGENCY_REPOSITORY = 'https://github.com/msitarzewski/agency-agents';

/** The first line of a card proposed by the importer: such a card stays at L0, its prompt is a third party's (D-119, tappa T3b). */
export const AGENCY_CARD_MARK = '# Proposed by pnpm agency:import (D-079)';
