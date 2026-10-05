// "Sviluppo di Arianna" (D-102): the parsers of the documents, on excerpts of
// the real ones, the answers appended to docs/RISPOSTE.md, and the routes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck, secretMatcher } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import {
  ANSWERS_FILE,
  ANSWERS_HEADER,
  buildProgress,
  cells,
  cleanAnswer,
  decisionState,
  DevAnswerError,
  eventKey,
  formatAnswer,
  loadProgress,
  MAX_ANSWER_CHARS,
  parseAnswers,
  parseDecisions,
  parseEpics,
  parseHandoff,
  parseOpenQuestions,
  parseProposals,
  parseTasks,
  saveAnswer,
  type AnswerGate,
  type OpenQuestion,
} from '../src/dev-progress.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `dev-progress-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Excerpts of docs/DECISIONS.md as of 2026-10-05 (decision texts shortened where long).
const DECISIONS = `# Registro delle decisioni

| Id | Data | Decisione | Motivo | Stato |
| --- | --- | --- | --- | --- |
| D-001 | 2026-10-02 | Livelli di privacy L0-L3, default-deny, gateway unico | Garantire che L2/L3 non escano | Accettata |
| D-004 | 2026-10-02 | Coda e scheduler: tabella \`jobs\` propria su PostgreSQL (\`FOR UPDATE SKIP LOCKED\`) dietro l'interfaccia \`JobQueue\` | Zero dipendenze | Proposta, applicata: la tabella \`jobs\` esiste dal task 0.3, il consumo della coda arriva con il task 1.8 |
| D-006 | 2026-10-02 | pixel-agents integrato con \`HookProvider\` proprio (MIT) | Riuso senza dipendere da Claude Code | Sostituita da D-011 |
| D-022 | 2026-10-02 | Fatture dall'XML FatturaPA prima dell'OCR | Le fatture elettroniche hanno già i campi esatti | Proposta (Fase 2) |
| D-064 | 2026-10-04 | Errori leggibili e chat di sistema (richiesta dell'utente: "non mostrare solo Fallito") | Oggi un fallimento lascia solo "Fallito" | Accettata (2026-10-04, scelte dell'utente). **Prima parte applicata** (2026-10-04, migrazione \`0013\`) |
| D-075 | 2026-10-04 | Prompt dell'orchestratore appena sopra i 2048 token | La finestra mobile cambiava il prompt | Proposta, in prova |
| D-079 | 2026-10-05 | Catalogo "Agenzia" da agency-agents: \`pnpm agency:import [--propose <slug> ...\\|--propose-all]\` | Ispirazione | Proposta; prima parte applicata: da confermare |
| D-081 | 2026-10-05 | Prova di un modello del catalogo con gli eval dell'orchestratore, in background | Provare un modello nuovo | Proposta, applicata: da confermare |
| D-099 | 2026-10-05 | Riga con una cella in meno | Motivo |
| D-1 | 2026-10-05 | Id malformato | Motivo | Accettata |
`;

// Excerpts of docs/PROPOSTE.md (the D-096 code block holds lines that look like headings).
const PROPOSALS = `# Proposte da discutere (notte 2026-10-05)

## D-078 — Arianna sviluppata da dentro Arianna

- **Stato:** Proposta, da discutere

### Domande per l'utente

1. **Clone separato \`~/arianna-dev\` come progetto L1, con le modifiche portate nell'installazione solo con \`git pull\`?** Raccomandazione: sì; è l'unica forma che non apre \`data/\` e non richiede di allentare D-058.
2. **Memoria di sviluppo: (c1) tutto nel clone; oppure (c2) un file distinto?** Raccomandazione: (c1);
   con (c2) due memorie vanno tenute allineate a mano.
3. Chi fa il commit nel clone? Raccomandazione: l'utente, a mano.

---

## D-096 — Backup cifrato notturno, 3-2-1, con prova di ripristino

### Proposta

\`\`\`sh
# 1. Decifrare in una cartella privata sotto data/
# 2. Stesso codice del backup
\`\`\`

### Domande per l'utente

1. **Dove va la copia fuori dal Mac?** (a) Synology di casa; (b) un secondo sito. Raccomandazione: (a) subito e (b) appena possibile.

### Cose non verificate (D-096)

1. Questa non è una domanda.

## Cose non verificate

- Numeri di stelle, commit e date.
`;

