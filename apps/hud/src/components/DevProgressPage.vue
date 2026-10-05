<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { loadDevProgress, sendDevAnswer } from '../lib/api.ts';
import {
  answerStatus,
  barSegments,
  checkAnswer,
  countStates,
  filterItems,
  filterQuestions,
  groupItems,
  groupQuestions,
  isPicked,
  markAnswered,
  percentDone,
  phases,
  pickOption,
  phaseText,
  QUESTION_FILTERS,
  skippedText,
  STATE_HINT,
  STATE_TEXT,
  STATES,
  KIND_TEXT,
  type ItemKind,
  type ItemState,
  type OpenQuestion,
  type Progress,
  type QuestionFilter,
} from '../lib/dev-progress.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * "Sviluppo di Arianna" (D-102): a bar of what is done, in progress and still
 * to do, read by the core from the documents of the repository; the list,
 * filterable; the open questions, each with a field to answer as in the chat
 * with Claude. The answers go to docs/RISPOSTE.md and Claude Code applies
 * them at the start of its next session.
 */
const progress = ref<Progress | null>(null);
const maxAnswer = ref(4000);
const loading = ref(true);
const loadError = ref<string | null>(null);

const stateFilter = ref<ItemState | 'all'>('all');
const phaseFilter = ref('all');
const kindFilter = ref<ItemKind | 'all'>('all');
const query = ref('');
const questionFilter = ref<QuestionFilter>('open');

const drafts = ref<Record<string, string>>({});
const sending = ref<string | null>(null);
const sendErrors = ref<Record<string, string>>({});
/** Answers saved whose event did not reach the chain (`logged: false`). */
const unlogged = ref<Record<string, boolean>>({});
/** Questions already answered whose field the user opened again to add something. */
const reopened = ref<Record<string, boolean>>({});

const segments = computed(() => (progress.value === null ? [] : barSegments(progress.value.counts)));
const done = computed(() => (progress.value === null ? 0 : percentDone(progress.value.counts)));
const total = computed(() => progress.value?.items.length ?? 0);
const allPhases = computed(() => phases(progress.value?.items ?? []));
/** The list before the state filter: the buttons count what each state would show. */
const beforeState = computed(() => filterItems(progress.value?.items ?? [], { state: 'all', phase: phaseFilter.value, kind: kindFilter.value, query: query.value }));
const stateCounts = computed(() => countStates(beforeState.value));
const shown = computed(() => filterItems(beforeState.value, { state: stateFilter.value, phase: 'all', kind: 'all', query: '' }));
const groups = computed(() => groupItems(shown.value));
const questionCounts = computed(() => {
  const questions = progress.value?.questions ?? [];
  return { open: filterQuestions(questions, 'open').length, answered: filterQuestions(questions, 'answered').length, all: questions.length };
});
const questionGroups = computed(() => groupQuestions(filterQuestions(progress.value?.questions ?? [], questionFilter.value)));
const skipped = computed(() => (progress.value === null ? null : skippedText(progress.value.skipped)));

const BAR_CLASS: Record<ItemState, string> = { done: 'bg-ok', doing: 'bg-accent', todo: 'bg-line-strong' };
const DOT_CLASS: Record<ItemState, string> = { done: 'bg-ok', doing: 'bg-accent shadow-[0_0_6px_var(--accent)]', todo: 'bg-line-strong' };
const TEXT_CLASS: Record<ItemState, string> = { done: 'text-ink', doing: 'text-ink', todo: 'text-muted' };
const KINDS: (ItemKind | 'all')[] = ['all', 'decision', 'task', 'epic', 'idea', 'request'];

