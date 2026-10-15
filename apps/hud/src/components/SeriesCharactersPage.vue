<script setup lang="ts">
/**
 * Impostazioni → Personaggi (request of the user of 2026-10-16, D-224): every
 * person of the series, grouped by series, each with its card — who it is and
 * how it speaks, the scene, the catchphrases and the real lines. Which agent
 * wears whom is chosen in Agenti → Aspetto; here only the character.
 */
import { computed, onMounted, ref } from 'vue';

import { loadSeriesPersonas, sheetUrl, type SeriesPersonaView } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { seriesFocus } from '../lib/series-focus.ts';
import type { SeriesValues } from '../lib/settings.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import PixelAgent from './PixelAgent.vue';
import SeriesPersonaCard from './SeriesPersonaCard.vue';
import SheetPreview from './SheetPreview.vue';

const props = defineProps<{
  form: { series: Record<string, SeriesValues> };
  save: () => Promise<boolean>;
  busy: boolean;
  error?: string | undefined;
  /** The packs and who wears what (D-103): the look of the character and its agents. */
  characters: CharacterListing | null;
  sheetVersion: number;
  /** Agent → the name it is shown with. */
  agentName: (agent: string) => string;
}>();

const SERIES_PACK = 'serie';
/** How the cards of agents/ are called in the chat. */
const AGENT_LABELS: Record<string, string> = { arianna: 'Arianna', coder: 'Coder', god: 'GOD', designer: 'Designer', finanze: 'Finanze', reviewer: 'Reviewer' };
const POSES = [
  { pose: 'idle', text: 'fermo' },
  { pose: 'thinking', text: 'pensa' },
  { pose: 'working', text: 'lavora' },
] as const;
const animationsOpen = ref(false);

/** The sheet of the chosen character in the pack serie; undefined when the pack does not serve it. */
const look = computed((): CharacterChoice | undefined => {
  const info = props.characters?.packs.find((pack) => pack.id === SERIES_PACK)?.characters.find((character) => character.id === chosen.value);
  return info === undefined || chosen.value === null ? undefined : { pack: SERIES_PACK, character: chosen.value, rows: info.rows };
});
/** The agents that wear it now, as the core assigns them. */
const wornBy = computed(() =>
  Object.entries(props.characters?.agents ?? {})
    .filter(([, choice]) => choice.pack === SERIES_PACK && choice.character === chosen.value)
    .map(([agent]) => props.characters?.names?.[agent] ?? AGENT_LABELS[agent] ?? props.agentName(agent)),
);

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
    <div class="flex min-w-0 flex-1 flex-col gap-3.5">
      <!-- The look of the character (request of the user of 2026-10-16) -->
      <section v-if="look !== undefined" class="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-3.5" aria-label="Aspetto del personaggio">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="mr-auto text-[14px] font-medium">Aspetto</h3>
          <span class="text-[12.5px] text-muted">{{ wornBy.length === 0 ? 'Non lo indossa nessun agente: si assegna in Agenti → Aspetto.' : `Lo indossa: ${wornBy.join(', ')}` }}</span>
        </div>
        <div class="flex flex-wrap items-end gap-2.5">
          <div v-for="item in POSES" :key="item.pose" class="flex flex-col items-center gap-1 rounded-[10px] border border-line px-2.5 pt-2 pb-1.5 text-[12.5px] text-muted">
            <PixelAgent :choice="look" :pose="item.pose" :scale="2" :version="sheetVersion" />{{ item.text }}
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :aria-expanded="animationsOpen" @click="animationsOpen = !animationsOpen">{{ animationsOpen ? 'Chiudi le animazioni' : 'Tutte le animazioni' }}</button>
            <a class="btn px-2.5 py-1 text-[13px]" :href="sheetUrl(look, sheetVersion)" :download="`${look.character}.png`">Scarica PNG</a>
          </div>
        </div>
        <SheetPreview v-if="animationsOpen" :src="sheetUrl(look, sheetVersion)" :rows="look.rows" />
      </section>
      <SeriesPersonaCard v-if="chosen !== null" :key="chosen" :character="chosen" :form="form" :save="save" :busy="busy" :error="error" :own-traits="false" />
    </div>
  </div>
</template>
