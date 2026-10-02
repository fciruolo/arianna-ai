// The only exit (docs/PRIVACY-POLICY-SPEC.md, rules 4, 9 and 10). Pure: it
// decides, the core writes the decision to gateway_log before anything is sent.
import { canUseCloud, isContext, type Context, type Labeled } from './context.ts';
import { canSendTo, labelOrDefault, maxLabel, type Label, type Locality } from './labels.ts';
import { payloadText, scanParts } from './payload.ts';
import { scanText, type Finding } from './scanner.ts';
import type { KnownSecrets } from './secrets.ts';

export type ChannelId = 'web' | 'telegram' | 'phone';

export type Target =
  | { kind: 'executor'; id: string; locality: Locality }
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'web' };

/** Which rule decided; stored in `gateway_log.rule`. */
export type GatewayRule =
  | 'invalid-input'
  | 'secret'
  | 'contaminated'
  | 'cloud-label'
  | 'unscannable'
  | 'scanner'
  | 'local'
  | 'cloud';

/**
 * What the caller does after a block. `notify-reference`: a channel gets a
 * notice that points to the web chat instead of the content. `wait-user`: the
 * task stops in "Attende te". `stay-local`: the work stays on a local model,
 * or the user approves the exact text (declassify) and it is checked again.
 */
export type NextStep = 'notify-reference' | 'wait-user' | 'stay-local';

export type Decision =
  | {
      decision: 'allow';
      rule: 'local' | 'cloud';
      label: Label;
      reason: string;
      /** The exact text checked for each fragment, frozen: this is what is sent. */
      texts: readonly string[];
    }
  | {
      decision: 'block';
      rule: Exclude<GatewayRule, 'local' | 'cloud'>;
      label: Label;
      reason: string;
      next: NextStep;
      /** Scanner matches, without the matched text. */
      findings?: Finding[];
    };

const CHANNELS: readonly string[] = ['web', 'telegram', 'phone'];

/**
 * Executors whose inference is always in the cloud: declaring them local is a
 * bug or an attack, not a configuration. Whether any other executor is really
 * local (its endpoint in `local_endpoints`) is checked by its adapter.
 */
const CLOUD_EXECUTORS: readonly string[] = ['claude', 'codex'];

/** Runtime check: targets also come from configuration and model output. */
export function isTarget(value: unknown): value is Target {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  switch (target.kind) {
    case 'executor':
      return (
        typeof target.id === 'string' &&
        target.id !== '' &&
        (target.locality === 'local' || target.locality === 'cloud')
      );
    case 'channel':
      return CHANNELS.includes(target.id as string);
    case 'web':
      return true;
    default:
      return false;
  }
}

/**
 * Where inference or delivery happens. Only the web chat, reached over the
 * VPN, is a local channel; Telegram and the phone are cloud (D-016).
 */
export function localityOf(target: Target): Locality {
  if (target.kind === 'executor') return target.locality;
  if (target.kind === 'channel' && target.id === 'web') return 'local';
  return 'cloud';
}

/** `gateway_log.target`: e.g. `claude`, `telegram`, `web-search`. */
export function targetName(target: Target): string {
  return target.kind === 'web' ? 'web-search' : target.id;
}

function block(
  rule: Exclude<GatewayRule, 'local' | 'cloud'>,
  label: Label,
  reason: string,
  next: NextStep,
  findings?: Finding[],
): Decision {
  const decision: Decision = { decision: 'block', rule, label, reason, next };
  return findings === undefined ? decision : { ...decision, findings };
}

