// A tiny OpenAI-compatible server for tests: no model, scripted answers.
// The last user message selects the behaviour:
//   "!slow:<ms>"   answers after <ms>
//   "!status:<n>"  answers with HTTP status <n>
//   "!garbage"     a body that is not JSON
//   "!empty"       JSON without choices
//   "!notjson"     content that is not JSON, even when a schema was asked
//   "!redirect:<url>"  302 to <url>
// anything else   "hello", or {"ok":true} when a schema was asked.
// POST /__hang makes every later request hang; GET /__last returns the last chat body.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServer {
  url: string;
  port: number;
  /** Chat requests received, in order. */
  requests: unknown[];
  close(): Promise<void>;
}

export async function startFakeServer(port = 0): Promise<FakeServer> {
  const requests: unknown[] = [];
  let hanging = false;

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/__hang') {
      hanging = true;
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/__last') {
      sendJson(res, 200, requests.at(-1) ?? null);
      return;
    }
    if (hanging) return; // never answers
    if (req.method === 'GET' && req.url === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: [{ id: 'fake-large', object: 'model' }] });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body) as { messages?: { role: string; content: string }[]; response_format?: unknown };
      requests.push(parsed);
      const last = parsed.messages?.at(-1)?.content ?? '';
      await answer(res, last, parsed.response_format !== undefined);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(actual)}/v1`,
    port: actual,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function answer(res: ServerResponse, last: string, wantsJson: boolean): Promise<void> {
  const match = /^!(\w+)(?::(.*))?$/s.exec(last);
  const command = match?.[1] ?? '';
  const argument = match?.[2] ?? '';
  switch (command) {
    case 'slow':
      await new Promise((resolve) => setTimeout(resolve, Number(argument)));
      break;
    case 'status':
      sendJson(res, Number(argument), { error: { message: `echo: ${last}` } });
      return;
    case 'garbage':
      res.writeHead(200, { 'content-type': 'application/json' }).end('{not json');
      return;
    case 'empty':
      sendJson(res, 200, { choices: [] });
      return;
    case 'redirect':
      res.writeHead(302, { location: argument }).end();
      return;
  }
  const content = command === 'notjson' ? 'not json' : wantsJson ? '{"ok":true}' : 'hello';
  sendJson(res, 200, {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
