// The only exit (docs/PRIVACY-POLICY-SPEC.md, rules 4, 9 and 10). Pure: it
// decides, the core writes the decision to gateway_log before anything is sent.
import { canUseCloud, isContext, type Context, type Labeled } from './context.ts';
import { canSendTo, labelOrDefault, maxLabel, type Label, type Locality } from './labels.ts';
import { payloadText, scanParts } from './payload.ts';
import { scanText, type Finding } from './scanner.ts';
import type { KnownSecrets } from './secrets.ts';

// `voice`: a call from the web chat to apps/voice, on this machine (D-066);
// `push`: the notification of a call, through Apple, Google or Mozilla.
export type ChannelId = 'web' | 'telegram' | 'phone' | 'voice' | 'push';

/**
 * Why the user allowed a link to be downloaded (D-154): its site is in
 * `[capture] fetch_sites` (`list`), or the user pressed "Scarica e riassumi"
 * on that note (`click`).
 */
export type LinkConsent = 'list' | 'click';

export type Target =
  | { kind: 'executor'; id: string; locality: Locality }
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'web' }
  /**
   * The address of a link saved by the user, to its own site (D-154). With
   * `list`, `sites` are the sites of the list the caller read: the address
   * must be on one of them (or a subdomain). The consent is declared by the
   * caller (only organize.ts, for the url the capture code wrote): what the
   * gateway guarantees is one address, checked and scanned, never other text.
   */
  | { kind: 'link'; consent: 'list'; sites: readonly string[] }
  | { kind: 'link'; consent: 'click' };

/** Which rule decided; stored in `gateway_log.rule`. */
export type GatewayRule =
  | 'invalid-input'
  | 'secret'
  | 'contaminated'
  | 'cloud-label'
  | 'unscannable'
  | 'scanner'
  | 'link-invalid'
  | 'local'
  | 'cloud'
  | 'link';

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
      rule: 'local' | 'cloud' | 'link';
      label: Label;
      reason: string;
      /** The exact text checked for each fragment, frozen: this is what is sent. */
      texts: readonly string[];
    }
  | {
      decision: 'block';
      rule: Exclude<GatewayRule, 'local' | 'cloud' | 'link'>;
      label: Label;
      reason: string;
      next: NextStep;
      /** Scanner matches, without the matched text. */
      findings?: Finding[];
    };

const CHANNELS: readonly string[] = ['web', 'telegram', 'phone', 'voice', 'push'];
/** Sites a `list` consent may name (the list of arianna.toml holds 100 at most, plus publish.twitter.com). */
const MAX_LINK_SITES = 200;
const MAX_LINK = 2_000;
const X_HOSTS = ['x.com', 'twitter.com', 'publish.twitter.com'];

/**
 * The address of a link as the scanner reads it: the numeric id of a post of
 * X, alone or inside the oEmbed address, is masked, since a post id passes the
 * card check (Luhn) about once in ten. Everything else of the address is read.
 */
export function linkScanText(address: string): string {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
  } catch {
    return address;
  }
  if (!X_HOSTS.includes(host)) return address;
  return address.replace(/(status(?:\/|%2F))\d{1,25}/gi, (_match, prefix: string) => `${prefix}0`);
}

/** A host name of the list: lowercase, at least two labels, no scheme, port or path (`com` would cover every .com site). */
function isSiteName(site: string): boolean {
  if (site.length > 253) return false;
  const labels = site.split('.');
  return labels.length >= 2 && labels.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) && !/^\d+$/.test(labels.at(-1) ?? '');
}

/** A link target allows one address only: http(s), normalized, no credentials, no space; with `list`, on a site of the list. */
function checkLink(payload: readonly Labeled<unknown>[], texts: readonly string[], label: Label, target: Extract<Target, { kind: 'link' }>): Decision {
  const [text] = texts;
  if (payload.length !== 1 || typeof payload[0]?.value !== 'string' || text === undefined) {
    return block('link-invalid', label, 'a link target takes exactly one address', 'stay-local');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return block('link-invalid', label, 'not an address', 'stay-local');
  }
  if (text.length > MAX_LINK || /[\s\p{Cc}]/u.test(text) || url.href !== text) return block('link-invalid', label, 'not a single normalized address', 'stay-local');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return block('link-invalid', label, 'only http and https addresses', 'stay-local');
  if (url.username !== '' || url.password !== '') return block('link-invalid', label, 'no credentials in an address', 'stay-local');
  if (target.consent === 'list') {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!target.sites.some((site) => host === site || host.endsWith(`.${site}`))) return block('link-invalid', label, 'the site is not in the list of the user', 'stay-local');
  }
  // Values in an address are often %-encoded: the scanner reads it as written and decoded (decodable: checked before).
  const masked = linkScanText(text);
  const findings = [...scanText(masked), ...scanText(decodeURIComponent(masked))];
  if (findings.length > 0) {
    const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
    return block('scanner', label, `scanner matched: ${kinds}`, 'stay-local', findings);
  }
  return allow({ decision: 'allow', rule: 'link', label, reason: `${label} address to its site, ${target.consent} consent, scan clean`, texts }, target);
}

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
    case 'link':
      if (target.consent === 'click') return true;
      return (
        target.consent === 'list' &&
        Array.isArray(target.sites) &&
        target.sites.length > 0 &&
        target.sites.length <= MAX_LINK_SITES &&
        (target.sites as unknown[]).every((site) => typeof site === 'string' && isSiteName(site))
      );
    default:
      return false;
  }
}

