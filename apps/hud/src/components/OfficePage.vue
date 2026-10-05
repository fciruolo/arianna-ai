<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import baseMapText from '../office/maps/base.json?raw';
import { listDelegations } from '../lib/api.ts';
import { parseMapText } from '../lib/office/map.ts';
import type { OfficeSignals } from '../lib/office/signals.ts';
import { officeSnapshot, type OfficeAgent, type OfficeSnapshot } from '../lib/office/snapshot.ts';
import { runningWork, talkTarget, type RunningWork, type TalkTarget } from '../lib/office/talk.ts';
import { pendingItems, pendingTotal } from '../lib/pending.ts';
import { loadPending } from '../lib/pending-api.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Approval, CharacterListing, Conversation, ProjectInfo, StatusSnapshot } from '../lib/types.ts';
import OfficeCanvas from './OfficeCanvas.vue';
import PendingDecisions from './PendingDecisions.vue';
import PixelAgent from './PixelAgent.vue';

/**
 * "Ufficio" (D-106, stage 1): the agents in a pixel office, from the same
 * data the chat already reads (status, live signals, pending decisions,
 * approved projects). This page holds the conversations and turns them into
 * "where to talk"; the canvas gets only the photograph. The list "Nell'ufficio"
 * next to it does everything the canvas does: the office never replaces the chat.
 */
const props = defineProps<{
  status: StatusSnapshot | null;
  approvals: Approval[];
  projects: ProjectInfo[];
  conversations: Conversation[];
  characters: CharacterListing | null;
  signals: OfficeSignals;
}>();
const emit = defineEmits<{ open: [conversationId: string]; draft: [mode: 'work' | 'private', project?: string] }>();

const parsed = parseMapText(baseMapText);
const map = parsed.ok ? parsed.map : null;
const mapProblem = parsed.ok ? null : parsed.reason;

// What waits for the user: the same total as the panel's row (D-091), the folder requests counted as the Coder's.
const pendingSignal = computed(() => [props.status, props.approvals]);
const pending = ref({ total: 0, hidden: 0, coder: 0 });
let pendingLatest = 0;
async function readPending(): Promise<void> {
  const request = ++pendingLatest;
  try {
    const data = await loadPending();
    if (request !== pendingLatest) return;
    const coder = data.approvals.filter((approval) => approval.state === 'pending' && approval.kind === 'workspace').length;
    pending.value = { total: pendingTotal(pendingItems(data.approvals, data.tasks, data.titles, data.waiting), data.hidden), hidden: data.hidden, coder };
  } catch {
    // Keeps the last count.
  }
}
watch(pendingSignal, () => void readPending(), { immediate: true });

// Running delegations: who works in which conversation (never their titles).
// The widest page the core gives (it has no filter by status): a running
// delegation behind many finished ones still counts.
const DELEGATIONS_READ = 200;
const work = ref<RunningWork[]>([]);
let workLatest = 0;
async function readWork(): Promise<void> {
  const request = ++workLatest;
  try {
    const rows = await listDelegations(DELEGATIONS_READ);
    if (request !== workLatest) return;
    work.value = runningWork(rows);
  } catch {
    // Keeps the last list: a failed read does not send the Coder to the pause.
  }
}
watch(() => props.status, () => void readWork(), { immediate: true });

// A tick for the freshness of activity lines, the end of a pause and Arianna's wandering (D-124).
const now = ref(Date.now());
let tick: number | undefined;
// With reduced motion Arianna, free, stays at Privata: no jumps every half minute.
const motionQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
const still = ref(motionQuery?.matches ?? false);
function motionChanged(event: MediaQueryListEvent): void {
  still.value = event.matches;
}
onMounted(() => {
  tick = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  motionQuery?.addEventListener('change', motionChanged);
});
onBeforeUnmount(() => {
  window.clearInterval(tick);
  motionQuery?.removeEventListener('change', motionChanged);
});

