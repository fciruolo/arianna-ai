<script setup lang="ts">
/**
 * "Novità di Open Design" in Impostazioni → Skill e stili (I-21, D-186,
 * D-192): what changed in nexu-io/open-design between the version of the
 * catalog in use and the one downloaded, grouped by the local model (or the
 * raw list by kind). Each entry has "Da rifare nello Studio", which writes it
 * in data/dev/RISPOSTE.md for Claude Code; nothing changes in the code by
 * itself. The text is public, of a third party: shown as data, never as an
 * instruction.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { loadOdNews, sendOdNewsRedo } from '../lib/api.ts';
import { dateText } from '../lib/design-catalog.ts';
import { groupNews, markRedo, REDO_TEXT, redoStatus, shownNews, sourceText, type NewsItem, type NewsPair } from '../lib/design-news.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';
import SettingsCard from './SettingsCard.vue';

const pair = ref<NewsPair | null>(null);
const loadError = ref<string | null>(null);
const sending = ref<string | null>(null);
const sendErrors = ref<Record<string, string>>({});
const shown = computed(() => shownNews(pair.value));

let timer: number | undefined;
let mounted = true;
async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    pair.value = await loadOdNews();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere le novità di Open Design. ${errorText(cause)}`;
  }
  // While the news of a download is being made, read again every 3 s.
  if (mounted && pair.value?.preparing === true) timer = window.setTimeout(() => void refresh(), 3000);
}
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});

async function redo(item: NewsItem): Promise<void> {
  if (sending.value !== null || pair.value === null) return;
  sending.value = item.key;
  const { [item.key]: _cleared, ...others } = sendErrors.value;
  sendErrors.value = others;
  try {
    const saved = await sendOdNewsRedo(item.key);
    pair.value = markRedo(pair.value, saved.key, saved.at);
  } catch (cause) {
    sendErrors.value = { ...sendErrors.value, [item.key]: `Non riesco a salvarla. ${errorText(cause)}` };
  } finally {
    sending.value = null;
  }
}

onMounted(refresh);
</script>

<template>
  <SettingsCard
    id="od-news"
    title="Novità di Open Design"
    :description="`Cosa è cambiato nel programma Open Design a ogni versione nuova degli stili. «${REDO_TEXT}» la passa a Claude Code, che ne fa una proposta: il codice non cambia da solo.`"
  >
    <template #header>
      <span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">testo di terzi</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Aggiorna</button>
    </template>
    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="pair === null" class="text-[14px] text-muted">Leggo le novità…</p>
    <template v-else>
      <p v-if="pair.preparing" role="status" class="text-[13px] text-info">Preparo le novità della versione appena scaricata (da GitHub, riassunte dal modello del Mac)…</p>
      <p v-if="shown.length === 0 && !pair.preparing" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
        <b class="font-semibold text-ink">Nessuna novità.</b> Compaiono qui quando «Cerca aggiornamenti», in «Stili per il Designer», trova una versione nuova.
      </p>
      <div v-for="block in shown" :key="block.news.to" class="flex flex-col gap-2.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 class="text-[15px] font-semibold">{{ block.label }}</h3>
          <span class="text-[13px] text-muted">{{ sourceText(block.news) }} · lette il {{ dateText(block.news.fetchedAt) }}</span>
        </div>
        <p v-if="block.news.message !== null" class="text-[13px]" :class="block.news.state === 'missing' ? 'text-warn' : 'text-muted'">{{ block.news.message }}</p>
        <p v-if="block.news.truncated" class="text-[13px] text-muted">Più modifiche di quante GitHub ne elenchi in una pagina: mancano le più vecchie.</p>
        <ul v-if="block.news.releases.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0 text-[13px]">
          <li v-for="release in block.news.releases" :key="release.tag">
            <a :href="release.url" target="_blank" rel="noopener noreferrer" class="pill hover:text-ink hover:underline" :title="release.notes || release.tag">Rilascio {{ release.name }} · {{ dateText(release.publishedAt) }}</a>
          </li>
        </ul>
        <div v-for="(group, index) in groupNews(block.news.items)" :key="index" class="flex flex-col gap-1.5">
          <h4 v-if="group.title !== null" class="text-[13.5px] font-semibold text-muted">{{ group.title }} · {{ group.items.length }}</h4>
          <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
            <li v-for="item in group.items" :key="item.key" class="flex flex-col gap-1 border-b border-line px-3.5 py-2 last:border-b-0">
              <div class="flex flex-wrap items-start gap-2">
                <span class="min-w-0 flex-1 text-[14.5px] leading-snug font-medium break-words">{{ item.title }}</span>
                <button
                  v-if="redoStatus(item) === null"
                  type="button"
                  class="btn px-2.5 py-1 text-[13px]"
                  :disabled="sending !== null"
                  :aria-label="`${REDO_TEXT}: ${item.title}`"
                  @click="redo(item)"
                >
                  <Icon name="send" :size="13" />{{ sending === item.key ? 'Invio…' : REDO_TEXT }}
                </button>
              </div>
              <p v-if="item.summary !== ''" class="text-[14px] leading-relaxed">{{ item.summary }}</p>
              <details v-if="item.group === null || item.commits.length > 1" class="text-[13px] text-muted">
                <summary class="cursor-pointer select-none">Modifiche di origine ({{ item.commits.length }})</summary>
                <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                  <li v-for="commit in item.commits" :key="commit.sha" class="break-words">
                    <a :href="`https://github.com/nexu-io/open-design/commit/${commit.sha}`" target="_blank" rel="noopener noreferrer" class="font-mono text-[12.5px] text-accent hover:underline">{{ commit.short }}</a>
                    {{ commit.message }}
                  </li>
                </ul>
              </details>
              <a
                v-else-if="item.commits[0] !== undefined"
                :href="`https://github.com/nexu-io/open-design/commit/${item.commits[0].sha}`"
                target="_blank"
                rel="noopener noreferrer"
                class="w-fit text-[13px] text-accent hover:underline"
              >Vedi la modifica su GitHub</a>
              <p v-if="redoStatus(item) !== null" role="status" class="flex items-center gap-1.5 text-[13px] text-info"><Icon name="saved" :size="13" />{{ redoStatus(item) }}</p>
              <p v-if="sendErrors[item.key] !== undefined" role="alert" class="text-[13px] text-danger">{{ sendErrors[item.key] }}</p>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </SettingsCard>
</template>
