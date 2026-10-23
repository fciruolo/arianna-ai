// D-304: the run guardians this test process started, read from the system `ps`.
import { execFileSync } from 'node:child_process';

import { GUARD_NAME } from '@arianna/executors';

/** The guardians whose parent is this process, with the group each one guards. */
export function guardians(): { pid: number; group: number }[] {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', env: { LC_ALL: 'C' } });
  return out.split('\n').flatMap((row) => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/.exec(row);
    if (match === null || Number(match[2]) !== process.pid) return [];
    const guarded = new RegExp(`${GUARD_NAME} ([0-9]+)\\s*$`).exec(match[3] ?? '');
    return guarded === null ? [] : [{ pid: Number(match[1]), group: Number(guarded[1]) }];
  });
}

/** True once no guardian of this process is left, within `ms`. */
export async function noGuardianLeft(ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (guardians().length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return guardians().length === 0;
}
