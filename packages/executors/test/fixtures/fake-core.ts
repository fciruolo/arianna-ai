// D-304: a stand-in for the core that guards one process group (argv[2]) and
// can be killed. After the guardian it starts another child that lives as
// long as it: that child must not hold the guardian's pipe open. It prints
// `{"guard":<pid>,"other":<pid>}`, and `released` after a `release` line on stdin.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { guardGroup } from '@arianna/executors';

const guard = guardGroup(Number(process.argv[2]));
const other = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ guard: guard.pid, other: other.pid }));
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line !== 'release') return;
  guard.release();
  console.log('released');
});
setInterval(() => undefined, 1_000);
