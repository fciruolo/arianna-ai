import { asString, asTable, ConfigError } from './validate.ts';

/**
 * Which pixel character each agent wears (D-060): `[characters]` of
 * arianna.toml, agent id → "<pack>/<character>". The packs are folders of
 * data/characters/ copied by the user, plus the originals in git. Cosmetic: it
 * applies without a restart, and a pack that is missing falls back to the
 * originals when the core serves the sheet.
 */
export type CharacterChoices = Record<string, string>;

/** A pack folder or a character id: lowercase, digits, `-` and `_`. */
export const CHARACTER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The pack of the originals, in git: no folder of data/characters may take its name. */
export const ORIGINAL_PACK = 'originali';

export function parseCharacters(value: unknown): CharacterChoices {
  if (value === undefined) return {};
  const table = asTable(value, 'characters');
  const choices: CharacterChoices = {};
  for (const [agent, raw] of Object.entries(table)) {
    const where = `characters.${agent}`;
    if (!CHARACTER_ID.test(agent)) throw new ConfigError(`${where}: an agent id is lowercase letters, digits, - and _`);
    const choice = asString(raw, where);
    const [pack, character, ...rest] = choice.split('/');
    if (pack === undefined || character === undefined || rest.length > 0 || !CHARACTER_ID.test(pack) || !CHARACTER_ID.test(character)) {
      throw new ConfigError(`${where}: expected "<pack>/<character>", e.g. "${ORIGINAL_PACK}/${agent}"`);
    }
    choices[agent] = choice;
  }
  return choices;
}
