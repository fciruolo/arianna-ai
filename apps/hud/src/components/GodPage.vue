<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { actOnSubtask, landGod, loadGod, loadGodPlans, syncGodClone } from '../lib/api.ts';
import { afterLanding, cloneText, godBlocker, landBlocker, type GodStatus } from '../lib/god.ts';
import {
  ACTION_TEXT,
  actionsOf,
  badgeOf,
  LAND_TEXT,
  landActionsOf,
  PLAN_LAND_TEXT,
  planLandActionsOf,
  quotaText,
  verdictText,
  waitsText,
  type GodPlan,
  type GodSubtask,
  type LandAction,
  type SubtaskAction,
  type Tone,
} from '../lib/god-work.ts';
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
 * chats, Ferma, Riprendi, Scarta; then «Prova» (the installation restarts on
 * a trial branch with the work), «Approva funzionalità» (into main, with the
 * version, and a restart) and «Non funziona» (back to main, the words to the
 * Coder), on a subtask or a whole plan (D-179). Read again every 10 s, every
 * 2 s while an operation runs; the page reloads when the core comes back.
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
/** An operation of D-179 was started here, on this run of the core: when a new core answers, the page reloads. */
const awaitingRestart = ref<{ boot: string | undefined; since: string } | null>(null);
const coreGone = ref(false);
/** «Non funziona» being written: on a subtask or a plan. */
const rejecting = ref<{ kind: 'subtasks' | 'plans'; id: string; text: string } | null>(null);
const landing = computed(() => status.value?.landing ?? null);
const busyLanding = computed(() => landing.value?.landing !== null && landing.value?.landing !== undefined);

const blocker = computed(() => (status.value === null ? null : godBlocker(status.value)));
/** Why the work in the trial, or any work without one, cannot land now (read again every 10 s), or null: the line above the plans. */
const landBlock = computed(() => landBlocker(landing.value?.installation, true));
/** The same for one work: a subtask, or a plan with some subtask in the trial; another work waits for the trial. */
function blockOf(inTrial: boolean): string | null {
  return landBlocker(landing.value?.installation, inTrial);
}
/** Some plan has a landing button: only then the reason is worth a line. */
const anyLanding = computed(() => plans.value.some((plan) => planLandActionsOf(plan.subtasks).length > 0 || plan.subtasks.some((subtask) => landActionsOf(subtask).length > 0)));

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  info: 'border-info/40 bg-info/10 text-info',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  neutral: 'border-line bg-surface-2 text-muted',
};

const LAND_CLASS: Record<LandAction, string> = {
  trial: 'border border-line hover:border-line-strong',
  approve: 'bg-accent text-accent-ink',
  reject: 'border border-danger/50 text-danger hover:bg-danger/10',
};

