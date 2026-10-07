// HTTP for model downloads: GET with a Range header, HTTPS only, at most a
// few redirects (model hosts send downloads to a CDN), each one HTTPS too.
// Its own agent, so no proxy variable and no global agent applies.
import http from 'node:http';
import https from 'node:https';

import { ModelError, type Download, type Fetcher } from './model-files.ts';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface HttpOptions {
  /** Plain HTTP too: only tests against a local server set it. */
  allowHttp?: boolean;
  /** Without data for this long the download fails; it can be resumed. 60 seconds by default. */
  idleTimeoutMs?: number;
}

export function createFetcher(options: HttpOptions = {}): Fetcher {
  const agents = { 'https:': new https.Agent({ keepAlive: false }), 'http:': new http.Agent({ keepAlive: false }) };
  const idle = options.idleTimeoutMs ?? 60_000;

  const open = (url: URL, offset: number, redirects: number, signal?: AbortSignal): Promise<Download> => {
    if (url.protocol !== 'https:' && !(options.allowHttp === true && url.protocol === 'http:')) {
      return Promise.reject(new ModelError('insecure-url', `refused a download over ${url.protocol}`));
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.get(
        url,
        {
          agent: url.protocol === 'https:' ? agents['https:'] : agents['http:'],
          headers: offset > 0 ? { range: `bytes=${String(offset)}-` } : {},
          timeout: idle,
          ...(signal === undefined ? {} : { signal }),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (REDIRECTS.has(status) && location !== undefined) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new ModelError('redirects', 'too many redirects'));
              return;
            }
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              reject(new ModelError('redirects', 'invalid redirect'));
              return;
            }
            open(next, offset, redirects + 1, signal).then(resolve, reject);
            return;
          }
          const range = response.headers['content-range'];
          resolve({ status, body: response, ...(range === undefined ? {} : { contentRange: range }) });
        },
      );
      request.on('timeout', () => request.destroy(new Error('no data from the server in time')));
      request.on('error', reject);
    });
  };

  return (url, offset, signal) => open(new URL(url), offset, 0, signal);
}
