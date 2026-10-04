// A stand-in for oMLX in the tests: node fake-omlx.ts <port> [silent]. Answers
// GET /v1/models and writes the keys of its environment to its output, which
// the watchdog sends to the log file, so the test sees what leaked in.
// `silent`: never listens, like oMLX still loading a model.
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
console.log(`env ${JSON.stringify(Object.keys(process.env).sort())}`);

if (process.argv[3] === 'silent') setInterval(() => undefined, 1_000);
else createServer((request, response) => {
  if (request.url === '/v1/models') response.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
  else response.writeHead(404).end();
}).listen(port, '127.0.0.1');
