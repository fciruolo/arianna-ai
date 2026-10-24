// The milestones of a project on the cardwall (D-313): the database keeps a
// card in a milestone of its own project and the «bloccata da» without
// cycles; the core counts the cards done, asks to close a milestone whose
// cards are all done, and asks again only once its cards changed. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listApprovals, loadApproval } from '../src/approvals.ts';
import { createCard, listCards, moveCard, updateCard } from '../src/cardwall.ts';
import { recordDecision } from '../src/engine.ts';
import {
  addMilestoneDependency,
  checkMilestones,
  closeMilestone,
  closeQuestion,
  createMilestone,
  listMilestones,
  milestoneReminderLines,
  moveMilestone,
  removeMilestoneDependency,
  reopenMilestone,
  updateMilestone,
} from '../src/milestones.ts';
import { noticeOf } from '../src/notifications.ts';
import { fireReminder } from '../src/reminders.ts';
import { createTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const CARDS = { projects: ['panificio-rossi', 'demo'], agents: ['coder'] };
const NAMES = { projects: [{ name: 'panificio-rossi', label: 'L1' as const }, { name: 'demo', label: 'L0' as const }] };
const sqlError = /violates|cycle|one project|never changes|only its removal/;

async function done(sql: ReturnType<typeof db>['sql'], id: string): Promise<void> {
  await moveCard(sql, id, 'done');
}

test('the database: a milestone only on a card of its project; «bloccata da» in one project, never a cycle; at most L2; its project never changes', async () => {
  const { sql } = db();
  const accessi = await createMilestone(sql, { project: 'panificio-rossi', title: 'Accessi' }, NAMES);
  const dashboard = await createMilestone(sql, { project: 'panificio-rossi', title: 'Sezione dashboard' }, NAMES);
  const other = await createMilestone(sql, { project: 'demo', title: 'Altro progetto' }, NAMES);
  const card = await createTask(sql, { title: 'Design degli accessi', project: 'panificio-rossi' });
  const general = await createTask(sql, { title: 'Carta generale' });

  // Positive: in a milestone of its own project.
  await sql`UPDATE tasks SET milestone_id = ${accessi.id} WHERE id = ${card.id}`;
  // Negative: another project's, or a card without a project.
  await assert.rejects(sql`UPDATE tasks SET milestone_id = ${other.id} WHERE id = ${card.id}`, sqlError);
  await assert.rejects(sql`UPDATE tasks SET milestone_id = ${accessi.id} WHERE id = ${general.id}`, sqlError);
  // A card in a milestone cannot slip into another project with it.
  await assert.rejects(sql`UPDATE tasks SET project = 'demo' WHERE id = ${card.id}`, sqlError);
  await assert.rejects(sql`UPDATE milestones SET project = 'demo' WHERE id = ${accessi.id}`, sqlError);
  await assert.rejects(sql`UPDATE milestones SET label = 'L3' WHERE id = ${accessi.id}`, sqlError);

  await sql`INSERT INTO milestone_dependencies (milestone_id, depends_on) VALUES (${dashboard.id}, ${accessi.id})`;
  await assert.rejects(sql`INSERT INTO milestone_dependencies (milestone_id, depends_on) VALUES (${accessi.id}, ${dashboard.id})`, sqlError);
  await assert.rejects(sql`INSERT INTO milestone_dependencies (milestone_id, depends_on) VALUES (${accessi.id}, ${accessi.id})`, sqlError);
  await assert.rejects(sql`INSERT INTO milestone_dependencies (milestone_id, depends_on) VALUES (${accessi.id}, ${other.id})`, sqlError);
  await assert.rejects(sql`DELETE FROM milestones`, /permission denied/);
});

test('the core: label of the project and of the words, order, «bloccata da», a card moved in and out of a milestone', async () => {
  const { sql } = db();
  // Written by hand: Privato (L2) even in an Interno (L1) project, never below the project.
  const accessi = await createMilestone(sql, { project: 'panificio-rossi', title: '  Accessi ', description: 'Login e ruoli funzionano', due: '2026-11-02' }, NAMES);
  const dashboard = await createMilestone(sql, { project: 'panificio-rossi', title: 'Sezione dashboard' }, NAMES);
  await assert.rejects(createMilestone(sql, { project: 'sconosciuto', title: 'No' }, NAMES), /unknown project/);
  await assert.rejects(createMilestone(sql, { project: 'panificio-rossi', title: '' }, NAMES), /title/);
  await assert.rejects(createMilestone(sql, { project: 'panificio-rossi', title: 'X', due: 'domani' }, NAMES), /due/);

  let list = (await listMilestones(sql)).filter((item) => item.project === 'panificio-rossi');
  const first = list.find((item) => item.id === accessi.id);
  assert.ok(first !== undefined);
  assert.equal(first.title, 'Accessi');
  assert.equal(first.label, 'L2');
  assert.equal(first.due, '2026-11-02');
  assert.deepEqual(first.cards, { done: 0, total: 0 });
  assert.ok(list.findIndex((item) => item.id === accessi.id) < list.findIndex((item) => item.id === dashboard.id));

  await moveMilestone(sql, dashboard.id, 'up');
  list = (await listMilestones(sql)).filter((item) => item.project === 'panificio-rossi');
  assert.ok(list.findIndex((item) => item.id === dashboard.id) < list.findIndex((item) => item.id === accessi.id));
  await assert.rejects(moveMilestone(sql, dashboard.id, 'sideways'), /direction/);

  await addMilestoneDependency(sql, dashboard.id, accessi.id);
  await assert.rejects(addMilestoneDependency(sql, accessi.id, dashboard.id), /wait for each other/);
  list = await listMilestones(sql);
  assert.deepEqual(list.find((item) => item.id === dashboard.id)?.blockedBy.map((item) => item.title), ['Accessi']);

  // A card: in a milestone of its project; out when it changes project; never one of another project.
  const id = (await createCard(sql, { title: 'Database degli accessi', project: 'panificio-rossi', milestone: accessi.id }, CARDS)).id;
  let card = (await listCards(sql)).find((item) => item.id === id);
  assert.equal(card?.milestone, accessi.id);
  await assert.rejects(createCard(sql, { title: 'Generale', milestone: accessi.id }, CARDS), /without a project/);
  const demo = await createMilestone(sql, { project: 'demo', title: 'Demo' }, NAMES);
  await assert.rejects(updateCard(sql, id, { milestone: demo.id }, CARDS), /another project/);
  await updateCard(sql, id, { project: 'demo' }, CARDS);
  card = (await listCards(sql)).find((item) => item.id === id);
  assert.equal(card?.milestone, null);
  await updateCard(sql, id, { project: 'panificio-rossi', milestone: accessi.id }, CARDS);
  // A closed milestone takes no new card.
  await closeMilestone(sql, dashboard.id);
  await assert.rejects(updateCard(sql, id, { milestone: dashboard.id }, CARDS), /closed/);
  await reopenMilestone(sql, dashboard.id);

  await updateMilestone(sql, accessi.id, { title: 'Accessi e ruoli', due: null }, NAMES);
  const changed = (await listMilestones(sql)).find((item) => item.id === accessi.id);
  assert.ok(changed !== undefined);
  assert.equal(changed.title, 'Accessi e ruoli');
  assert.equal(changed.due, null);
  assert.equal(changed.description, 'Login e ruoli funzionano');
});

test('the closing: asked when every card is done, «No» holds until a card comes in, «Sì» closes; no text in the notices', async () => {
  const { sql } = db();
  const milestone = await createMilestone(sql, { project: 'panificio-rossi', title: 'Accessi panificio' }, NAMES);
  const empty = await createMilestone(sql, { project: 'panificio-rossi', title: 'Ancora vuota' }, NAMES);
  const design = (await createCard(sql, { title: 'Design', project: 'panificio-rossi', milestone: milestone.id }, CARDS)).id;
  const database = (await createCard(sql, { title: 'Database', project: 'panificio-rossi', milestone: milestone.id }, CARDS)).id;

  // Not all done: nothing asked; an empty milestone is never asked about.
  await done(sql, design);
  let outcomes = await checkMilestones(sql);
  assert.equal(outcomes[milestone.id], 'none');
  assert.equal(outcomes[empty.id], 'none');
  let listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.deepEqual(listed?.cards, { done: 1, total: 2 });

  // All done: the question, once.
  await done(sql, database);
  outcomes = await checkMilestones(sql);
  assert.equal(outcomes[milestone.id], 'asked');
  assert.equal((await checkMilestones(sql))[milestone.id], 'none');
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.notEqual(listed?.proposal, null);
  const first = await loadApproval(sql, listed?.proposal ?? '');
  assert.ok(first !== undefined);
  assert.equal(first.kind, 'milestone');
  assert.equal(first.taskId, null);
  assert.equal(first.label, 'L2');
  assert.deepEqual(first.detail, { milestoneId: milestone.id, project: 'panificio-rossi', title: 'Accessi panificio' });

  // The message of Arianna in the secretary conversation, written by code; its event carries ids only.
  const [message] = await sql<{ body: string; label: string; conversationId: string }[]>`
    SELECT body, label, conversation_id::text AS "conversationId" FROM messages WHERE body LIKE 'La milestone%' ORDER BY id DESC LIMIT 1`;
  assert.ok(message !== undefined);
  assert.equal(message.body, closeQuestion('Accessi panificio', 'panificio-rossi'));
  assert.equal(message.label, 'L2');
  assert.equal(first.conversationId, message.conversationId);
  const pendingThere = await listApprovals(sql, 'pending', 100, { conversationId: message.conversationId });
  assert.ok(pendingThere.some((item) => item.id === first.id));
  const [event] = await sql<{ payload: { [key: string]: string | boolean } }[]>`
    SELECT payload FROM events WHERE kind = 'message.created' AND payload ->> 'approval' = ${first.id}`;
  assert.ok(event !== undefined);
  assert.equal(JSON.stringify(event.payload).includes('Accessi'), false);
  assert.deepEqual(noticeOf({ kind: 'message.created', taskId: null, payload: event.payload }), { kind: 'approval', conversationId: message.conversationId });

  // «No»: stays open, not asked again while the cards are the same; the answer is silent.
  await recordDecision(sql, first.id, 'rejected', 'web');
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.equal(listed?.status, 'open');
  assert.equal(listed.proposal, null);
  assert.equal((await checkMilestones(sql))[milestone.id], 'none');
  const [answer] = await sql<{ payload: { [key: string]: string | boolean } }[]>`
    SELECT payload FROM events WHERE kind = 'message.created' AND payload ->> 'silent' = 'true' ORDER BY id DESC LIMIT 1`;
  assert.equal(noticeOf({ kind: 'message.created', taskId: null, payload: answer?.payload ?? {} }), undefined);

  // A card comes in (already done): the «No» no longer holds, asked again.
  const implementation = (await createCard(sql, { title: 'Implementazione', project: 'panificio-rossi' }, CARDS)).id;
  await done(sql, implementation);
  await updateCard(sql, implementation, { milestone: milestone.id }, CARDS);
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');

  // A card opens meanwhile: the pending question goes.
  const late = (await createCard(sql, { title: 'Ritocco', project: 'panificio-rossi' }, CARDS)).id;
  await updateCard(sql, late, { milestone: milestone.id }, CARDS);
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.equal(listed?.proposal, null);
  assert.equal((await checkMilestones(sql))[milestone.id], 'none');
  await done(sql, late);
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');

  // «Sì»: closed.
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  await recordDecision(sql, listed?.proposal ?? '', 'approved', 'web');
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.equal(listed?.status, 'closed');
  assert.deepEqual(listed.cards, { done: 4, total: 4 });
  assert.equal((await checkMilestones(sql))[milestone.id], undefined);

  // Reopened by hand: not asked at once, as after a «No».
  await reopenMilestone(sql, milestone.id);
  assert.equal((await checkMilestones(sql))[milestone.id], 'none');
  // The approval holds the milestone, its project and title, no task; decided only in the web chat.
  await assert.rejects(sql`INSERT INTO approvals (kind, action, detail, label) VALUES ('milestone', 'milestone.close', ${sql.json({ milestoneId: milestone.id })}, 'L2')`, /violates/);
  const [raw] = await sql<{ id: string }[]>`
    INSERT INTO approvals (kind, action, detail, label) VALUES ('milestone', 'milestone.close', ${sql.json({ milestoneId: milestone.id, project: 'panificio-rossi', title: 'Accessi panificio' })}, 'L2') RETURNING id::text`;
  await assert.rejects(sql`INSERT INTO approvals (kind, action, detail, label) VALUES ('milestone', 'milestone.close', ${sql.json({ milestoneId: milestone.id, project: 'panificio-rossi', title: 'Doppia' })}, 'L2')`, /duplicate|unique/);
  await assert.rejects(sql`UPDATE approvals SET state = 'approved', decided_via = 'telegram', decided_at = now() WHERE id = ${raw?.id ?? ''}`, /violates/);
});

test('the morning of the secretary names the open milestones due soon or late, with their count', async () => {
  const { sql } = db();
  const today = '2026-10-24';
  const soon = await createMilestone(sql, { project: 'demo', title: 'Consegna demo', due: '2026-10-25' }, NAMES);
  await createMilestone(sql, { project: 'demo', title: 'Lontana', due: '2026-12-01' }, NAMES);
  const closed = await createMilestone(sql, { project: 'demo', title: 'Chiusa in scadenza', due: '2026-10-24' }, NAMES);
  await closeMilestone(sql, closed.id);
  const card = (await createCard(sql, { title: 'Una card', project: 'demo', milestone: soon.id }, CARDS)).id;
  await done(sql, card);
  await createCard(sql, { title: 'Un’altra', project: 'demo', milestone: soon.id }, CARDS);
  const lines = (await milestoneReminderLines(sql, today)).map((line) => line.text);
  assert.ok(lines.includes('La milestone «Consegna demo» di demo scade domani: 1 di 2 card fatte.'));
  assert.ok(!lines.some((line) => line.includes('Lontana') || line.includes('Chiusa in scadenza')));
  assert.equal(await fireReminder(sql, today, 'morning'), 'written');
  const [message] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE body LIKE 'Buongiorno%' ORDER BY id DESC LIMIT 1`;
  assert.match(message?.body ?? '', /Milestone in scadenza:\n- La milestone «Consegna demo» di demo scade domani/);
});

test('after the review: a card back from Fatto expires the question and a late «Sì» does not close; a card out clears the «No»; title and «Chiudi» expire it', async () => {
  const { sql, owner } = db();
  const milestone = await createMilestone(sql, { project: 'panificio-rossi', title: 'Revisione' }, NAMES);
  const a = (await createCard(sql, { title: 'A', project: 'panificio-rossi', milestone: milestone.id }, CARDS)).id;
  const b = (await createCard(sql, { title: 'B', project: 'panificio-rossi', milestone: milestone.id }, CARDS)).id;
  await done(sql, a);
  await done(sql, b);
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');
  const proposal = (await listMilestones(sql)).find((item) => item.id === milestone.id)?.proposal ?? '';

  // A card goes back from Fatto (only the engine does it: here as the owner) and the «Sì» comes before the next look.
  await owner`UPDATE tasks SET status = 'ready' WHERE id = ${b}`;
  await recordDecision(sql, proposal, 'approved', 'web');
  let listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.equal(listed?.status, 'open');
  const [kept] = await sql<{ body: string }[]>`SELECT body FROM messages WHERE body LIKE 'Non ho chiuso la milestone «Revisione»%'`;
  assert.ok(kept !== undefined);

  // Done again: asked; back again before the «Sì»: the next look expires the question.
  await owner`UPDATE tasks SET status = 'done' WHERE id = ${b}`;
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');
  await owner`UPDATE tasks SET status = 'ready' WHERE id = ${b}`;
  assert.equal((await checkMilestones(sql))[milestone.id], 'expired');
  await owner`UPDATE tasks SET status = 'done' WHERE id = ${b}`;

  // «No», then a card goes out of the milestone: the «No» no longer holds.
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  await recordDecision(sql, listed?.proposal ?? '', 'rejected', 'web');
  assert.equal((await checkMilestones(sql))[milestone.id], 'none');
  await updateCard(sql, b, { milestone: null }, CARDS);
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');

  // A new title expires the question that names the old one; the label never goes down.
  await updateMilestone(sql, milestone.id, { title: 'Revisione finale' }, NAMES);
  listed = (await listMilestones(sql)).find((item) => item.id === milestone.id);
  assert.equal(listed?.proposal, null);
  assert.equal(listed.label, 'L2');
  await updateMilestone(sql, milestone.id, { due: '2026-12-01' }, { projects: [{ name: 'panificio-rossi', label: 'L0' }] });
  assert.equal((await listMilestones(sql)).find((item) => item.id === milestone.id)?.label, 'L2');

  // «Chiudi» by hand expires a pending question.
  assert.equal((await checkMilestones(sql))[milestone.id], 'asked');
  const pending = (await listMilestones(sql)).find((item) => item.id === milestone.id)?.proposal ?? '';
  await closeMilestone(sql, milestone.id);
  assert.equal((await loadApproval(sql, pending))?.state, 'expired');
});

test('after the review: «bloccata da» taken away once, the arrows skip a milestone closed long ago, a bad id is refused', async () => {
  const { sql, owner } = db();
  const one = await createMilestone(sql, { project: 'demo', title: 'Uno' }, NAMES);
  const old = await createMilestone(sql, { project: 'demo', title: 'Vecchia' }, NAMES);
  const three = await createMilestone(sql, { project: 'demo', title: 'Tre' }, NAMES);
  await addMilestoneDependency(sql, three.id, one.id);
  await removeMilestoneDependency(sql, three.id, one.id);
  await assert.rejects(removeMilestoneDependency(sql, three.id, one.id), /no such dependency/);
  await assert.rejects(sql`UPDATE milestone_dependencies SET removed_at = now() WHERE milestone_id = ${three.id}`, sqlError);
  await assert.rejects(sql`UPDATE milestone_dependencies SET depends_on = ${old.id} WHERE milestone_id = ${three.id}`, sqlError);
  await assert.rejects(createCard(sql, { title: 'X', project: 'demo', milestone: '------------------------------------' }, CARDS), /id of a milestone/);

  // «Vecchia» closed a month ago: out of sight, «Tre» goes up past it, before «Uno».
  await closeMilestone(sql, old.id);
  await owner`UPDATE milestones SET closed_at = now() - interval '30 days' WHERE id = ${old.id}`;
  await moveMilestone(sql, three.id, 'up');
  const shown = (await listMilestones(sql)).filter((item) => item.project === 'demo').map((item) => item.title);
  assert.ok(shown.indexOf('Tre') < shown.indexOf('Uno'));
  assert.ok(!shown.includes('Vecchia'));
});
