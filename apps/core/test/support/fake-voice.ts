// A stand-in for apps/voice in the tests: same environment, token and routes,
// no models. It exits when its standard input closes, like the real one.
import { createServer } from 'node:http';

const port = Number(process.env.ARIANNA_VOICE_PORT);
const token = process.env.ARIANNA_VOICE_TOKEN ?? '';

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length === 0 ? undefined : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    if (request.url === '/health') {
      // The keys of its environment, so the test sees what leaked in.
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, env: Object.keys(process.env).sort() }));
    } else if (request.url === '/trial/transcribe') {
      const models = (body?.models ?? []) as { id: string; family: string }[];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: models.map((model) => ({ ...model, text: 'ciao', seconds: 0.1 })) }));
    } else if (request.url === '/trial/speak') {
      if (body?.text === 'rompi') {
        response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"inference"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'audio/wav', 'x-seconds-spent': '0.25', 'x-first-audio': '0.1' }).end(Buffer.concat([Buffer.from('RIFF'), Buffer.from(JSON.stringify(body))]));
    } else {
      response.writeHead(404).end();
    }
  });
});
server.listen(port, '127.0.0.1');
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => process.exit(0));
