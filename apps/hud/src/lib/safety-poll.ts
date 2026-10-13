import type { SafetyView } from './safety-report.ts';

/** How often a text is read again while its safety report is being made (D-196). */
export const SAFETY_POLL_MS = 4000;

/**
 * Reads a role or a skill again while Opus writes its report (D-196): `read`
 * gives the text with its report, `apply` shows it and says whether it is
 * still the one on screen (false: the user chose another one, the poll ends).
 */
export function safetyPoll<T extends { safety?: SafetyView }>(read: () => Promise<T>, apply: (value: T) => boolean): { follow: (current: T | null) => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function stop(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function follow(current: T | null): void {
    stop();
    if (current?.safety?.state !== 'running') return;
    timer = setTimeout(() => {
      read()
        .then((value) => {
          if (apply(value)) follow(value);
        })
        .catch(() => {
          // The core did not answer: try again at the next round.
          follow(current);
        });
    }, SAFETY_POLL_MS);
  }
  return { follow, stop };
}
