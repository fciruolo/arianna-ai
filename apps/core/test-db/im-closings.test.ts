// The IM between meetings against PostgreSQL (D-167, P4b): the closing asked
// once in the secretary conversation after the meeting (the moved call
// counting), answered item by item and closed with a last message; an IM with
// nothing open closed at once; the card of an item made the first time, and
// the state going both ways between the item and its card.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { loadCard, moveCard } from '../src/cardwall.ts';
import { completeItemCard, itemCard } from '../src/im-cards.ts';
import { createImWatcher, finishClosing, listImClosings } from '../src/im-watch.ts';
import { closeImItem, readIm, setImItemState } from '../src/im.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-closings-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function container(name: string, ims: Record<string, string>): Project {
  const root = join(HOME, 'repos', name);
  // Fake data only.
  write(root, { ...ims, 'parte/.git/HEAD': 'ref: refs/heads/main\n' });
  return { name, path: `repos/${name}`, absolute: root, label: 'L1' };
}

const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) };
const NAMES = (projects: readonly Project[]) => ({ projects: projects.map((project) => project.name), agents: ['coder'] });

const im = (number: number, date: string, items: string[], extra = ''): string =>
  [`---`, `im: ${String(number)}`, `data: ${date}`, ...(extra === '' ? [] : [extra]), 'stato: previsto', '---', '', '## Lavori', '', ...items, '', '## Note', ''].join('\n');

async function secretaryMessages(): Promise<string[]> {
  const rows = await db().sql<{ body: string }[]>`
    SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.secretary ORDER BY m.id`;
  return rows.map((row) => row.body);
}

test('the closing is asked once after the moved call, answered item by item, and closed with a last message', async () => {
  const project = container('alfa', { 'IM/IM-33.md': im(33, '2026-10-15 10:00', ['- [/] Pagamento — Parte 2', '- [ ] Fatture', '- [x] Login'], 'chiamata: 2026-10-16 15:00') });
  const projects = [project];
  let now = new Date(2026, 9, 15, 18, 0);
  const watcher = createImWatcher({ sql: db().sql, projects: () => projects, env: ENV, onError: (error) => assert.fail(String(error)), now: () => now });

  // After the date, before the moved call: nothing yet.
  await watcher.check();
  assert.deepEqual(await listImClosings(db().sql), []);

  now = new Date(2026, 9, 16, 15, 30);
  await watcher.check();
  await watcher.check();
  const [closing, ...others] = await listImClosings(db().sql);
  assert.ok(closing !== undefined);
  assert.equal(others.length, 0);
  assert.equal(closing.project, 'alfa');
  assert.equal(closing.im, 33);
  assert.equal(closing.closedAt, null);
  const messages = await secretaryMessages();
  assert.deepEqual(messages, ["È passato l'IM-33 di alfa (giovedì 15 ottobre 2026, 10:00). Ci sono 2 voci ancora aperte: dimmi qui sotto, voce per voce, se è finita. Quelle non finite passano all'IM successivo."]);
  const [row] = await db().sql<{ id: string }[]>`SELECT m.id::text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.secretary`;
  assert.equal(closing.messageId, row?.id);

  const items = readIm(projects, 'alfa', ENV, 33).items;
  const pagamento = items.find((item) => item.title === 'Pagamento') ?? assert.fail();
  const fatture = items.find((item) => item.title === 'Fatture') ?? assert.fail();
  closeImItem(projects, 'alfa', ENV, 33, pagamento, 'part');
  assert.equal(await finishClosing(db().sql, projects, ENV, closing), false);
  closeImItem(projects, 'alfa', ENV, 33, fatture, 'not-done');
  assert.equal(await finishClosing(db().sql, projects, ENV, closing), true);
  assert.equal(await finishClosing(db().sql, projects, ENV, closing), true);

  const [closed] = await listImClosings(db().sql);
  assert.notEqual(closed?.closedAt, null);
  assert.equal((await secretaryMessages()).at(-1), "Chiuso l'IM-33 di alfa: le voci rimaste sono nell'IM successivo.");
  assert.equal((await secretaryMessages()).length, 2);
  assert.equal(readIm(projects, 'alfa', ENV, 33).status, 'chiuso');
  assert.deepEqual(readIm(projects, 'alfa', ENV, 34).items.map((item) => [item.title, item.part]), [['Pagamento', 3], ['Fatture', null]]);

  // The next IM (22 October) is not over: nothing more is asked.
  await watcher.check();
  assert.equal((await listImClosings(db().sql)).length, 1);
});

test('an IM with nothing open is closed at once, without a message', async () => {
  const project = container('beta', { 'IM/IM-5.md': im(5, '2026-10-01 09:00', ['- [x] Login', '- [>] Tema scuro']) });
  const projects = [project];
  const before = (await secretaryMessages()).length;
  const watcher = createImWatcher({ sql: db().sql, projects: () => projects, env: ENV, onError: (error) => assert.fail(String(error)), now: () => new Date(2026, 9, 2, 9, 0) });
  await watcher.check();
  const closing = (await listImClosings(db().sql)).find((item) => item.project === 'beta');
  assert.ok(closing !== undefined);
  assert.notEqual(closing.closedAt, null);
  assert.equal(closing.messageId, null);
  assert.equal((await secretaryMessages()).length, before);
  assert.equal(readIm(projects, 'beta', ENV, 5).status, 'chiuso');
  assert.deepEqual(readIm(projects, 'beta', ENV, 6).items.map((item) => item.title), ['Tema scuro']);
});