let reading = false;
async function refresh(): Promise<void> {
  // One reading at a time: a slow core does not pile them up.
  if (reading) return;
  reading = true;
  try {
    const [loaded, approved] = await Promise.all([loadGod(), loadGodPlans().catch(() => plans.value)]);
    if (awaitingRestart.value !== null) {
      const next = afterLanding(awaitingRestart.value, loaded);
      if (next === 'reload') {
        window.location.reload();
        return;
      }
      if (next === 'done') awaitingRestart.value = null;
    }
    status.value = loaded;
    plans.value = approved;
    loadError.value = null;
    coreGone.value = false;
  } catch (cause) {
    if (awaitingRestart.value !== null) {
      coreGone.value = true;
      return;
    }
    loadError.value = `Non riesco a leggere lo stato di GOD. ${errorText(cause)}`;
  } finally {
    loading.value = false;
    reading = false;
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
};

const LAND_CONFIRM: Record<Exclude<LandAction, 'reject'>, string> = {
  trial:
    'Provare il lavoro? Arianna fa il commit nel clone, lo unisce a main su un ramo di prova con la versione nuova, lancia pnpm check (qualche minuto), ricompila la chat e si riavvia sulla prova (si fermano gli agenti al lavoro e i servizi avviati da Progetti). Main non cambia finché non approvi.',
  approve:
    'Approvare la funzionalità? Il lavoro entra in main con la versione nuova e il tag (senza una prova in corso, prima pnpm check), poi Arianna ricompila la chat e si riavvia. Con il riavvio si fermano un agente al lavoro e i servizi avviati da Progetti.',
};

async function land(kind: 'subtasks' | 'plans', id: string, action: LandAction, text = ''): Promise<void> {
  if (action !== 'reject' && !window.confirm(LAND_CONFIRM[action])) return;
  acting.value = id;
  const since = new Date().toISOString();
  try {
    const view = await landGod(kind, id, action, text);
    if (status.value !== null) status.value = { ...status.value, landing: view };
    actionError.value = null;
    rejecting.value = null;
    awaitingRestart.value = { boot: status.value?.boot, since };
  } catch (cause) {
    actionError.value = `«${LAND_TEXT[action]}» non è partito. ${errorText(cause)}`;
    // The installation may have changed since the last reading: the line above the plans follows now.
    void refresh();
  } finally {
    acting.value = null;
  }
}

function startLand(kind: 'subtasks' | 'plans', id: string, action: LandAction): void {
  if (action === 'reject') rejecting.value = { kind, id, text: '' };
  else void land(kind, id, action);
}

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
let ticks = 0;
onMounted(() => {
  void refresh();
  // Every 2 s while an operation runs or the core restarts, every 10 s otherwise.
  timer = window.setInterval(() => {
    ticks += 1;
    if (busyLanding.value || awaitingRestart.value !== null || ticks % 5 === 0) void refresh();
  }, 2_000);
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
          GOD lavora in cloni del codice di Arianna con soli dati finti: non vede mai il database, la cassaforte né le tue conversazioni. Propone un piano; approvato, ogni sottocompito lavora in un clone suo con il Coder e poi il Reviewer. Poi «Prova» riavvia questa Arianna con il lavoro, e «Approva funzionalità» lo porta in main.
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
          <div v-if="landing !== null && (landing.landing !== null || landing.installation.trial !== null || coreGone)" class="mt-3 rounded-lg border border-info/50 bg-info/10 px-3 py-2 text-sm" role="status">
            <p v-if="coreGone">Arianna si sta riavviando: la pagina si ricarica da sola appena torna.</p>
            <p v-else-if="landing.landing !== null">{{ LAND_TEXT[landing.landing.action] }}: {{ landing.landing.phase }}…</p>
            <p v-else>Arianna è in prova sul ramo <span class="font-mono text-[12px]">{{ landing.installation.trial }}</span>: provala, poi «Approva funzionalità» o «Non funziona» sul lavoro qui sotto.</p>
          </div>
          <p
            v-if="landing !== null && landing.outcome !== null && landing.landing === null && !coreGone"
            class="mt-3 rounded-lg border px-3 py-2 text-sm"
            :class="landing.outcome.ok ? 'border-ok/50 bg-ok/10' : 'border-danger/50 bg-danger/10 text-danger'"
          >
            {{ landing.outcome.text }} <span class="font-mono text-[11px] text-muted">{{ when(landing.outcome.at) }}</span>
          </p>
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

      <p v-if="landBlock !== null && anyLanding && !busyLanding && !coreGone" id="god-land-block" class="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm" role="status">{{ landBlock }}</p>
      <p v-if="actionError !== null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ actionError }}</p>

      <article v-for="plan in plans" :key="plan.id" class="hud-card p-4" :aria-label="`Piano ${plan.title}`">
        <header class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="font-hud text-[15px] font-semibold">{{ plan.title }}</h2>
          <span class="font-mono text-[11px] text-muted">{{ when(plan.createdAt) }}</span>
          <button v-if="plan.conversationId !== null" type="button" class="ml-auto text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline" @click="emit('open', plan.conversationId)">chat con GOD</button>
          <div v-if="planLandActionsOf(plan.subtasks).length > 0" class="flex w-full flex-wrap gap-2">
            <button
              v-for="action in planLandActionsOf(plan.subtasks)"
              :key="action"
              type="button"
              class="rounded-lg px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-50"
              :class="LAND_CLASS[action]"
              :disabled="acting !== null || busyLanding || blockOf(plan.subtasks.some((subtask) => subtask.trial === true)) !== null"
              :title="blockOf(plan.subtasks.some((subtask) => subtask.trial === true)) ?? undefined"
              :aria-describedby="landBlock !== null ? 'god-land-block' : undefined"
              @click="startLand('plans', plan.id, action)"
            >
              {{ PLAN_LAND_TEXT[action] }}
            </button>
          </div>
          <div v-if="rejecting !== null && rejecting.kind === 'plans' && rejecting.id === plan.id" class="w-full">
            <textarea v-model="rejecting.text" rows="3" maxlength="4000" class="field w-full px-2 py-1.5 text-[13px]" placeholder="Cosa non va? Lo leggono i Coder del piano, nel cloud: niente dati personali." />
            <div class="mt-1 flex gap-2">
              <button type="button" class="rounded-lg border border-danger/50 px-2.5 py-1 text-[12.5px] text-danger disabled:opacity-50" :disabled="rejecting.text.trim() === '' || acting !== null || landBlock !== null" :title="landBlock ?? undefined" @click="land('plans', plan.id, 'reject', rejecting.text)">Torna a main e manda</button>
              <button type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px]" @click="rejecting = null">Annulla</button>
            </div>
          </div>
        </header>
        <ol class="flex flex-col gap-3">
          <li v-for="subtask in plan.subtasks" :key="subtask.id" class="rounded-lg border border-line px-3 py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-[11px] text-muted">{{ subtask.position }}</span>
              <span class="min-w-0 flex-1 text-[13.5px] font-medium">{{ subtask.title }}</span>
              <span class="rounded-[5px] border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.06em] uppercase" :class="TONE_CLASS[badgeOf(subtask).tone]">{{ badgeOf(subtask).text }}</span>
            </div>
            <p class="mt-1 font-mono text-[11px] text-muted">
              {{ subtask.branch }} · {{ subtask.path }}<template v-if="waitsText(subtask.blockedBy) !== null"> · {{ waitsText(subtask.blockedBy) }}</template>
            </p>
            <p v-if="subtask.reason !== null" class="mt-1 text-[12.5px]">{{ subtask.reason }}</p>
            <p v-if="verdictText(subtask.review) !== null" class="mt-1 text-[12.5px]" :class="subtask.review === 'ok' ? 'text-ok' : subtask.review === 'changes' ? 'text-warn' : 'text-muted'">{{ verdictText(subtask.review) }}</p>
            <p v-if="subtask.changed.length > 0" class="mt-1 font-mono text-[11px] break-words text-muted">Cambiati: {{ subtask.changed.join(' · ') }}</p>
            <p v-if="subtask.outside.length > 0" class="mt-1 text-[12.5px] text-warn">Fuori dai suoi file: {{ subtask.outside.join(', ') }}</p>
            <p v-if="subtask.sensitive.length > 0" class="mt-1 rounded-lg border border-warn/50 bg-warn/10 px-2 py-1 text-[12.5px]">
              Da guardare prima di provare, eseguono codice sul tuo computer: {{ subtask.sensitive.join(', ') }}
            </p>
            <details v-if="subtask.mergeCommands !== undefined && subtask.merged !== true && subtask.trial !== true" class="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2">
              <summary class="cursor-pointer text-[12.5px] text-muted">Unire a mano, dalla cartella dell’installazione</summary>
              <pre class="mt-1 font-mono text-[11.5px] whitespace-pre-wrap">{{ subtask.mergeCommands.join('\n') }}</pre>
            </details>
            <div v-if="rejecting !== null && rejecting.kind === 'subtasks' && rejecting.id === subtask.id" class="mt-2">
              <textarea v-model="rejecting.text" rows="3" maxlength="4000" class="field w-full px-2 py-1.5 text-[13px]" placeholder="Cosa non va? Lo legge il Coder, nel cloud: niente dati personali." />
              <div class="mt-1 flex gap-2">
                <button type="button" class="rounded-lg border border-danger/50 px-2.5 py-1 text-[12.5px] text-danger disabled:opacity-50" :disabled="rejecting.text.trim() === '' || acting !== null || landBlock !== null" :title="landBlock ?? undefined" @click="land('subtasks', subtask.id, 'reject', rejecting.text)">Torna a main e manda</button>
                <button type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px]" @click="rejecting = null">Annulla</button>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <button v-if="subtask.conversationId !== null" type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong" @click="emit('open', subtask.conversationId)">Chat del Coder</button>
              <button v-if="subtask.reviewConversationId !== null" type="button" class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong" @click="emit('open', subtask.reviewConversationId)">Chat del Reviewer</button>
              <button
                v-for="action in landActionsOf(subtask)"
                :key="`land-${action}`"
                type="button"
                class="rounded-lg px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-50"
                :class="LAND_CLASS[action]"
                :disabled="acting !== null || busyLanding || blockOf(subtask.trial === true) !== null"
                :title="blockOf(subtask.trial === true) ?? undefined"
                :aria-describedby="landBlock !== null ? 'god-land-block' : undefined"
                @click="startLand('subtasks', subtask.id, action)"
              >
                {{ LAND_TEXT[action] }}
              </button>
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
