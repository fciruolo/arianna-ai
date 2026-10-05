import { randomUUID } from 'node:crypto';

import type { Persona } from '@arianna/agents';
import type { AriannaConfig, SpriteModel } from '@arianna/config';
import { ClaudeError, LocalModelError, prepareEmptyWorkspace, removeWorkspace, type ClaudeExecutor, type LocalModel } from '@arianna/executors';
import { createContext, scanText, type Context, type Decision, type Labeled, type Target } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { spriteBrief, SUBJECT_LABEL, type SpriteSubject } from './prompt.ts';
import { readSpriteReply, SPRITE_SCHEMA, SpriteSpecError, spriteSheet } from './spec.ts';

/**
 * "Genera personaggio" (D-123): the brief through the gateway, the model of
 * `[sprites]` (Claude through packages/executors, with no tool in an empty
 * folder, or the local model with the schema), the answer checked and turned
 * into a sheet. Nothing is written: the page keeps the PNG with the upload
 * of D-118. One drawing at a time.
 */
export const SPRITE_LOCAL_ALIAS = 'local-large';
const CLAUDE_TIMEOUT_MS = 4 * 60_000;
const CLAUDE_MAX_TURNS = 3;
const LOCAL_TIMEOUT_MS = 5 * 60_000;
const LOCAL_MAX_TOKENS = 6000;
export const MAX_NAME = 40;
export const MAX_DESCRIPTION = 200;
export const MAX_PROMPT = 4000;
export const MAX_HINT = 300;
/** What leaves towards the model, by field: the page shows it. */
export const SPRITE_SENDS = ['name', 'description', 'prompt', 'tone', 'specialization', 'hint'] as const;

export type SpriteErrorCode = 'invalid' | 'unavailable' | 'busy' | 'blocked' | 'quota' | 'failed' | 'bad-reply';

export class SpriteError extends Error {
  override name = 'SpriteError';
  readonly code: SpriteErrorCode;
  readonly resetsAt: Date | undefined;

  constructor(code: SpriteErrorCode, message: string, resetsAt?: Date) {
    super(message);
    this.code = code;
    this.resetsAt = resetsAt;
  }
}

/** The gateway as the core uses it (passGateway: decision plus its row in gateway_log). */
export type SpriteGateway = (payload: readonly Labeled<unknown>[], context: Context, target: Target, meta: { summary?: string }) => Promise<Decision>;

export interface SpriteGeneratorOptions {
  /** `[sprites] model`, read at each request. */
  model: () => SpriteModel;
  /** Why this model cannot draw now (Claude off, no local server); undefined when it can. */
  unavailable: (model: SpriteModel) => string | undefined;
  claude?: ClaudeExecutor | undefined;
  localModel: () => LocalModel;
  /** `[personas.<name>]`, if any. */
  persona: (name: string) => Pick<Persona, 'tone' | 'specialization'> | undefined;
  gateway: SpriteGateway;
  /** data/: the empty folder of a Claude run goes in data/worktrees. */
  dataDir: string;
}

export interface SpriteInfo {
  model: SpriteModel;
  available: boolean;
  reason: string | null;
  sends: readonly string[];
}

export interface SpriteResult {
  png: Buffer;
  rows: 4;
  model: SpriteModel;
  label: typeof SUBJECT_LABEL;
}

export interface SpriteGenerator {
  info(): SpriteInfo;
  generate(body: Record<string, unknown>, signal?: AbortSignal): Promise<SpriteResult>;
}

/**
 * Why the model of `[sprites]` cannot draw now, in the words the page shows;
 * undefined when it can. Never another model in its place: the user chose it.
 */
export function spriteUnavailable(config: Pick<AriannaConfig, 'sprites' | 'cloud' | 'local'>, claudeRuns: boolean): string | undefined {
  const { model } = config.sprites;
  if (model === 'local') {
    return config.local.endpoints.some((endpoint) => endpoint.models[SPRITE_LOCAL_ALIAS] !== undefined)
      ? undefined
      : `no local server serves ${SPRITE_LOCAL_ALIAS} (the orchestrator of [roles])`;
  }
  if (!config.cloud.executors.includes('claude')) return 'claude is not on in [cloud] executors';
  if (!config.cloud.models[model].enabled) return `${model} is off in [cloud.models]`;
  if (!claudeRuns) return 'claude cannot run on this installation (sandbox refused)';
  return undefined;
}

/**
 * The user's text is L1 by declaration and may reach Claude: as for the
 * texts of the user's agents (D-119), a finding of the scanner or a value of
 * the vault refuses it, naming the field and the kind, never the text.
 */
function checkText(text: string, field: string): void {
  const kinds = [...new Set(scanText(text).map((finding) => finding.kind))];
  if (kinds.length > 0) throw new SpriteError('invalid', `${field} looks like personal data or a secret (${kinds.join(', ')}): not sent`);
  if (knownSecrets.find(text).length > 0) throw new SpriteError('invalid', `${field} holds a value of the vault: not sent`);
}

