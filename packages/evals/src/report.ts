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
    for (const measure of group.measures) {
      lines.push(
        `      ${measure.name.padEnd(12)} ${String(measure.passed)}/${String(measure.total)} ` +
          `(${percent(measure.rate)}, threshold ${percent(measure.threshold)})`,
      );
    }
    if (group.measures.length > 0) {
      lines.push(`      latency      median ${String(Math.round(group.latency.medianMs))} ms, max ${String(Math.round(group.latency.maxMs))} ms`);
    }
    for (const reason of group.reasons) lines.push(`      reason: ${reason}`);
    for (const result of group.results.filter((candidate) => !candidate.passed)) {
      const detail = result.error ?? `got ${JSON.stringify(result.actual)}`;
      lines.push(`      failed: ${result.id} (${detail})`);
    }
  }

  // The counts keep an "OK" with nothing evaluated from looking like a success.
  const pending = report.groups.filter((group) => group.status === 'pending').length;
  const active = report.groups.length - pending;
  lines.push(
    `Result: ${report.ok ? 'OK' : 'FAILED'} (${String(active)} active, ${String(pending)} pending)`,
  );
  return lines.join('\n');
}
