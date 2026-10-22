import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfigOrExit, resolveHome } from '@arianna/config';
import { createContext, gatewayCheck, piiUnavailable, type ResourceType } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { connect } from '../db/client.ts';
import { resolveLogin } from '../db/logins.ts';
import { appendEvent, type NewEvent } from '../events.ts';
import { cliPiiGuard, configurePiiGuard, stopPiiGuard } from '../pii-guard.ts';

import { openDockerChannel } from './channel.ts';
import { execDocker, leftoverContainers, VNC_SOCKET } from './container.ts';
import { BrowserManager } from './manager.ts';
import { connectSession } from './session.ts';

/**
 * Live trial of step 1 of the agent's browser (D-264), outside the tests:
 * `node apps/core/src/browser/try-cli.ts`. Needs Docker and the image of
 * config/browser-image.lock (`pnpm browser:build`). Opens an invented page
 * (data: URL), checks that https://example.com fails (the container has no
 * network until step 2), that a page cannot reach the old CDP port on the
 * loopback, that nothing listens on TCP, that VNC answers on its socket,
 * that downloads are refused, writes a screenshot in data/test-tmp/ and
 * closes. With `web` (and optionally an address) it tries step 2 instead,
 * the network from the core: see stepTwo.
 */

const home = resolveHome();
const out = join(home, 'data', 'test-tmp');
mkdirSync(out, { recursive: true });

const ms = (start: number): string => `${String(Math.round(performance.now() - start))} ms`;
const manager = new BrowserManager({ home });

const removed = await manager.cleanup();
if (removed.length > 0) console.log(`removed leftovers: ${removed.join(', ')}`);

if (process.argv[2] === 'web') await stepTwo();
else await stepOne();

/** Step 1: no network at all. */
async function stepOne(): Promise<void> {

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
    const session = await connectSession(open, { home });
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

    // A page tries the loopback of the container, where CDP and VNC used to listen.
    const probe = '<!doctype html><title>loopback</title><body>loopback</body>';
    await session.openPage(`data:text/html,${encodeURIComponent(probe)}`);
    const loopback = await session.context.pages().at(-1)?.evaluate(async () => {
      const tryFetch = async (url: string): Promise<string> => {
        try {
          const response = await fetch(url);
          return `answered ${String(response.status)}`;
        } catch (error) {
          return `failed (${String(error)})`;
        }
      };
      const tryWebSocket = (url: string): Promise<string> =>
        new Promise((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => { resolve('open'); socket.close(); };
          socket.onerror = () => { resolve('failed'); };
          setTimeout(() => { resolve('no answer in 5 s'); }, 5000);
        });
      return {
        fetchCdp: await tryFetch('http://127.0.0.1:9222/json/version'),
        fetchVnc: await tryFetch('http://127.0.0.1:5900/'),
        webSocketCdp: await tryWebSocket('ws://127.0.0.1:9222/devtools/browser'),
      };
    });
    console.log(`loopback from a page: ${JSON.stringify(loopback)}`);

    const tcp = (await execDocker(['exec', open.container, 'cat', '/proc/net/tcp', '/proc/net/tcp6'])).trim().split('\n').filter((line) => !line.trimStart().startsWith('sl'));
    console.log(tcp.length === 0 ? 'TCP sockets in the container: none' : `ERROR: TCP sockets: ${String(tcp.length)}`);

    const vnc = openDockerChannel(open.container, VNC_SOCKET);
    const banner = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => { resolve('no answer'); }, 5000);
      vnc.stream.once('data', (chunk: Buffer) => { clearTimeout(timer); resolve(chunk.toString('latin1').trim()); });
    });
    vnc.close();
    console.log(`VNC on ${VNC_SOCKET}: ${banner}`);

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
}

/**
 * Step 2 (`node apps/core/src/browser/try-cli.ts web`): the network from the
 * core. Needs the database (`pnpm db:up`) and config/arianna.toml. A Public
 * job (L0 context, public consent) opens a real public page, writes a
 * screenshot, prints counts by kind, refusals by rule of gateway_log and
 * times; then an invented data: page whose resources point at this machine
 * and the local network, which must all be refused. The addresses the
 * scanner refused are printed here only (public addresses, never stored), to
 * count its false positives.
 */
