import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHome } from '@arianna/config';

import { execDocker, leftoverContainers } from './container.ts';
import { BrowserManager } from './manager.ts';
import { connectSession } from './session.ts';

/**
 * Live trial of step 1 of the agent's browser (D-264), outside the tests:
 * `node apps/core/src/browser/try-cli.ts`. Needs Docker and the image of
 * config/browser-image.lock (`pnpm browser:build`). Opens an invented page
 * (data: URL), checks that https://example.com fails (the container has no
 * network until step 2), writes a screenshot in data/test-tmp/ and closes.
 */

const home = resolveHome();
const out = join(home, 'data', 'test-tmp');
mkdirSync(out, { recursive: true });

const ms = (start: number): string => `${String(Math.round(performance.now() - start))} ms`;
const manager = new BrowserManager({ home });

const removed = await manager.cleanup();
if (removed.length > 0) console.log(`removed leftovers: ${removed.join(', ')}`);

let t = performance.now();
const open = await manager.start('try');
console.log(`start until CDP ready: ${ms(t)}`);

try {
  try {
    await manager.start('second');
    console.log('ERROR: a second browser started');
  } catch (error) {
    console.log(`second browser refused: ${(error as Error).message}`);
  }

  t = performance.now();
  const session = await connectSession(open, home);
  console.log(`connectOverCDP: ${ms(t)}`);

  const html = '<!doctype html><title>Prova D-264</title><body style="font:32px sans-serif;background:#f4efe6"><h1>Pagina inventata</h1><p>Il browser dell\'agente apre questa pagina senza rete.</p></body>';
  t = performance.now();
  const page = await session.openPage(`data:text/html,${encodeURIComponent(html)}`);
  console.log(`open data: page: ${ms(t)} (title "${page.title}")`);

  t = performance.now();
  try {
    await session.openPage('https://example.com', 10_000);
    console.log('ERROR: https://example.com loaded without network');
  } catch (error) {
    console.log(`https://example.com refused as expected after ${ms(t)}: ${(error as Error).message.split('\n')[0] ?? ''}`);
  }

  // Downloads are refused: a link with `download` must leave no file in the container.
  const link = '<a id="d" href="data:application/octet-stream;base64,aGVsbG8=" download="prova-d264.bin">scarica</a>';
  await session.openPage(`data:text/html,${encodeURIComponent(link)}`);
  await session.context.pages().at(-1)?.click('#d');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const found = (await execDocker(['exec', open.container, 'find', '/srv/browser', '/tmp', '-name', 'prova-d264*'])).trim();
  console.log(found === '' ? 'download refused: no file in the container' : `ERROR: downloaded ${found}`);

  await session.openPage(`data:text/html,${encodeURIComponent(html)}`);
  const png = await session.screenshot();
  const file = join(out, 'd264-screenshot.png');
  writeFileSync(file, png);
  console.log(`screenshot: ${file} (${String(png.length)} bytes)`);

  console.log(`memory: ${(await execDocker(['stats', '--no-stream', '--format', '{{.MemUsage}} {{.PIDs}} pids', open.container])).trim()}`);
  console.log(`tmpfs: ${(await execDocker(['exec', open.container, 'du', '-sh', '/srv/browser', '/tmp'])).trim().replace(/\n/g, ', ')}`);
  await session.close();
} finally {
  await manager.stop(open.id);
}

const left = await leftoverContainers(execDocker);
console.log(left.length === 0 ? 'no arianna-browser-* container left' : `ERROR: left ${left.join(', ')}`);