async function refresh(): Promise<void> {
  try {
    const loaded = await loadDevProgress();
    progress.value = loaded.progress;
    maxAnswer.value = loaded.maxAnswer;
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere i documenti dello sviluppo. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

function canAnswer(question: OpenQuestion): boolean {
  return question.answer === null || reopened.value[question.key] === true;
}

async function send(question: OpenQuestion): Promise<void> {
  if (sending.value !== null) return;
  const checked = checkAnswer(drafts.value[question.key] ?? '', maxAnswer.value);
  if ('error' in checked) {
    sendErrors.value = { ...sendErrors.value, [question.key]: checked.error };
    return;
  }
  sending.value = question.key;
  const { [question.key]: _cleared, ...others } = sendErrors.value;
  sendErrors.value = others;
  try {
    const saved = await sendDevAnswer(question.key, checked.text);
    if (progress.value !== null) progress.value = { ...progress.value, questions: markAnswered(progress.value.questions, saved.key, saved.at) };
    if (!saved.logged) unlogged.value = { ...unlogged.value, [saved.key]: true };
    drafts.value = { ...drafts.value, [question.key]: '' };
    reopened.value = { ...reopened.value, [question.key]: false };
    void refresh();
  } catch (cause) {
    sendErrors.value = { ...sendErrors.value, [question.key]: errorText(cause) };
  } finally {
    sending.value = null;
  }
}

/** A click on an option writes its label in the answer (D-122); the user can still change it or add to it. */
function choose(question: OpenQuestion, label: string): void {
  const labels = question.explain?.options.map((option) => option.label) ?? [];
  drafts.value = { ...drafts.value, [question.key]: pickOption(drafts.value[question.key] ?? '', labels, label) };
}

function onKey(event: KeyboardEvent, question: OpenQuestion): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    void send(question);
  }
}

