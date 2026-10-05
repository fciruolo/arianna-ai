<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { loadChangelog } from '../lib/api.ts';
import { currentText, orderVersions, sectionTone, skippedText, versionDate, versionTitle, type SectionTone } from '../lib/changelog.ts';
import { errorText } from '../lib/italian.ts';
import type { Changelog } from '../lib/types.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * "Novità": the register of the versions, read by the core from CHANGELOG.md.
 * The current version on top, then the versions from the most recent; the
 * items as Markdown through MarkdownText (never v-html), read only.
 */
const changelog = ref<Changelog | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

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

onMounted(refresh);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <section class="hud-card p-4" aria-labelledby="changelog-title">
        <div class="flex flex-wrap items-center gap-2">
          <Icon name="history" :size="16" />
          <h1 id="changelog-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">Novità</h1>
          <span class="ml-auto font-mono text-[10.5px] tracking-[0.06em] text-muted">da CHANGELOG.md</span>
          <button type="button" class="rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi il registro" aria-label="Rileggi il registro" @click="refresh">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p v-if="loadError !== null" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
        <p v-else-if="loading" class="py-4 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO IL REGISTRO…</p>
        <template v-else>
          <p v-if="current !== null" class="mt-3 font-hud text-[26px] leading-none font-semibold">{{ current }}</p>
          <p v-else class="mt-3 text-sm text-muted">Nessuna versione rilasciata finora.</p>
          <p v-if="skipped !== null" class="mt-2 text-xs text-muted">{{ skipped }}</p>
        </template>
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
            </li>
          </ul>
        </div>
      </article>
    </div>
  </div>
</template>
