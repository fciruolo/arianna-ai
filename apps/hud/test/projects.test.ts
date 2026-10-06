// The page "Progetti" (D-134): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agoText, changeMark, childPath, commandText, confirmText, fileBadge, firstChangedLine, highlightLine, isProjectsPath, serviceStateText, sizeText, vscodeUrl, type ServiceState } from '../src/lib/projects.ts';

test('the address of the page', () => {
  assert.equal(isProjectsPath('/progetti'), true);
  assert.equal(isProjectsPath('/progetti/'), true);
  assert.equal(isProjectsPath('/progetti/x'), false);
  assert.equal(isProjectsPath('/pensieri'), false);
});

test('"Apri in VS Code": a vscode://file link, encoded, with the line when known', () => {
  assert.equal(vscodeUrl('/srv/orto'), 'vscode://file/srv/orto');
  assert.equal(vscodeUrl('/srv/orto/', 'src/a b.ts', 12), 'vscode://file/srv/orto/src/a%20b.ts:12');
  assert.equal(vscodeUrl('/x', 'q?#.ts'), 'vscode://file/x/q%3F%23.ts');
});

test('badges by kind, marks of git on files and folders', () => {
  assert.deepEqual(fileBadge('App.vue'), { text: 'VUE', tone: 'vue' });
  assert.deepEqual(fileBadge('orto.PNG'), { text: 'IMG', tone: 'img' });
  assert.equal(fileBadge('Makefile').text, '');
  assert.equal(fileBadge('.env').text, '');
  const changes = [
    { path: 'src/a.ts', change: 'modified' as const },
    { path: 'src/new.ts', change: 'added' as const },
    { path: 'docs/n.md', change: 'added' as const },
    { path: 'gone.ts', change: 'deleted' as const },
  ];
  assert.equal(changeMark(changes, 'src/a.ts', 'file'), 'M');
  assert.equal(changeMark(changes, 'src/new.ts', 'file'), 'A');
  assert.equal(changeMark(changes, 'src', 'dir'), 'M');
  assert.equal(changeMark(changes, 'docs', 'dir'), 'A');
  assert.equal(changeMark(changes, 'gone.ts', 'file'), undefined);
  assert.equal(changeMark(changes, 'sr', 'dir'), undefined);
  assert.equal(childPath('', 'src'), 'src');
  assert.equal(childPath('src', 'a.ts'), 'src/a.ts');
});

test('sizes and times in Italian', () => {
  assert.equal(sizeText(840), '840 B');
  assert.equal(sizeText(2100), '2,1 kB');
  assert.equal(sizeText(1_400_000), '1,4 MB');
  const now = 1_000_000_000_000;
  assert.equal(agoText(now / 1000 - 10, now), 'ora');
  assert.equal(agoText(now / 1000 - 300, now), '5 min fa');
  assert.equal(agoText(now / 1000 - 7200, now), '2 ore fa');
  assert.equal(agoText(now / 1000 - 86_400 * 1.5, now), 'ieri');
  assert.equal(agoText(now / 1000 - 86_400 * 3, now), '3 giorni fa');
});

test('the highlighter: strings, numbers, keywords and comments as tokens, the text unchanged', () => {
  const line = "const crops = ['pomodori', 3]; // <b>not HTML</b>";
  const tokens = highlightLine(line, 'ts');
  assert.equal(tokens.map(({ text }) => text).join(''), line);
  assert.deepEqual(tokens[0], { kind: 'keyword', text: 'const' });
  assert.ok(tokens.some((token) => token.kind === 'string' && token.text === "'pomodori'"));
  assert.ok(tokens.some((token) => token.kind === 'number' && token.text === '3'));
  assert.deepEqual(tokens.at(-1), { kind: 'comment', text: '// <b>not HTML</b>' });
  assert.deepEqual(highlightLine('# titolo', 'yml'), [{ kind: 'comment', text: '# titolo' }]);
  assert.deepEqual(highlightLine('# Orto', 'md'), [{ kind: 'plain', text: '# Orto' }]);
  assert.equal(highlightLine("'unterminated", 'ts')[0]?.kind, 'string');
  assert.equal(
    highlightLine('v2 = x1', 'py').some((token) => token.kind === 'number'),
    false,
  );
});

test('the first changed line of a diff', () => {
  const hunks = [
    {
      oldStart: 4,
      oldLines: 3,
      newStart: 4,
      newLines: 4,
      lines: [
        { kind: 'context' as const, text: 'a' },
        { kind: 'removed' as const, text: 'b' },
        { kind: 'added' as const, text: 'c' },
      ],
    },
  ];
  assert.equal(firstChangedLine(hunks), 5);
  assert.equal(firstChangedLine([]), undefined);
});

test('the confirmation of the tab Servizi: the command, its file, how long it may run', () => {
  const dev: ServiceState = { id: 'package.json:dev', source: 'package.json', file: 'package.json', name: 'dev', command: ['pnpm', 'run', 'dev'], script: 'vite', ports: [5180], stays: true, fingerprint: '0123456789abcdef', on: false, run: null };
  assert.deepEqual(confirmText(dev, false), { title: 'Avviare “dev”?', command: 'pnpm run dev', from: 'package.json → scripts.dev', duration: 'resta acceso finché lo fermi o chiudi Arianna' });
  assert.equal(confirmText({ ...dev, stays: false, name: 'test' }, false).duration, 'si ferma da solo dopo 10 minuti');
  const db: ServiceState = { ...dev, id: 'compose:db', source: 'compose', file: 'compose.yaml', name: 'db', command: ['docker', 'compose', '-f', 'compose.yaml', 'up', '-d', 'db'], ports: [], on: false };
  assert.equal(confirmText(db, true).command, 'docker compose -f compose.yaml stop db');
  assert.equal(confirmText(db, false).duration, 'resta acceso con Docker finché lo fermi');
  assert.equal(commandText(['node', '-e', "console.log('x')"]), "node -e 'console.log('\\''x'\\'')'");
  assert.equal(serviceStateText(db), 'stato sconosciuto');
  assert.equal(serviceStateText({ ...dev, on: true }), 'acceso');
  assert.equal(serviceStateText(dev), 'spento');
});