test('the card of an item is made once and written on its line; the state goes both ways', async () => {
  const project = container('gamma', { 'IM/IM-1.md': im(1, '2030-01-10 10:00', ['- [ ] Fatture — Parte 1', '- [ ] Login']) });
  const projects = [project];
  const file = join(project.absolute, 'IM', 'IM-1.md');
  const watcher = createImWatcher({ sql: db().sql, projects: () => projects, env: ENV, onError: (error) => assert.fail(String(error)), now: () => new Date(2030, 0, 1) });
  await watcher.check(); // takes the events cursor

  const fatture = readIm(projects, 'gamma', ENV, 1).items[0] ?? assert.fail();
  const first = await itemCard(db().sql, projects, ENV, NAMES(projects), 'gamma', 1, fatture);
  const short = first.cardId.slice(0, 8);
  assert.match(readFileSync(file, 'utf8'), new RegExp(`- \\[ \\] Fatture — Parte 1 #card-${short}\\n`));
  const card = await loadCard(db().sql, first.cardId);
  assert.equal(card.title, 'Fatture — Parte 1');
  assert.equal(card.project, 'gamma');
  // Opened again: the same card, no new one.
  const again = await itemCard(db().sql, projects, ENV, NAMES(projects), 'gamma', 1, first.im.items[0] ?? assert.fail());
  assert.equal(again.cardId, first.cardId);
  const [count] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tasks WHERE project = 'gamma'`;
  assert.equal(count?.n, 1);

  // While the item is open the card goes on; item checked → card in "Fatto".
  await completeItemCard(db().sql, projects, ENV, 'gamma', short);
  assert.equal((await loadCard(db().sql, first.cardId)).status, 'inbox');
  const checked = readIm(projects, 'gamma', ENV, 1);
  setImItemState(projects, 'gamma', ENV, 1, checked.items[0]?.line ?? 0, 'done', checked.version);
  await completeItemCard(db().sql, projects, ENV, 'gamma', short);
  assert.equal((await loadCard(db().sql, first.cardId)).status, 'done');

  // Card in "Fatto" → item checked, at the next look.
  const login = readIm(projects, 'gamma', ENV, 1).items.find((item) => item.title === 'Login') ?? assert.fail();
  const second = await itemCard(db().sql, projects, ENV, NAMES(projects), 'gamma', 1, login);
  await moveCard(db().sql, second.cardId, 'done');
  await watcher.check();
  assert.equal(readIm(projects, 'gamma', ENV, 1).items.find((item) => item.title === 'Login')?.state, 'done');
});

test('a card for an item that changed in the file meanwhile is refused', async () => {
  const project = container('delta', { 'IM/IM-1.md': im(1, '2030-01-10 10:00', ['- [ ] Fatture']) });
  const projects = [project];
  const fatture = readIm(projects, 'delta', ENV, 1).items[0] ?? assert.fail();
  writeFileSync(join(project.absolute, 'IM', 'IM-1.md'), im(1, '2030-01-10 10:00', ['- [ ] Fatture del mese']));
  await assert.rejects(itemCard(db().sql, projects, ENV, NAMES(projects), 'delta', 1, fatture), /changed/);
  const [count] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tasks WHERE project = 'delta'`;
  assert.equal(count?.n, 0);
});

test('a closing whose last item is checked by hand ends at the next look; old IM left open are never chained', async () => {
  const project = container('epsilon', {
    'IM/IM-1.md': im(1, '2026-06-04 10:00', ['- [ ] Vecchia voce']),
    'IM/IM-2.md': im(2, '2026-10-08 10:00', ['- [ ] Fatture']),
  });
  const projects = [project];
  const now = new Date(2026, 9, 9, 9, 0);
  const watcher = createImWatcher({ sql: db().sql, projects: () => projects, env: ENV, onError: (error) => assert.fail(String(error)), now: () => now });
  await watcher.check();
  const mine = async () => (await listImClosings(db().sql)).filter((closing) => closing.project === 'epsilon');
  // Only the last IM whose meeting is over is asked about.
  assert.deepEqual((await mine()).map((closing) => closing.im), [2]);

  const file = join(project.absolute, 'IM', 'IM-2.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] Fatture', '- [x] Fatture'));
  await watcher.check();
  const [closing] = await mine();
  assert.notEqual(closing?.closedAt, null);
  assert.equal(readIm(projects, 'epsilon', ENV, 2).status, 'chiuso');
  // The next IM is not in the past: 15 October, after "now".
  assert.equal(readIm(projects, 'epsilon', ENV, 3).date, '2026-10-15 10:00');
  assert.equal(readIm(projects, 'epsilon', ENV, 1).status, 'previsto');
  await watcher.check();
  assert.equal((await mine()).length, 1);
});
