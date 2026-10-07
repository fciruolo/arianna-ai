// HTTP towards huggingface.co for the search of the "Modelli" page (I-10,
// D-139): GET only, HTTPS only, no token, no cookie, no header that says
// anything about the user or the machine. The JSON of the public API comes
// from huggingface.co and follows redirects only there (a renamed
// repository answers with one); the small files read when a model is added
// may follow redirects to any HTTPS host, since their content is checked
// against the commit. Its own agent, so no proxy variable applies.
import http from 'node:http';
import https from 'node:https';

/** Codes only: a message never carries a response body. */
export class HubError extends Error {
  override name = 'HubError';
  readonly code: 'invalid' | 'blocked' | 'not-found' | 'conflict' | 'upstream';

  constructor(code: HubError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HubClient {
  /** The parsed JSON of an address of the API of huggingface.co. */
  json(url: string, signal?: AbortSignal): Promise<unknown>;
  /** A whole small file; refused above `maxBytes`. */
  bytes(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

const HUB_HOST = 'huggingface.co';
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** A search of 20 models or the card of one with a few hundred files is far below this. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export interface HubClientOptions {
  /** Without an answer for this long the request fails. 20 seconds by default. */
  timeoutMs?: number;
  /** The whole request, redirects and body included, ends after this long. 60 seconds by default. */
  deadlineMs?: number;
  /** Plain HTTP and another host for the API: only tests against a local server set them. */
  allowHttp?: boolean;
  hubHost?: string;
}

export function createHubClient(options: HubClientOptions = {}): HubClient {
  const agents = { 'https:': new https.Agent({ keepAlive: false }), 'http:': new http.Agent({ keepAlive: false }) };
  const timeout = options.timeoutMs ?? 20_000;
  const hubHost = options.hubHost ?? HUB_HOST;
  const deadline = options.deadlineMs ?? 60_000;
  /** A slow answer that keeps the socket busy still ends at the deadline. */
  const bounded = (signal?: AbortSignal): AbortSignal => (signal === undefined ? AbortSignal.timeout(deadline) : AbortSignal.any([signal, AbortSignal.timeout(deadline)]));

  const get = (url: URL, maxBytes: number, hubOnly: boolean, redirects: number, signal?: AbortSignal): Promise<Buffer> => {
    if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) return Promise.reject(new HubError('upstream', `refused a request over ${url.protocol}`));
    if (hubOnly && url.host !== hubHost) return Promise.reject(new HubError('upstream', 'refused a redirect away from huggingface.co'));
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const request = client.get(url, { agent: url.protocol === 'https:' ? agents['https:'] : agents['http:'], headers: { accept: hubOnly ? 'application/json' : '*/*' }, timeout, ...(signal === undefined ? {} : { signal }) }, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECTS.has(status) && location !== undefined) {
          response.resume();
          if (redirects >= MAX_REDIRECTS) {
            reject(new HubError('upstream', 'too many redirects'));
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            reject(new HubError('upstream', 'invalid redirect'));
            return;
          }
          get(next, maxBytes, hubOnly, redirects + 1, signal).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          // 401 is how the API answers for a repository that does not exist or is private.
          reject(status === 404 || status === 401 ? new HubError('not-found', `huggingface.co answered ${String(status)}`) : new HubError('upstream', `huggingface.co answered ${String(status)}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new HubError('upstream', 'the answer is larger than expected'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => {
          reject(error instanceof HubError ? error : new HubError('upstream', 'the answer of huggingface.co was cut'));
        });
        response.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });
      request.on('timeout', () => request.destroy(new HubError('upstream', 'no answer from huggingface.co in time')));
      request.on('error', (error) => {
        reject(error instanceof HubError ? error : new HubError('upstream', 'huggingface.co cannot be reached'));
      });
    });
  };

  return {
    async json(url, signal) {
      const body = await get(new URL(url), MAX_JSON_BYTES, true, 0, bounded(signal));
      try {
        return JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        throw new HubError('upstream', 'huggingface.co answered with something that is not JSON');
      }
    },
    bytes: (url, maxBytes, signal) => get(new URL(url), maxBytes, false, 0, bounded(signal)),
  };
}
