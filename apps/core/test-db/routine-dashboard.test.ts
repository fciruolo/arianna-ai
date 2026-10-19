// The source «Dashboard» of the routines (D-258) against PostgreSQL: at the
// routine's time the tiles chosen are refreshed by the same «Aggiorna» of the
// page (a private hidden conversation, erased once the answer is in the
// tile), a Segreto tile never, a tile at work skipped; a tile removed leaves
// the routine without errors; «Prova adesso» refreshes too; the report names
// only what it may. Fake data only.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { loadTile, pinTile, removeTile, settleDashboard, startRefresh, startRefreshesIn, type DashboardTile } from '../src/dashboard.ts';
import { splitRoutine } from '../src/routine-split.ts';
import { claimRun, createRoutine, loadRoutine, pauseRoutine, retireRoutine, runDue, runNow, updateRoutine, type RoutineEnv, type RoutineInput } from '../src/routines.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const RULES = parseLabelRules('');
const HOME = join(resolveHome({}), 'data', 'test-tmp', 'routine-dashboard');
const AGENTS = { agents: () => ['arianna', 'local-chat', 'finanze'], financeAgents: () => ['finanze'] };
const MINUTE = 60_000;

/** The env of the core; `withAgents` false: no agents given, as without the core's list (none is refreshable). */
function env(withAgents = true): RoutineEnv {
  return { sql: db().sql, home: HOME, rules: RULES, ...(withAgents ? { dashboard: AGENTS } : {}) };
}

/** An answer of a private conversation pinned as a tile (L2, as the finances). */
async function tile(title: string): Promise<DashboardTile> {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, `Domanda finta per ${title}?`);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${task.id}`}`;
  const [reply] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${conversation.id}, 'assistant', 'L2', 'Risposta finta di ieri.', ${task.id}) RETURNING id::text`;
  await owner`UPDATE tasks SET status = 'done', evidence = ${owner.json([{ kind: 'message', ref: reply?.id ?? '' }])} WHERE id = ${task.id}`;
  return pinTile(sql, { messageId: reply?.id ?? '', title, question: `Domanda finta per ${title}?` });
}

/** A routine every day in UTC whose run was a minute ago, still to do. */
async function dueRoutine(extra: Partial<RoutineInput> = {}): Promise<{ id: string; conversationId: string }> {
  const at = new Date(Math.floor((Date.now() - MINUTE) / MINUTE) * MINUTE);
  const clock = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  const routine = await createRoutine(db().sql, { title: 'Mattina finta', days: [1, 2, 3, 4, 5, 6, 7], at: clock, timezone: 'UTC', sources: ['dashboard'], summary: false, ...extra });
  await db().sql`UPDATE routines SET next_run_at = ${at} WHERE id = ${routine.id}`;
  return { id: routine.id, conversationId: routine.conversationId };
}

async function lastMessage(conversationId: string): Promise<{ body: string; label: string }> {
  const [row] = await db().sql<{ body: string; label: string }[]>`
    SELECT body, label::text AS label FROM messages WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 1`;
  assert.ok(row !== undefined, 'the routine wrote its report');
  return row;
}

/** Every tile of the Dashboard out of the way of the next test (the database is shared by the tests of this file). */
async function clearDashboard(): Promise<void> {
  const { owner } = db();
  await owner`UPDATE dashboard_tiles SET refresh_state = 'idle', refresh_error = NULL, refresh_conversation_id = NULL, refresh_started_at = NULL WHERE refresh_state = 'running'`;
  await owner`DELETE FROM dashboard_tiles`;
}

test('at its time a routine refreshes its tiles as «Aggiorna»: Segreto never, a tile at work skipped, the report names only those started', async () => {
  await clearDashboard();
  const { sql, owner } = db();
  const spese = await tile('Spese del mese');
  const scadenze = await tile('Scadenze');
  const diario = await tile('Diario segreto finto');
  await owner`UPDATE dashboard_tiles SET label = 'L3' WHERE id = ${diario.id}`;
  const busy = await tile('Clienti finti');
  await startRefresh(sql, busy.id, AGENTS);
  const routine = await dueRoutine();

  const outcome = await runDue(env(), routine.id);
  assert.equal(outcome.kind, 'done');
  const report = await lastMessage(routine.conversationId);
  assert.equal(report.label, 'L2');
  assert.match(report.body, /Dashboard, riquadri in aggiornamento \(2\):\n- Scadenze\n- Spese del mese\n\+ 1 Segreto, non si aggiorna\n\+ 1 già in aggiornamento/);
  assert.doesNotMatch(report.body, /Diario|Clienti/);

  // The same refresh as the page: a private hidden conversation of its own, the question at its label, the local model.
  for (const id of [spese.id, scadenze.id]) {
    const [row] = await owner<{ state: string; mode: string; clearance: string; agent: string; dashboardOf: string }[]>`
      SELECT d.refresh_state AS state, c.mode, c.clearance::text AS clearance, c.agent, c.dashboard_of::text AS "dashboardOf"
      FROM dashboard_tiles d JOIN conversations c ON c.id = d.refresh_conversation_id WHERE d.id = ${id}`;
    assert.deepEqual(row, { state: 'running', mode: 'private', clearance: 'L2', agent: 'local-chat', dashboardOf: (await loadTile(sql, id))?.sourceConversationId });
  }
  assert.equal((await loadTile(sql, diario.id))?.refreshState, 'idle');
  // The busy tile keeps its own refresh, not a second one.
  const [{ refreshes } = { refreshes: -1 }] = await owner<{ refreshes: number }[]>`SELECT count(*)::int AS refreshes FROM conversations WHERE dashboard_of = ${busy.sourceConversationId}`;
  assert.equal(refreshes, 1);

  // Events: ids and numbers only, never a title.
  const events = await owner<{ kind: string; label: string; payload: Record<string, unknown> }[]>`
    SELECT kind, label::text AS label, payload FROM events WHERE (kind = 'routine.run' AND payload ->> 'routineId' = ${routine.id})
      OR (kind = 'dashboard.tile_refreshing' AND payload ->> 'routineId' = ${routine.id}) ORDER BY id`;
  assert.deepEqual(events.map((event) => event.kind).sort(), ['dashboard.tile_refreshing', 'dashboard.tile_refreshing', 'routine.run']);
  assert.ok(events.every((event) => event.label === 'L0' && !JSON.stringify(event.payload).includes('Spese')));
  assert.equal(events.find((event) => event.kind === 'routine.run')?.payload.tiles, 2);

  // The answer comes through settleDashboard, as for the page: in the tile, the refresh conversation erased.
  const [refresh] = await owner<{ conversationId: string; taskId: string }[]>`
    SELECT d.refresh_conversation_id::text AS "conversationId", t.id::text AS "taskId" FROM dashboard_tiles d JOIN tasks t ON t.conversation_id = d.refresh_conversation_id WHERE d.id = ${spese.id}`;
  assert.ok(refresh !== undefined);
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${refresh.taskId}`}`;
  const [answer] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, task_id) VALUES (${refresh.conversationId}, 'assistant', 'L2', 'Risposta finta di oggi.', ${refresh.taskId}) RETURNING id::text`;
  await owner`UPDATE tasks SET status = 'done', evidence = ${owner.json([{ kind: 'message', ref: answer?.id ?? '' }])} WHERE id = ${refresh.taskId}`;
  await settleDashboard(sql);
  const after = await loadTile(sql, spese.id);
  assert.ok(after !== undefined);
  assert.equal(after.body, 'Risposta finta di oggi.');
  assert.equal(after.refreshState, 'idle');
  const [gone] = await owner<{ purged: boolean }[]>`SELECT purged_at IS NOT NULL AS purged FROM conversations WHERE id = ${refresh.conversationId}`;
  assert.ok(gone === undefined || gone.purged);
  await clearDashboard();
});

