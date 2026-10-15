<script setup lang="ts">
/**
 * The card of a person of the series (D-223), in Impostazioni → Agenti →
 * Aspetto, then in Personaggi (D-224): who it is and how it speaks, its scene
 * (private chats only), its lines (`SeriesLinesPanel`) and the exact block the
 * model reads. The user may rewrite the
 * texts: they become theirs (Interno), saved in `[series.<id>]` with their own
 * Salva; «Ripristina» goes back to the repository's text.
 */
import { computed, onMounted, ref, watch } from 'vue';

import { loadSeriesPersonas, type SeriesPersonaView } from '../lib/api.ts';
import { errorText } from '../lib/italian.ts';
import { nameForms, SERIES_LIMITS, seriesForm, seriesProblem, seriesRewrite, withRewrite, type SeriesForm } from '../lib/series-persona.ts';
import type { SeriesValues } from '../lib/settings.ts';
import SeriesLinesPanel from './SeriesLinesPanel.vue';

const props = defineProps<{
  /** The id of the character in the pack serie: jd, cox… */
  character: string;
  /** The settings form: its `series` is what the card changes. */
  form: { series: Record<string, SeriesValues> };
  save: () => Promise<boolean>;
  busy: boolean;
  error?: string | undefined;
  /** The user wrote a personality for this agent: it wins over the character's (D-214). */
  ownTraits: boolean;
}>();

const people = ref<SeriesPersonaView[] | null>(null);
const loadError = ref<string | null>(null);
const person = computed(() => people.value?.find((item) => item.id === props.character));
const draft = ref<SeriesForm | null>(null);
const mode = ref<'private' | 'work'>('private');
const saved = ref(false);