const TASKS = `# Task delle Fasi 0 e 1

## Fase 0 — Fondamenta (13-21 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 0.1 | Monorepo pnpm, TypeScript strict, lint, script in CLAUDE.md | 2-3 | 0,1 (solo sessione di Claude) | \`pnpm build/test/lint\` girano |

## Fase 1A — Percorso critico (65-97 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 1.10 | Orchestratore locale con strumenti a schema vincolato, contesto per task | 7-10 | 2,6 finora (solo sessione di Claude) | Test di accettazione |
| 1.15 | Telegram: notifiche e chat L0/L1 | 4-6 | 1,5 (solo sessione di Claude, D-044; aperto fino alla prova dal telefono) | Approvazione da telefono |
| 1.12 | Riga rotta | 4-6 |

## Fase 1B — Completamenti (25-39 h)

| Id | Task | Ore | Reali | Fatto quando |
| --- | --- | --- | --- | --- |
| 1.16 | Adattatore \`codex exec --json\` con lo stesso profilo di confinamento; scheda Reviewer | 4-7 | | Compito banale e canarino |
`;

const ROADMAP = `## Epic per fase (ore)

**Fase 2 (64-96), in ordine di valore:** fatture da XML FatturaPA e scadenziario in Postgres, poi OCR per la carta 14-20 · cardwall backend e UI 12-18 · archivio e ingestione 8-12 (in parte anticipati: cattura in \`kb/inbox/\` D-080, riordino col modello locale D-086; mancano archivio cifrato, link, PDF, vocali e video) · export/import cifrati 4-6.

**Fase 3 (43-69):** layout HUD e WebSocket 10-15 · pagina Impostazioni 8-14 (anticipata: D-071; prove dei modelli in background D-081).

**Richieste nuove dell'utente (2026-10-05, ore da stimare).** Vicino a "archivio e ingestione" della Fase 2: pagina "Pensieri".
`;

const OPEN_QUESTIONS = `# Decisioni aperte e idee da scegliere

## Decisioni aperte

| Decisione | Proposta | Entro |
| --- | --- | --- |
| ~~Linguaggio del nucleo~~ | **Deciso: TypeScript** (D-003) | |
| Dove gira il server | Mac Studio all'inizio, dietro interfaccia sostituibile | Fase 1A |
| Riga rotta | senza terza cella |

### Domande delle proposte della notte del 2026-10-05

| Proposta | Domanda | Stato |
| --- | --- | --- |
| D-078 Sviluppo da dentro Arianna | 1. Clone separato del repository sotto la home come progetto L1? | Aperta |
| D-078 | 2. Una sola memoria di sviluppo? | Aperta |
| D-088 Pulsante "Aggiorna" | Come si porta il codice nuovo dallo sviluppo all'installazione? | Proposta, da discutere |

## Idee dalla ricerca — da decidere

| # | Idea | Fase | Ore | Raccomandazione |
| --- | --- | --- | --- | --- |
| 1 | Pattern Dual LLM / CaMeL | 2 | 12-20 | **Sì**, prima che il Segretario legga posta vera |
| 3 | DBOS per esecuzione durevole | 0-1 | 6-10 | **No per ora** |
| x | Riga senza numero | 1 | 1 | No |
`;