async function stepTwo(): Promise<void> {
  const config = loadConfigOrExit();
  const sql = connect(config, await resolveLogin(config, 'app'));
  configurePiiGuard(cliPiiGuard(config));
  const since = new Date();
  const events: NewEvent[] = [];
  const refused: { url: string; type: string }[] = [];
  const context = createContext('L1', 'L0');
  const open = await manager.start('try-web');
  try {
    let t = performance.now();
    const session = await connectSession(open, {
      home,
      network: {
        sql,
        context,
        consent: { from: 'public' },
        onEvent: (event) => {
          events.push(event);
          void appendEvent(sql, event).catch(() => undefined);
        },
        trace: (entry) => {
          if (entry.outcome === 'blocked') refused.push({ url: entry.url, type: entry.type });
          else if (entry.outcome !== 'ok' && entry.outcome !== 'http-error') console.log(`  ${entry.outcome} ${entry.kind}${entry.reason === undefined ? '' : ` (${entry.reason})`}: ${entry.url.slice(0, 120)}`);
        },
      },
    });
    console.log(`connectOverCDP and network: ${ms(t)}`);
    const address = process.argv[3] ?? 'https://developer.mozilla.org/';
    t = performance.now();
    try {
      const page = await session.openPage(address, 45_000);
      console.log(`open ${address}: ${ms(t)} (title "${page.title}", now at ${page.url})`);
    } catch (error) {
      console.log(`open ${address} failed after ${ms(t)}: ${(error as Error).message.split('\n')[0] ?? ''}`);
    }
    // Late resources (lazy images, fonts) have a moment to arrive.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const png = await session.screenshot();
    const file = join(out, 'd264-screenshot-web.png');
    writeFileSync(file, png);
    console.log(`screenshot: ${file} (${String(png.length)} bytes)`);
    console.log(`counts by kind and outcome: ${JSON.stringify(session.network?.counts())}`);
    const budget = session.network?.budget;
    console.log(`job: ${String(budget?.pages)} pages, ${String(budget?.requests)} requests, ${String(Math.round((budget?.bytes ?? 0) / 1024))} KB`);
    // Why the gateway refused each one: the same check, pure, here only.
    for (const entry of refused) {
      const decision = gatewayCheck([{ value: entry.url, label: 'L0', source: 'web:resource' }], context, { kind: 'web', resource: { of: 'public', type: entry.type === 'page' || entry.type === 'other' ? 'image' : (entry.type as ResourceType), method: 'GET' } }, knownSecrets, piiUnavailable('off'));
      console.log(`  refused ${entry.type}: ${decision.rule} ${decision.decision === 'block' ? (decision.findings ?? []).map((finding) => finding.kind).join(',') : ''} ${entry.url.slice(0, 160)}`);
    }

    // An invented page whose resources point at this machine and the local network.
    const local = ['http://127.0.0.1:9222/json/version', 'http://127.0.0.1:5900/', 'http://10.0.0.1/a.png', 'http://localhost/a.png', 'http://[::1]/a.png', 'http://192.168.1.1/a.css'];
    const before = session.network?.counts() ?? {};
    const html = `<!doctype html><title>locale</title><body>${local.map((url, index) => (index % 2 === 0 ? `<img src="${url}">` : `<link rel="stylesheet" href="${url}">`)).join('')}<script>fetch("http://127.0.0.1:7420/api/health").catch(()=>{})</script></body>`;
    await session.openPage(`data:text/html,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log(`local page, counts before: ${JSON.stringify(before)}`);
    console.log(`local page, counts after:  ${JSON.stringify(session.network?.counts())}`);
    await session.close();
    const rows = await sql<{ target: string; decision: string; rule: string; n: string }[]>`
      SELECT target, decision, rule, count(*)::text AS n FROM gateway_log
      WHERE ts >= ${since} AND target LIKE 'web-%' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    console.log('gateway_log since the start:');
    for (const row of rows) console.log(`  ${row.target} ${row.decision} ${row.rule}: ${row.n}`);
    console.log(`events: ${events.map((event) => `${event.kind} ${JSON.stringify(event.payload)}`).join('\n        ')}`);
  } finally {
    await manager.stop(open.id);
    await stopPiiGuard();
    await sql.end();
  }
}

const left = await leftoverContainers(execDocker);
console.log(left.length === 0 ? 'no arianna-browser-* container left' : `ERROR: left ${left.join(', ')}`);
