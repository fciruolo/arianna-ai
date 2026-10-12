<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { generateStyleExamples, loadDesignStyle, loadSkill, loadStyleExamples, readStyleExample, skillTranslations } from '../lib/api.ts';
import type { StyleSummary } from '../lib/design-catalog.ts';
import type { SkillSummary } from '../lib/skills-catalog.ts';
import { exampleState, STUDIO_SKILLS_MAX, studioErrorText, type ExamplesStatus, type StudioDesign, type StyleSample, type TranslationsStatus } from '../lib/studio.ts';
import Icon from './Icon.vue';
import StudioFrame from './StudioFrame.vue';
import StyleMiniPage from './StyleMiniPage.vue';

/**
 * The window of style and skills of the Studio (I-20, D-185): every style
 * as the same small page in its own colors, fonts and corners, with its
 * category and description and «Leggi tutto» for the whole DESIGN.md; the
 * skills with what they do. The choice applies when the user confirms.
 */
const props = defineProps<{ styles: StyleSummary[]; skills: SkillSummary[]; samples: Record<string, StyleSample>; design: StudioDesign }>();
const emit = defineEmits<{ apply: [design: StudioDesign]; close: [] }>();

const tab = ref<'styles' | 'skills'>('styles');
const query = ref('');
const style = ref<string | null>(props.design.style);
const chosenSkills = ref<string[]>([...props.design.skills]);
const dialog = ref<HTMLElement | null>(null);

const needle = computed(() => query.value.trim().toLowerCase());
const shownStyles = computed(() =>
  props.styles.filter((entry) => needle.value === '' || `${entry.name} ${entry.category ?? ''} ${entry.description}`.toLowerCase().includes(needle.value)),
);
const shownSkills = computed(() => props.skills.filter((entry) => needle.value === '' || `${entry.name} ${entry.source} ${entry.description}`.toLowerCase().includes(needle.value)));
const styleName = computed(() => (style.value === null ? 'Nessuno' : (props.styles.find((entry) => entry.slug === style.value)?.name ?? style.value)));

function toggleSkill(id: string): void {
  if (chosenSkills.value.includes(id)) chosenSkills.value = chosenSkills.value.filter((skill) => skill !== id);
  else if (chosenSkills.value.length < STUDIO_SKILLS_MAX) chosenSkills.value = [...chosenSkills.value, id];
}

// «Leggi tutto»: the whole text over the list, one at a time.
const reading = ref<{ title: string; text: string | null; problem: string | null } | null>(null);
let readToken = 0;
async function readAll(kind: 'style' | 'skill', id: string, title: string): Promise<void> {
  const token = ++readToken;
  reading.value = { title, text: null, problem: null };
  try {
    const text = kind === 'style' ? (await loadDesignStyle(id)).text : (await loadSkill(id)).text;
    if (token === readToken) reading.value = { title, text, problem: null };
  } catch (cause) {
    if (token === readToken) reading.value = { title, text: null, problem: studioErrorText(cause) };
  }
}

// Examples written by Sonnet (D-185): on request, one style or all the missing ones; read again while some are on their way.
const examples = ref<ExamplesStatus | null>(null);
const examplesProblem = ref<string | null>(null);
const missingExamples = computed(() => props.styles.filter((entry) => examples.value?.examples[entry.slug]?.current !== true).length);
const examplesBusy = computed(() => examples.value !== null && (examples.value.running !== null || examples.value.queue.length > 0));
async function generate(slug?: string): Promise<void> {
  examplesProblem.value = null;
  try {
    examples.value = await generateStyleExamples(slug);
  } catch (cause) {
    examplesProblem.value = studioErrorText(cause);
  }
}

// The Italian descriptions (D-185): the missing ones are asked when the window opens; the English one meanwhile.
const translations = ref<TranslationsStatus | null>(null);
const skillText = (entry: SkillSummary): string => translations.value?.translations[entry.id] ?? entry.description;