onMounted(refresh);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[920px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <!-- The bar -->
      <section class="hud-card p-4" aria-labelledby="dev-title">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Icon name="system" :size="16" />
          <h1 id="dev-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">Sviluppo di Arianna</h1>
          <span class="ml-auto font-mono text-[10.5px] tracking-[0.06em] text-muted">dai documenti di docs/ · resta qui</span>
          <button type="button" class="rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi i documenti" aria-label="Rileggi i documenti" @click="refresh">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p v-if="loadError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
        <p v-else-if="loading" class="py-4 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO I DOCUMENTI…</p>
        <template v-else-if="progress !== null">
          <div class="mb-2 flex items-baseline gap-2">
            <span class="font-hud text-[26px] leading-none font-semibold">{{ done }}%</span>
            <span class="text-sm text-muted">fatto, su {{ total }} voci</span>
          </div>
          <div
            class="flex h-3 w-full overflow-hidden rounded-full border border-line bg-surface-2"
            role="img"
            :aria-label="segments.map((segment) => `${STATE_TEXT[segment.state]} ${segment.count}`).join(', ')"
          >
            <div
              v-for="segment in segments"
              :key="segment.state"
              class="h-full transition-[width] duration-500"
              :class="BAR_CLASS[segment.state]"
              :style="{ width: `${segment.percent}%` }"
              :title="`${STATE_TEXT[segment.state]}: ${segment.count}`"
            />
          </div>
          <ul class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
            <li v-for="segment in segments" :key="segment.state" class="flex items-center gap-1.5" :title="STATE_HINT[segment.state]">
              <span class="size-[8px] rounded-full" :class="DOT_CLASS[segment.state]" />
              <span :class="TEXT_CLASS[segment.state]">{{ STATE_TEXT[segment.state] }}</span>
              <span class="text-ink">{{ segment.count }}</span>
            </li>
            <li v-if="progress.dropped > 0" class="text-muted" title="Decisioni sostituite o rifiutate: fuori dalla barra">{{ progress.dropped }} superate</li>
          </ul>
          <p v-if="progress.missing.length > 0" class="mt-2 text-xs text-warn">Documenti che non trovo: {{ progress.missing.join(', ') }}.</p>
          <p v-if="skipped !== null" class="mt-1 text-xs text-muted">{{ skipped }}</p>
        </template>
      </section>

      <!-- Open questions -->
      <section v-if="progress !== null" class="flex flex-col gap-3" aria-labelledby="dev-questions">
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="dev-questions" class="hud-title mx-1">Domande aperte</h2>
          <div class="ml-auto flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label="Quali domande">
            <button
              v-for="item in QUESTION_FILTERS"
              :key="item.value"
              type="button"
              role="radio"
              :aria-checked="questionFilter === item.value"
              class="rounded-md px-2.5 py-1 font-mono text-[11px] tracking-[0.04em]"
              :class="questionFilter === item.value ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'"
              @click="questionFilter = item.value"
            >
              {{ item.text }} <span class="text-muted">{{ questionCounts[item.value] }}</span>
            </button>
          </div>
        </div>
        <p class="mx-1 text-xs text-muted">
          Rispondi come nella chat con Claude: la risposta va in <span class="font-mono">{{ progress.answersFile }}</span> e Claude Code la applica all’inizio della
          sessione successiva. Etichetta L1 dichiarata da te: niente dati personali; la legge Claude Code (cloud), passando dal gateway.
        </p>
        <p v-if="questionGroups.length === 0" class="py-4 text-center text-sm text-muted">Nessuna domanda qui.</p>
        <details v-for="group in questionGroups" :key="group.id" class="hud-card group" open>
          <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 select-none">
            <Icon name="expand" :size="14" class="transition-transform group-open:rotate-180" />
            <span class="min-w-0 flex-1 text-[14px] font-medium">{{ group.title }}</span>
            <span class="font-mono text-[10.5px] text-muted">{{ group.questions.length }}</span>
          </summary>
          <ul class="flex flex-col gap-3 border-t border-line px-4 py-3">
            <li v-for="question in group.questions" :key="question.key" class="flex flex-col gap-1.5">
              <p class="text-[14px] leading-snug font-medium">{{ question.text }}</p>
              <template v-if="question.explain !== null">
                <p v-if="question.explain.context !== null" class="text-[13px] leading-relaxed">
                  <span class="font-mono text-[10.5px] tracking-[0.06em] text-muted uppercase">Cosa si decide · </span>{{ question.explain.context }}
                </p>
                <div v-if="question.explain.options.length > 0" class="flex flex-col gap-1.5" role="group" :aria-label="`Opzioni per: ${question.text}`">
                  <button
                    v-for="(option, index) in question.explain.options"
                    :key="index"
                    type="button"
                    class="flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left disabled:cursor-default"
                    :class="isPicked(drafts[question.key], option.label) ? 'border-accent bg-surface-2' : 'border-line-strong hover:border-muted'"
                    :aria-pressed="isPicked(drafts[question.key], option.label)"
                    :disabled="!canAnswer(question)"
                    :title="canAnswer(question) ? 'Scegli: la risposta si riempie, poi puoi aggiungere qualcosa' : 'Hai già risposto: «Aggiungi qualcosa» per scrivere ancora'"
                    @click="choose(question, option.label)"
                  >
                    <span class="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                      {{ option.label }}
                      <span v-if="option.recommended" class="rounded-full border border-ok px-1.5 font-mono text-[10px] tracking-[0.04em] text-ink">CONSIGLIATA</span>
                    </span>
                    <span v-if="option.effect !== ''" class="text-xs leading-relaxed text-muted">{{ option.effect }}</span>
                  </button>
                </div>
                <p v-if="question.explain.example !== null" class="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed">
                  <span class="font-mono text-[10.5px] tracking-[0.06em] text-muted uppercase">Esempio · </span>{{ question.explain.example }}
                </p>
                <details v-if="question.detail !== null" class="text-xs text-muted">
                  <summary class="cursor-pointer select-none">Nota del documento</summary>
                  <p class="mt-1 leading-relaxed">{{ question.detail }}</p>
                </details>
              </template>
              <p v-else-if="question.detail !== null" class="text-xs leading-relaxed text-muted">{{ question.detail }}</p>
              <p class="font-mono text-[10.5px] text-muted">{{ question.key }} · docs/{{ question.source }}</p>
              <p v-if="answerStatus(question) !== null" role="status" class="flex flex-wrap items-center gap-2 font-mono text-xs" :class="question.answer?.state === 'new' ? 'text-info' : 'text-ink'">
                <Icon name="saved" :size="13" />{{ answerStatus(question) }}
                <span v-if="unlogged[question.key]" class="text-warn">· salvata, evento non registrato</span>
                <button
                  v-if="!canAnswer(question)"
                  type="button"
                  class="text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                  @click="reopened = { ...reopened, [question.key]: true }"
                >
                  Aggiungi qualcosa
                </button>
              </p>
              <form v-if="canAnswer(question)" class="flex flex-col gap-2" @submit.prevent="send(question)">
                <label :for="`answer-${question.key}`" class="sr-only">Risposta a {{ question.text }}</label>
                <textarea
                  :id="`answer-${question.key}`"
                  v-model="drafts[question.key]"
                  rows="2"
                  :maxlength="maxAnswer"
                  :placeholder="question.explain !== null && question.explain.options.length > 0 ? 'Scegli un’opzione sopra o scrivi la tua risposta…' : 'La tua risposta…'"
                  class="block min-h-[56px] w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-muted"
                  @keydown="onKey($event, question)"
                />
                <div class="flex items-center gap-2">
                  <p v-if="sendErrors[question.key] !== undefined" role="alert" class="min-w-0 flex-1 text-xs text-danger">{{ sendErrors[question.key] }}</p>
                  <span v-else class="min-w-0 flex-1 font-mono text-[10.5px] text-muted">⌘/Ctrl+Invio per inviare</span>
                  <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="sending !== null || (drafts[question.key] ?? '').trim() === ''">
                    <Icon name="send" :size="14" />{{ sending === question.key ? 'Invio…' : 'Invia' }}
                  </button>
                </div>
              </form>
            </li>
          </ul>
        </details>
      </section>

      <!-- The list -->
      <section v-if="progress !== null" class="flex flex-col gap-3" aria-labelledby="dev-list">
        <h2 id="dev-list" class="hud-title mx-1">Tutte le voci</h2>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
            <Icon name="search" :size="14" />
            <input v-model="query" type="search" class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" placeholder="Filtra per id o testo" aria-label="Filtra le voci" />
          </label>
          <div class="flex rounded-lg border border-line bg-surface p-0.5" role="radiogroup" aria-label="Stato">
            <button
              v-for="state in ['all', ...STATES] as const"
              :key="state"
              type="button"
              role="radio"
              :aria-checked="stateFilter === state"
              class="rounded-md px-2.5 py-1 font-mono text-[11px] tracking-[0.04em]"
              :class="stateFilter === state ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink'"
              @click="stateFilter = state"
            >
              {{ state === 'all' ? 'Tutte' : STATE_TEXT[state] }} <span class="text-muted">{{ stateCounts[state] }}</span>
            </button>
          </div>
          <select v-model="kindFilter" class="field w-auto py-1 text-sm" aria-label="Tipo">
            <option v-for="kind in KINDS" :key="kind" :value="kind">{{ kind === 'all' ? 'Ogni tipo' : KIND_TEXT[kind] }}</option>
          </select>
          <select v-model="phaseFilter" class="field w-auto py-1 text-sm" aria-label="Fase">
            <option value="all">Ogni fase</option>
            <option v-for="phase in allPhases" :key="phase" :value="phase">{{ phaseText(phase) }}</option>
            <option value="none">Senza fase</option>
          </select>
        </div>
        <p v-if="shown.length === 0" class="py-4 text-center text-sm text-muted">Nessuna voce corrisponde ai filtri.</p>
        <div v-for="group in groups" :key="group.kind">
          <h3 class="mx-1 mb-1.5 font-mono text-[10.5px] tracking-[0.08em] text-muted uppercase">{{ group.title }} · {{ group.items.length }}</h3>
          <ul class="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <li v-for="item in group.items" :key="`${item.kind}:${item.id}`" class="flex items-start gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
              <span class="mt-[7px] size-[7px] shrink-0 rounded-full" :class="DOT_CLASS[item.state]" :title="STATE_TEXT[item.state]" />
              <span class="w-[62px] shrink-0 font-mono text-[11px] leading-6 text-muted">{{ item.id }}</span>
              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[13.5px] leading-snug break-words">{{ item.title }}</span>
                <span class="font-mono text-[10.5px] break-words text-muted">
                  <span :class="TEXT_CLASS[item.state]">{{ STATE_TEXT[item.state] }}</span> · {{ item.status }}<template v-if="item.phase !== null"> · {{ phaseText(item.phase) }}</template> ·
                  docs/{{ item.source }}
                </span>
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>