const HANDOFF = `# Consegna fra conversazioni

**Coda dell'utente (richieste di stanotte, risposte sue), in ordine:** (1) **Barra sinistra come Claude Code**, dall'alto: icona per collassare (via "locale"); campo "Cerca". (2) **Barra destra** con la stessa logica. (3) Pensieri: microfono da collegare **di giorno con l'utente** (tocca \`apps/voice\`).

## In attesa dell'utente

| Cosa | Note |
| --- | --- |
| **Prova delle chiamate (D-066)** | Provare la chiamata dalla chat |
| Permessi in \`.claude/settings.json\` | Proposta: comandi in \`allow\`; \`pnpm add/install <pkg>\` | in \`ask\` |
| (storico) \`git push\` di \`main\` | vecchio |

## Modo di lavorare concordato

| Non | è una domanda |
| --- | --- |
| a | b |
`;

describe('decisions', () => {
  it('classifies the states of the register', () => {
    assert.equal(decisionState('Accettata'), 'done');
    assert.equal(decisionState('Accettata (2026-10-02, confermata dall\'utente)'), 'done');
    assert.equal(decisionState('Proposta, applicata (task 0.1)'), 'done');
    assert.equal(decisionState('Proposta, applicata: da confermare'), 'doing');
    assert.equal(decisionState('Proposta; prima parte applicata: da confermare'), 'doing');
    assert.equal(decisionState('Proposta, in prova'), 'doing');
    assert.equal(decisionState('Accettata (scelte). **Prima parte applicata** (2026-10-04)'), 'doing');
    assert.equal(decisionState('Proposta'), 'todo');
    assert.equal(decisionState('Proposta, da discutere'), 'todo');
    assert.equal(decisionState('Proposta (Fase 2)'), 'todo');
    assert.equal(decisionState('Sostituita da D-011'), 'dropped');
    assert.equal(decisionState('Rifiutata'), 'dropped');
  });

  it('reads the rows of the table, escaped pipes included, and counts the malformed ones', () => {
    const { values, skipped } = parseDecisions(DECISIONS);
    assert.deepEqual(
      values.map((row) => [row.id, row.state]),
      [
        ['D-001', 'done'],
        ['D-004', 'done'],
        ['D-006', 'dropped'],
        ['D-022', 'todo'],
        ['D-064', 'doing'],
        ['D-075', 'doing'],
        ['D-079', 'doing'],
        ['D-081', 'doing'],
      ],
    );
    assert.equal(skipped, 2);
    // Markdown out, first clause only, never cut inside a parenthesis.
    assert.equal(values[1]?.title, "Coda e scheduler: tabella jobs propria su PostgreSQL (FOR UPDATE SKIP LOCKED) dietro l'interfaccia JobQueue");
    assert.equal(values[4]?.title, 'Errori leggibili e chat di sistema');
  });

  it('splits table cells on pipes that are not escaped', () => {
    assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b \\| c', 'd']);
    assert.equal(cells('not a row'), undefined);
  });
});

