<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { actOnSubtask, loadGod, loadGodPlans, syncGodClone } from '../lib/api.ts';
import { cloneText, godBlocker, type GodStatus } from '../lib/god.ts';
import { ACTION_TEXT, actionsOf, quotaText, STATE_TEXT, STATE_TONE, verdictText, waitsText, type GodPlan, type GodSubtask, type SubtaskAction, type Tone } from '../lib/god-work.ts';
import { errorText } from '../lib/italian.ts';
import type { CharacterChoice } from '../lib/types.ts';
import Icon from './Icon.vue';
import PixelAgent from './PixelAgent.vue';

/**
 * The page of GOD (D-127): Arianna developed from inside Arianna. The clone
 * GOD reads (repos/arianna/main, never the installation), "Crea/Aggiorna il
 * clone", the conversations with GOD and "Nuova conversazione"; the
 * cruscotto of the plans (G3): each subtask with its state, the files its
 * Coder changed (and the ones outside its own), the Reviewer's verdict, the
 * chats, and Ferma, Riprendi, Scarta, Prepara il ramo; a branch ready shows
 * the commands that merge it, which the user runs. Read again every 10 s.
 */
const props = defineProps<{ character?: CharacterChoice | undefined }>();
const emit = defineEmits<{
  /** A new conversation with GOD on this part of the container. */
  chat: [workspace: string];
  open: [id: string];
}>();

const status = ref<GodStatus | null>(null);
const plans = ref<GodPlan[]>([]);
const loading = ref(true);
const syncing = ref(false);
const acting = ref<string | null>(null);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);

const blocker = computed(() => (status.value === null ? null : godBlocker(status.value)));

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  info: 'border-info/40 bg-info/10 text-info',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  neutral: 'border-line bg-surface-2 text-muted',
};

