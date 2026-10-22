/**
 * The chat opened from the phone (D-292): over HTTPS on the Tailscale name of
 * the Mac (`*.ts.net`), through the remote port of the core. Stage B: the
 * phone pairs with a code shown on the Mac, creates a passkey, then signs in
 * with Face ID; a decision on an approval asks the passkey again, bound to it.
 *
 * The pure parts (base64url, the options of WebAuthn, the JSON of a
 * credential, the Italian texts) are tested; the calls use `fetch` and
 * `navigator.credentials`.
 */

export function onRemoteOrigin(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'https:' && location.hostname.endsWith('.ts.net');
}

/** What `GET /api/remote/status` says; anything else (an error, a refusal) counts as no session. */
export function sessionOf(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'session' in body && body.session === true;
}

export async function remoteSession(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/api/remote/status', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return false;
    return sessionOf(await response.json());
  } catch {
    return false;
  }
}

/**
 * The service worker from the remote origin too: the page becomes an app of
 * the iPhone's home screen, and Web Push needs it.
 */
export async function registerWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

// --- base64url ---------------------------------------------------------------

export function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// --- WebAuthn options and credentials as JSON ----------------------------------

/** The creation options as the core sends them (D-292): binary fields in base64url. */
export interface CreationOptionsJson {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' };
  excludeCredentials?: { type: 'public-key'; id: string }[];
}

export interface RequestOptionsJson {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required';
  allowCredentials: { type: 'public-key'; id: string }[];
}

export function creationOptionsOf(json: CreationOptionsJson): PublicKeyCredentialCreationOptions {
  return {
    challenge: fromBase64url(json.challenge),
    rp: { id: json.rp.id, name: json.rp.name },
    user: { id: fromBase64url(json.user.id), name: json.user.name, displayName: json.user.displayName },
    pubKeyCredParams: json.pubKeyCredParams.map((param) => ({ type: 'public-key', alg: param.alg })),
    timeout: json.timeout,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: (json.excludeCredentials ?? []).map((item) => ({ type: 'public-key', id: fromBase64url(item.id) })),
  };
}

export function requestOptionsOf(json: RequestOptionsJson): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64url(json.challenge),
    rpId: json.rpId,
    timeout: json.timeout,
    userVerification: 'required',
    allowCredentials: json.allowCredentials.map((item) => ({ type: 'public-key', id: fromBase64url(item.id) })),
  };
}

/** The parts of a PublicKeyCredential the core reads, whatever the browser adds. */
export interface CredentialLike {
  rawId: ArrayBuffer;
  type: string;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
}

/** A credential as the core wants it: a registration (attestationObject) or an assertion (signature). */
export function credentialJson(credential: CredentialLike): Record<string, unknown> {
  const id = toBase64url(credential.rawId);
  const { response } = credential;
  const clientDataJSON = toBase64url(response.clientDataJSON);
  if (response.attestationObject !== undefined) {
    return { id, rawId: id, type: credential.type, response: { clientDataJSON, attestationObject: toBase64url(response.attestationObject) } };
  }
  if (response.authenticatorData === undefined || response.signature === undefined) throw new Error('not a WebAuthn credential');
  return {
    id,
    rawId: id,
    type: credential.type,
    response: {
      clientDataJSON,
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle === undefined || response.userHandle === null ? null : toBase64url(response.userHandle),
    },
  };
}

// --- Errors in Italian ---------------------------------------------------------

export class RemoteError extends Error {
  override name = 'RemoteError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PASSKEY_MISMATCH = 'La passkey non è di questo indirizzo di Arianna: apri la chat dal nome del Mac indicato in Impostazioni → Dispositivi e, se serve, abbina di nuovo il telefono.';

const ERROR_TEXT: Record<string, string> = {
  code: 'Codice sbagliato o scaduto. Controlla le 6 cifre, o crea un nuovo codice sul Mac in Impostazioni → Dispositivi.',
  'too-many': 'Troppi tentativi in poco tempo. Aspetta un minuto e riprova.',
  challenge: 'La richiesta è scaduta o è già stata usata. Riprova da capo.',
  signature: 'La passkey non è stata riconosciuta. Riprova.',
  counter: 'Questa passkey sembra copiata da un altro dispositivo: Arianna l’ha rifiutata. Scollega il dispositivo dal Mac e abbinalo di nuovo.',
  'unknown-credential': 'Questa passkey non è (più) abbinata ad Arianna. Abbina il telefono con un nuovo codice.',
  'device-not-paired': 'Sessione finita o dispositivo scollegato. Entra di nuovo con Face ID.',
  'local-only': 'Questa operazione si fa solo dal Mac.',
  'verification-required': 'Per decidere dal telefono serve Face ID: la verifica non è riuscita o è scaduta. Riprova.',
  // The passkey answered, but not as Arianna asks: another name of the Mac, no Face ID, a broken answer.
  'rp-id': PASSKEY_MISMATCH,
  origin: PASSKEY_MISMATCH,
  'cross-origin': PASSKEY_MISMATCH,
  'user-handle': PASSKEY_MISMATCH,
  'user-verification': 'Serve Face ID (o il codice del telefono): la passkey ha risposto senza verificarti. Riprova.',
  'user-presence': 'Serve Face ID (o il codice del telefono): la passkey ha risposto senza verificarti. Riprova.',
  credential: 'La risposta della passkey non è leggibile. Riprova.',
  'client-data': 'La risposta della passkey non è leggibile. Riprova.',
  'attestation-format': 'Questa passkey non è del tipo che Arianna accetta. Usa il Portachiavi di iCloud del telefono.',
  algorithm: 'Questa passkey non è del tipo che Arianna accetta. Usa il Portachiavi di iCloud del telefono.',
  cancelled: 'Operazione annullata.',
  unsupported: 'Questo browser non supporta le passkey. Apri Arianna da Safari su iPhone.',
};

/** The Italian text of a refusal of the core or of the browser; a generic one for anything else. */
export function remoteErrorText(code: string | undefined): string {
  return (code === undefined ? undefined : ERROR_TEXT[code]) ?? 'Non è riuscito: il Mac non risponde o la VPN è spenta. Riprova.';
}

/** A refusal of navigator.credentials (Face ID cancelled, timeout) as a code of the texts above. */
export function browserErrorCode(error: unknown): string {
  if (error instanceof RemoteError) return error.code;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return 'cancelled';
    if (error.name === 'NotSupportedError') return 'unsupported';
  }
  return 'unknown';
}

