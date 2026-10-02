// A revealed secret (docs/PRIVACY-POLICY-SPEC.md, rule 6): the value is held
// in a private field and comes out only through `reveal()`, called by the code
// that uses it. Printed, interpolated, logged or serialized, a secret is its
// reference: an accidental `console.log`, template string or JSON event shows
// `vault://name`, never the value.
import { secretMatcher, type KnownSecrets } from '@arianna/policy';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  /** `vault://name`. */
  readonly ref: string;
  readonly #value: string;

  constructor(ref: string, value: string) {
    this.ref = ref;
    this.#value = value;
    Object.freeze(this);
  }

  /** The value, for the code that uses it (a header, a connection). Never for a prompt or a log. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return this.ref;
  }

  toJSON(): string {
    return this.ref;
  }

  [INSPECT](): string {
    return `Secret(${this.ref})`;
  }
}

// Every value revealed in this process, with its reference; a rotated secret
// keeps its old value too. The core passes this registry to the gateway: a
// revealed value found in a payload blocks it.
const revealed = new Map<string, string>();
let matcher = secretMatcher([]);

/** The secrets revealed so far in this process, as the gateway reads them. */
export const knownSecrets: KnownSecrets = {
  find: (text) => matcher.find(text),
};

/** Registers the value before handing it out, so the gateway knows it first. */
export function revealSecret(ref: string, value: string): Secret {
  if (!revealed.has(value)) {
    revealed.set(value, ref);
    matcher = secretMatcher([...revealed].map(([knownValue, knownRef]) => ({ ref: knownRef, value: knownValue })));
  }
  return new Secret(ref, value);
}