function field(body: Record<string, unknown>, key: string, max: number, required: boolean, oneLine: boolean): string {
  const value = body[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new SpriteError('invalid', `${key}: text`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw new SpriteError('invalid', `${key}: required`);
  if (trimmed.length > max) throw new SpriteError('invalid', `${key}: at most ${String(max)} characters`);
  if (oneLine && /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) throw new SpriteError('invalid', `${key}: one line`);
  checkText(trimmed, key);
  return trimmed;
}

/** `{ name, description, prompt?, hint? }` and nothing else. */
export function parseSpriteRequest(body: Record<string, unknown>): SpriteSubject {
  const unknown = Object.keys(body).filter((key) => !['name', 'description', 'prompt', 'hint'].includes(key));
  if (unknown.length > 0) throw new SpriteError('invalid', `unknown field(s): ${unknown.join(', ')}`);
  return {
    name: field(body, 'name', MAX_NAME, true, true),
    description: field(body, 'description', MAX_DESCRIPTION, true, true),
    prompt: field(body, 'prompt', MAX_PROMPT, false, false),
    hint: field(body, 'hint', MAX_HINT, false, false),
  };
}

export function createSpriteGenerator(options: SpriteGeneratorOptions): SpriteGenerator {
  let running = false;

  async function askClaude(model: 'sonnet' | 'opus', payload: Labeled<unknown>[], signal: AbortSignal | undefined): Promise<string> {
    const claude = options.claude;
    if (claude === undefined) throw new SpriteError('unavailable', 'claude cannot run on this installation');
    const folder = { data: options.dataDir, runId: randomUUID() };
    const workspace = await prepareEmptyWorkspace(folder);
    try {
      const launch = { workspace, model, tools: [], limits: { maxTurns: CLAUDE_MAX_TURNS, timeoutMs: CLAUDE_TIMEOUT_MS } };
      // Before the gateway: no allow is logged for a run that cannot start.
      await claude.check(launch);
      const decision = await options.gateway(payload, createContext('L1', SUBJECT_LABEL), { kind: 'executor', id: 'claude', locality: 'cloud' }, { summary: `character drawn by claude/${model}` });
      if (decision.decision === 'block') throw new SpriteError('blocked', `the gateway refused the brief for Claude: ${decision.reason}`);
      const run = claude.start({ ...launch, brief: decision, ...(signal === undefined ? {} : { signal }) });
      return (await run.result).text;
    } catch (error) {
      if (!(error instanceof ClaudeError)) throw error;
      if (error.kind === 'not-enabled') throw new SpriteError('unavailable', 'claude is not on in [cloud] executors');
      if (error.kind === 'quota' || error.kind === 'overage') throw new SpriteError('quota', 'claude is out of quota', error.resetsAt);
      throw new SpriteError('failed', `claude: ${error.kind}`);
    } finally {
      await removeWorkspace(folder).catch(() => undefined);
    }
  }

  async function askLocal(payload: Labeled<unknown>[], signal: AbortSignal | undefined): Promise<unknown> {
    const decision = await options.gateway(payload, createContext('L2', SUBJECT_LABEL), { kind: 'executor', id: 'local', locality: 'local' }, { summary: 'character drawn by the local model' });
    if (decision.decision === 'block') throw new SpriteError('blocked', `the gateway refused the brief: ${decision.reason}`);
    const [system = '', ...rest] = decision.texts;
    try {
      const result = await options.localModel().chat({
        model: SPRITE_LOCAL_ALIAS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: rest.join('\n\n') },
        ],
        schema: { name: 'sprite', schema: SPRITE_SCHEMA },
        temperature: 0.7,
        maxTokens: LOCAL_MAX_TOKENS,
        timeoutMs: LOCAL_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      return result.value ?? result.text;
    } catch (error) {
      if (error instanceof LocalModelError) {
        if (error.kind === 'bad-response') throw new SpriteError('bad-reply', 'the local model did not answer with JSON');
        throw new SpriteError(error.kind === 'unavailable' || error.kind === 'no-endpoint' ? 'unavailable' : 'failed', `local model: ${error.kind}`);
      }
      throw error;
    }
  }

  return {
    info() {
      const model = options.model();
      const reason = options.unavailable(model);
      return { model, available: reason === undefined, reason: reason ?? null, sends: SPRITE_SENDS };
    },

    async generate(body, signal) {
      const subject = parseSpriteRequest(body);
      const model = options.model();
      const reason = options.unavailable(model);
      if (reason !== undefined) throw new SpriteError('unavailable', reason);
      if (running) throw new SpriteError('busy', 'a character is being drawn already');
      running = true;
      try {
        const brief = spriteBrief(subject, options.persona(subject.name));
        const payload = brief.map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source }));
        const reply = model === 'local' ? await askLocal(payload, signal) : await askClaude(model, payload, signal);
        let sheet;
        try {
          sheet = spriteSheet(readSpriteReply(reply));
        } catch (error) {
          if (error instanceof SpriteSpecError) throw new SpriteError('bad-reply', `the drawing is not valid: ${error.message}`);
          throw error;
        }
        // The output inherits the highest label of what went in: the agent's texts, L1 (never above: the brief holds nothing else).
        return { png: sheet.png, rows: sheet.rows, model, label: SUBJECT_LABEL };
      } finally {
        running = false;
      }
    },
  };
}
