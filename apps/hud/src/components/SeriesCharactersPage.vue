<script setup lang="ts">
/**
 * Impostazioni → Personaggi (request of the user of 2026-10-16, D-224): every
 * person of the series, grouped by series, each with its card — who it is and
 * how it speaks, the scene, the catchphrases and the real lines. Which agent
 * wears whom is chosen in Agenti → Aspetto; here only the character.
 */
import { computed, onMounted, ref } from 'vue';

import { loadSeriesPersonas, type SeriesPersonaView } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { seriesFocus } from '../lib/series-focus.ts';
import type { SeriesValues } from '../lib/settings.ts';
import SeriesPersonaCard from './SeriesPersonaCard.vue';

defineProps<{
  form: { series: Record<string, SeriesValues> };
  save: () => Promise<boolean>;
  busy: boolean;
  error?: string | undefined;
}>();

const people = ref<SeriesPersonaView[] | null>(null);
const loadError = ref<string | null>(null);
// Opened from an agent's Aspetto: its character first (read once).
const chosen = ref<string | null>(seriesFocus.value);
seriesFocus.value = null;

/** The series in the order the repository lists them, each with its people. */
const groups = computed(() => {
  const byShow = new Map<string, SeriesPersonaView[]>();
  for (const person of people.value ?? []) byShow.set(person.show ?? '', [...(byShow.get(person.show ?? '') ?? []), person]);
  return [...byShow.entries()].map(([show, members]) => ({ show: show === '' ? 'Altri' : show, members }));
});

onMounted(async () => {
  try {
    people.value = await loadSeriesPersonas();
    if (chosen.value === null || !people.value.some((person) => person.id === chosen.value)) chosen.value = people.value[0]?.id ?? null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere i personaggi. ${errorText(cause)}`;
  }
});
</script>

<template>
  <div class="flex flex-col gap-3.5 lg:flex-row lg:items-start">
    <p v-if="loadError" role="alert" class="text-[13px] text-danger">{{ loadError }}</p>
    <nav class="flex shrink-0 flex-col gap-3 lg:w-[200px]" aria-label="Personaggi delle serie">
      <div v-for="group in groups" :key="group.show" class="flex flex-col gap-0.5">
        <h3 class="mx-2 mb-0.5 text-[12.5px] font-semibold text-muted">{{ group.show }}</h3>
        <div class="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
          <button
            v-for="person in group.members"
            :key="person.id"
            type="button"
            class="rounded-lg px-2.5 py-1.5 text-left text-[14px] hover:bg-surface-2 hover:text-ink"
            :class="chosen === person.id ? 'bg-surface-2 font-semibold text-ink' : 'text-muted'"
            :aria-pressed="chosen === person.id"
            @click="chosen = person.id"
          >
            {{ person.name }}
            <span v-if="person.own !== null" class="ml-1 text-[11.5px] font-normal text-warn">riscritto</span>
          </button>
        </div>
      </div>
    </nav>
    <div class="min-w-0 flex-1">
      <SeriesPersonaCard v-if="chosen !== null" :key="chosen" :character="chosen" :form="form" :save="save" :busy="busy" :error="error" :own-traits="false" />
    </div>
  </div>
</template>
