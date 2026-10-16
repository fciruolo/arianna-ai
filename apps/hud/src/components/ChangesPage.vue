<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { loadChanges } from '../lib/api.ts';
import { CHANGE_GROUPS, changeDays, groupCounts, sinceText, timeText, type ChangeGroup, type ChangesReport } from '../lib/changes.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';

/**
 * «Cosa è cambiato», a section of the settings (D-233, idea 11 of OpenWork):
 * what the core observed changing in this installation, by day, with a
 * filter by kind and a link to the section where that thing is changed.
 * Only names, ids, versions and states (GET /api/changes); no chat or note.
 */
const emit = defineEmits<{ section: [slug: string] }>();

const report = ref<ChangesReport | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const chosen = ref<ChangeGroup | null>(null);
let request = 0;
const now = ref(new Date());

async function refresh(): Promise<void> {
  const mine = (request += 1);
  loading.value = true;
  now.value = new Date();
  try {
    const next = await loadChanges();
    if (mine !== request) return;
    report.value = next;
    loadError.value = null;
  } catch (cause) {
    if (mine !== request) return;
    loadError.value = `Non riesco a leggere i cambiamenti. ${errorText(cause)}`;
  } finally {
    if (mine === request) loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});

const days = computed(() => (report.value === null ? [] : changeDays(report.value, chosen.value, now.value)));
const counts = computed(() => (report.value === null ? null : groupCounts(report.value)));
const filters = computed(() => CHANGE_GROUPS.filter((group) => (counts.value?.[group.id] ?? 0) > 0));

function choose(group: ChangeGroup | null): void {
  chosen.value = chosen.value === group ? null : group;
}

function open(slug: string): void {
  emit('section', slug);
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2.5">
      <span v-if="report !== null" class="text-[13px] text-muted">{{ sinceText(report, now) }}</span>
      <span class="ml-auto flex items-center gap-1.5 text-[13px] text-muted"><LabelBadge label="L1" class="text-xs" />solo nomi e versioni</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="loading" @click="refresh">{{ loading ? 'Controllo…' : 'Controlla ora' }}</button>
    </div>

    <div v-if="filters.length > 1" class="flex flex-wrap gap-1.5" role="group" aria-label="Tipo di cambiamento">
      <button
        type="button"
        class="rounded-full border px-2.5 py-0.5 text-[13px]"
        :class="chosen === null ? 'border-line-strong bg-surface font-semibold text-ink' : 'border-line text-muted hover:text-ink'"
        :aria-pressed="chosen === null"
        @click="chosen = null"
      >
        Tutti
      </button>
      <button
        v-for="group in filters"
        :key="group.id"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[13px]"
        :class="chosen === group.id ? 'border-line-strong bg-surface font-semibold text-ink' : 'border-line text-muted hover:text-ink'"
        :aria-pressed="chosen === group.id"
        @click="choose(group.id)"
      >
        <Icon :name="group.icon" :size="14" />{{ group.title }}
        <span class="tabular-nums">{{ counts?.[group.id] ?? 0 }}</span>
      </button>
    </div>

    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="loading && report === null" class="text-[14px] text-muted">Leggo i cambiamenti…</p>

    <template v-if="report !== null">
      <p v-if="days.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
        <b class="font-semibold text-ink">Niente di cambiato finora.</b> Quando scarichi un modello, accendi Claude o Codex, usi una versione nuova di un catalogo, aggiungi un progetto o cambi tema, qui compare una riga.
      </p>

      <section v-for="day in days" :key="day.day" class="flex flex-col gap-1.5" :aria-labelledby="`changes-${day.day}`" :class="{ 'opacity-60': loading }">
        <h2 :id="`changes-${day.day}`" class="text-[15px] font-semibold first-letter:uppercase">{{ day.title }}</h2>
        <ul class="flex flex-col overflow-hidden rounded-xl border border-line">
          <li v-for="row in day.rows" :key="row.key" class="flex items-start gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
            <span class="mt-0.5 text-muted" :title="row.group.title"><Icon :name="row.group.icon" :size="17" /></span>
            <div class="min-w-0 flex-1">
              <div class="text-[14.5px] break-words text-ink">{{ row.title }}</div>
              <div v-if="row.detail !== null" class="text-[13px] break-words text-muted">{{ row.detail }}</div>
            </div>
            <span class="shrink-0 text-[13px] text-muted tabular-nums">{{ timeText(row.at) }}</span>
            <a :href="row.href" class="shrink-0 text-[13px] text-accent hover:underline" @click.prevent="open(row.slug)">{{ row.link }}</a>
          </li>
          <li v-if="day.more > 0" class="border-t border-line px-3.5 py-2 text-[13px] text-muted first:border-t-0">e altri {{ day.more }} cambiamenti non elencati</li>
        </ul>
      </section>

      <p v-if="report.truncated" class="text-[13px] text-muted">Mostro gli ultimi 300 controlli con dei cambiamenti; i più vecchi restano nel registro degli eventi.</p>
    </template>
  </div>
</template>
