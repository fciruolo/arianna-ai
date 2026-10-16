// Projects as containers (I-11, D-145): the parts found on the disk, the
// management folders with their labels, `parts` and `[[project.folder]]`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { defaultFolderLabel, homeRelativePath, managementFolders, parseConfig, projectNamed, projectParts, projectProblemText, resolveHome, workParts, type Project } from '../src/index.ts';

const ROOT = join(resolveHome({}), 'data', 'test-tmp', `projects-${randomUUID()}`);
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A folder with the given subfolders; `git` ones get a `.git` folder, as the top of a repository. */
function container(name: string, folders: string[], git: string[] = [], self = false): Project {
  const absolute = join(ROOT, name);
  mkdirSync(absolute, { recursive: true });
  for (const folder of folders) mkdirSync(join(absolute, folder), { recursive: true });
  for (const folder of git) mkdirSync(join(absolute, folder, '.git'), { recursive: true });
  if (self) mkdirSync(join(absolute, '.git'));
  return { name, path: `repos/${name}`, absolute, label: 'L1' };
}

describe('parts of a container', () => {
  it('a container that is a git repository is its only part, named as the project (every project before D-145)', () => {
    const project = container('uno', ['src', 'Workplan', 'admin'], ['admin'], true);
    assert.deepEqual(projectParts(project), [{ ...project, project: 'uno', container: project.absolute, part: null }]);
  });

  it('a missing folder stays one part: opening it says why, as before', () => {
    const project: Project = { name: 'manca', path: 'repos/manca', absolute: join(ROOT, 'manca'), label: 'L1' };
    assert.deepEqual(projectParts(project).map(({ name, part }) => [name, part]), [['manca', null]]);
  });

  it('otherwise the parts are the git subfolders, never the container itself', () => {
    const project = container('progetto-test', ['Workplan', 'IM', 'documenti', 'progetto-test-admin', 'progetto-test-client', 'senza-git'], ['progetto-test-admin', 'progetto-test-client', '.nascosto']);
    symlinkSync(join(project.absolute, 'progetto-test-admin'), join(project.absolute, 'alias-admin'));
    const parts = projectParts(project);
    assert.deepEqual(
      parts.map(({ name, path, absolute, part, project: owner }) => [name, path, absolute, part, owner]),
      [
        ['progetto-test:progetto-test-admin', 'repos/progetto-test/progetto-test-admin', join(project.absolute, 'progetto-test-admin'), 'progetto-test-admin', 'progetto-test'],
        ['progetto-test:progetto-test-client', 'repos/progetto-test/progetto-test-client', join(project.absolute, 'progetto-test-client'), 'progetto-test-client', 'progetto-test'],
      ],
    );
    assert.ok(parts.every((part) => part.absolute !== project.absolute && part.label === 'L1'));
    // A conversation names a part; the container alone is no part of it.
    assert.equal(projectNamed(workParts([project]), 'progetto-test'), undefined);
    assert.equal(projectNamed(workParts([project]), 'progetto-test:progetto-test-client')?.part, 'progetto-test-client');
  });

  it('`parts` keeps only the listed folders, ignoring case; a container without git folders has no part', () => {
    const project = { ...container('lista', ['a', 'b'], ['a', 'b']), parts: ['B'] };
    assert.deepEqual(projectParts(project).map(({ part }) => part), ['b']);
    assert.deepEqual(projectParts(container('vuoto', ['Workplan'])), []);
  });
});

