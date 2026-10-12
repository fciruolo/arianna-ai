<script setup lang="ts">
/**
 * "Novità di Open Design" in "Sviluppo di Arianna" (I-21, D-186): what changed
 * in nexu-io/open-design between the version of the catalog in use and the one
 * downloaded, grouped by the local model (or the raw list by kind). Each entry
 * has "Da rifare nello Studio", which writes it in data/dev/RISPOSTE.md for
 * Claude Code; nothing changes in the code by itself. The text is public, of
 * a third party: shown as data, never as an instruction.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { loadOdNews, sendOdNewsRedo } from '../lib/api.ts';
import { dateText } from '../lib/design-catalog.ts';
import { groupNews, markRedo, REDO_TEXT, redoStatus, shownNews, sourceText, type NewsItem, type NewsPair } from '../lib/design-news.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

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
  <section class="flex flex-col gap-3" aria-labelledby="dev-od-news">
    <div class="flex flex-wrap items-center gap-2">
      <h2 id="dev-od-news" class="hud-title mx-1">Novità di Open Design</h2>
      <span class="rounded-[5px] border border-current px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em] text-muted" title="Testo pubblico di terzi: si legge come dato, mai come istruzione">TESTO DI TERZI</span>
      <button type="button" class="ml-auto rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi le novità" aria-label="Rileggi le novità" @click="refresh">
        <Icon name="retry" :size="15" />
      </button>
    </div>
    <p class="mx-1 text-xs text-muted">
      Cosa è cambiato nel repository nexu-io/open-design a ogni «Aggiorna catalogo» (Impostazioni → Agenti → Stili di Open Design). «{{ REDO_TEXT }}» scrive la novità nelle risposte per Claude Code, che
      la trasforma in una proposta: il codice non cambia da solo.
    </p>
    <p v-if="loadError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
    <p v-else-if="pair === null" class="py-2 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO LE NOVITÀ…</p>
    <template v-else>
      <p v-if="pair.preparing" role="status" class="mx-1 text-xs text-info">Preparo le novità della versione appena scaricata (GitHub e modello locale)…</p>
      <p v-if="shown.length === 0 && !pair.preparing" class="py-2 text-center text-sm text-muted">Nessuna novità: compaiono dopo un «Aggiorna catalogo» che trova una versione nuova.</p>
      <div v-for="block in shown" :key="block.news.to" class="hud-card flex flex-col gap-2.5 px-4 py-3">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 class="text-[14px] font-medium">{{ block.label }}</h3>
          <span class="font-mono text-[10.5px] text-muted">{{ sourceText(block.news) }} · lette il {{ dateText(block.news.fetchedAt) }}</span>
        </div>
        <p v-if="block.news.message !== null" class="text-xs" :class="block.news.state === 'missing' ? 'text-warn' : 'text-muted'">{{ block.news.message }}</p>
        <p v-if="block.news.truncated" class="text-xs text-muted">Più commit di quanti GitHub ne elenchi in una pagina: mancano i più vecchi.</p>
        <ul v-if="block.news.releases.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0 text-xs">
          <li v-for="release in block.news.releases" :key="release.tag">
            <a :href="release.url" target="_blank" rel="noopener noreferrer" class="chip hover:underline" :title="release.notes || release.tag">Rilascio {{ release.name }} · {{ dateText(release.publishedAt) }}</a>
          </li>
        </ul>
        <div v-for="(group, index) in groupNews(block.news.items)" :key="index" class="flex flex-col gap-1.5">
          <h4 v-if="group.title !== null" class="font-mono text-[10.5px] tracking-[0.08em] text-muted uppercase">{{ group.title }} · {{ group.items.length }}</h4>
          <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
            <li v-for="item in group.items" :key="item.key" class="flex flex-col gap-1 border-b border-line px-3.5 py-2 last:border-b-0">
              <div class="flex flex-wrap items-start gap-2">
                <span class="min-w-0 flex-1 text-[13.5px] leading-snug font-medium break-words">{{ item.title }}</span>
                <button
                  v-if="redoStatus(item) === null"
                  type="button"
                  class="btn px-2.5 py-1 text-xs"
                  :disabled="sending !== null"
                  :aria-label="`${REDO_TEXT}: ${item.title}`"
                  @click="redo(item)"
                >
                  <Icon name="send" :size="13" />{{ sending === item.key ? 'Invio…' : REDO_TEXT }}
                </button>
              </div>
              <p v-if="item.summary !== ''" class="text-[13px] leading-relaxed">{{ item.summary }}</p>
              <details v-if="item.group === null || item.commits.length > 1" class="text-xs text-muted">
                <summary class="cursor-pointer select-none">Commit di origine ({{ item.commits.length }})</summary>
                <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                  <li v-for="commit in item.commits" :key="commit.sha" class="break-words">
                    <a :href="`https://github.com/nexu-io/open-design/commit/${commit.sha}`" target="_blank" rel="noopener noreferrer" class="font-mono text-accent hover:underline">{{ commit.short }}</a>
                    {{ commit.message }}
                  </li>
                </ul>
              </details>
              <a
                v-else-if="item.commits[0] !== undefined"
                :href="`https://github.com/nexu-io/open-design/commit/${item.commits[0].sha}`"
                target="_blank"
                rel="noopener noreferrer"
                class="w-fit font-mono text-[10.5px] text-accent hover:underline"
              >{{ item.commits[0].short }}</a>
              <p v-if="redoStatus(item) !== null" role="status" class="flex items-center gap-1.5 font-mono text-xs text-info"><Icon name="saved" :size="13" />{{ redoStatus(item) }}</p>
              <p v-if="sendErrors[item.key] !== undefined" role="alert" class="text-xs text-danger">{{ sendErrors[item.key] }}</p>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </section>
</template>