const snapshot = computed<OfficeSnapshot>(() =>
  officeSnapshot({
    agents: props.status?.agents ?? [
      { id: 'arianna', state: 'idle', run: null },
      { id: 'coder', state: 'idle', run: null },
    ],
    projects: props.projects,
    slots: map?.anchors.islands.length ?? 0,
    activity: props.signals.activity,
    coderConversations: work.value.filter((item) => item.agent === 'coder').map((item) => item.conversationId),
    pending: pending.value,
    quota: props.signals.quota,
    now: now.value,
    still: still.value,
  }),
);

/** Everything behind the archive: the named projects and those only counted. */
const archiveCount = computed(() => snapshot.value.archived.length + snapshot.value.unnamed);

const sheets = computed(() => Object.fromEntries(snapshot.value.agents.map((agent) => [agent.id, props.characters?.agents[agent.id]])));

function placeText(agent: OfficeAgent): string {
  switch (agent.place.kind) {
    case 'private':
      return 'Privata · L2';
    case 'pause':
      return 'Pausa';
    case 'archive':
      return 'Archivio';
    case 'island': {
      const slot = agent.place.slot;
      const island = snapshot.value.islands.find((item) => item.slot === slot);
      return island === undefined ? 'Isola' : `${island.project} · ${island.label}`;
    }
  }
}

function projectOf(agent: OfficeAgent): string | undefined {
  if (agent.place.kind !== 'island') return undefined;
  const slot = agent.place.slot;
  return snapshot.value.islands.find((item) => item.slot === slot)?.project;
}

function targetOf(agentId: string): TalkTarget {
  const agent = snapshot.value.agents.find((item) => item.id === agentId);
  return talkTarget(agentId, work.value, props.conversations, agent === undefined ? undefined : projectOf(agent));
}

function talk(agentId: string): void {
  const target = targetOf(agentId);
  if (target.kind === 'conversation') emit('open', target.id);
  else emit('draft', target.mode, target.project);
}

const office = ref<InstanceType<typeof OfficeCanvas> | null>(null);
function reach(target: string): void {
  office.value?.focus();
  office.value?.goTo(target, false);
}

const showPending = ref(false);
const showArchive = ref(false);
const archiveHeading = ref<HTMLElement | null>(null);
async function openArchive(): Promise<void> {
  showArchive.value = true;
  await nextTick();
  archiveHeading.value?.focus();
}
function leaveCanvas(): void {
  showArchive.value = false;
  document.getElementById('office-roster')?.focus();
}

// Announced to screen readers: an agent that starts waiting for the user.
const announce = ref('');
const waitingAgents = computed(() => snapshot.value.agents.filter((agent) => agent.pose === 'waiting'));
watch(
  waitingAgents,
  (waiting, before) => {
    const was = new Set((before ?? []).map((agent) => agent.id));
    for (const agent of waiting) if (!was.has(agent.id)) announce.value = `${agent.name} aspetta una tua decisione: vai alla scrivania Decisioni.`;
  },
);

