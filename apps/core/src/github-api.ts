// HTTP towards the public API of GitHub for the news of Open Design (I-21,
// D-186): GET only, HTTPS only, no token, no cookie, a fixed user agent that
// says nothing about the user or the machine (the API refuses a request
// without one). Redirects are followed only on the same host (a renamed
// repository answers with one); a body larger than the limit, or one that is
// not JSON, is refused. Its own agent, so no proxy variable applies.
import http from 'node:http';
import https from 'node:https';

/** Codes only: a message never carries a response body. */
export class GithubError extends Error {
  override name = 'GithubError';
  readonly code: 'not-found' | 'limited' | 'upstream';

  constructor(code: GithubError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** The parsed JSON of a path of the API (`/repos/...`), at most `maxBytes` long. */
export type GithubGet = (path: string, maxBytes: number, signal?: AbortSignal) => Promise<unknown>;

export const GITHUB_API_HOST = 'api.github.com';
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 307, 308]);
/** Fixed: the API asks for one, and it must not say who the user is. */
const USER_AGENT = 'arianna-catalog';

export interface GithubClientOptions {
  /** Without an answer for this long the request fails. 20 seconds by default. */
  timeoutMs?: number;
  /** The whole request, redirects and body included, ends after this long. 60 seconds by default. */
  deadlineMs?: number;
  /** Plain HTTP and another host: only tests against a local server set them. */
  allowHttp?: boolean;
  host?: string;
}

/** A path of the API: no scheme, no host, no `..`, no spaces. */
const API_PATH = /^\/[A-Za-z0-9._~\-/]+(?:\?[A-Za-z0-9._~\-=&]*)?$/;

export function createGithubClient(options: GithubClientOptions = {}): GithubGet {
  const agents = { 'https:': new https.Agent({ keepAlive: false }), 'http:': new http.Agent({ keepAlive: false }) };
  const timeout = options.timeoutMs ?? 20_000;
  const deadline = options.deadlineMs ?? 60_000;
  const host = options.host ?? GITHUB_API_HOST;
  const scheme = options.allowHttp === true ? 'http:' : 'https:';

  const get = (url: URL, maxBytes: number, redirects: number, signal: AbortSignal): Promise<Buffer> => {
    if (url.protocol !== scheme) return Promise.reject(new GithubError('upstream', `refused a request over ${url.protocol}`));
    if (url.host !== host) return Promise.reject(new GithubError('upstream', `refused a redirect away from ${GITHUB_API_HOST}`));
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      const request = client.get(
        url,
        {
          agent: url.protocol === 'https:' ? agents['https:'] : agents['http:'],
          headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': '2022-11-28' },
          timeout,
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (REDIRECTS.has(status) && location !== undefined) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new GithubError('upstream', 'too many redirects'));
              return;
            }
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              reject(new GithubError('upstream', 'invalid redirect'));
              return;
            }
            get(next, maxBytes, redirects + 1, signal).then(resolve, reject);
            return;
          }
          if (status !== 200) {
            response.resume();
            const limited = (status === 403 || status === 429) && response.headers['x-ratelimit-remaining'] === '0';
            reject(
              status === 404
                ? new GithubError('not-found', `${GITHUB_API_HOST} answered 404`)
                : limited || status === 429
                  ? new GithubError('limited', `${GITHUB_API_HOST} limits the requests without an account: try again later`)
                  : new GithubError('upstream', `${GITHUB_API_HOST} answered ${String(status)}`),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy(new GithubError('upstream', 'the answer is larger than expected'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', (error) => {
            reject(error instanceof GithubError ? error : new GithubError('upstream', `the answer of ${GITHUB_API_HOST} was cut`));
          });
          response.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        },
      );
      request.on('timeout', () => request.destroy(new GithubError('upstream', `no answer from ${GITHUB_API_HOST} in time`)));
      request.on('error', (error) => {
        reject(error instanceof GithubError ? error : new GithubError('upstream', `${GITHUB_API_HOST} cannot be reached`));
      });
    });
  };

  return async (path, maxBytes, signal) => {
    if (!API_PATH.test(path) || path.includes('..')) throw new GithubError('upstream', 'invalid path of the API');
    const bounded = signal === undefined ? AbortSignal.timeout(deadline) : AbortSignal.any([signal, AbortSignal.timeout(deadline)]);
    const body = await get(new URL(`${scheme}//${host}${path}`), maxBytes, 0, bounded);
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new GithubError('upstream', `${GITHUB_API_HOST} answered with something that is not JSON`);
    }
  };
}