describe('management folders (D-145)', () => {
  it('Workplan and IM are Interne (L1), any other Privata (L2), ignoring case', () => {
    assert.equal(defaultFolderLabel('Workplan'), 'L1');
    assert.equal(defaultFolderLabel('WORKPLAN'), 'L1');
    assert.equal(defaultFolderLabel('im'), 'L1');
    assert.equal(defaultFolderLabel('documenti'), 'L2');
    assert.equal(defaultFolderLabel('Workplan-vecchio'), 'L2');
    assert.equal(defaultFolderLabel('immagini'), 'L2');
  });

  it('every non-git, non-hidden subfolder of a container, with the label the user chose', () => {
    const project = { ...container('gestione', ['workplan', 'IM', 'documenti', 'admin', 'node_modules', '.privata'], ['admin']), folders: [{ path: 'Documenti', label: 'L3' as const }, { path: 'IM', label: 'L2' as const }] };
    symlinkSync(join(project.absolute, 'documenti'), join(project.absolute, 'collegamento'));
    assert.deepEqual(managementFolders(project), [
      { path: 'documenti', label: 'L3', defaultLabel: 'L2', chosen: true },
      { path: 'IM', label: 'L2', defaultLabel: 'L1', chosen: true },
      { path: 'workplan', label: 'L1', defaultLabel: 'L1', chosen: false },
    ]);
  });

  it('in a container that is one git, only the folders known by name, always with their label by name', () => {
    // The choices of [[project.folder]] are for kb/progetti/<project>: they never lower nor add a folder of the code.
    const project = { ...container('un-git', ['src', 'Workplan', 'Documenti', 'note'], [], true), folders: [{ path: 'note', label: 'L2' as const }, { path: 'Documenti', label: 'L0' as const }] };
    assert.deepEqual(managementFolders(project).map(({ path, label, chosen }) => [path, label, chosen]), [['Documenti', 'L2', false], ['Workplan', 'L1', false]]);
  });
});

describe('parts and folders in arianna.toml', () => {
  const HOME = resolve('some-home');
  const parse = (extra: string) => parseConfig(`[paths]\ndata = "data"\n\n[database]\nhost = "127.0.0.1"\nport = 5432\nname = "arianna"\nuser = "arianna"\n\n[[project]]\nname = "box"\npath = "repos/box"\n${extra}\n`, HOME, undefined, resolve('some-user')).projects;

  it('reads `parts` and [[project.folder]]; a project without them as before', () => {
    assert.deepEqual(parse(''), [{ name: 'box', path: 'repos/box', absolute: join(HOME, 'repos', 'box'), label: 'L1' }]);
    const [project] = parse('parts = ["box-admin"]\n\n[[project.folder]]\npath = "Workplan"\nlabel = "L2"\n');
    assert.deepEqual(project?.parts, ['box-admin']);
    assert.deepEqual(project.folders, [{ path: 'Workplan', label: 'L2' }]);
  });

  it('reads `planner` (D-235): opus, sonnet or local; absent, no key', () => {
    for (const planner of ['opus', 'sonnet', 'local'] as const) assert.equal(parse(`planner = "${planner}"`)[0]?.planner, planner);
    assert.equal('planner' in (parse('')[0] ?? {}), false);
  });

  it('refuses a `planner` that is not opus, sonnet or local (D-235)', () => {
    for (const extra of ['planner = "fable"', 'planner = "Opus"', 'planner = ""', 'planner = true']) assert.throws(() => parse(extra), /planner/, extra);
  });

  it('refuses a part or a folder that is a path, hidden, twice, or a label that is not one', () => {
    for (const extra of [
      'parts = ["../fuori"]',
      'parts = [".git"]',
      'parts = ["a/b"]',
      'parts = ["a", "A"]',
      '[[project.folder]]\npath = "../fuori"\nlabel = "L1"',
      '[[project.folder]]\npath = ".segreti"\nlabel = "L1"',
      '[[project.folder]]\npath = "a/b"\nlabel = "L1"',
      '[[project.folder]]\npath = "IM"\nlabel = "L5"',
      '[[project.folder]]\npath = "IM"\nlabel = "L1"\n\n[[project.folder]]\npath = "im"\nlabel = "L2"',
      '[[project.folder]]\npath = "IM"\nlabel = "L1"\nnote = "x"',
    ]) {
      assert.throws(() => parse(extra), /project\[0\]/, extra);
    }
  });
});

// A file in a folder that is not plain: the folder is not listed at all.
it('a management folder that is a file or a link is not a folder', () => {
  const project = container('file', []);
  writeFileSync(join(project.absolute, 'Workplan'), 'non una cartella\n');
  assert.deepEqual(managementFolders(project), []);
});