async function refresh(): Promise<void> {
  try {
    const [loaded, approved] = await Promise.all([loadGod(), loadGodPlans().catch(() => plans.value)]);
    status.value = loaded;
    plans.value = approved;
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere lo stato di GOD. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

async function sync(): Promise<void> {
  syncing.value = true;
  try {
    status.value = await syncGodClone();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Il clone non si è aggiornato. ${errorText(cause)}`;
  } finally {
    syncing.value = false;
  }
}

const CONFIRM: Partial<Record<SubtaskAction, string>> = {
  discard: 'Scartare il sottocompito? Il lavoro si ferma e il suo clone si cancella con il suo ramo: le modifiche non unite in main si perdono.',
  branch: 'Preparare il ramo? Il nucleo fa il commit di ciò che il Coder ha lasciato nel clone, sul ramo del sottocompito.',
};

async function act(subtask: GodSubtask, action: SubtaskAction): Promise<void> {
  const question = CONFIRM[action];
  if (question !== undefined && !window.confirm(question)) return;
  acting.value = subtask.id;
  try {
    await actOnSubtask(subtask.id, action);
    actionError.value = null;
    await refresh();
  } catch (cause) {
    actionError.value = `«${ACTION_TEXT[action]}» non è riuscito. ${errorText(cause)}`;
  } finally {
    acting.value = null;
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

let timer: number | undefined;
onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(), 10_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[960px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <section class="hud-card p-4" aria-labelledby="god-title">
        <div class="flex flex-wrap items-center gap-2">
          <PixelAgent v-if="props.character !== undefined" :choice="props.character" pose="idle" :scale="1" label="GOD" />
          <Icon v-else name="god" :size="16" />
          <h1 id="god-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">GOD</h1>
          <span class="font-mono text-[10.5px] tracking-[0.06em] text-muted">Arianna sviluppata da dentro Arianna</span>
          <button type="button" class="ml-auto rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi" aria-label="Rileggi" @click="refresh">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p class="mt-2 text-[13.5px] text-muted">
          GOD lavora in cloni del codice di Arianna con soli dati finti: non vede mai il database, la cassaforte né le tue conversazioni. Propone un piano; approvato, ogni sottocompito lavora in un clone suo con il Coder e poi il Reviewer. I lavori tornano qui solo come rami git che unisci tu.
        </p>
        <p v-if="loadError !== null" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
        <p v-else-if="loading" class="py-4 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO LO STATO…</p>
        <template v-if="status !== null">
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <Icon name="branch" :size="14" />
            <span class="min-w-0 flex-1 font-mono text-[12px] break-words">{{ cloneText(status.main) }}</span>
            <button
              type="button"
              class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong disabled:opacity-50"
              :disabled="syncing || status.project === 'wrong-path'"
              @click="sync"
            >
              {{ syncing ? 'Aggiorno…' : status.main.exists ? 'Aggiorna il clone' : 'Crea il clone' }}
            </button>
          </div>
          <p v-if="status.quota !== undefined" class="mt-2 font-mono text-[11px] text-muted">{{ quotaText(status.quota) }}</p>
          <p v-if="blocker !== null" class="mt-3 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">{{ blocker }}</p>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50"
              :disabled="blocker !== null"
              @click="emit('chat', status.workspace)"
            >
              <Icon name="new" :size="15" />Nuova conversazione con GOD
            </button>
            <span class="text-xs text-muted">Ogni messaggio va al cloud (Claude o Codex, a scelta nel selettore del modello) con il fascicolo di sviluppo del clone.</span>
          </div>
        </template>
      </section>

      <section v-if="status !== null && status.conversations.length > 0" class="hud-card p-4" aria-labelledby="god-chats">
        <h2 id="god-chats" class="mb-2 font-hud text-[13px] font-semibold tracking-[0.12em] uppercase">Conversazioni con GOD</h2>
        <ul class="flex flex-col">
          <li v-for="conversation in status.conversations" :key="conversation.id">
            <button type="button" class="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" @click="emit('open', conversation.id)">
              <span class="min-w-0 flex-1 truncate text-[13.5px]">{{ conversation.title ?? 'Conversazione senza titolo' }}</span>
              <span class="shrink-0 font-mono text-[11px] text-muted">{{ when(conversation.lastAt) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <p v-if="actionError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ actionError }}</p>

      <article v-for="plan in plans" :key="plan.id" class="hud-card p-4" :aria-label="`Piano ${plan.title}`">
        <header class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="font-hud text-[15px] font-semibold">{{ plan.title }}</h2>
          <span class="font-mono text-[11px] text-muted">{{ when(plan.createdAt) }}</span>
          <button v-if="plan.conversationId !== null" type="button" class="ml-auto text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline" @click="emit('open', plan.conversationId)">chat con GOD</button>
        </header>
        <ol class="flex flex-col gap-3">
          <li v-for="subtask in plan.subtasks" :key="subtask.id" class="rounded-lg border border-line px-3 py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-[11px] text-muted">{{ subtask.position }}</span>
              <span class="min-w-0 flex-1 text-[13.5px] font-medium">{{ subtask.title }}</span>
              <span class="rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.06em] uppercase" :class="TONE_CLASS[STATE_TONE[subtask.state]]">{{ STATE_TEXT[subtask.state] }}</span>
            </div>
            <p class="mt-1 font-mono text-[11px] text-muted">
              {{ subtask.branch }} · {{ subtask.path }}<template v-if="waitsText(subtask.blockedBy) !== null"> · {{ waitsText(subtask.blockedBy) }}</template>
            </p>
            <p v-if="subtask.reason !== null" class="mt-1 text-[12.5px]">{{ subtask.reason }}</p>
            <p v-if="verdictText(subtask.review) !== null" class="mt-1 text-[12.5px]" :class="subtask.review === 'ok' ? 'text-ok' : subtask.review === 'changes' ? 'text-warn' : 'text-muted'">{{ verdictText(subtask.review) }}</p>
            <p v-if="subtask.changed.length > 0" class="mt-1 font-mono text-[11px] break-words text-muted">Cambiati: {{ subtask.changed.join(' · ') }}</p>
            <p v-if="subtask.outside.length > 0" class="mt-1 text-[12.5px] text-warn">Fuori dai suoi file: {{ subtask.outside.join(', ') }}</p>
            <div v-if="subtask.mergeCommands !== undefined" class="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
              <p class="text-[12.5px]">
                {{ subtask.merged === true ? 'Già unito in main.' : 'Per unirlo, nella cartella dell’installazione (l’hook di pre-commit lancia pnpm check):' }}
              </p>
              <pre v-if="subtask.merged !== true" class="mt-1 font-mono text-[11.5px] whitespace-pre-wrap">{{ subtask.mergeCommands.join('\n') }}</pre>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <button v-if="subtask.conversationId !== null" type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong" @click="emit('open', subtask.conversationId)">Chat del Coder</button>
              <button v-if="subtask.reviewConversationId !== null" type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong" @click="emit('open', subtask.reviewConversationId)">Chat del Reviewer</button>
              <button
                v-for="action in actionsOf(subtask)"
                :key="action"
                type="button"
                class="rounded-lg border px-2.5 py-1 text-[12.5px] disabled:opacity-50"
                :class="action === 'discard' ? 'border-danger/50 text-danger hover:bg-danger/10' : 'border-line hover:border-line-strong'"
                :disabled="acting !== null"
                @click="act(subtask, action)"
              >
                {{ acting === subtask.id ? '…' : ACTION_TEXT[action] }}
              </button>
            </div>
          </li>
        </ol>
      </article>
    </div>
  </div>
</template>