describe('proposals', () => {
  it('reads titles and numbered questions, skipping code blocks and other sections', () => {
    const { titles, questions, skipped } = parseProposals(PROPOSALS);
    assert.deepEqual([...titles.keys()], ['D-078', 'D-096']);
    assert.equal(titles.get('D-096'), 'Backup cifrato notturno, 3-2-1, con prova di ripristino');
    assert.deepEqual(
      questions.map((question) => `${question.id}#${String(question.number)}`),
      ['D-078#1', 'D-078#2', 'D-078#3', 'D-096#1'],
    );
    assert.equal(questions[0]?.text, "Clone separato ~/arianna-dev come progetto L1, con le modifiche portate nell'installazione solo con git pull?");
    assert.match(questions[0].detail ?? '', /^Raccomandazione: sì/);
    // A continuation line joins its question.
    assert.match(questions[1]?.detail ?? '', /due memorie vanno tenute allineate a mano/);
    // Without bold, the question ends at the first question mark.
    assert.equal(questions[2]?.text, 'Chi fa il commit nel clone?');
    assert.equal(skipped, 0);
  });

  it('marks as answered the questions whose number the section of answers holds, and only those', () => {
    const answeredText = `${PROPOSALS}
## D-111 — Agenti nella chat

### Domande per l'utente

1. **Quattro carte?** Raccomandazione: sì.
2. **Ospiti?**
3. **Codex?**

### Risposte dell'utente (2026-10-05, mattina, in conversazione)

1. **No:** prima Privata/Lavoro, sotto gli agenti.
3. Alla pari di Claude.

\`\`\`md
### Risposte dell'utente
2. Dentro un blocco di codice: non conta.
\`\`\`

## D-112 — Risposte prima delle domande, senza data

### Risposte dell'utente

1. Sì.

### Domande per l'utente

1. **Ora accanto ai messaggi?**

## D-113 — Risposte senza domande

### Risposte dell'utente

1. Niente da chiedere.
`;
    const { questions, answered, skipped } = parseProposals(answeredText);
    assert.deepEqual(
      [...answered].map(([id, entry]) => [id, entry.at, [...entry.numbers]]),
      [
        ['D-111', '2026-10-05', [1, 3]],
        ['D-112', '', [1]],
        ['D-113', '', [1]],
      ],
    );
    // The numbered answers are not questions.
    assert.deepEqual(
      questions.filter((question) => question.id !== 'D-078' && question.id !== 'D-096').map((question) => `${question.id}#${String(question.number)}`),
      ['D-111#1', 'D-111#2', 'D-111#3', 'D-112#1'],
    );
    assert.equal(skipped, 0);
    const progress = buildProgress({ 'PROPOSTE.md': answeredText }, undefined);
    const answerOf = (key: string) => progress.questions.find((question) => question.key === key)?.answer;
    assert.deepEqual(answerOf('D-111#1'), { state: 'done', at: '2026-10-05' });
    // A question the section does not answer stays open.
    assert.equal(answerOf('D-111#2'), null);
    assert.deepEqual(answerOf('D-111#3'), { state: 'done', at: '2026-10-05' });
    assert.deepEqual(answerOf('D-112#1'), { state: 'done', at: '' });
    assert.equal(answerOf('D-078#1'), null);
    // An answer sent from the page wins over the section.
    const fromPage = buildProgress({ 'PROPOSTE.md': answeredText }, `${ANSWERS_HEADER}\n## 2026-10-06 09:00 · D-111#1 · nuova\n\n> aggiungo\n`);
    assert.deepEqual(fromPage.questions.find((question) => question.key === 'D-111#1')?.answer, { state: 'new', at: '2026-10-06 09:00' });
  });

  it('returns nothing from a text without proposals', () => {
    const { titles, questions } = parseProposals('# Titolo\n\n1. **Domanda fuori sezione?**\n');
    assert.equal(titles.size, 0);
    assert.equal(questions.length, 0);
  });
});

describe('tasks and epics', () => {
  it('reads the tasks with their phase and state from the real hours', () => {
    const { values, skipped } = parseTasks(TASKS);
    assert.deepEqual(
      values.map((item) => [item.id, item.phase, item.state]),
      [
        ['0.1', '0', 'done'],
        ['1.10', '1A', 'doing'],
        ['1.15', '1A', 'doing'],
        ['1.16', '1B', 'todo'],
      ],
    );
    assert.equal(skipped, 1);
  });

  it('reads the epics of the roadmap, a note with "anticipat" in progress', () => {
    const { values, skipped } = parseEpics(ROADMAP);
    assert.deepEqual(
      values.map((item) => [item.id, item.title, item.state]),
      [
        ['F2.1', 'Fatture da XML FatturaPA e scadenziario in Postgres, poi OCR per la carta', 'todo'],
        ['F2.2', 'Cardwall backend e UI', 'todo'],
        ['F2.3', 'Archivio e ingestione', 'doing'],
        ['F2.4', 'Export/import cifrati', 'todo'],
        ['F3.1', 'Layout HUD e WebSocket', 'todo'],
        ['F3.2', 'Pagina Impostazioni', 'doing'],
      ],
    );
    assert.equal(skipped, 0);
  });
});

