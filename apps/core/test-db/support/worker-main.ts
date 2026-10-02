// A core worker as a separate process, for the kill -9 test:
//   node worker-main.ts <schema> <hang|finish> <lockTimeoutMs>
// hang:   saves a session id, then works forever on the step.
// finish: completes the step, with the resumed session id as evidence.
import { loadConfig } from '@arianna/config';

import { connect } from '../../src/db/client.ts';
import { createWorker, type StepExecutor } from '../../src/engine.ts';

const [schema = '', mode = '', lockTimeout = '1000'] = process.argv.slice(2);
const sql = connect(loadConfig(), process.env, { schema });

const executor: StepExecutor = {
  plan: () => ({ agent: 'coder', executor: 'local-model', locality: 'local' }),
  async run(ctx) {
    if (mode === 'hang') {
      await ctx.setSessionRef('session-1');
      await new Promise(() => undefined);
    }
    return { kind: 'done', evidence: [{ resumed: ctx.resume?.sessionRef ?? null }] };
  },
};

const worker = createWorker({
  sql,
  executor,
  allowedActions: () => [],
  agentLimits: () => ({ maxSteps: 10, maxMinutes: 10 }),
  lockTimeoutMs: Number(lockTimeout),
  pollMs: 50,
});
await worker.start();

process.once('SIGTERM', () => {
  void worker.stop().then(() => sql.end());
});
