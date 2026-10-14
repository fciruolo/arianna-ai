<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { askDevRewrite, loadDevProgress, sendDevAnswer } from '../lib/api.ts';
import {
  answerStatus,
  barSegments,
  canAskRewrite,
  checkAnswer,
  countStates,
  filterItems,
  filterQuestions,
  groupItems,
  groupQuestions,
  isPicked,
  markAnswered,
  markRewrite,
  pendingBadge,
  pendingCount,
  pendingText,
  percentDone,
  phases,
  pickOption,
  REWRITE_TEXT,
  rewriteStatus,
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
import DevUserNote from './DevUserNote.vue';
import FollowedProjects from './FollowedProjects.vue';
import Icon from './Icon.vue';

/**
 * "Sviluppo di Arianna" (D-102), a section of the settings since D-192: a bar
 * of what is done, in progress and still to do, read by the core from the
 * documents of the repository; the open questions, each with a field to
 * answer as in the chat with Claude; the list, filterable. The answers go to
 * data/dev/RISPOSTE.md and Claude Code applies them at the start of its next
 * session. Title, sentence and width are the settings page's; the news of
 * Open Design moved to «Skill e stili».
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
/** "Riscrivi più chiara" (D-153): the question being sent to Claude to rewrite, and why one failed. */
const rewriting = ref<string | null>(null);
const rewriteErrors = ref<Record<string, string>>({});
/** Rewrites asked whose event did not reach the chain: apart from the answers, so an answer logged later is not marked. */
const rewriteUnlogged = ref<Record<string, boolean>>({});

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
/** The questions that wait for the user (D-120): the dot of the settings follows this page. */
const pending = computed(() => pendingCount(progress.value?.questions ?? []));
const pendingLabel = computed(() => pendingText(pending.value));
const pendingDot = computed(() => pendingBadge(pending.value));

const emit = defineEmits<{ pending: [count: number]; knowledge: [] }>();
watch(pending, (count) => {
  if (progress.value !== null) emit('pending', count);
});

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

/** Asks Claude Code to rewrite the question more clearly (D-153): no model, a fixed entry in the answers file. */
async function askRewrite(question: OpenQuestion): Promise<void> {
  if (rewriting.value !== null) return;
  rewriting.value = question.key;
  const { [question.key]: _cleared, ...others } = rewriteErrors.value;
  rewriteErrors.value = others;
  try {
    const saved = await askDevRewrite(question.key);
    if (progress.value !== null) progress.value = { ...progress.value, questions: markRewrite(progress.value.questions, saved.key, saved.at) };
    if (saved.logged === false) rewriteUnlogged.value = { ...rewriteUnlogged.value, [saved.key]: true };
    void refresh();
  } catch (cause) {
    rewriteErrors.value = { ...rewriteErrors.value, [question.key]: `Non riesco a chiedere la riscrittura. ${errorText(cause)}` };
  } finally {
    rewriting.value = null;
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
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-end gap-2">
      <button type="button" class="btn px-2.5 py-1 text-[13px]" title="Apri i documenti dello sviluppo nella Conoscenza" @click="emit('knowledge')">Leggi i documenti</button>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Aggiorna</button>
    </div>

    <div v-if="loadError !== null" role="alert" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]">
      <span class="min-w-[220px] flex-1">{{ loadError }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-else-if="loading" class="text-[14px] text-muted">Leggo i documenti…</p>

    <!-- The bar -->
    <section v-if="progress !== null" class="rounded-xl border border-line bg-surface-2 p-4" aria-label="A che punto è Arianna">
      <div class="flex items-baseline gap-2">
        <span class="text-[26px] leading-none font-semibold">{{ done }}%</span>
        <span class="text-muted">fatto, su {{ total }} voci</span>
      </div>
      <div
        class="my-2 flex h-3 w-full overflow-hidden rounded-full border border-line bg-surface"
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
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-[13.5px]">
        <li v-for="segment in segments" :key="segment.state" class="flex items-center gap-1.5" :title="STATE_HINT[segment.state]">
          <span class="size-[9px] rounded-full" :class="DOT_CLASS[segment.state]" />
          <span :class="TEXT_CLASS[segment.state]">{{ STATE_TEXT[segment.state] }}</span>
          <span>{{ segment.count }}</span>
        </li>
        <li v-if="progress.dropped > 0" class="text-muted" title="Decisioni sostituite o rifiutate: fuori dalla barra">{{ progress.dropped }} superate</li>
      </ul>
      <p v-if="progress.missing.length > 0" class="mt-2 text-[13px] text-warn">Documenti che non trovo: {{ progress.missing.join(', ') }}.</p>
      <p v-if="skipped !== null" class="mt-1 text-[13px] text-muted">{{ skipped }}</p>
    </section>

    <!-- Open questions -->
    <section v-if="progress !== null" class="flex flex-col gap-3" aria-labelledby="dev-questions">
      <div class="flex flex-wrap items-center gap-2.5">
        <h2 id="dev-questions" class="text-[17px] font-semibold">Domande aperte</h2>
        <span
          v-if="pendingDot !== null"
          class="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[12px] leading-5 font-semibold text-accent-ink"
          :title="pendingLabel ?? undefined"
          :aria-label="pendingLabel ?? undefined"
          role="img"
        >{{ pendingDot }}</span>
        <div class="ml-auto inline-flex overflow-hidden rounded-[9px] border border-line-strong" role="radiogroup" aria-label="Quali domande">
          <button
            v-for="item in QUESTION_FILTERS"
            :key="item.value"
            type="button"
            role="radio"
            :aria-checked="questionFilter === item.value"
            class="px-3 py-1 text-[14px]"
            :class="questionFilter === item.value ? 'bg-surface font-semibold text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:text-ink'"
            @click="questionFilter = item.value"
          >
            {{ item.text }} {{ questionCounts[item.value] }}
          </button>
        </div>
      </div>
      <p v-if="questionGroups.length === 0" class="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[14px] text-muted">
        <b class="font-semibold text-ink">Nessuna domanda qui.</b> Quando Claude Code ha bisogno di una tua decisione, la trovi in questa lista.
      </p>
      <div v-for="group in questionGroups" :key="group.id" class="flex flex-col gap-2.5">
        <h3 v-if="questionGroups.length > 1" class="text-[14px] font-semibold text-muted">{{ group.title }} · {{ group.questions.length }}</h3>
        <article v-for="question in group.questions" :key="question.key" class="question flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3.5">
          <p class="text-[15px] leading-snug font-semibold">{{ question.text }}</p>
          <template v-if="question.explain !== null">
            <p v-if="question.explain.context !== null" class="text-[14px] leading-relaxed"><b class="font-semibold">Cosa si decide:</b> {{ question.explain.context }}</p>
            <div v-if="question.explain.options.length > 0" class="flex flex-col gap-1.5" role="group" :aria-label="`Opzioni per: ${question.text}`">
              <button
                v-for="(option, index) in question.explain.options"
                :key="index"
                type="button"
                class="flex w-full flex-col items-start gap-0.5 rounded-[10px] border bg-surface px-3 py-2 text-left disabled:cursor-default"
                :class="isPicked(drafts[question.key], option.label) ? 'border-accent shadow-[inset_0_0_0_1px_var(--accent)]' : option.recommended ? 'border-ok hover:border-accent' : 'border-line-strong hover:border-muted'"
                :aria-pressed="isPicked(drafts[question.key], option.label)"
                :disabled="!canAnswer(question)"
                :title="canAnswer(question) ? 'Scegli: la risposta si riempie, poi puoi aggiungere qualcosa' : 'Hai già risposto: «Aggiungi qualcosa» per scrivere ancora'"
                @click="choose(question, option.label)"
              >
                <span class="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                  {{ option.label }}
                  <span v-if="option.recommended" class="pill border-ok py-0 text-[12.5px] font-normal text-ok">consigliata</span>
                </span>
                <span v-if="option.effect !== ''" class="text-[13.5px] leading-relaxed text-muted">{{ option.effect }}</span>
              </button>
            </div>
            <p v-if="question.explain.example !== null" class="rounded-lg bg-surface px-3 py-2 text-[13.5px] leading-relaxed"><b class="font-semibold">Esempio:</b> {{ question.explain.example }}</p>
            <details v-if="question.detail !== null" class="text-[13px] text-muted">
              <summary class="cursor-pointer select-none">Nota del documento</summary>
              <p class="mt-1 leading-relaxed">{{ question.detail }}</p>
            </details>
          </template>
          <p v-else-if="question.detail !== null" class="text-[13.5px] leading-relaxed text-muted">{{ question.detail }}</p>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <button
              v-if="canAskRewrite(question)"
              type="button"
              class="inline-flex items-center gap-1 rounded-md text-muted underline decoration-dotted underline-offset-2 hover:text-ink disabled:cursor-default disabled:opacity-60"
              :title="REWRITE_TEXT"
              :aria-label="`${REWRITE_TEXT}: ${question.text}`"
              :disabled="rewriting !== null"
              @click="askRewrite(question)"
            >
              <Icon name="rename" :size="12" />{{ rewriting === question.key ? 'Invio…' : REWRITE_TEXT }}
            </button>
            <span v-if="rewriteStatus(question) !== null" role="status" class="text-info" title="Claude Code la riscriverà nel documento; puoi comunque rispondere">
              {{ rewriteStatus(question) }}<template v-if="rewriteUnlogged[question.key]"> · evento non registrato</template>
            </span>
            <!-- Where the question lives: only under the pointer or with the focus. -->
            <span class="where ml-auto font-mono text-[12px]">{{ question.key }} · docs/{{ question.source }}</span>
          </div>
          <p v-if="rewriteErrors[question.key] !== undefined" role="alert" class="text-[13px] text-danger">{{ rewriteErrors[question.key] }}</p>
          <p v-if="answerStatus(question) !== null" role="status" class="flex flex-wrap items-center gap-2 text-[13.5px]" :class="question.answer?.state === 'new' ? 'text-info' : 'text-ink'">
            <Icon name="saved" :size="13" />{{ answerStatus(question) }}
            <span v-if="unlogged[question.key]" class="text-warn">· salvata, evento non registrato</span>
            <button v-if="!canAnswer(question)" type="button" class="text-muted underline decoration-dotted underline-offset-2 hover:text-ink" @click="reopened = { ...reopened, [question.key]: true }">
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
              class="field block min-h-[56px] w-full resize-y px-3 py-2 text-[14px] leading-relaxed placeholder:text-muted"
              @keydown="onKey($event, question)"
            />
            <div class="flex flex-wrap items-center gap-2">
              <p v-if="sendErrors[question.key] !== undefined" role="alert" class="min-w-0 flex-1 text-[13px] text-danger">{{ sendErrors[question.key] }}</p>
              <span v-else class="min-w-0 flex-1 text-[13px] text-muted">⌘ + Invio per inviare · non scrivere dati personali: la risposta va al cloud</span>
              <button type="submit" class="btn btn-primary px-3 py-1 text-[13.5px]" :disabled="sending !== null || (drafts[question.key] ?? '').trim() === ''">
                <Icon name="send" :size="14" />{{ sending === question.key ? 'Invio…' : 'Invia' }}
              </button>
            </div>
          </form>
        </article>
      </div>
    </section>

    <!-- The projects followed for ideas (D-202) -->
    <FollowedProjects />

    <!-- The list -->
    <section v-if="progress !== null" class="rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="dev-list">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 id="dev-list" class="mr-auto text-[16px] font-semibold">Tutte le voci</h2>
        <input v-model="query" type="search" class="field w-[200px] px-2.5 py-1 text-[14px]" placeholder="Cerca per id o testo" aria-label="Cerca fra le voci" />
        <select v-model="stateFilter" class="field w-auto px-2 py-1 text-[14px]" aria-label="Stato">
          <option value="all">Ogni stato · {{ stateCounts.all }}</option>
          <option v-for="state in STATES" :key="state" :value="state">{{ STATE_TEXT[state] }} · {{ stateCounts[state] }}</option>
        </select>
        <select v-model="kindFilter" class="field w-auto px-2 py-1 text-[14px]" aria-label="Tipo">
          <option v-for="kind in KINDS" :key="kind" :value="kind">{{ kind === 'all' ? 'Ogni tipo' : KIND_TEXT[kind] }}</option>
        </select>
        <select v-model="phaseFilter" class="field w-auto px-2 py-1 text-[14px]" aria-label="Fase">
          <option value="all">Ogni fase</option>
          <option v-for="phase in allPhases" :key="phase" :value="phase">{{ phaseText(phase) }}</option>
          <option value="none">Senza fase</option>
        </select>
      </div>
      <p v-if="shown.length === 0" class="text-[14px] text-muted">Nessuna voce con questi filtri.</p>
      <div v-for="group in groups" :key="group.kind" class="mt-3 first:mt-0">
        <h3 class="mb-1 text-[13.5px] font-semibold text-muted">{{ group.title }} · {{ group.items.length }}</h3>
        <ul class="flex flex-col">
          <li v-for="item in group.items" :key="`${item.kind}:${item.id}`" class="flex items-start gap-3 border-t border-line py-2 first:border-t-0">
            <span class="mt-[7px] size-[8px] shrink-0 rounded-full" :class="DOT_CLASS[item.state]" :title="STATE_TEXT[item.state]" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[14.5px] leading-snug break-words">{{ item.title }}</span>
              <span class="text-[13px] break-words text-muted">
                <span :class="TEXT_CLASS[item.state]">{{ STATE_TEXT[item.state] }}</span> · {{ item.status }}<template v-if="item.phase !== null"> · {{ phaseText(item.phase) }}</template>
              </span>
            </span>
            <span class="shrink-0 font-mono text-[12px] leading-6 text-muted" :title="`docs/${item.source}`">{{ item.id }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- «Su di te, per Claude Code» (D-114): data/dev/UTENTE.md, through the gateway -->
    <DevUserNote />
  </div>
</template>

<style scoped>
/* The key and the file of a question show under the pointer or with the focus; on a touch screen they are always there. */
@media (hover: hover) {
  .question .where {
    opacity: 0;
  }
  .question:hover .where,
  .question:focus-within .where {
    opacity: 1;
  }
}
</style>

