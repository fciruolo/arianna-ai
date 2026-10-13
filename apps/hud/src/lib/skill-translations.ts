import { onBeforeUnmount, ref, type Ref } from 'vue';

import { skillTranslations } from './api.ts';
import { shouldStartTranslations, skillDescription, type SkillSummary } from './skills-catalog.ts';
import type { TranslationsStatus } from './studio.ts';

/** How often the status is read again while Sonnet translates. */
const POLL_MS = 4000;

export interface SkillTranslationsHandle {
  status: Ref<TranslationsStatus | null>;
  /** The Italian description of a skill, the English one until it arrives. */
  text: (skill: SkillSummary) => string;
  /** Reads the translations and, when some are missing and no run is on, asks the core for them in the background. */
  open: () => Promise<void>;
}

/**
 * The Italian descriptions of the skills (I-20, D-185), shared by every page
 * that lists skills (the Studio, the tab "Skill" of an agent, Skill e stili).
 * Skills are public text of the catalogs (L0): the core has Sonnet translate
 * them, never data of the user. A failure is silent: the English stays.
 */
export function useSkillTranslations(): SkillTranslationsHandle {
  const status = ref<TranslationsStatus | null>(null);
  let timer: number | undefined;
  let alive = true;

  function schedule(): void {
    window.clearTimeout(timer);
    timer = undefined;
    if (alive && status.value?.running === true) timer = window.setTimeout(() => void refresh(), POLL_MS);
  }

  async function refresh(): Promise<void> {
    try {
      status.value = await skillTranslations();
    } catch {
      // Without the core's answer the descriptions stay in English.
    }
    schedule();
  }

  async function open(): Promise<void> {
    try {
      const found = await skillTranslations();
      status.value = found;
      if (shouldStartTranslations(found)) status.value = await skillTranslations(true);
    } catch {
      // Without Claude the descriptions stay in English.
    }
    schedule();
  }

  onBeforeUnmount(() => {
    alive = false;
    window.clearTimeout(timer);
  });

  return { status, text: (skill) => skillDescription(skill, status.value?.translations), open };
}
