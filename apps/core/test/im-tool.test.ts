// `im.add` (D-167, tappa P4b): "per il prossimo IM…" said to Arianna writes an
// item in the IM file of the project, by code; the model reads one line.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createContext, createLabelRules } from '@arianna/policy';

import { addImTool, applyImProposal, imProposalOf, type ImProposal, type ImToolEnv, type ImToolOutcome } from '../src/orchestrator/im-tool.ts';
import { runTool, type ToolEnv } from '../src/orchestrator/tools.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-tool-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
const EMPTY = join(HOME, 'repos', 'vuoto');
const SECRET = join(HOME, 'repos', 'riservato');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// Fake data only.
const IM32 = '---\nim: 32\ndata: 2026-10-08 10:00\nstato: chiuso\n---\n\n# IM-32\n\n## Lavori\n\n- [x] Pagamento — Parte 1\n';
const IM33 = '---\nim: 33\ndata: 2026-10-15 10:00\nstato: previsto\n---\n\n# IM-33\n\n## Lavori\n\n- [ ] Fatture\n\n## Note\n\nLibere.\n';
write(BOX, { 'IM/IM-32.md': IM32, 'IM/IM-33.md': IM33, 'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n' });
write(EMPTY, { 'parte/.git/HEAD': 'ref: refs/heads/main\n', 'Workplan/piano.md': '# Piano\n' });
write(SECRET, {
  'parte/.git/HEAD': 'ref: refs/heads/main\n',
  'IM/IM-5.md': '---\nim: 5\ndata: 2026-10-14 09:30\nstato: previsto\nlabel: L2\n---\n\n## Lavori\n\n- [ ] Bilancio\n',
});

const PROJECTS: Project[] = [
  { name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' },
  { name: 'vuoto', path: 'repos/vuoto', absolute: EMPTY, label: 'L1' },
  { name: 'riservato', path: 'repos/riservato', absolute: SECRET, label: 'L1' },
];
const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
// Saturday 10 October 2026, 9:00 local time: IM-33 (Thursday 15) is the current one.
const NOW = new Date(2026, 9, 10, 9, 0);
const ENV: ImToolEnv = { projects: () => PROJECTS, knowledge: { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) }, now: () => NOW };

const call = (args: Record<string, unknown>, workspace?: string, effective: 'L0' | 'L1' | 'L2' = 'L1') => addImTool(ENV, { args, workspace, effective });
const errorOf = (outcome: ImToolOutcome): string => (outcome.kind === 'error' ? outcome.error : assert.fail(`expected an error, got: ${JSON.stringify(outcome)}`));