describe('open questions and handoff', () => {
  it('reads open decisions, proposals not in PROPOSTE.md and ideas', () => {
    const { questions, ideas, skipped } = parseOpenQuestions(OPEN_QUESTIONS, new Set(['D-078']));
    assert.deepEqual(
      questions.map((question) => question.key),
      ['oq-dove-gira-il-server', 'oq-D-088-come-si-porta-il-codice'],
    );
    assert.equal(questions[0]?.ref, 'Entro: Fase 1A');
    assert.equal(questions[1]?.topic, 'Pulsante "Aggiorna"');
    assert.deepEqual(
      ideas.map((idea) => [idea.id, idea.phase, idea.state]),
      [
        ['Idea 1', '2', 'todo'],
        ['Idea 3', null, 'todo'],
      ],
    );
    // The broken row of the open decisions and the idea without a number.
    assert.equal(skipped, 2);
  });

  it('keeps the questions of a proposal that PROPOSTE.md does not hold', () => {
    const { questions } = parseOpenQuestions(OPEN_QUESTIONS, new Set());
    assert.deepEqual(
      questions.filter((question) => question.ref === 'D-078').map((question) => question.key),
      ['oq-D-078-1', 'oq-D-078-2'],
    );
  });

  it('reads the queue of the user and the waiting table, leaving out the old rows', () => {
    const { requests, waiting, skipped } = parseHandoff(HANDOFF);
    assert.deepEqual(
      requests.map((item) => [item.id, item.title]),
      [
        ['Coda 1', 'Barra sinistra come Claude Code'],
        ['Coda 2', 'Barra destra'],
        ['Coda 3', 'Pensieri: microfono da collegare di giorno con l\'utente (tocca apps/voice).'],
      ],
    );
    assert.deepEqual(
      waiting.map((question) => question.key),
      ['ho-prova-delle-chiamate-d-066', 'ho-permessi-in-claude-settings-json'],
    );
    // A pipe left unescaped in the note: the rest of the row is the note.
    assert.match(waiting[1]?.detail ?? '', /pnpm add\/install <pkg> \| in ask$/);
    assert.equal(skipped, 0);
  });
});

describe('the page', () => {
  const docs = {
    'DECISIONS.md': DECISIONS,
    'PROPOSTE.md': PROPOSALS,
    'PHASE-0-1-TASKS.md': TASKS,
    'ROADMAP.md': ROADMAP,
    'OPEN-QUESTIONS.md': OPEN_QUESTIONS,
    'HANDOFF.md': HANDOFF,
  };

  it('counts the states, leaves superseded decisions out of the bar and adds proposals not yet in the register', () => {
    const progress = buildProgress(docs, undefined);
    assert.equal(progress.dropped, 1);
    assert.deepEqual(progress.missing, []);
    assert.equal(progress.items.find((item) => item.id === 'D-096')?.source, 'PROPOSTE.md');
    assert.equal(progress.items.find((item) => item.id === 'D-096')?.state, 'todo');
    const total = progress.counts.done + progress.counts.doing + progress.counts.todo;
    assert.equal(total, progress.items.length);
    assert.deepEqual(progress.skipped, { 'DECISIONS.md': 2, 'PHASE-0-1-TASKS.md': 1, 'OPEN-QUESTIONS.md': 2 });
    // Questions: proposals, confirmations of what waits for the user, open rows, waiting rows.
    assert.deepEqual(
      progress.questions.map((question) => question.key),
      [
        'D-078#1',
        'D-078#2',
        'D-078#3',
        'D-096#1',
        'conf-D-079',
        'conf-D-081',
        'oq-dove-gira-il-server',
        'oq-D-088-come-si-porta-il-codice',
        'ho-prova-delle-chiamate-d-066',
        'ho-permessi-in-claude-settings-json',
      ],
    );
  });

  it('marks the questions already answered, the latest entry winning', () => {
    const answers = `${ANSWERS_HEADER}
## 2026-10-05 07:40 · D-078#1 · evasa

> sì

## 2026-10-05 07:41 · D-078#2 · nuova

> (c1)

## 2026-10-05 07:42 · D-078#1 · nuova

> anzi, aspetta
`;
    const progress = buildProgress(docs, answers);
    const answerOf = (key: string) => progress.questions.find((question) => question.key === key)?.answer;
    assert.deepEqual(answerOf('D-078#1'), { state: 'new', at: '2026-10-05 07:42' });
    assert.deepEqual(answerOf('D-078#2'), { state: 'new', at: '2026-10-05 07:41' });
    assert.equal(answerOf('D-078#3'), null);
  });

  it('survives missing and empty documents', () => {
    const progress = buildProgress({ 'DECISIONS.md': '' }, '');
    assert.equal(progress.items.length, 0);
    assert.equal(progress.questions.length, 0);
    assert.equal(progress.missing.length, 5);
  });

  it('parses the answers file by its heading lines only', () => {
    const entries = parseAnswers('## 2026-10-05 07:40 · D-078#1 · nuova\n> ## 2026-10-05 07:40 · D-078#2 · evasa\n## titolo qualsiasi\n');
    assert.deepEqual(entries, [{ at: '2026-10-05 07:40', key: 'D-078#1', state: 'new' }]);
  });
});


