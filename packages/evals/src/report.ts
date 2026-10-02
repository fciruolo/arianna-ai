import type { TierReport } from './types.ts';

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Human-readable summary: one line per group, then the failed cases. */
export function formatReport(report: TierReport): string {
  const lines = [`Eval tier: ${report.tier}`];
  if (report.groups.length === 0) lines.push('  (no groups in this tier)');

  for (const group of report.groups) {
    if (group.status === 'pending') {
      lines.push(
        `  ${group.name.padEnd(13)} PENDING  waits for ${group.until} (${String(group.cases)} case(s) ready)`,
      );
      continue;
    }
    const verdict = group.status === 'passed' ? 'PASS' : 'FAIL';
    lines.push(
      `  ${group.name.padEnd(13)} ${verdict.padEnd(8)} ${String(group.passed)}/${String(group.total)} ` +
        `(${percent(group.rate)}, threshold ${percent(group.threshold)})`,
    );
    for (const reason of group.reasons) lines.push(`      reason: ${reason}`);
    for (const result of group.results.filter((candidate) => !candidate.passed)) {
      const detail = result.error ?? `got ${JSON.stringify(result.actual)}`;
      lines.push(`      failed: ${result.id} (${detail})`);
    }
  }

  lines.push(report.ok ? 'Result: OK' : 'Result: FAILED');
  return lines.join('\n');
}
