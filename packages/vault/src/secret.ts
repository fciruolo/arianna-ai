// A revealed secret (docs/PRIVACY-POLICY-SPEC.md, rule 6): the value is held
// in a private field and comes out only through `reveal()`, called by the code
// that uses it. Printed, interpolated, logged or serialized, a secret is its
// reference: an accidental `console.log`, template string or JSON event shows
// `vault://name`, never the value.
import { secretMatcher, type KnownSecrets } from '@arianna/policy';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

// Every value revealed in this process, with its reference; a rotated secret
// keeps its old value too. The core passes this registry to the gateway: a
// revealed value found in a payload blocks it. It lives as long as the
// process: after a restart a value is known again once it is resolved again.
const revealed = new Map<string, string>();
let matcher = secretMatcher([]);

function register(ref: string, value: string): void {
  if (revealed.has(value)) return;
  revealed.set(value, ref);
  matcher = secretMatcher([...revealed].map(([knownValue, knownRef]) => ({ ref: knownRef, value: knownValue })));
}

/** The secrets revealed so far in this process, as the gateway reads them. */
export const knownSecrets: KnownSecrets = {
  find: (text) => matcher.find(text),
};

export class Secret {
  /** `vault://name`. */
  readonly ref: string;
  readonly #value: string;

  /** Registers the value before anyone holds it, so the gateway always knows it first. */
  constructor(ref: string, value: string) {
    register(ref, value);
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