describe('a project path as typed (D-228)', () => {
  const user = join(ROOT, 'utente');

  it('a full path under the home becomes ~/..., also with spaces and slashes at the end', () => {
    assert.equal(homeRelativePath(join(user, 'Sites', 'negozio-finto'), user), '~/Sites/negozio-finto');
    assert.equal(homeRelativePath(`  ${join(user, 'Sites', 'negozio')}// `, user), '~/Sites/negozio');
    assert.equal(homeRelativePath('~/Sites/negozio/', user), '~/Sites/negozio');
    assert.equal(homeRelativePath('repos/demo/', user), 'repos/demo');
    assert.equal(homeRelativePath(user, user), '~');
    // The disk ignores case: the home typed in other case is still the home.
    assert.equal(homeRelativePath(join(user.toUpperCase(), 'Sites', 'x'), user), '~/Sites/x');
  });

  it('only the form changes: dots, hidden folders and double slashes stay in the path, for parseProjects to refuse', () => {
    const dotted = ['a', '..', 'b'].join('/');
    assert.equal(homeRelativePath(`${user}/${dotted}`, user), `~/${dotted}`);
    assert.equal(homeRelativePath(`${user}/./x`, user), '~/./x');
    assert.equal(homeRelativePath(`${user}//x`, user), '~//x');
    assert.equal(homeRelativePath(`${user}/.ssh`, user), '~/.ssh');
    assert.equal(homeRelativePath(`${user}/Library/x`, user), '~/Library/x');
  });

  it('a path elsewhere, a folder whose name only starts like the home, or a home that is not absolute stay as typed', () => {
    assert.equal(homeRelativePath(join(ROOT, 'altrove', 'sito'), user), join(ROOT, 'altrove', 'sito'));
    assert.equal(homeRelativePath(`${user}-altro/sito`, user), `${user}-altro/sito`);
    assert.equal(homeRelativePath(join(user, 'x'), 'relative/home'), join(user, 'x'));
    assert.equal(homeRelativePath('/', user), '/');
  });
});

describe('refusals of the project list in Italian (D-228)', () => {
  const VALID = '[paths]\ndata = "data"\n\n[database]\nhost = "127.0.0.1"\nport = 54329\nname = "arianna"\nuser = "arianna"\n';
  const home = join(ROOT, 'casa-arianna');
  const user = join(ROOT, 'utente');
  const refusal = (sections: string, userHome = user): string => {
    try {
      parseConfig(`${VALID}\n${sections}\n`, home, undefined, userHome);
    } catch (error) {
      if (error instanceof Error) return error.message;
    }
    assert.fail(`not refused: ${sections}`);
  };
  const project = (name: string, path: string, label = 'L1') => `[[project]]\nname = "${name}"\npath = "${path}"\nlabel = "${label}"\n`;

  it('every refusal of a project path, name, label or list has its Italian text, with no English left', () => {
    const cases: [string, RegExp][] = [
      [project('casa', '~'), /cartella utente intera/],
      [project('casa', user), /cartella utente intera/],
      [project('assoluto', join(user, 'Sites', 'negozio')), /^Scrivi la cartella come ~\/Sites\/negozio:/],
      [project('altrove', join(ROOT, 'altrove')), /altrove sul disco/],
      [project('rel', 'Sites/negozio'), /oppure repos\/<nome>/],
      [project('nascosta', '~/.ssh'), /cartelle nascoste/],
      [project('lib', '~/Library/x'), /^Library contiene/],
      [project('demo', 'repos/altro'), /qui repos\/demo\.$/],
      [project('Maiuscole', '~/x'), /lettere minuscole/],
      [project('privato', '~/x', 'L2'), /Pubblico o Interno/],
      [`${project('a', '~/a')}\n${project('a', '~/b')}`, /^Il progetto a compare due volte\.$/],
      [`${project('a', '~/p')}\n${project('b', '~/p/b')}`, /^I progetti a e b sono la stessa cartella/],
    ];
    for (const [sections, italian] of cases) {
      const text = projectProblemText(refusal(sections));
      assert.ok(text !== undefined, sections);
      assert.match(text, italian);
      assert.doesNotMatch(text, /\b(write|must|folder|project)\b/);
    }
    assert.match(projectProblemText(refusal(project('x', '~/x'), 'relative/home')) ?? '', /HOME/);
  });

  it('other messages are not translated', () => {
    assert.equal(projectProblemText('roles.orchestrator: unknown model'), undefined);
    assert.equal(projectProblemText('project[0].path: something new'), undefined);
    assert.equal(projectProblemText('voice.port: must differ from server.port'), undefined);
  });
});