/**
 * Where inference or delivery happens. The web chat, reached over the VPN,
 * and the internet call to apps/voice (D-066) are local channels; Telegram,
 * the phone and push notifications are cloud (D-016).
 */
export function localityOf(target: Target): Locality {
  if (target.kind === 'executor') return target.locality;
  if (target.kind === 'channel' && (target.id === 'web' || target.id === 'voice')) return 'local';
  return 'cloud';
}

/** `gateway_log.target`: e.g. `claude`, `telegram`, `web-search`, `link-list`; never the address nor the site of a link. */
export function targetName(target: Target): string {
  if (target.kind === 'web') return 'web-search';
  if (target.kind === 'link') return `link-${target.consent}`;
  return target.id;
}

/** What a decision allowed, as recorded when it was made; see `allowedBy`. */
export interface Allowed {
  readonly target: Readonly<Target>;
  readonly label: Label;
  readonly texts: readonly string[];
}

// Decisions made here, and only these, can be spent by an adapter: an object
// literal could claim `allow` for any text, and a real decision could be edited.
const allowed = new WeakMap<object, Allowed & { logged: boolean }>();

function allow(decision: Extract<Decision, { decision: 'allow' }>, target: Target): Decision {
  allowed.set(decision, {
    target: Object.freeze({ ...target }),
    label: decision.label,
    texts: decision.texts,
    logged: false,
  });
  return decision;
}

/**
 * What `decision` allowed, and towards which target, when it is an `allow`
 * made by `gatewayCheck` and not yet spent; undefined otherwise. Read-only:
 * adapters use `spendAllowed`.
 */
export function allowedBy(decision: unknown): Allowed | undefined {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  return record === undefined ? undefined : Object.freeze({ target: record.target, label: record.label, texts: record.texts });
}

/**
 * Marks an allow as written to gateway_log. The core's `passGateway` calls it
 * after the INSERT; evals and tests, which have no log, call it themselves.
 * False for anything that is not an unspent allow of `gatewayCheck`.
 */
export function markLogged(decision: unknown): boolean {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  if (record === undefined) return false;
  record.logged = true;
  return true;
}

/**
 * Takes what an allow permits, once: an adapter sends `texts` from here, never
 * from the decision object, and checks the target is its own. Undefined when
 * the decision is not an allow of `gatewayCheck`, was not logged, or was
 * already spent: one row in gateway_log, one exit.
 */
export function spendAllowed(decision: unknown): Allowed | undefined {
  const record = typeof decision === 'object' && decision !== null ? allowed.get(decision) : undefined;
  if (record?.logged !== true) return undefined;
  allowed.delete(decision as object);
  return Object.freeze({ target: record.target, label: record.label, texts: record.texts });
}

function block(
  rule: Exclude<GatewayRule, 'local' | 'cloud' | 'link'>,
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
  // An address carries its values %-encoded: the vault and the scanner read it decoded too (D-154).
  if (target.kind === 'link') {
    for (const text of texts) {
      try {
        parts.push(decodeURIComponent(text));
      } catch {
        return block('link-invalid', label, 'an address with a broken escape', 'stay-local');
      }
    }
  }

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

  // The address of a link (D-154): chosen by the user, checked by its own rules whatever the label of its note.
  if (target.kind === 'link') return checkLink(payload, texts, label, target);

  if (locality === 'local') {
    // L3 is out already: local targets take everything else.
    return allow({ decision: 'allow', rule: 'local', label, reason: `${label} to a local target`, texts }, target);
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

  return allow({ decision: 'allow', rule: 'cloud', label, reason: `${label} to a cloud target, scan clean`, texts }, target);
}
