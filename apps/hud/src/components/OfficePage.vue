<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import baseMapText from '../office/maps/base.json?raw';
import corsiaMapText from '../office/maps/corsia.json?raw';
import ufficioMapText from '../office/maps/ufficio.json?raw';
import springfieldMapText from '../office/maps/springfield.json?raw';
import quahogMapText from '../office/maps/quahog.json?raw';
import langleyMapText from '../office/maps/langley.json?raw';
import foxRiverMapText from '../office/maps/fox-river.json?raw';
import planetExpressMapText from '../office/maps/planet-express.json?raw';
import pasadenaMapText from '../office/maps/pasadena.json?raw';
import { listDelegations } from '../lib/api.ts';
import { boardPoint } from '../lib/office/map.ts';
import { officeMapOf, officeView, skinOfTheme } from '../lib/office/skins.ts';
import type { OfficeSignals } from '../lib/office/signals.ts';
import { roomClaims } from '../lib/office/rooms.ts';
import { officeSnapshot, type OfficeAgent, type OfficeSnapshot } from '../lib/office/snapshot.ts';
import { runningWork, talkTarget, type RunningWork, type TalkTarget } from '../lib/office/talk.ts';
import { loadViewMode, saveViewMode, type OfficeViewMode } from '../lib/office/world3d.ts';
import { pendingRows, pendingTotal } from '../lib/pending.ts';
import { loadPending } from '../lib/pending-api.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Approval, CharacterListing, Conversation, ExecutorChoice, ProjectInfo, StatusSnapshot } from '../lib/types.ts';
import { labelWord } from '../lib/labels.ts';
import OfficeCanvas from './OfficeCanvas.vue';
import OfficeCardwall from './OfficeCardwall.vue';
import PendingDecisions from './PendingDecisions.vue';
import PixelAgent from './PixelAgent.vue';
import AgentName from './AgentName.vue';

/**
 * "Ufficio" (D-106, stage 1): the agents in a pixel office, from the same
 * data the chat already reads (status, live signals, pending decisions,
 * approved projects). This page holds the conversations and turns them into
 * "where to talk"; the canvas gets only the photograph. The list "Nell'ufficio"
 * next to it does everything the canvas does: the office never replaces the chat.
 * The cardwall on the wall opens the cardwall over the office (D-165): the
 * same component as the page, with `cardsVersion`, the approvals and `decide`.
 */
const props = defineProps<{
  status: StatusSnapshot | null;
  approvals: Approval[];
  projects: ProjectInfo[];
  conversations: Conversation[];
  characters: CharacterListing | null;
  signals: OfficeSignals;
  cardsVersion: number;
  decide: (approval: Approval, state: 'approved' | 'rejected', choice?: ExecutorChoice, plan?: { starts: readonly number[]; revision: number }) => Promise<void>;
  /** The agents the user may talk with directly now (D-111d): «Parla con…» opens a chat with them (D-212). */
  directAgents?: string[] | undefined;
  /** The theme in use (D-103): Scrubs and The Office have a place of their own (D-216); undefined is Base. */
  theme?: string | undefined;
}>();
const emit = defineEmits<{ open: [conversationId: string]; draft: [mode: 'work' | 'private', project?: string]; talk: [agent: string, project?: string] }>();

// The place of the theme (D-216): its map, or the base one with its colours when it does not pass.
const MAP_TEXTS = { base: baseMapText, corsia: corsiaMapText, ufficio: ufficioMapText, springfield: springfieldMapText, quahog: quahogMapText, langley: langleyMapText, 'fox-river': foxRiverMapText, 'planet-express': planetExpressMapText, pasadena: pasadenaMapText };
const skin = computed(() => skinOfTheme(props.theme));
const chosenMap = computed(() => officeMapOf(skin.value, MAP_TEXTS));
const map = computed(() => chosenMap.value.map);
/** The error, or the office with its notice: a pure choice, tested (officeView). */
const view = computed(() => officeView(chosenMap.value));
/** The map hangs a cardwall on a wall (D-165). */
const hasBoard = computed(() => map.value !== null && boardPoint(map.value) !== null);

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
    pending.value = { total: pendingTotal(pendingRows(data), data.hidden), hidden: data.hidden, coder };
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

/** Who has a room (D-229): pinned projects first, then those active in the last days; the rest behind the archive. */
// Working now counts too: the running delegations and the run of each agent (the repository it works in).
const working = computed(() => [...work.value, ...(props.status?.agents ?? []).filter((agent) => agent.state === 'thinking' || agent.state === 'working').map((agent) => ({ repo: agent.run?.repo ?? null }))]);
const claims = computed(() => roomClaims(props.projects, props.conversations, working.value, now.value));

