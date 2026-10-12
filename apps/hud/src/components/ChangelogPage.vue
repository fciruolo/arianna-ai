<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { discussWithGod, loadChangelog, loadGod } from '../lib/api.ts';
import { orderVersions, sectionTone, skippedText, versionDate, versionTitle, type SectionTone } from '../lib/changelog.ts';
import { discussBlocker, discussTitle, plainItem, type GodStatus } from '../lib/god.ts';
import { errorText } from '../lib/italian.ts';
import type { Changelog, ChangelogVersion } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * "Novità", a section of the settings (D-192): the register of the versions,
 * read by the core from CHANGELOG.md, from the most recent; the title, the
 * sentence and the width are the settings page's. The items as Markdown
 * through MarkdownText (never v-html), read only. "Parlane con GOD" (I-6,
 * D-178), shown when the pointer is on the line or the line has the focus,
 * opens a new conversation with GOD whose context the core writes from the
 * entry as main holds it in git; off, with the reason, when GOD cannot answer.
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
const skipped = computed(() => skippedText(changelog.value?.skipped ?? 0));

const KIND_CLASS: Record<SectionTone, string> = {
  ok: 'text-ok',
  info: 'text-info',
  warn: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-muted',
};

async function refresh(): Promise<void> {
  try {
    changelog.value = await loadChangelog();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere l’elenco delle novità. ${errorText(cause)}`;
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
  <div class="flex flex-col gap-4">
    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="reload">Riprova</button>
    </div>
    <p v-else-if="loading" class="text-[14px] text-muted">Leggo le novità…</p>
    <template v-else>
      <p v-if="versions.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
        <b class="font-semibold text-ink">Nessuna versione ancora.</b> Ogni lavoro finito aggiunge qui le sue righe, con la data in cui entra.
      </p>
      <p v-if="skipped !== null" class="text-[13px] text-muted">{{ skipped }}</p>
      <p v-if="godLoaded && godOff !== null && versions.length > 0" class="text-[13px] text-muted">«Parlane con GOD» è spento: {{ godOff }}</p>
    </template>
    <div v-if="godError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ godError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="godError = null">Chiudi</button>
    </div>

    <article
      v-for="entry in versions"
      :key="entry.version ?? 'unreleased'"
      class="rounded-xl border border-line bg-surface-2 p-4"
      :aria-labelledby="`version-${entry.version ?? 'unreleased'}`"
    >
      <header class="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 :id="`version-${entry.version ?? 'unreleased'}`" class="text-[16px] font-semibold" :class="entry.unreleased ? 'text-muted' : 'text-ink'">{{ versionTitle(entry) }}</h2>
        <span v-if="entry.version !== null && entry.version === changelog?.current" class="pill border-accent text-accent">attuale</span>
        <span v-if="versionDate(entry) !== null" class="ml-auto text-[14px] text-muted">{{ versionDate(entry) }}</span>
      </header>
      <MarkdownText v-if="entry.summary !== null" class="mb-2 text-[14.5px] text-muted" :source="entry.summary" />
      <p v-if="entry.sections.length === 0" class="text-[14px] text-muted">Nessuna voce.</p>
      <div v-for="section in entry.sections" :key="section.title" class="mt-3 first:mt-0">
        <h3 class="mb-1 text-[13.5px] font-semibold" :class="KIND_CLASS[sectionTone(section.title)]">{{ section.title }}</h3>
        <ul class="flex flex-col gap-1 text-[14.5px]">
          <li v-for="(item, index) in section.items" :key="index" class="god-line flex items-baseline gap-2.5 py-0.5">
            <MarkdownText class="min-w-0 flex-1" :source="item" />
            <button
              type="button"
              class="god inline-flex shrink-0 items-center gap-1 self-start rounded-lg border border-line-strong bg-surface px-2 py-0.5 text-[13px] text-muted hover:text-ink disabled:opacity-50"
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
</template>

<style scoped>
/* «Parlane con GOD» shows on the line under the pointer or with the focus; on a touch screen it is always there. */
@media (hover: hover) {
  .god-line .god {
    opacity: 0;
  }
  .god-line:hover .god,
  .god-line:focus-within .god {
    opacity: 1;
  }
}
</style>