// --- Calls ---------------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new RemoteError(response.status, typeof data.code === 'string' ? data.code : 'unknown', typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data as T;
}

function credentials(): CredentialsContainer {
  if (typeof navigator === 'undefined' || !('credentials' in navigator) || typeof PublicKeyCredential === 'undefined') throw new RemoteError(0, 'unsupported', 'no WebAuthn');
  return navigator.credentials;
}

/** The code typed on the phone; the options of the passkey to create next. */
export async function pairWithCode(code: string): Promise<CreationOptionsJson> {
  return (await post<{ options: CreationOptionsJson }>('/api/remote/pair', { code })).options;
}

/** Creates the passkey (Face ID) and registers it: the session cookie follows. Must run from a tap. */
export async function registerPasskey(options: CreationOptionsJson): Promise<void> {
  const created = await credentials().create({ publicKey: creationOptionsOf(options) });
  if (created === null) throw new RemoteError(0, 'cancelled', 'no credential');
  await post('/api/remote/register', { credential: credentialJson(created as unknown as CredentialLike) });
}

async function assertion(options: RequestOptionsJson): Promise<Record<string, unknown>> {
  const got = await credentials().get({ publicKey: requestOptionsOf(options) });
  if (got === null) throw new RemoteError(0, 'cancelled', 'no credential');
  return credentialJson(got as unknown as CredentialLike);
}

/** Sign-in with the passkey (Face ID): the session cookie follows. Must run from a tap. */
export async function signIn(): Promise<void> {
  const { options } = await post<{ options: RequestOptionsJson }>('/api/remote/login/options', {});
  await post('/api/remote/login', { credential: await assertion(options) });
}

/** The header that carries the Face ID check of an action from the phone (D-292, step-up), as the core reads it. */
export const VERIFICATION_HEADER = 'x-arianna-verification';

/** The refusal of the core that asks Face ID for this action: the page asks it and sends the action again, once. */
export function needsVerification(remote: boolean, status: number, body: Record<string, unknown>): boolean {
  return remote && status === 403 && body.code === 'verification-required';
}

/** A failed Face ID check as the page shows it: status, Italian text, and the code in the body. */
export function checkFailure(error: unknown): { status: number; text: string; body: Record<string, unknown> } {
  const code = browserErrorCode(error);
  const status = error instanceof RemoteError ? error.status : 0;
  return { status, text: remoteErrorText(code === 'unknown' ? undefined : code), body: { code } };
}

/** The path of an action as the core sees it: no query, no host. */
export function actionPath(path: string, origin: string): string {
  return new URL(path, origin).pathname;
}

/**
 * The Face ID check of one action (D-292, step-up): the core binds it to the
 * method, the path and the body, which the page sends again unchanged.
 * The header to add to that request.
 */
export async function stepUpHeader(path: string, body: unknown): Promise<Record<string, string>> {
  const { options } = await post<{ options: RequestOptionsJson }>('/api/remote/verify', { method: 'POST', path, body: body ?? {} });
  const check = await assertion(options);
  return { [VERIFICATION_HEADER]: base64urlOfText(JSON.stringify(check)) };
}

function base64urlOfText(text: string): string {
  return toBase64url(new TextEncoder().encode(text));
}

/** A 401 of the remote port without a session: the page goes back to «Entra con Face ID». */
export function sessionEnded(remote: boolean, status: number, body: Record<string, unknown>): boolean {
  return remote && status === 401 && body.code === 'device-not-paired';
}

// --- This browser already has a passkey ---------------------------------------

const REGISTERED_KEY = 'arianna-remote-passkey';

/** Whether this browser created a passkey before: the page starts from «Entra con Face ID». A convenience only. */
export function rememberedPasskey(): boolean {
  try {
    return window.localStorage.getItem(REGISTERED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberPasskey(): void {
  try {
    window.localStorage.setItem(REGISTERED_KEY, '1');
  } catch {
    // Private mode: the page asks for the code first, the sign-in stays one tap away.
  }
}