async function refresh(): Promise<void> {
  try {
    people.value = await loadSeriesPersonas();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere i personaggi. ${errorText(cause)}`;
  }
}

function fill(): void {
  const found = person.value;
  draft.value = found === undefined ? null : seriesForm(found.repository, props.form.series[found.id] ?? null);
}

onMounted(async () => {
  await refresh();
  fill();
});
watch(() => props.character, fill);

const rewrite = computed(() => (draft.value === null || person.value === undefined ? {} : seriesRewrite(draft.value, person.value.repository)));
/** The names of the other people of the series: only the scene may hold them (D-223). */
const others = computed(() => {
  const mine = new Set(person.value === undefined ? [] : nameForms(person.value.name));
  return (people.value ?? []).filter((item) => item.id !== props.character).flatMap((item) => nameForms(item.name)).filter((name) => !mine.has(name));
});
const problem = computed(() => (draft.value === null ? null : seriesProblem(draft.value, others.value)));
/** What is saved now for this character, compared as sent. */
const savedRewrite = computed(() => JSON.stringify(person.value?.own ?? {}));
const dirty = computed(() => JSON.stringify(rewrite.value) !== savedRewrite.value);
const own = computed(() => person.value?.own !== null && person.value?.own !== undefined);

async function store(next: SeriesValues): Promise<void> {
  if (person.value === undefined) return;
  saved.value = false;
  const before = props.form.series;
  props.form.series = withRewrite(before, person.value.id, next);
  if (await props.save()) {
    await refresh();
    fill();
    saved.value = true;
  } else {
    // Not saved: the settings keep what was read, the card keeps the edits.
    props.form.series = before;
  }
}

const count = (text: string): number => Array.from(text.replace(/\s+/g, ' ').trim()).length;
</script>

<template>
  <section class="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-3.5" :aria-label="`Personalità di ${person?.name ?? 'personaggio'}`">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="mr-auto text-[14px] font-medium">Personalità di {{ person?.name ?? '…' }}</h3>
      <span class="pill" :class="own ? 'border-warn/50 text-warn' : 'border-line-strong text-muted'">{{ own ? 'Riscritta da te · Interno' : 'Testo originale' }}</span>
    </div>
    <p v-if="loadError" role="alert" class="text-[13px] text-danger">{{ loadError }}</p>
    <p v-if="person?.refused" role="alert" class="text-[12.5px] text-warn">
      Il tuo testo salvato contiene qualcosa che sembra un dato personale o un valore del vault: il modello riceve quello originale. Correggilo e salva di nuovo, oppure ripristina.
    </p>
    <p v-if="ownTraits" class="text-[12.5px] text-warn">Per questo agente hai scritto una Personalità tua (tab Personalità): vince su quella del personaggio, che qui resta solo per gli altri agenti che lo indossano.</p>

    <template v-if="draft !== null && person !== undefined">
      <label class="flex flex-col gap-1 text-[13px]">
        <span class="flex items-baseline gap-2 font-medium">Chi è e come parla <span class="ml-auto text-[12px] font-normal text-muted tabular-nums">{{ count(draft.traits) }}/{{ SERIES_LIMITS.traits }}</span></span>
        <textarea v-model="draft.traits" rows="3" class="field block w-full resize-y px-3 py-2 text-[13.5px] leading-relaxed" />
        <span class="text-[12px] text-muted">Va in ogni chat, anche di lavoro e quindi anche a Claude e Codex: niente dati personali, e niente nomi di altri personaggi.</span>
      </label>
      <label class="flex flex-col gap-1 text-[13px]">
        <span class="flex items-baseline gap-2 font-medium">La scena <span class="ml-auto text-[12px] font-normal text-muted tabular-nums">{{ count(draft.scene) }}/{{ SERIES_LIMITS.scene }}</span></span>
        <textarea v-model="draft.scene" rows="4" class="field block w-full resize-y px-3 py-2 text-[13.5px] leading-relaxed" />
        <span class="text-[12px] text-muted">Solo nelle chat private, che restano sul Mac: luoghi, gli altri personaggi, i tic in scena (didascalie fra parentesi quadre, voce narrante…).</span>
      </label>

      <div class="flex flex-wrap items-center gap-2">
        <p v-if="problem !== null" role="alert" class="min-w-0 flex-1 text-[13px] text-warn">{{ problem }}</p>
        <p v-else-if="error" role="alert" class="min-w-0 flex-1 text-[13px] text-danger">{{ error }}</p>
        <p v-else-if="saved && !dirty" role="status" class="min-w-0 flex-1 text-[13px] text-ok">Salvato: vale dal prossimo messaggio.</p>
        <span v-else class="min-w-0 flex-1" />
        <button v-if="own" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy" @click="store({})">Ripristina il testo originale</button>
        <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="busy || !dirty" @click="fill">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="busy || !dirty || problem !== null" @click="store(rewrite)">{{ busy ? 'Salvo…' : 'Salva' }}</button>
      </div>

      <SeriesLinesPanel :character="person.id" :name="person.name" :own-quotes="person.own?.quotes !== undefined" :fallback="person.own?.quotes ?? person.repository.quotes" />

      <details class="text-[13px]">
        <summary class="cursor-pointer select-none text-muted">Cosa riceve il modello</summary>
        <div class="mt-2 flex flex-col gap-2">
          <div class="inline-flex w-fit overflow-hidden rounded-[9px] border border-line-strong" role="group" aria-label="Quale chat">
            <button type="button" class="px-3 py-1 text-[13px]" :class="mode === 'private' ? 'bg-surface-2 font-semibold text-ink' : 'text-muted hover:text-ink'" :aria-pressed="mode === 'private'" @click="mode = 'private'">Chat privata</button>
            <button type="button" class="px-3 py-1 text-[13px]" :class="mode === 'work' ? 'bg-surface-2 font-semibold text-ink' : 'text-muted hover:text-ink'" :aria-pressed="mode === 'work'" @click="mode = 'work'">Chat di lavoro</button>
          </div>
          <pre class="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{{ person.blocks[mode] }}</pre>
          <p class="text-[12px] text-muted">Il testo salvato, in inglese per le regole e in italiano per il personaggio. Nella chat privata entra anche la scena; in quella di lavoro no, perché può finire a Claude.</p>
        </div>
      </details>
    </template>
  </section>
</template>
