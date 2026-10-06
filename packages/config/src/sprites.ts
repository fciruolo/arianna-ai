import { asOneOf, asTable, onlyKeys } from './validate.ts';

/**
 * The model that draws an agent's character (D-123): Claude Sonnet, Claude
 * Opus or the local model (`local-large`). Not a privacy setting: Claude must
 * already be on in `[cloud] executors` and in `[cloud.models]`.
 */
export const SPRITE_MODELS = ['sonnet', 'opus', 'local'] as const;
export type SpriteModel = (typeof SPRITE_MODELS)[number];

/** Without `[sprites]`: Claude Opus (D-132; Sonnet before). */
export const DEFAULT_SPRITE_MODEL: SpriteModel = 'opus';

/** `[sprites]` of arianna.toml: `model` only. */
export interface SpritesConfig {
  model: SpriteModel;
}

export function parseSprites(value: unknown): SpritesConfig {
  if (value === undefined) return { model: DEFAULT_SPRITE_MODEL };
  const table = asTable(value, 'sprites');
  onlyKeys(table, ['model'], 'sprites');
  return { model: table.model === undefined ? DEFAULT_SPRITE_MODEL : asOneOf(table.model, SPRITE_MODELS, 'sprites.model') };
}