/**
 * Decides whether a payload may go to a target. Checks, in order:
 * 1. inputs are well formed (a context made by the policy, a known target whose
 *    locality matches what is known about it, a list of fragments);
 * 2. no fragment is L3, whatever the target;
 * 3. every fragment has a text form (text or plain JSON);
 * 4. no fragment contains the value of a secret revealed by the vault
 *    (`secrets`), whatever its label and the target;
 * 5. local targets take up to L2;
 * 6. cloud targets (cloud executors, Telegram, phone, web search) need a context
 *    that has read at most L1, a payload of at most L1, and a clean scan.
 *
 * `context` is the session the payload belongs to on the sending side: the run
 * for a brief to a cloud executor, the task for a channel message or a web query.
 * Fragments without a valid label count as L2. Reasons name labels and rules,
 * never content, so they can be logged.
 *
 * An allowed decision carries `texts`, the exact text checked for each fragment:
 * adapters send those, never a new serialization of the original values.
 *
 * `secrets` is required, so no caller can skip the check by forgetting it:
 * the core passes the vault's registry, evals and tests `secretMatcher([])` or
 * their fake values.
 */
export function gatewayCheck(
  payload: readonly Labeled<unknown>[],
  context: Context,
  target: Target,
  secrets: KnownSecrets,
): Decision {
  // Types do not hold at runtime: payloads also come from model output and JSON.
  const fragments: readonly unknown[] = payload;
  if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === 'object' && fragment !== null)) {
    return block('invalid-input', 'L2', 'payload is not a list of labeled fragments', 'stay-local');
  }
  const label = maxLabel(...payload.map((fragment) => labelOrDefault(fragment.label)));
  if (!isContext(context)) return block('invalid-input', label, 'context was not created by the policy', 'stay-local');
  if (!isTarget(target)) return block('invalid-input', label, 'unknown target', 'stay-local');
  // Types do not hold at runtime: a missing matcher must not mean "no secrets".
  if (typeof (secrets as Partial<KnownSecrets> | undefined)?.find !== 'function') {
    return block('invalid-input', label, 'the known secrets were not given', 'stay-local');
  }
  if (target.kind === 'executor' && CLOUD_EXECUTORS.includes(target.id) && target.locality !== 'cloud') {
    return block('invalid-input', label, `executor ${target.id} is a cloud executor, not ${target.locality}`, 'stay-local');
  }

  const locality = localityOf(target);
  const onBlock: NextStep = target.kind === 'channel' && locality === 'cloud' ? 'notify-reference' : 'stay-local';

  if (label === 'L3') return block('secret', label, 'L3 never leaves the vault: send a vault:// reference', onBlock);

  const texts: string[] = [];
  const parts: string[] = [];
  for (const fragment of payload) {
    const text = payloadText(fragment.value);
    if (text === undefined) {
      return block('unscannable', label, 'a fragment is not text or plain JSON', onBlock === 'notify-reference' ? onBlock : 'wait-user');
    }
    texts.push(text);
    parts.push(...scanParts(text, typeof fragment.value !== 'string'));
  }
  Object.freeze(texts);

  let refs: string[];
  try {
    refs = parts.flatMap((part) => secrets.find(part));
  } catch {
    return block('invalid-input', label, 'the known secrets could not be checked', 'stay-local');
  }
  if (refs.length > 0) {
    // References name secrets, they are not secrets: the reason can be logged.
    return block('secret', label, `payload contains the value of ${[...new Set(refs)].join(', ')}`, onBlock === 'notify-reference' ? onBlock : 'wait-user');
  }

  if (locality === 'local') {
    // L3 is out already: local targets take everything else.
    return { decision: 'allow', rule: 'local', label, reason: `${label} to a local target`, texts };
  }

  if (!canUseCloud(context)) {
    return block('contaminated', label, `the session has read ${context.effective}: it stays local`, onBlock);
  }
  if (!canSendTo('cloud', label)) {
    return block('cloud-label', label, `${label} cannot go to a cloud target; at most L1`, onBlock);
  }

  const findings = parts.flatMap((part) => scanText(part));
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    return block('scanner', label, `scanner matched: ${kinds}`, onBlock === 'notify-reference' ? onBlock : 'wait-user', findings);
  }

  return { decision: 'allow', rule: 'cloud', label, reason: `${label} to a cloud target, scan clean`, texts };
}