let poll: number | undefined;
async function refresh(): Promise<void> {
  const [found, words] = await Promise.allSettled([loadStyleExamples(), skillTranslations()]);
  if (found.status === 'fulfilled') examples.value = found.value;
  if (words.status === 'fulfilled') translations.value = words.value;
}

// «Vedi esempio»: the landing or the presentation in an isolated frame, over the list.
const preview = ref<{ slug: string; name: string; kind: 'landing' | 'deck'; text: string | null; problem: string | null } | null>(null);
let previewToken = 0;
async function showExample(slug: string, name: string, kind: 'landing' | 'deck'): Promise<void> {
  const token = ++previewToken;
  preview.value = { slug, name, kind, text: null, problem: null };
  try {
    const text = await readStyleExample(slug, kind);
    if (token === previewToken) preview.value = { slug, name, kind, text, problem: null };
  } catch (cause) {
    if (token === previewToken) preview.value = { slug, name, kind, text: null, problem: studioErrorText(cause) };
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (preview.value !== null) preview.value = null;
  else if (reading.value !== null) reading.value = null;
  else emit('close');
}
onMounted(async () => {
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
  poll = window.setInterval(() => {
    if (examplesBusy.value || translations.value?.running === true) void refresh();
  }, 4000);
  try {
    translations.value = await skillTranslations(true);
  } catch {
    // Without Claude the descriptions stay in English.
  }
  await refresh();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.clearInterval(poll);
});
</script>

<template>
  <div class="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" @click.self="emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="design-title"
      tabindex="-1"
      class="hud-card flex h-[min(860px,92vh)] w-full max-w-[1040px] flex-col bg-surface outline-none"
    >
      <header class="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-[15px] py-2.5">
        <h2 id="design-title" class="font-medium">Stile e skill per il Designer</h2>
        <nav class="flex gap-1" role="tablist" aria-label="Cosa scegli">
          <button type="button" role="tab" class="rounded-md px-2.5 py-1 text-[13px]" :class="tab === 'styles' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-selected="tab === 'styles'" @click="tab = 'styles'">
            Stili <span class="text-muted">{{ styles.length }}</span>
          </button>
          <button type="button" role="tab" class="rounded-md px-2.5 py-1 text-[13px]" :class="tab === 'skills' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-selected="tab === 'skills'" @click="tab = 'skills'">
            Skill <span class="text-muted">{{ chosenSkills.length }}/{{ STUDIO_SKILLS_MAX }}</span>
          </button>
        </nav>
        <label class="ml-auto flex h-8 w-[240px] max-w-full items-center gap-2 rounded-md border border-line px-2 text-muted">
          <Icon name="search" :size="14" />
          <input v-model="query" type="search" :placeholder="tab === 'styles' ? 'Cerca uno stile' : 'Cerca una skill'" aria-label="Cerca" class="w-full bg-transparent text-[13px] text-ink" />
        </label>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-[15px]">
        <template v-if="tab === 'styles'">
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <p class="min-w-0 flex-1">
              Ogni stile ha una pagina di prova coi suoi colori e caratteri; con «Genera esempio» Claude Sonnet scrive per quello stile una landing e una presentazione vere, che restano salvate e non si rifanno finché lo stile non cambia.
            </p>
            <button
              v-if="missingExamples > 0"
              type="button"
              class="btn shrink-0 px-2.5 py-1 text-xs"
              :disabled="examplesBusy"
              title="Claude Sonnet scrive gli esempi mancanti uno dopo l'altro, in background; consuma quota di Claude"
              @click="generate()"
            >Genera i mancanti ({{ missingExamples }})</button>
          </div>
          <p v-if="examples?.running" class="mb-2 text-xs text-muted" role="status">
            Sonnet scrive l'esempio di {{ styles.find((entry) => entry.slug === examples?.running)?.name ?? examples.running }}<template v-if="examples.queue.length > 0">, poi altri {{ examples.queue.length }}</template>…
          </p>
          <p v-if="examples?.stopped" class="mb-2 text-xs text-warn" role="alert">Esempi fermati: {{ examples.stopped }}</p>
          <p v-if="examplesProblem !== null" class="mb-2 text-xs text-danger" role="alert">{{ examplesProblem }}</p>
          <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            <button
              type="button"
              class="flex flex-col gap-2 rounded-lg border p-2.5 text-left"
              :class="style === null ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'"
              :aria-pressed="style === null"
              @click="style = null"
            >
              <span class="grid h-[118px] place-items-center rounded-md border border-dashed border-line text-xs text-muted">Il Designer sceglie da sé</span>
              <span class="text-[13px] font-medium">Nessuno stile</span>
            </button>
            <div
              v-for="entry in shownStyles"
              :key="entry.slug"
              class="flex flex-col gap-1.5 rounded-lg border p-2.5"
              :class="style === entry.slug ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'"
            >
              <button
                type="button"
                class="flex flex-col gap-1.5 text-left"
                :aria-pressed="style === entry.slug"
                :title="style === entry.slug ? 'Scelto: un altro clic lo toglie' : undefined"
                @click="style = style === entry.slug ? null : entry.slug"
              >
                <StyleMiniPage v-if="samples[entry.slug]" :sample="samples[entry.slug]!" />
                <span v-else class="grid h-[118px] place-items-center rounded-md border border-dashed border-line text-xs text-muted">Nessun campione</span>
                <span class="flex items-baseline gap-1.5">
                  <span class="min-w-0 truncate text-[13px] font-medium">{{ entry.name }}</span>
                  <span v-if="entry.category" class="truncate text-[11px] text-muted">{{ entry.category }}</span>
                </span>
                <span class="line-clamp-2 text-[11.5px] leading-snug text-muted">{{ entry.description }}</span>
              </button>
              <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                <template v-if="exampleState(examples, entry.slug) === 'ready' || exampleState(examples, entry.slug) === 'old'">
                  <button type="button" class="text-ink underline hover:text-accent" @click="showExample(entry.slug, entry.name, 'landing')">Vedi esempio</button>
                </template>
                <span v-if="exampleState(examples, entry.slug) === 'running'" class="text-muted">Genero…</span>
                <span v-else-if="exampleState(examples, entry.slug) === 'queued'" class="text-muted">In coda</span>
                <button
                  v-else-if="exampleState(examples, entry.slug) !== 'ready'"
                  type="button"
                  class="text-muted underline hover:text-ink"
                  :title="exampleState(examples, entry.slug) === 'old' ? 'Lo stile è cambiato: Sonnet riscrive l\'esempio' : 'Claude Sonnet scrive una landing e una presentazione in questo stile'"
                  @click="generate(entry.slug)"
                >{{ exampleState(examples, entry.slug) === 'old' ? 'Rigenera' : 'Genera esempio' }}</button>
                <button type="button" class="text-muted underline hover:text-ink" @click="readAll('style', entry.slug, entry.name)">Leggi tutto</button>
              </span>
              <span v-if="examples?.failed[entry.slug]" class="text-[11px] text-warn">{{ examples.failed[entry.slug] }}</span>
            </div>
          </div>
          <p v-if="shownStyles.length === 0" class="mt-3 text-sm text-muted">Nessuno stile corrisponde alla ricerca.</p>
        </template>

        <template v-else>
          <p class="mb-3 text-xs text-muted">
            Una skill è un insieme di istruzioni su un tipo di lavoro (per esempio come impaginare una presentazione) che il Designer legge prima di cominciare. Al più {{ STUDIO_SKILLS_MAX }}.
            <template v-if="translations?.running"> Traduco le descrizioni in italiano ({{ translations.missing }} da fare): intanto alcune sono in inglese.</template>
            <template v-else-if="translations?.stopped"> Traduzione ferma: {{ translations.stopped }}.</template>
          </p>
          <ul class="flex flex-col gap-1.5">
            <li v-for="entry in shownSkills" :key="entry.id" class="flex items-start gap-2.5 rounded-lg border px-3 py-2" :class="chosenSkills.includes(entry.id) ? 'border-accent bg-accent/10' : 'border-line'">
              <input
                :id="`skill-${entry.id}`"
                type="checkbox"
                class="mt-1 accent-[var(--accent)]"
                :checked="chosenSkills.includes(entry.id)"
                :disabled="!chosenSkills.includes(entry.id) && chosenSkills.length >= STUDIO_SKILLS_MAX"
                @change="toggleSkill(entry.id)"
              />
              <label :for="`skill-${entry.id}`" class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex items-baseline gap-1.5"><span class="text-[13px] font-medium">{{ entry.name }}</span><span class="truncate text-[11px] text-muted">{{ entry.source }}</span></span>
                <span class="text-[12px] leading-snug text-muted">{{ skillText(entry) || 'Senza descrizione.' }}</span>
              </label>
              <button type="button" class="shrink-0 text-[11.5px] text-muted underline hover:text-ink" @click="readAll('skill', entry.id, entry.name)">Leggi tutto</button>
            </li>
          </ul>
          <p v-if="skills.length === 0" class="text-sm text-muted">Nessuna skill nel catalogo: si aggiungono in Impostazioni → Agenti.</p>
          <p v-else-if="shownSkills.length === 0" class="text-sm text-muted">Nessuna skill corrisponde alla ricerca.</p>
        </template>

        <!-- «Vedi esempio»: the landing or the presentation written by Sonnet, in an isolated frame (no network, no access to the chat). -->
        <div v-if="preview !== null" class="absolute inset-0 z-10 flex flex-col bg-surface">
          <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-[15px] py-2">
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="preview = null"><Icon name="restore" :size="13" />Torna</button>
            <span class="truncate text-[13px] font-medium">{{ preview.name }}</span>
            <span class="ml-auto flex gap-1" role="group" aria-label="Esempio">
              <button type="button" class="rounded-md px-2.5 py-1 text-xs" :class="preview.kind === 'landing' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="preview.kind === 'landing'" @click="showExample(preview.slug, preview.name, 'landing')">Landing</button>
              <button type="button" class="rounded-md px-2.5 py-1 text-xs" :class="preview.kind === 'deck' ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'" :aria-pressed="preview.kind === 'deck'" @click="showExample(preview.slug, preview.name, 'deck')">Presentazione</button>
            </span>
          </div>
          <p v-if="preview.problem !== null" class="p-[15px] text-sm text-danger" role="alert">{{ preview.problem }}</p>
          <p v-else-if="preview.text === null" class="p-[15px] text-sm text-muted">Leggo…</p>
          <div v-else class="min-h-0 flex-1 p-2">
            <StudioFrame :key="`${preview.slug}-${preview.kind}`" class="h-full" :source="preview.text" :title="`Esempio ${preview.name}`" />
          </div>
        </div>

        <!-- «Leggi tutto»: over the list, Esc or «Torna» goes back. -->
        <div v-if="reading !== null" class="absolute inset-0 flex flex-col bg-surface">
          <div class="flex shrink-0 items-center gap-2 border-b border-line px-[15px] py-2">
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="reading = null"><Icon name="restore" :size="13" />Torna</button>
            <span class="truncate text-[13px] font-medium">{{ reading.title }}</span>
          </div>
          <p v-if="reading.problem !== null" class="p-[15px] text-sm text-danger" role="alert">{{ reading.problem }}</p>
          <p v-else-if="reading.text === null" class="p-[15px] text-sm text-muted">Leggo…</p>
          <pre v-else class="min-h-0 flex-1 overflow-auto p-[15px] font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{{ reading.text }}</pre>
        </div>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-[15px] py-2.5">
        <span class="min-w-0 flex-1 truncate text-xs text-muted">Stile: <b class="text-ink">{{ styleName }}</b> · {{ chosenSkills.length === 0 ? 'nessuna skill' : `${String(chosenSkills.length)} skill` }}</span>
        <button type="button" class="rounded-md px-3 py-1 text-[13px] text-muted hover:text-ink" @click="emit('close')">Annulla</button>
        <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" @click="emit('apply', { style, skills: chosenSkills })">Usa questa scelta</button>
      </footer>
    </section>
  </div>
</template>
