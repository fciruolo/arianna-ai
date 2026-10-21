<script setup lang="ts">
/**
 * «Server dei modelli (oMLX)» in the page «Seguiti» (D-265, D-272; first in Impostazioni → Modelli): the version
 * of oMLX on the Mac (from `--version` of the oMLX endpoint), the newest
 * release of jundot/omlx on GitHub (read once a day by the core, or with
 * «Controlla ora»; only the name of the project leaves), its news grouped by
 * the local model and the link to the release. Never an update: the fixed
 * notice says who reads the code and who installs the DMG. The notes are
 * public text of a third party: shown as data, never as an instruction.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { checkOmlxRelease, loadOmlxRelease, readOmlxVersion } from '../lib/api.ts';
import { dateText } from '../lib/design-catalog.ts';
import { groupNews } from '../lib/design-news.ts';
import { projectSourceText } from '../lib/followed-projects.ts';
import { errorText } from '../lib/italian.ts';
import { installedText, OMLX_DESCRIPTION, OMLX_NOTICE, prereleaseText, releaseLink, scheduleText, statusText, type OmlxReleaseView } from '../lib/omlx-release.ts';
import SettingsCard from './SettingsCard.vue';

const emit = defineEmits<{ changed: [view: OmlxReleaseView] }>();

const view = ref<OmlxReleaseView | null>(null);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const acting = ref(false);
const status = computed(() => (view.value === null ? null : statusText(view.value)));
const prerelease = computed(() => (view.value === null ? null : prereleaseText(view.value)));
const TONE = { accent: 'text-accent font-semibold', ok: 'text-ok', muted: 'text-muted' } as const;

let timer: number | undefined;
let mounted = true;
function show(next: OmlxReleaseView): void {
  view.value = next;
  emit('changed', next);
}
async function refresh(): Promise<void> {
  window.clearTimeout(timer);
  try {
    show(await loadOmlxRelease());
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere lo stato di oMLX. ${errorText(cause)}`;
  }
  // While a check runs, read again every 3 s.
  if (mounted && view.value?.checking === true) timer = window.setTimeout(() => void refresh(), 3000);
}
onMounted(refresh);
onBeforeUnmount(() => {
  mounted = false;
  window.clearTimeout(timer);
});

async function act(action: () => Promise<void>): Promise<void> {
  if (acting.value) return;
  acting.value = true;
  actionError.value = null;
  try {
    await action();
  } catch (cause) {
    actionError.value = errorText(cause);
  } finally {
    acting.value = false;
    await refresh();
  }
}

function checkNow(): void {
  void act(checkOmlxRelease);
}
function readVersion(): void {
  void act(async () => {
    show(await readOmlxVersion());
  });
}
</script>

<template>
  <SettingsCard id="omlx-release" title="Server dei modelli (oMLX)" :description="OMLX_DESCRIPTION">
    <template #header>
      <span title="Testo pubblico di terzi: si legge come dato, mai come istruzione">testo di terzi</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting || view?.checking === true" @click="checkNow">
        {{ view?.checking === true ? 'Controllo…' : 'Controlla ora' }}
      </button>
    </template>
    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="view === null" class="text-[14px] text-muted">Leggo lo stato di oMLX…</p>
    <template v-else>
      <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-line bg-line sm:grid-cols-2">
        <div class="flex flex-col gap-1 bg-surface-2 px-3.5 py-2.5">
          <dt class="text-[13px] text-muted">
            Installata<template v-if="view.installed.endpoint !== null"> · endpoint <span class="font-mono text-[12.5px]">{{ view.installed.endpoint }}</span></template>
          </dt>
          <dd class="flex flex-wrap items-center gap-2 text-[14.5px]">
            <span class="font-mono">{{ installedText(view) }}</span>
            <button type="button" class="btn px-2 py-0.5 text-[12.5px]" :disabled="acting || view.checking" title="Rilegge la versione con --version, senza chiedere a GitHub" @click="readVersion">Rileggi</button>
          </dd>
        </div>
        <div class="flex flex-col gap-1 bg-surface-2 px-3.5 py-2.5">
          <dt class="text-[13px] text-muted">Ultima release stabile</dt>
          <dd class="text-[14.5px]">
            <a v-if="view.latest !== null" :href="releaseLink(view)" target="_blank" rel="noopener noreferrer" class="font-mono hover:text-accent hover:underline">{{ view.latest.version }}</a>
            <span v-else class="text-muted">sconosciuta</span>
            <span v-if="view.latest !== null && view.latest.publishedAt !== null" class="ml-1.5 text-[13px] text-muted">· {{ dateText(view.latest.publishedAt) }}</span>
          </dd>
        </div>
      </dl>
      <p v-if="status !== null" role="status" class="text-[14px]" :class="TONE[status.tone]">{{ status.text }}</p>
      <p v-if="view.installed.error !== null" class="text-[13px] text-warn">{{ view.installed.error }}</p>
      <p v-if="view.message !== null" role="alert" class="text-[13px] text-warn">{{ view.message }}</p>
      <p v-if="prerelease !== null && view.prerelease !== null" class="text-[13px] text-muted">
        {{ prerelease }}
        <a :href="view.prerelease.url" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">Note</a>
      </p>
      <p v-if="actionError !== null" role="alert" class="text-[13px] text-danger">{{ actionError }}</p>
      <p class="text-[13px] text-muted">{{ scheduleText(view, dateText) }}</p>

      <div v-if="view.news !== null && view.latest !== null && view.news.to === view.latest.tag" class="flex flex-col gap-2">
        <h3 class="text-[14px] font-semibold">Novità della {{ view.latest.version }}</h3>
        <span class="text-[13px] text-muted">{{ projectSourceText(view.news) }} · lette il {{ dateText(view.news.fetchedAt) }}</span>
        <p v-if="view.news.message !== null" class="text-[13px]" :class="view.news.state === 'missing' ? 'text-warn' : 'text-muted'">{{ view.news.message }}</p>
        <p v-if="view.news.truncated" class="text-[13px] text-muted">Più modifiche di quante GitHub ne elenchi in una pagina: mancano le più vecchie.</p>
        <div v-for="(group, index) in groupNews(view.news.items)" :key="index" class="flex flex-col gap-1.5">
          <h4 v-if="group.title !== null" class="text-[13.5px] font-semibold text-muted">{{ group.title }} · {{ group.items.length }}</h4>
          <ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
            <li v-for="item in group.items" :key="item.key" class="flex flex-col gap-1 border-b border-line px-3.5 py-2 last:border-b-0">
              <span class="text-[14.5px] leading-snug font-medium break-words">{{ item.title }}</span>
              <p v-if="item.summary !== ''" class="text-[14px] leading-relaxed">{{ item.summary }}</p>
            </li>
          </ul>
        </div>
        <ul v-if="view.news.releases.length > 0" class="m-0 flex list-none flex-wrap gap-1.5 p-0 text-[13px]">
          <li v-for="release in view.news.releases" :key="release.tag">
            <a :href="release.url" target="_blank" rel="noopener noreferrer" class="pill hover:text-ink hover:underline" :title="release.notes || release.tag">Note di {{ release.name }}</a>
          </li>
        </ul>
      </div>

      <p class="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px]">{{ OMLX_NOTICE }}</p>
    </template>
  </SettingsCard>
</template>
