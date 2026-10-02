import { MODEL_ROLES, type ModelCatalog, type ModelRole } from './catalog.ts';
import { asOneOf, asString, asTable, ConfigError } from './validate.ts';

/** Role → catalog id. A role without a model is simply absent. */
export type Roles = Partial<Record<ModelRole, string>>;

/**
 * The router speaks of model aliases (docs/ROUTER-SPEC.md): the roles that the
 * local endpoints serve map onto them. Embedder and voice arrive with later
 * phases and have no alias yet. A test keeps these in step with @arianna/router.
 */
export const ROLE_ALIASES: Partial<Record<ModelRole, string>> = {
  orchestrator: 'local-large',
  extractor: 'local-small',
};

/** Each role names a catalog entry that lists that role among those it suits. */
export function parseRoles(value: unknown, catalog: ModelCatalog): Roles {
  if (value === undefined) return {};
  const table = asTable(value, 'roles');
  const roles: Roles = {};
  for (const [key, raw] of Object.entries(table)) {
    const role = asOneOf(key, MODEL_ROLES, 'roles');
    const id = asString(raw, `roles.${role}`);
    const entry = catalog.models.find((model) => model.id === id);
    if (entry === undefined) throw new ConfigError(`roles.${role}: ${id} is not in config/models.catalog.yaml`);
    if (!entry.roles.includes(role)) throw new ConfigError(`roles.${role}: ${id} is not suited to this role in the catalog`);
    roles[role] = id;
  }
  return roles;
}

/** Alias → model name on a local server, from the roles; the id is the name oMLX serves. */
export function aliasesOf(roles: Roles): Record<string, string> {
  const models: Record<string, string> = {};
  for (const role of MODEL_ROLES) {
    const alias = ROLE_ALIASES[role];
    const id = roles[role];
    if (alias !== undefined && id !== undefined) models[alias] = id;
  }
  return models;
}
