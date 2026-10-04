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

export interface HttpBytesResponse {
  status: number;
  /** Lowercase names, as node:http gives them. */
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export class HttpBodyTooLarge extends Error {
  override name = 'HttpBodyTooLarge';
}

export function localRequest(
  url: string,
  options: { method: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; signal: AbortSignal },
): Promise<HttpResponse> {
  const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers };
  return localRequestBytes(url, { ...options, headers }).then(({ status, body }) => ({ status, body: body.toString('utf8') }));
}

/** The same request, with any body and headers, answering bytes (apps/voice speaks WAV, D-066). */
export function localRequestBytes(
  url: string,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    body?: string | Buffer;
    headers?: Record<string, string>;
    signal: AbortSignal;
    maxBytes?: number;
  },
): Promise<HttpBytesResponse> {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const agent = parsed.protocol === 'https:' ? AGENTS['https:'] : AGENTS['http:'];
  const limit = options.maxBytes ?? MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const req = client.request(
      parsed,
      { method: options.method, agent, signal: options.signal, headers: options.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        res.on('data', (chunk: Buffer) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > limit) {
            // Rejected here: an answer that came in one chunk would otherwise still reach 'end'.
            tooLarge = true;
            const error = new HttpBodyTooLarge(`answer larger than ${String(limit)} bytes`);
            reject(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!tooLarge) resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
