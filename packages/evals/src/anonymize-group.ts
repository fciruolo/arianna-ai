import { anonymize, anonymizeInput, type LocalModel } from '@arianna/executors';

import type { EvalGroup } from './types.ts';

/**
 * The anonymous version of a private note (I-11 P5, D-187), on the local
 * model, with the prompt the core uses. A case passes when none of the
 * identifying details is left (`avoids`, case ignored) and the technical
 * content the note is for is still there (`keeps`). It only proposes: the
 * user reads and corrects the text before it leaves.
 */
export interface AnonymizeExpectation {
  avoids: string[];
  keeps: string[];
}

export interface AnonymizeActual {
  ok: boolean;
  text?: string;
  reason?: string;
}

/** Spaces as the model may write them, case ignored. */
function plain(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, ' ').toLowerCase();
}

export function matchesAnonymous(actual: unknown, expect: unknown): boolean {
  const result = actual as AnonymizeActual;
  if (!result.ok || typeof result.text !== 'string') return false;
  const { avoids, keeps } = expect as AnonymizeExpectation;
  const text = plain(result.text);
  return avoids.every((item) => !text.includes(plain(item))) && keeps.every((item) => text.includes(plain(item)));
}

export function createAnonymizeGroup(model: () => LocalModel): EvalGroup {
  return {
    name: 'anonymize',
    tier: 'models',
    threshold: 0.85,
    strictTags: [],
    compare: matchesAnonymous,
    measures: [{ name: 'schema', threshold: 1, excludeErrors: true, passed: (result) => (result.actual as AnonymizeActual | undefined)?.ok === true }],
    subject: {
      status: 'active',
      evaluate: async (input, signal) => {
        const { note } = input as { note: string };
        const outcome = await anonymize(model(), anonymizeInput(note), signal === undefined ? {} : { signal });
        return outcome.ok ? { ok: true, text: outcome.text } : { ok: false, reason: outcome.reason };
      },
    },
  };
}
