<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { discussWithGod, loadChangelog, loadGod } from '../lib/api.ts';
import { currentText, orderVersions, sectionTone, skippedText, versionDate, versionTitle, type SectionTone } from '../lib/changelog.ts';
import { discussBlocker, discussTitle, plainItem, type GodStatus } from '../lib/god.ts';
import { errorText } from '../lib/italian.ts';
import type { Changelog, ChangelogVersion } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * "Novità": the register of the versions, read by the core from CHANGELOG.md.
 * The current version on top, then the versions from the most recent; the
 * items as Markdown through MarkdownText (never v-html), read only. Next to
 * each item "Parlane con GOD" (I-6, D-178) opens a new conversation with GOD
 * whose context the core writes from the entry as main holds it in git; off,
 * with the reason, when GOD cannot answer.
 */
const emit = defineEmits<{ open: [id: string] }>();

const changelog = ref<Changelog | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const god = ref<GodStatus | null>(null);
const godLoaded = ref(false);
const opening = ref<string | null>(null);
const godError = ref<string | null>(null);

const godOff = computed(() => (godLoaded.value ? discussBlocker(god.value) : 'Controllo se GOD può rispondere…'));

function itemKey(entry: ChangelogVersion, section: string, index: number): string {
  return `${entry.version ?? 'unreleased'}/${section}/${String(index)}`;
}

async function discuss(entry: ChangelogVersion, section: string, text: string, index: number): Promise<void> {
  if (godOff.value !== null || opening.value !== null) return;
  opening.value = itemKey(entry, section, index);
  try {
    const conversation = await discussWithGod({ version: entry.version, section, text });
    godError.value = null;
    emit('open', conversation.id);
  } catch (cause) {
    godError.value = `Non sono riuscita ad aprire la conversazione con GOD. ${errorText(cause)}`;
    // GOD may have changed since the page opened (the clone removed, an executor off): the button follows.
    void refreshGod();
  } finally {
    opening.value = null;
  }
}

async function refreshGod(): Promise<void> {
  try {
    god.value = await loadGod();
  } catch {
    god.value = null;
  } finally {
    godLoaded.value = true;
  }
}

const versions = computed(() => orderVersions(changelog.value?.versions ?? []));
const current = computed(() => currentText(changelog.value?.current ?? null));
const skipped = computed(() => skippedText(changelog.value?.skipped ?? 0));

const BADGE_CLASS: Record<SectionTone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  info: 'border-info/40 bg-info/10 text-info',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  neutral: 'border-line bg-surface-2 text-muted',
};
const DOT_CLASS: Record<SectionTone, string> = {
  ok: 'bg-ok/70',
  info: 'bg-info/70',
  warn: 'bg-warn/70',
  danger: 'bg-danger/70',
  neutral: 'bg-line-strong',
};

async function refresh(): Promise<void> {
  try {
    changelog.value = await loadChangelog();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere il registro delle versioni. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
  void refreshGod();
});

function reload(): void {
  void refresh();
  void refreshGod();
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <section class="hud-card p-4" aria-labelledby="changelog-title">
        <div class="flex flex-wrap items-center gap-2">
          <Icon name="history" :size="16" />
          <h1 id="changelog-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">Novità</h1>
          <span class="ml-auto font-mono text-[10.5px] tracking-[0.06em] text-muted">da CHANGELOG.md</span>
          <button type="button" class="rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi il registro" aria-label="Rileggi il registro" @click="reload">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p v-if="loadError !== null" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
        <p v-else-if="loading" class="py-4 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO IL REGISTRO…</p>
        <template v-else>
          <p v-if="current !== null" class="mt-3 font-hud text-[26px] leading-none font-semibold">{{ current }}</p>
          <p v-else class="mt-3 text-sm text-muted">Nessuna versione rilasciata finora.</p>
          <p v-if="skipped !== null" class="mt-2 text-xs text-muted">{{ skipped }}</p>
          <p v-if="godLoaded && godOff !== null && versions.length > 0" class="mt-2 text-xs text-muted">«Parlane con GOD» è spento: {{ godOff }}</p>
        </template>
        <p v-if="godError !== null" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ godError }}</p>
      </section>

      <p v-if="!loading && loadError === null && versions.length === 0" class="mx-1 text-sm text-muted">Il registro delle versioni è vuoto o manca.</p>

      <article
        v-for="entry in versions"
        :key="entry.version ?? 'unreleased'"
        class="hud-card p-4"
        :aria-labelledby="`version-${entry.version ?? 'unreleased'}`"
      >
        <header class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 :id="`version-${entry.version ?? 'unreleased'}`" class="font-hud text-lg font-semibold" :class="entry.unreleased ? 'text-muted' : 'text-ink'">
            {{ versionTitle(entry) }}
          </h2>
          <span v-if="versionDate(entry) !== null" class="text-sm text-muted">{{ versionDate(entry) }}</span>
          <span v-if="entry.version !== null && entry.version === changelog?.current" class="rounded-[5px] border border-accent/50 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] text-accent uppercase">attuale</span>
        </header>
        <MarkdownText v-if="entry.summary !== null" class="mb-3 text-[13.5px] text-muted" :source="entry.summary" />
        <p v-if="entry.sections.length === 0" class="text-sm text-muted">Nessuna voce.</p>
        <div v-for="section in entry.sections" :key="section.title" class="mt-3 first:mt-0">
          <h3 class="mb-1.5">
            <span class="rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.08em] uppercase" :class="BADGE_CLASS[sectionTone(section.title)]">{{ section.title }}</span>
          </h3>
          <ul class="flex flex-col gap-1 text-[13.5px]">
            <li v-for="(item, index) in section.items" :key="index" class="flex gap-2.5">
              <span class="mt-[0.55em] size-[6px] shrink-0 rounded-full" :class="DOT_CLASS[sectionTone(section.title)]" aria-hidden="true" />
              <MarkdownText class="min-w-0 flex-1" :source="item" />
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 self-start rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-muted hover:border-line-strong hover:text-ink disabled:opacity-50 disabled:hover:border-line disabled:hover:text-muted"
                :disabled="godOff !== null || opening !== null"
                :title="discussTitle(godOff, entry.unreleased)"
                :aria-label="`Parlane con GOD: ${plainItem(item)}`"
                @click="discuss(entry, section.title, item, index)"
              >
                <Icon name="god" :size="12" />{{ opening === itemKey(entry, section.title, index) ? 'Apro…' : 'Parlane con GOD' }}
              </button>
            </li>
          </ul>
        </div>
      </article>
    </div>
  </div>
</template>