describe('im.add (D-167, P4b)', () => {
  it('"per il prossimo IM": the item goes in the next IM, created seven days after the current one', () => {
    const outcome = call({ project: 'progetto-test', title: 'Esportazione CSV' });
    assert.deepEqual(outcome, { kind: 'done', text: 'Aggiunta a IM-34 (giovedì 22 ottobre 2026, 10:00) di progetto-test: Esportazione CSV', label: 'L1' });
    assert.match(readFileSync(join(BOX, 'IM', 'IM-34.md'), 'utf8'), /- \[ \] Esportazione CSV/);
  });

  it('"per questo IM": the item goes in the current IM, the rest of the file untouched', () => {
    const outcome = call({ project: 'progetto-test', title: '  Tema scuro ', which: 'current' });
    assert.deepEqual(outcome, { kind: 'done', text: 'Aggiunta a IM-33 (giovedì 15 ottobre 2026, 10:00) di progetto-test: Tema scuro', label: 'L1' });
    const text = readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8');
    assert.match(text, /- \[ \] Fatture\n- \[ \] Tema scuro\n/);
    assert.match(text, /## Note\n\nLibere\.\n$/);
  });

  it('without "project" the conversation’s project is used', () => {
    const outcome = call({ title: 'Report mensile', which: 'current' }, 'progetto-test');
    assert.equal(outcome.kind === 'done' && outcome.text, 'Aggiunta a IM-33 (giovedì 15 ottobre 2026, 10:00) di progetto-test: Report mensile');
  });

  it('an item already there is not written twice', () => {
    assert.equal(errorOf(call({ project: 'progetto-test', title: 'Fatture', which: 'current' })), 'IM-33 ha già questa voce');
  });

  it('an unknown project is refused with the known names; none at all asks which', () => {
    assert.equal(errorOf(call({ project: 'altro', title: 'Fatture' })), "il progetto 'altro' non esiste fra quelli approvati (progetti noti: progetto-test, vuoto, riservato)");
    assert.match(errorOf(call({ title: 'Fatture' })), /^manca il progetto: .*progetto-test, vuoto, riservato/);
  });

  it('an empty, multi-line or too long title is refused', () => {
    for (const title of ['', '   ', 'Fatture\nPagamenti', 'x'.repeat(301), 42]) {
      assert.match(errorOf(call({ project: 'progetto-test', title })), /il titolo deve essere una riga sola/);
    }
  });

  it('"which" other than next or current is refused', () => {
    assert.match(errorOf(call({ project: 'progetto-test', title: 'Fatture', which: 'domani' })), /"which" deve essere/);
  });

  it('a project without IM gets the readable error, and no folder is created', () => {
    assert.equal(errorOf(call({ project: 'vuoto', title: 'Fatture' })), 'il progetto non ha ancora IM con una data: crea il primo dal cardwall');
    assert.equal(existsSync(join(EMPTY, 'IM')), false);
  });

  it('a step that read data above the IM writes nothing: the user confirms the exact text first', () => {
    const before = readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8');
    assert.deepEqual(call({ project: 'progetto-test', title: ' Affitto ', which: 'current' }, undefined, 'L2'), {
      kind: 'confirm',
      proposal: { project: 'progetto-test', which: 'current', number: 33, date: '2026-10-15 10:00', dateText: 'giovedì 15 ottobre 2026, 10:00', imLabel: 'L1', title: 'Affitto' },
    });
    assert.equal(readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8'), before);
    // The next IM: its number and date as the core finds or creates it, and no file written now.
    const next = call({ project: 'progetto-test', title: 'Cassa' }, undefined, 'L2');
    assert.equal(next.kind === 'confirm' && `${String(next.proposal.number)} ${next.proposal.dateText}`, '34 giovedì 22 ottobre 2026, 10:00');
    // An IM raised to L2 by its header takes an L2 step at once, and the result carries its label.
    assert.deepEqual(call({ project: 'riservato', title: 'Bilancio 2027', which: 'current' }, undefined, 'L2'), {
      kind: 'done',
      text: 'Aggiunta a IM-5 (mercoledì 14 ottobre 2026, 09:30) di riservato: Bilancio 2027',
      label: 'L2',
    });
    // Its next IM would be a new file of an Interno folder: confirmed first.
    assert.equal(call({ project: 'riservato', title: 'Cassa' }, undefined, 'L2').kind, 'confirm');
  });

  it('without the IM of the projects the tool answers with an error', () => {
    assert.match(errorOf(addImTool(undefined, { args: { project: 'progetto-test', title: 'Fatture' }, workspace: undefined, effective: 'L1' })), /non sono disponibili/);
  });

  it('the confirmed item is written exactly where the card said, once', () => {
    const proposal: ImProposal = { project: 'progetto-test', which: 'next', number: 99, date: '2026-10-29 10:00', dateText: 'giovedì 29 ottobre 2026, 10:00', imLabel: 'L1', title: 'Rinnovo dominio' };
    // IM-99 is not the next one: refused, nothing created.
    assert.match(errorOf(applyImProposal(ENV, proposal)), /IM-99 non è più il prossimo/);
    assert.equal(existsSync(join(BOX, 'IM', 'IM-99.md')), false);
    const current: ImProposal = { ...proposal, which: 'current', number: 33, date: '2026-10-15 10:00' };
    assert.deepEqual(applyImProposal(ENV, current), { kind: 'done', text: 'Aggiunta a IM-33 (giovedì 15 ottobre 2026, 10:00) di progetto-test: Rinnovo dominio', label: 'L1' });
    // A step that runs again finds it there: said, not written twice.
    assert.deepEqual(applyImProposal(ENV, current), { kind: 'done', text: 'Già presente in IM-33 (giovedì 15 ottobre 2026, 10:00) di progetto-test: Rinnovo dominio', label: 'L1' });
    assert.equal(readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8').split('Rinnovo dominio').length, 2);
    // An IM now below what the user confirmed, or a project no longer approved: refused.
    assert.match(errorOf(applyImProposal(ENV, { ...current, imLabel: 'L2' })), /livello più basso/);
    assert.match(errorOf(applyImProposal(ENV, { ...current, project: 'altro' })), /non è più fra quelli approvati/);
    assert.match(errorOf(applyImProposal(undefined, current)), /non sono disponibili/);
  });

  it('the proposal of an approval: only a whole detail of kind im', () => {
    const detail = { project: 'progetto-test', which: 'next', number: 34, date: '2026-10-22 10:00', dateText: 'giovedì 22 ottobre 2026, 10:00', imLabel: 'L1', title: 'Fatture', step: 2 };
    assert.equal(imProposalOf({ kind: 'im', detail })?.title, 'Fatture');
    assert.equal(imProposalOf({ kind: 'commitment', detail }), undefined);
    assert.equal(imProposalOf({ kind: 'im', detail: { ...detail, which: 'domani' } }), undefined);
    assert.equal(imProposalOf({ kind: 'im', detail: { ...detail, imLabel: 'L9' } }), undefined);
    assert.equal(imProposalOf({ kind: 'im', detail: { ...detail, number: '34' } }), undefined);
  });

  it('through runTool: a result for the model, errors prefixed as the other tools', async () => {
    const env = (ims?: ImToolEnv): ToolEnv => ({
      sql: undefined as never,
      kb: undefined as never,
      task: { id: 't1', conversationId: null } as never,
      context: createContext('L1', 'L1'),
      autonomy: 'A1',
      ...(ims === undefined ? {} : { ims }),
    });
    const ok = await runTool('im.add', { project: 'progetto-test', title: 'Backup notturno', which: 'next' }, env(ENV));
    assert.deepEqual(ok, { text: 'Aggiunta a IM-34 (giovedì 22 ottobre 2026, 10:00) di progetto-test: Backup notturno', label: 'L1' });
    const refused = await runTool('im.add', { project: 'nessuno', title: 'Fatture' }, env(ENV));
    assert.equal(refused.label, 'L0');
    assert.match(refused.text, /^error: im\.add: il progetto 'nessuno' non esiste/);
    // Above the IM: nothing written, the proposal for the orchestrator to ask.
    const above = await runTool('im.add', { project: 'progetto-test', title: 'Ferie', which: 'current' }, { ...env(ENV), context: createContext('L2', 'L2') });
    assert.equal(above.confirm?.number, 33);
  });
});