test('a choice of tiles: only those refreshed; a tile removed leaves the routine, and with none left the report says so', async () => {
  await clearDashboard();
  const { sql } = db();
  const spese = await tile('Spese del mese');
  const scadenze = await tile('Scadenze');
  const altro = await tile('Altro riquadro');
  const routine = await dueRoutine({ dashboardTiles: [spese.id, scadenze.id] });
  assert.deepEqual((await loadRoutine(sql, routine.id))?.dashboardTiles?.sort(), [spese.id, scadenze.id].sort());

  await removeTile(sql, scadenze.id);
  assert.deepEqual((await loadRoutine(sql, routine.id))?.dashboardTiles, [spese.id]);
  assert.equal((await runDue(env(), routine.id)).kind, 'done');
  const report = await lastMessage(routine.conversationId);
  assert.match(report.body, /Dashboard, riquadri in aggiornamento \(1\):\n- Spese del mese/);
  assert.equal((await loadTile(sql, altro.id))?.refreshState, 'idle');

  // Every tile chosen removed: the routine stays, «Prova adesso» says there is none to refresh.
  // The refresh of the run above stopped by hand, so the tile can be removed.
  await db().owner`UPDATE dashboard_tiles SET refresh_state = 'idle', refresh_conversation_id = NULL, refresh_started_at = NULL WHERE id = ${spese.id}`;
  await removeTile(sql, spese.id);
  assert.deepEqual((await loadRoutine(sql, routine.id))?.dashboardTiles, []);
  await runNow(env(), routine.id);
  assert.match((await lastMessage(routine.conversationId)).body, /Dashboard: nessun riquadro da aggiornare\.$/);
  // A change that does not touch the choice keeps it; a choice of tiles no longer there is refused.
  await updateRoutine(sql, routine.id, { title: 'Mattina rinominata' });
  await assert.rejects(updateRoutine(sql, routine.id, { dashboardTiles: [spese.id] }), /none of the tiles chosen/);
  // Back to every tile, then without the source: the choice goes with it.
  assert.equal((await updateRoutine(sql, routine.id, { dashboardTiles: null })).dashboardTiles, null);
  await updateRoutine(sql, routine.id, { dashboardTiles: [altro.id] });
  assert.equal((await updateRoutine(sql, routine.id, { sources: ['todo'] })).dashboardTiles, null);
  await assert.rejects(updateRoutine(sql, routine.id, { dashboardTiles: [altro.id] }), /goes with the source dashboard/);
  await clearDashboard();
});