const DOT: Record<Pose, string> = { idle: 'bg-muted', thinking: 'bg-info', working: 'bg-accent', reading: 'bg-ok', waiting: 'bg-warn', paused: 'bg-muted' };
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto grid max-w-[1500px] grid-cols-1 gap-5 px-4 pt-5 pb-10 md:px-6 2xl:grid-cols-[minmax(0,1fr)_300px]">
      <section class="min-w-0" aria-labelledby="office-title">
        <h1 id="office-title" class="sr-only">Ufficio</h1>
        <p v-if="map === null" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
          La mappa dell'ufficio non è valida: {{ mapProblem }}.
        </p>
        <OfficeCanvas
          v-else
          ref="office"
          :map="map"
          :snapshot="snapshot"
          :sheets="sheets"
          @talk="talk"
          @decisions="showPending = true"
          @archive="void openArchive()"
          @escape="leaveCanvas"
        />
        <p id="office-help" class="mt-3 text-[12.5px] leading-relaxed text-muted">
          Clicca nell'ufficio o raggiungilo con <kbd class="kbd">Tab</kbd>, poi <kbd class="kbd">←</kbd><kbd class="kbd">↑</kbd><kbd class="kbd">→</kbd><kbd class="kbd">↓</kbd>
          o <kbd class="kbd">W</kbd><kbd class="kbd">A</kbd><kbd class="kbd">S</kbd><kbd class="kbd">D</kbd> per camminare, oppure clicca un punto del pavimento o un
          agente. Vicino a un agente <kbd class="kbd">E</kbd> o <kbd class="kbd">Invio</kbd> apre nella chat la sua conversazione, o una nuova; alla scrivania «Decisioni» apre le
          decisioni in attesa. <kbd class="kbd">Esc</kbd> esce dall'ufficio. L'ufficio mostra solo stati, etichette e nomi dei progetti, mai il testo delle conversazioni.
        </p>
      </section>

      <aside class="flex flex-col gap-4" aria-label="Nell'ufficio">
        <section class="hud-card p-3.5" aria-labelledby="office-roster">
          <h2 id="office-roster" tabindex="-1" class="hud-title mb-2.5 outline-none">Nell'ufficio</h2>
          <ul class="flex flex-col gap-3">
            <li v-for="agent in snapshot.agents" :key="agent.id" class="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3">
              <PixelAgent :choice="characters?.agents[agent.id]" :pose="agent.pose" :scale="2" />
              <div class="min-w-0">
                <b class="block font-semibold">{{ agent.name }}</b>
                <div class="text-xs text-muted">
                  <span class="mr-1 inline-block size-[7px] rounded-full" :class="DOT[agent.pose]" aria-hidden="true" />{{ POSE_TEXT[agent.pose] }} · {{ placeText(agent) }}<template v-if="agent.locality !== null"> · {{ agent.locality === 'local' ? 'in locale' : 'nel cloud' }}</template>
                </div>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="map === null" @click="reach(agent.id)">Raggiungi</button>
                  <button type="button" class="btn px-2.5 py-1 text-xs" @click="talk(agent.id)">Parla subito</button>
                </div>
              </div>
            </li>
          </ul>
        </section>

        <section class="hud-card p-3.5" :class="{ warn: snapshot.decisions.total > 0 }" aria-labelledby="office-decisions">
          <h2 id="office-decisions" class="hud-title mb-2">Decisioni in attesa</h2>
          <p v-if="snapshot.decisions.total === 0" class="text-xs text-muted">Nessuna. Quando c'è, sulla scrivania «Decisioni» compare un «!».</p>
          <template v-else>
            <p class="text-xs">
              <b class="font-mono text-warn">{{ snapshot.decisions.total }}</b> in attesa<template v-if="snapshot.decisions.hidden > 0">, {{ snapshot.decisions.hidden }} sopra L2 solo contate</template>.
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="map === null" @click="reach('decisions')">Vai alla scrivania</button>
              <button type="button" class="btn px-2.5 py-1 text-xs" aria-haspopup="dialog" @click="showPending = true">Apri subito</button>
            </div>
          </template>
        </section>

        <section v-if="archiveCount > 0 || showArchive" class="hud-card p-3.5" aria-labelledby="office-archive">
          <h2 id="office-archive" ref="archiveHeading" tabindex="-1" class="hud-title mb-2 outline-none">Archivio</h2>
          <p v-if="archiveCount === 0" class="text-xs text-muted">Tutti i progetti approvati hanno un'isola.</p>
          <ul v-if="snapshot.archived.length > 0" class="flex flex-col gap-1.5 text-xs">
            <li v-for="(name, index) in snapshot.archived" :key="`${name}-${String(index)}`" class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono">{{ name }}</span>
              <button type="button" class="btn px-2 py-0.5 text-[11px]" @click="emit('draft', 'work', name)">Nuova conversazione</button>
            </li>
          </ul>
          <p v-if="snapshot.unnamed > 0" class="mt-1.5 text-xs text-muted">
            {{ snapshot.unnamed === 1 ? 'Un altro progetto' : `Altri ${String(snapshot.unnamed)} progetti` }} con un nome che l'ufficio non mostra.
          </p>
        </section>
      </aside>
    </div>
    <div class="sr-only" aria-live="polite">{{ announce }}</div>

    <Teleport to="body">
      <PendingDecisions
        v-if="showPending"
        :signal="pendingSignal"
        @close="showPending = false; office?.focus()"
        @open="(id) => emit('open', id)"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.kbd {
  font: 600 11px ui-monospace, Menlo, monospace;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 4px;
  color: var(--ink);
}
</style>
