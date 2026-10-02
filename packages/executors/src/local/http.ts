import http from 'node:http';
import https from 'node:https';

/**
 * HTTP to local endpoints, deliberately without `fetch`: with
 * NODE_USE_ENV_PROXY (or --use-env-proxy) and HTTP_PROXY set, `fetch` and the
 * global agents send even loopback requests to the proxy, which would receive
 * L2 data. Dedicated agents never use a proxy, and `http.request` never
 * follows redirects.
 */
const AGENTS = { 'http:': new http.Agent(), 'https:': new https.Agent() };

/** Larger answers are refused: no local completion or model list is this big. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface HttpResponse {
  status: number;
  body: string;
}

export class HttpBodyTooLarge extends Error {
  override name = 'HttpBodyTooLarge';
}

export function localRequest(
  url: string,
  options: { method: 'GET' | 'POST'; body?: string; signal: AbortSignal },
): Promise<HttpResponse> {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const agent = parsed.protocol === 'https:' ? AGENTS['https:'] : AGENTS['http:'];
  return new Promise((resolve, reject) => {
    const req = client.request(
      parsed,
      {
        method: options.method,
        agent,
        signal: options.signal,
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new HttpBodyTooLarge(`answer larger than ${String(MAX_BODY_BYTES)} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