test('«Prova adesso» refreshes the tiles too, also of a paused routine; without the agents none is refreshable', async () => {
  await clearDashboard();
  const { sql } = db();
  const spese = await tile('Spese del mese');
  const routine = await dueRoutine({ sources: ['todo', 'dashboard'] });
  await pauseRoutine(sql, routine.id);

  await runNow(env(false), routine.id);
  assert.match((await lastMessage(routine.conversationId)).body, /Dashboard: nessun riquadro da aggiornare\.\n\+ 1 non aggiornabile adesso$/);
  assert.equal((await loadTile(sql, spese.id))?.refreshState, 'idle');

  await runNow(env(), routine.id);
  assert.match((await lastMessage(routine.conversationId)).body, /Dashboard, riquadri in aggiornamento \(1\):\n- Spese del mese/);
  assert.equal((await loadTile(sql, spese.id))?.refreshState, 'running');
  // Again while it works: skipped, never a second refresh.
  await runNow(env(), routine.id);
  assert.match((await lastMessage(routine.conversationId)).body, /Dashboard: nessun riquadro da aggiornare\.\n\+ 1 già in aggiornamento/);
  await clearDashboard();
});

test('a tile changed since it was judged is left out by its savepoint, the others start in the same transaction', async () => {
  await clearDashboard();
  const { sql } = db();
  const first = await tile('Primo riquadro');
  const busy = await tile('Già al lavoro');
  const gone = await tile('Tolto nel frattempo');
  await startRefresh(sql, busy.id, AGENTS);
  await removeTile(sql, gone.id);
  const routine = await dueRoutine();
  const started = await sql.begin((tx) => startRefreshesIn(tx, [busy.id, gone.id, first.id], AGENTS, routine.id));
  assert.equal(started, 1);
  assert.equal((await loadTile(sql, first.id))?.refreshState, 'running');
  await clearDashboard();
});

test('a run in flight gives up when the choice of tiles changes under it', async () => {
  await clearDashboard();
  const { sql } = db();
  const a = await tile('Riquadro A');
  const b = await tile('Riquadro B');
  const routine = await dueRoutine({ dashboardTiles: [a.id] });
  const seen = await loadRoutine(sql, routine.id);
  assert.ok(seen !== undefined && seen.nextRunAt !== null);
  await updateRoutine(sql, routine.id, { dashboardTiles: [b.id] });
  const outcome = await claimRun(sql, { ...seen, sources: [...seen.sources], days: [...seen.days] }, seen.nextRunAt, new Date(Date.now() + 86_400_000), () => Promise.resolve({ kind: 'none' }));
  assert.equal(outcome.kind, 'none');
  assert.equal((await loadTile(sql, a.id))?.refreshState, 'idle');
  await clearDashboard();
});

test('the split keeps the choice of tiles; a routine removed or proposed never changes it', async () => {
  await clearDashboard();
  const { sql, owner } = db();
  const spese = await tile('Spese del mese');
  const routine = await createRoutine(sql, {
    title: 'Due giorni finti', days: [1, 3], at: '08:00', timezone: 'UTC', sources: ['dashboard'], dashboardTiles: [spese.id],
    channel: 'call', voiceMaxLabel: 'L1', retryMinutes: 15,
  });
  const { created } = await splitRoutine(sql, routine.id, { day: 3, to: 4, at: '09:00' });
  assert.deepEqual(created.dashboardTiles, [spese.id]);
  // The call of D-259 goes with the tiles: both kept by the split.
  assert.deepEqual([created.channel, created.voiceMaxLabel, created.retryMinutes], ['call', 'L1', 15]);
  await retireRoutine(sql, created.id);
  await assert.rejects(owner`UPDATE routines SET dashboard_tiles = NULL WHERE id = ${created.id}`, /a routine removed stays as it was/);
  // The guards of 0081 and 0082 hold together on a routine removed.
  await assert.rejects(owner`UPDATE routines SET retry_minutes = 30 WHERE id = ${created.id}`, /a routine removed stays as it was/);
  // The database: a choice only with the source, never empty; a proposal never chooses tiles.
  await assert.rejects(owner`UPDATE routines SET sources = '{todo}' WHERE id = ${routine.id}`, /routines_dashboard_tiles/);
  await assert.rejects(owner`UPDATE routines SET dashboard_tiles = '{}' WHERE id = ${routine.id}`, /routines_dashboard_tiles/);
  const [conversation] = await owner<{ id: string }[]>`INSERT INTO conversations (mode, clearance, title) VALUES ('private', 'L2', 'Routine · Proposta finta') RETURNING id::text`;
  await assert.rejects(
    owner`INSERT INTO routines (title, conversation_id, days, at, timezone, sources, dashboard_tiles, status)
          VALUES ('Proposta finta', ${conversation?.id ?? ''}, '{1}', '08:00', 'UTC', '{dashboard}', ${[spese.id]}::uuid[], 'proposed')`,
    /never chooses tiles/,
  );
  await clearDashboard();
});