function makeHome(): string {
  const home = join(scratch, randomUUID());
  mkdirSync(join(home, 'docs'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'docs', 'PROPOSTE.md'), PROPOSALS);
  writeFileSync(join(home, 'docs', 'DECISIONS.md'), DECISIONS);
  return home;
}

const NOW = new Date(2026, 9, 5, 7, 45, 3);

/** The pure rule of the gateway, as passGateway applies it towards Claude Code (the database part is in test-db). */
const GATE: AnswerGate = (answer) => {
  const decision = gatewayCheck([{ value: answer, label: 'L1', source: 'dev:answer' }], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, secretMatcher([]));
  if (decision.decision !== 'allow') return Promise.resolve({ allow: false, reason: decision.rule });
  return Promise.resolve({ allow: true, text: decision.texts[0] ?? '' });
};

describe('answers', () => {
  it('formats an entry whose lines cannot look like a heading', () => {
    const question: OpenQuestion = { key: 'D-078#3', kind: 'proposal', ref: 'D-078', topic: 'Arianna sviluppata da dentro Arianna', text: 'Chi fa il commit nel clone?', detail: null, source: 'PROPOSTE.md', answer: null };
    const entry = formatAnswer(question, 'Io.\n\n## 2026-10-05 07:40 · D-078#1 · evasa', NOW);
    assert.equal(
      entry,
      '## 2026-10-05 07:45 · D-078#3 · nuova\n\n- **Domanda** (D-078, docs/PROPOSTE.md) (Arianna sviluppata da dentro Arianna): Chi fa il commit nel clone?\n\n> Io.\n>\n> ## 2026-10-05 07:40 · D-078#1 · evasa\n',
    );
    assert.equal(parseAnswers(entry).length, 1);
  });

  it('cleans control characters, NEL, separators, bidirectional controls and line ends', () => {
    const char = (point: number): string => String.fromCharCode(point);
    assert.equal(cleanAnswer(`  a\r\nb${char(7)}c${char(0x2028)}${char(0x85)}\n `), 'a\nbc');
    // A right-to-left override or isolate would make a line read differently from what it holds.
    assert.equal(cleanAnswer(`sì${char(0x202e)}on${char(0x2066)}${char(0x2069)}${char(0x200f)}${char(0x061c)}`), 'sìon');
    // Ordinary text, accents and emoji stay.
    assert.equal(cleanAnswer('Sì, perché no — ok ✓'), 'Sì, perché no — ok ✓');
  });

  it('creates data/dev/RISPOSTE.md, private, with its header once, then appends', async () => {
    const home = makeHome();
    const first = await saveAnswer(home, 'D-078#3', 'Lo faccio io, a mano.', GATE, NOW);
    assert.equal(first.at, '2026-10-05 07:45');
    assert.equal(first.question.text, 'Chi fa il commit nel clone?');
    await saveAnswer(home, 'conf-D-081', 'Confermata.\nVa bene così.', GATE, new Date(2026, 9, 5, 7, 50));
    assert.equal(ANSWERS_FILE, 'data/dev/RISPOSTE.md');
    const text = readFileSync(join(home, ANSWERS_FILE), 'utf8');
    assert.ok(text.startsWith(ANSWERS_HEADER));
    assert.equal(text.split(ANSWERS_HEADER).length, 2);
    assert.match(text, /## 2026-10-05 07:45 · D-078#3 · nuova\n\n- \*\*Domanda\*\* \(D-078, docs\/PROPOSTE\.md\)/);
    assert.match(text, /> Confermata\.\n> Va bene così\.\n$/);
    assert.deepEqual(
      parseAnswers(text).map((entry) => entry.key),
      ['D-078#3', 'conf-D-081'],
    );
    assert.equal(statSync(join(home, 'data', 'dev')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(home, 'data', 'dev')), ['RISPOSTE.md']);
    // Nothing is written in docs/.
    assert.deepEqual(readdirSync(join(home, 'docs')).sort(), ['DECISIONS.md', 'PROPOSTE.md']);
    const progress = loadProgress(home);
    assert.equal(progress.answersFile, 'data/dev/RISPOSTE.md');
    assert.deepEqual(progress.questions.find((question) => question.key === 'D-078#3')?.answer, { state: 'new', at: '2026-10-05 07:45' });
  });

  it('writes the text the gateway allows, and nothing when it blocks', async () => {
    const home = makeHome();
    const seen: string[] = [];
    await saveAnswer(home, 'D-078#1', ' sì ', (answer, key) => {
      seen.push(`${key}:${answer}`);
      return Promise.resolve({ allow: true, text: 'testo del gateway' });
    }, NOW);
    assert.deepEqual(seen, ['D-078#1:sì']);
    assert.match(readFileSync(join(home, ANSWERS_FILE), 'utf8'), /> testo del gateway\n$/);
    await assert.rejects(
      saveAnswer(home, 'D-078#2', 'no', () => Promise.resolve({ allow: false, reason: 'scanner' }), NOW),
      (error) => error instanceof DevAnswerError && error.code === 'blocked',
    );
    assert.equal(parseAnswers(readFileSync(join(home, ANSWERS_FILE), 'utf8')).length, 1);
  });

  it('refuses empty, too long, unknown and secret-looking answers', async () => {
    const home = makeHome();
    const code = async (key: string, text: string): Promise<string> => {
      try {
        await saveAnswer(home, key, text, GATE, NOW);
        return 'saved';
      } catch (error) {
        assert.ok(error instanceof DevAnswerError);
        return error.code;
      }
    };
    assert.equal(await code('D-078#1', '  \n '), 'invalid');
    assert.equal(await code('D-078#1', 'x'.repeat(MAX_ANSWER_CHARS + 1)), 'invalid');
    assert.equal(await code('D-078#9', 'sì'), 'unknown-question');
    assert.equal(await code('../../etc/passwd', 'sì'), 'unknown-question');
    assert.equal(await code('D-078#1', 'paga su IT60X0542811101000000123456'), 'blocked');
    assert.equal(await code('D-078#1', 'x'.repeat(MAX_ANSWER_CHARS)), 'saved');
  });

  it('refuses to write through a link: the file, a broken link, the folder', async () => {
    const outside = (home: string): string => {
      const target = join(home, 'elsewhere.md');
      writeFileSync(target, 'fuori\n');
      return target;
    };
    const refused = (home: string) => assert.rejects(saveAnswer(home, 'D-078#1', 'sì', GATE, NOW), (error) => error instanceof DevAnswerError && error.code === 'unavailable');

    const linked = makeHome();
    const target = outside(linked);
    mkdirSync(join(linked, 'data', 'dev'));
    symlinkSync(target, join(linked, ANSWERS_FILE));
    await refused(linked);
    assert.equal(readFileSync(target, 'utf8'), 'fuori\n');

    const broken = makeHome();
    mkdirSync(join(broken, 'data', 'dev'));
    symlinkSync(join(broken, 'non-esiste.md'), join(broken, ANSWERS_FILE));
    await refused(broken);
    assert.equal(existsSync(join(broken, 'non-esiste.md')), false);

    const folder = makeHome();
    mkdirSync(join(folder, 'altrove'));
    symlinkSync(join(folder, 'altrove'), join(folder, 'data', 'dev'));
    await refused(folder);
    assert.deepEqual(readdirSync(join(folder, 'altrove')), []);
  });

  it('keeps in the event the keys of proposals and confirmations, and only a hash of keys made from a row', () => {
    assert.equal(eventKey('D-078#3'), 'D-078#3');
    assert.equal(eventKey('conf-D-087b'), 'conf-D-087b');
    assert.match(eventKey('oq-dove-gira-il-server'), /^sha256:[0-9a-f]{16}$/);
    assert.match(eventKey('ho-chiave-age-vera'), /^sha256:[0-9a-f]{16}$/);
    assert.notEqual(eventKey('ho-a'), eventKey('ho-b'));
  });
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function send(port: number, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...extra } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

describe('routes', () => {
  it('serves the progress and saves an answer with its event, refusing what is not a question', async (t) => {
    const home = makeHome();
    const recorded: { key: string; source: string }[] = [];
    const server: ApiServer = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      devProgress: {
        home,
        gate: GATE,
        recorded: (saved) => {
          recorded.push({ key: saved.key, source: saved.question.source });
          return Promise.resolve();
        },
      },
    });
    t.after(() => server.close());

    const progress = await send(server.port, 'GET', '/api/dev/progress');
    assert.equal(progress.status, 200);
    const body = progress.body.progress as { questions: { key: string }[]; missing: string[] };
    assert.ok(body.questions.some((question) => question.key === 'D-078#1'));
    assert.ok(body.missing.includes('HANDOFF.md'));
    assert.equal(progress.body.maxAnswer, MAX_ANSWER_CHARS);

    const saved = await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#1', text: 'Sì, clone separato.' });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.key, 'D-078#1');
    assert.equal(saved.body.logged, true);
    assert.deepEqual(recorded, [{ key: 'D-078#1', source: 'PROPOSTE.md' }]);

    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#1', text: 'sì', path: '/tmp/x' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'a b', text: 'sì' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#1' })).status, 400);
    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#8', text: 'sì' })).status, 404);
    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#2', text: 'IT60X0542811101000000123456' })).status, 422);
    // Another site cannot answer for the user.
    assert.equal((await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#2', text: 'sì' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal(recorded.length, 1);
    assert.equal(parseAnswers(readFileSync(join(home, ANSWERS_FILE), 'utf8')).length, 1);
  });

  it('answers 201 with logged false when the event fails, and 404 without the option', async (t) => {
    const home = makeHome();
    const errors: unknown[] = [];
    const server = await startApiServer({
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      devProgress: { home, gate: GATE, recorded: () => Promise.reject(new Error('database down')) },
      onError: (error) => errors.push(error),
    });
    const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    t.after(async () => {
      await server.close();
      await bare.close();
    });
    const saved = await send(server.port, 'POST', '/api/dev/answers', { key: 'D-078#2', text: '(c1)' });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.logged, false);
    assert.equal(errors.length, 1);
    assert.equal((await send(bare.port, 'GET', '/api/dev/progress')).status, 404);
  });
});