const snapshot = computed<OfficeSnapshot>(() =>
  officeSnapshot({
    agents: props.status?.agents ?? [
      { id: 'arianna', state: 'idle', run: null },
      { id: 'coder', state: 'idle', run: null },
    ],
    projects: props.projects,
    slots: map.value?.anchors.islands.length ?? 0,
    claims: claims.value,
    strolls: map.value?.anchors.strolls.length ?? 0,
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
      return 'Privata';
    case 'pause':
      return 'Pausa';
    case 'stroll':
      return 'in giro';
    case 'archive':
      return 'Archivio';
    case 'island': {
      const slot = agent.place.slot;
      const island = snapshot.value.islands.find((item) => item.slot === slot);
      return island === undefined ? 'Stanza' : `${island.project} · ${labelWord(island.label)}`;
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
  return talkTarget(agentId, work.value, props.conversations, agent === undefined ? undefined : projectOf(agent), props.directAgents);
}

function talk(agentId: string): void {
  const target = targetOf(agentId);
  if (target.kind === 'conversation') emit('open', target.id);
  else if (target.kind === 'new') emit('talk', target.agent, target.project);
  else emit('draft', target.mode, target.project);
}

const office = ref<InstanceType<typeof OfficeCanvas> | null>(null);
function reach(target: string): void {
  office.value?.focus();
  office.value?.goTo(target, false);
}

const showPending = ref(false);
const showCardwall = ref(false);
const showArchive = ref(false);
/** The list of the keys under the map, behind «? Comandi» (D-194). */
const showKeys = ref(false);

/** The plan or the walk in 3D (D-230): a choice of this browser, the plan by default. */
function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
const viewMode = ref<OfficeViewMode>(loadViewMode(storage()));
/** The view really drawn: the plan when the 3D one could not start (the help and the keys follow it). */
const shownView = ref<OfficeViewMode>('2d');
function chooseView(mode: OfficeViewMode): void {
  viewMode.value = mode;
  saveViewMode(storage(), mode);
}
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
        <p v-if="view.kind === 'error'" role="alert" class="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ view.text }}</p>
        <template v-else>
          <p v-if="view.notice !== null" class="mb-2 text-[13px] text-muted">{{ view.notice }}</p>
          <!-- A new place is a new canvas (D-216): the map, the anchors and the paths are read when it starts. -->
          <OfficeCanvas
            :key="`${skin}:${view.map.id}`"
            ref="office"
            :map="view.map"
            :skin="skin"
            :snapshot="snapshot"
            :sheets="sheets"
            :mode="viewMode"
            @view="(mode) => (shownView = mode)"
            @talk="talk"
            @decisions="showPending = true"
            @archive="void openArchive()"
            @cardwall="showCardwall = true"
            @escape="leaveCanvas"
          />
        </template>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13.5px] text-muted">
          <p id="office-help" class="min-w-0 flex-1">
            <template v-if="shownView === '3d'">Clicca nell'ufficio o premi <kbd class="kbd">Tab</kbd>, cammina con le frecce e trascina per guardarti intorno. Vicino a un agente, <kbd class="kbd">E</kbd> apre la sua chat.</template>
            <template v-else>Clicca nell'ufficio o premi <kbd class="kbd">Tab</kbd>, poi cammina con le frecce. Vicino a un agente, <kbd class="kbd">E</kbd> apre la sua chat.</template>
          </p>
          <div class="ml-auto flex items-center gap-2">
            <div role="group" aria-label="Vista dell'ufficio" class="inline-flex overflow-hidden rounded-md border border-line-strong">
              <button
                v-for="option in (['2d', '3d'] as const)"
                :key="option"
                type="button"
                class="px-2.5 py-1 text-[13px] font-semibold"
                :class="viewMode === option ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'"
                :aria-pressed="viewMode === option"
                :disabled="map === null"
                @click="chooseView(option)"
              >{{ option === '2d' ? '2D' : '3D' }}</button>
            </div>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" aria-controls="office-keys" :aria-expanded="showKeys" @click="showKeys = !showKeys">? Comandi</button>
          </div>
        </div>
        <!-- Shown on request (D-194); still read as the description of the office when hidden. -->
        <div v-show="showKeys" id="office-keys" class="mt-2 rounded-xl border border-line bg-surface-2 p-3.5 text-[14px]">
          <dl v-if="shownView === '3d'" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> o <kbd class="kbd">W</kbd><kbd class="kbd">S</kbd></dt>
            <dd>cammina avanti e indietro</dd>
            <dt><kbd class="kbd">A</kbd><kbd class="kbd">D</kbd></dt>
            <dd>un passo di lato</dd>
            <dt><kbd class="kbd">←</kbd><kbd class="kbd">→</kbd> o trascina</dt>
            <dd>girati e guardati intorno (col mouse o col dito); un clic o un tocco sul pavimento o su un agente ti ci porta</dd>
            <dt><kbd class="kbd">E</kbd> o <kbd class="kbd">Invio</kbd></dt>
            <dd>vicino a un agente apre nella chat la sua conversazione, o una nuova; alla scrivania «Decisioni» apre le decisioni in attesa; al cardwall sul muro, le card sopra l'ufficio</dd>
            <dt><kbd class="kbd">Esc</kbd></dt>
            <dd>esce dall'ufficio</dd>
          </dl>
          <dl v-else class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <dt><kbd class="kbd">←</kbd><kbd class="kbd">↑</kbd><kbd class="kbd">→</kbd><kbd class="kbd">↓</kbd> o <kbd class="kbd">W</kbd><kbd class="kbd">A</kbd><kbd class="kbd">S</kbd><kbd class="kbd">D</kbd></dt>
            <dd>cammina; oppure clicca un punto del pavimento o un agente</dd>
            <dt><kbd class="kbd">E</kbd> o <kbd class="kbd">Invio</kbd></dt>
            <dd>vicino a un agente apre nella chat la sua conversazione, o una nuova; alla scrivania «Decisioni» apre le decisioni in attesa; al cardwall sul muro, le card sopra l'ufficio</dd>
            <dt><kbd class="kbd">Esc</kbd></dt>
            <dd>esce dall'ufficio</dd>
          </dl>
          <p class="mt-2.5 text-[13px] text-muted">L'ufficio mostra solo stati, etichette e nomi dei progetti, mai il testo delle conversazioni.</p>
        </div>
      </section>

      <aside class="flex flex-col gap-4" aria-label="Nell'ufficio">
        <section class="hud-card p-3.5" aria-labelledby="office-roster">
          <h2 id="office-roster" tabindex="-1" class="hud-title mb-2.5 outline-none">Nell'ufficio</h2>
          <ul class="flex flex-col gap-3">
            <li v-for="agent in snapshot.agents" :key="agent.id" class="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3">
              <PixelAgent :choice="characters?.agents[agent.id]" :pose="agent.pose" :scale="2" />
              <div class="min-w-0">
                <b class="block font-semibold"><AgentName :agent="agent.id" :name="agent.name" /></b>
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
              <b class="font-mono text-warn">{{ snapshot.decisions.total }}</b> in attesa<template v-if="snapshot.decisions.hidden > 0">, {{ snapshot.decisions.hidden }} sopra Privato solo contate</template>.
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="map === null" @click="reach('decisions')">Vai alla scrivania</button>
              <button type="button" class="btn px-2.5 py-1 text-xs" aria-haspopup="dialog" @click="showPending = true">Apri subito</button>
            </div>
          </template>
        </section>

        <section v-if="hasBoard" class="hud-card p-3.5" aria-labelledby="office-cardwall">
          <h2 id="office-cardwall" class="hud-title mb-2">Cardwall</h2>
          <p class="text-xs text-muted">Sul muro del corridoio, accanto alla libreria: le card e gli impegni, con i filtri della pagina Cardwall.</p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <button type="button" class="btn px-2.5 py-1 text-xs" @click="reach('cardwall')">Vai al cardwall</button>
            <button type="button" class="btn px-2.5 py-1 text-xs" aria-haspopup="dialog" @click="showCardwall = true">Apri subito</button>
          </div>
        </section>

        <section v-if="archiveCount > 0 || showArchive" class="hud-card p-3.5" aria-labelledby="office-archive">
          <h2 id="office-archive" ref="archiveHeading" tabindex="-1" class="hud-title mb-2 outline-none">Archivio</h2>
          <p v-if="archiveCount === 0" class="text-xs text-muted">Tutti i progetti approvati hanno una stanza.</p>
          <p v-else class="mb-2 text-xs text-muted">Hanno una stanza i progetti con una conversazione fissata, poi quelli attivi negli ultimi 7 giorni; gli altri sono qui.</p>
          <ul v-if="snapshot.archived.length > 0" class="flex flex-col gap-1.5 text-xs">
            <li v-for="(name, index) in snapshot.archived" :key="`${name}-${String(index)}`" class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono">{{ name }}</span>
              <button type="button" class="btn px-2 py-0.5 text-[12.5px]" @click="emit('draft', 'work', name)">Nuova conversazione</button>
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
      <OfficeCardwall
        v-if="showCardwall"
        :version="cardsVersion"
        :approvals="approvals"
        :decide="decide"
        @close="showCardwall = false"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.kbd {
  font: 600 12px ui-monospace, Menlo, monospace;
  border: 1px solid var(--line-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 4px;
  color: var(--ink);
}
</style>
