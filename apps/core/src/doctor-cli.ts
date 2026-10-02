// Usage: node apps/core/src/doctor-cli.ts   (pnpm arianna:doctor)
// Checks that the installation is ready for real data (task 1.13, D-046).
// Exits with 1 when a check fails.
import { loadConfig } from '@arianna/config';

import { runDoctor } from './doctor.ts';

const checks = await runDoctor({ config: loadConfig() });
const width = Math.max(...checks.map((check) => check.id.length));
for (const check of checks) {
  console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.id.padEnd(width)}  ${check.detail}`);
}
const failed = checks.filter((check) => !check.ok).length;
console.log(failed === 0 ? '\nReady for real data.' : `\n${String(failed)} check(s) failed: not ready for real data.`);
process.exitCode = failed === 0 ? 0 : 1;
