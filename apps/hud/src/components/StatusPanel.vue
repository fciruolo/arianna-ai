<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { agentName } from '../lib/italian.ts';
import { ACTION_TEXT, DECISION_TEXT, EXECUTOR_TEXT, MODEL_TEXT, REMOTE_CHANNEL_TEXT } from '../lib/labels.ts';
import { pendingItems, pendingTotal } from '../lib/pending.ts';
import { loadPending } from '../lib/pending-api.ts';
import { PENDING_OPEN } from '../lib/pending-text.ts';
import type { RemoteDecision } from '../lib/remote-decisions.ts';
import { routerReasonText } from '../lib/router-reasons.ts';
import { activeText } from '../lib/sidebar.ts';
import { POSE_TEXT, type Pose } from '../lib/sprites.ts';
import type { Approval, CharacterChoice, CharacterListing, StatusSnapshot } from '../lib/types.ts';
import LabelBadge from './LabelBadge.vue';
import ApprovalCard from './ApprovalCard.vue';
import Icon from './Icon.vue';
import PendingDecisions from './PendingDecisions.vue';
import PixelAgent from './PixelAgent.vue';
import RecentDelegations from './RecentDelegations.vue';

/**
 * The status panel (D-060): what waits for the user elsewhere, the agents,
 * the last router decision, the gateway today and the character packs.
 * Everything comes from the core; nothing here is made up.
 */
const props = defineProps<{
  status: StatusSnapshot | null;
  characters: CharacterListing | null;
  agentIds: string[];
  poseFor: (id: string) => Pose;
  approvals: Approval[];
  remoteDecisions: RemoteDecision[];
  decide: (approval: Approval, state: 'approved' | 'rejected') => Promise<void>;
}>();
const emit = defineEmits<{ dismiss: [approvalId: string]; refreshCharacters: []; close: []; open: [conversationId: string] }>();

const ROLE_TEXT: Record<string, string> = { arianna: 'orchestratrice · modello locale', coder: 'codice · esecutori cloud' };
const DIFFICULTY_TEXT: Record<string, string> = { trivial: 'banale', normal: 'normale', hard: 'difficile', critical: 'critico' };

function runOf(id: string) {
  return props.status?.agents.find((agent) => agent.id === id)?.run ?? null;
}

const active = computed(() => props.agentIds.filter((id) => props.poseFor(id) !== 'idle').length);

function timeOf(ts: string): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

/** "Decisioni in attesa" (D-091): opened from the row of what waits for the user. */
const showPending = ref(false);
/** Changes when the store reads the status or the approvals again: the window and the row read with it. */
const pendingSignal = computed(() => [props.status, props.approvals]);
/** The total of the window (approvals, waiting tasks, those above L2 counted), read again with the signal. */
const pendingRead = ref<number | null>(null);
let pendingLatest = 0;
async function readPending(): Promise<void> {
  const request = ++pendingLatest;
  try {
    const data = await loadPending();
    if (request === pendingLatest) pendingRead.value = pendingTotal(pendingItems(data.approvals, data.tasks, data.titles, data.waiting), data.hidden);
  } catch {
    // Keeps the last total; until the first read, the counts of the status stand in.
  }
}
watch(pendingSignal, () => void readPending(), { immediate: true });
/** Before the first read: the waiting tasks plus the approvals without a task, never fewer than the approvals listed. */
const pendingCount = computed(
  () =>
    pendingRead.value ??
    Math.max((props.status?.waiting ?? 0) + props.approvals.filter((approval) => approval.taskId === null).length, props.approvals.length),
);
const somethingWaits = computed(() => pendingCount.value > 0);

const peak = computed(() => Math.max(1, ...(props.status?.gateway.hours ?? [])));

/** The first character of a pack, as its preview. */
function previewOf(packId: string): CharacterChoice | undefined {
  const pack = props.characters?.packs.find((entry) => entry.id === packId);
  const first = pack?.characters[0];
  return pack === undefined || first === undefined ? undefined : { pack: pack.id, character: first.id, rows: first.rows };
}

function wornBy(packId: string): string[] {
  return Object.entries(props.characters?.agents ?? {})
    .filter(([, choice]) => choice.pack === packId)
    .map(([agent]) => agentName(agent));
}
</script>

<template>
  <aside class="flex min-w-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface px-4 py-[18px]" aria-label="Pannello di stato">
    <!-- On top, as in the left bar (D-097): the agents, how many are at work, and the button that folds the bar. -->
    <div class="flex items-center gap-2">
      <h2 class="font-hud text-[15px] leading-none font-semibold tracking-[0.12em] uppercase">Agenti</h2>
      <small class="flex-1 font-mono text-[10.5px] tracking-[0.06em] text-muted">{{ activeText(active) }}</small>
      <button type="button" class="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Chiudi la barra degli agenti" title="Chiudi la barra" @click="emit('close')">
        <span class="hidden xl:inline"><Icon name="panel-collapse" /></span><span class="xl:hidden"><Icon name="close" /></span>
      </button>
    </div>

    <section aria-label="Agenti">
      <div class="flex flex-col gap-2">
        <div v-for="id in agentIds" :key="id" class="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-3 rounded-[14px] border border-line bg-surface-2 p-2.5">
          <div class="grid h-16 w-14 place-items-end justify-center rounded-[10px] bg-[radial-gradient(circle_at_50%_85%,var(--glow),transparent_70%)] pb-1">
            <PixelAgent :choice="characters?.agents[id]" :pose="poseFor(id)" :scale="2" bubble />
          </div>
          <div class="min-w-0">
            <b class="block font-semibold">{{ agentName(id) }}</b>
            <button
              v-if="poseFor(id) === 'waiting'"
              type="button"
              class="text-left text-xs text-warn underline decoration-dotted underline-offset-2 hover:text-ink"
              aria-haspopup="dialog"
              @click="showPending = true"
            >{{ POSE_TEXT[poseFor(id)] }}</button>
            <div v-else class="text-xs text-muted">{{ POSE_TEXT[poseFor(id)] }}</div>
            <div class="mt-0.5 truncate font-mono text-[10.5px] text-muted">
              <template v-if="runOf(id) !== null">
                {{ EXECUTOR_TEXT[runOf(id)!.executor] ?? runOf(id)!.executor }}<template v-if="runOf(id)!.model"> · {{ MODEL_TEXT[runOf(id)!.model!] ?? runOf(id)!.model }}</template><template v-if="runOf(id)!.repo"> · {{ runOf(id)!.repo }}</template>
              </template>
              <template v-else>{{ ROLE_TEXT[id] ?? 'agente' }}</template>
            </div>
          </div>
        </div>
      </div>
    </section>

    <button
      v-if="somethingWaits"
      type="button"
      class="flex items-center gap-2 rounded-[10px] border border-warn/60 bg-surface-2 px-3 py-2 text-left text-xs hover:border-warn"
      aria-haspopup="dialog"
      @click="showPending = true"
    >
      <span class="text-warn"><Icon name="warning" :size="16" /></span>
      <span class="min-w-0 flex-1 font-semibold">{{ PENDING_OPEN }}</span>
      <span class="font-mono text-[10.5px] text-warn">{{ pendingCount }}</span>
    </button>

    <section v-if="approvals.length > 0">
      <h3 class="hud-title mb-2.5 flex items-center justify-between">
        Attende te <small class="font-mono text-[10px] tracking-[0.06em] normal-case">{{ approvals.length }} da altre conversazioni</small>
      </h3>
      <div class="flex flex-col gap-3">
        <ApprovalCard v-for="approval in approvals" :key="approval.id" :approval="approval" :decide="decide" />
      </div>
    </section>

    <section v-if="remoteDecisions.length > 0">
      <h3 class="hud-title mb-2.5">Decise altrove</h3>
      <ul class="flex flex-col gap-2">
        <li v-for="decision in remoteDecisions" :key="decision.approvalId" class="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
          <span class="font-semibold">{{ decision.action === undefined ? 'Richiesta' : (ACTION_TEXT[decision.action] ?? decision.action) }}</span>
          <span :class="decision.state === 'approved' ? 'text-ok' : 'text-danger'">{{ DECISION_TEXT[decision.state] }}</span>
          <span class="text-muted">da {{ REMOTE_CHANNEL_TEXT[decision.via] }} · {{ timeOf(decision.ts) }}</span>
          <button type="button" class="ml-auto rounded p-0.5 text-muted hover:text-ink" aria-label="Nascondi" @click="emit('dismiss', decision.approvalId)">
            <Icon name="close" :size="14" />
          </button>
        </li>
      </ul>
    </section>

    <section>
      <h3 class="hud-title mb-2.5 flex items-center justify-between">
        Instradamento <small class="font-mono text-[10px] tracking-[0.06em] normal-case">ultima delega</small>
      </h3>
      <div class="rounded-[14px] border border-line bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-[1.75]">
        <template v-if="status?.router">
          <div class="flex justify-between gap-2.5"><span class="text-muted">quando</span><span>{{ timeOf(status.router.ts) }}</span></div>
          <div class="flex justify-between gap-2.5">
            <span class="text-muted">etichetta</span><LabelBadge :label="status.router.label" />
          </div>
          <div class="flex justify-between gap-2.5">
            <span class="text-muted">difficoltà</span><span>{{ DIFFICULTY_TEXT[status.router.difficulty] ?? status.router.difficulty }}</span>
          </div>
          <div class="flex justify-between gap-2.5">
            <span class="text-muted">esito</span>
            <span v-if="status.router.decision === 'route'" class="truncate">
              {{ EXECUTOR_TEXT[status.router.executor ?? ''] ?? status.router.executor }} · {{ MODEL_TEXT[status.router.model ?? ''] ?? status.router.model }}
            </span>
            <span v-else class="text-warn">in attesa</span>
          </div>
          <div class="mt-1 border-t border-line pt-1 font-sans text-[11.5px] leading-snug">
            <span class="text-muted">motivo: </span>{{ routerReasonText(status.router.reason) }}
          </div>
        </template>
        <p v-else class="text-muted">Nessuna delega ancora: Arianna ha lavorato solo sul modello locale.</p>
      </div>
    </section>

    <RecentDelegations :status="status" @open="(id) => emit('open', id)" />

    <section>
      <h3 class="hud-title mb-2.5 flex items-center justify-between">
        Gateway <small class="font-mono text-[10px] tracking-[0.06em] normal-case">oggi</small>
      </h3>
      <div class="rounded-[14px] border border-line bg-surface-2 px-3 py-2.5 font-mono text-[11.5px] leading-[1.75]">
        <template v-if="status !== null">
          <div class="flex justify-between gap-2.5"><span class="text-muted">uscite verso il cloud</span><span>{{ status.gateway.allowedOut }}</span></div>
          <div class="flex justify-between gap-2.5">
            <span class="text-muted">bloccate</span><span :class="status.gateway.blocked > 0 ? 'text-warn' : 'text-ok'">{{ status.gateway.blocked }}</span>
          </div>
          <div class="flex justify-between gap-2.5">
            <span class="text-muted">uscite Private o Segrete</span>
            <span :class="status.gateway.privateOut === 0 ? 'text-ok' : 'text-danger'">{{ status.gateway.privateOut === 0 ? 'mai' : status.gateway.privateOut }}</span>
          </div>
          <div class="mt-2 flex h-[34px] items-end gap-[3px]" role="img" :aria-label="`Decisioni del gateway nelle ultime 12 ore: ${status.gateway.hours.join(', ')}`">
            <i
              v-for="(count, index) in status.gateway.hours"
              :key="index"
              class="flex-1 rounded-t-[2px] bg-accent"
              :class="index === status.gateway.hours.length - 1 ? 'opacity-100' : 'opacity-55'"
              :style="{ height: `${String(count === 0 ? 4 : Math.max(10, Math.round((count / peak) * 100)))}%` }"
              :title="`${String(count)}`"
            />
          </div>
          <div class="flex justify-between text-[9.5px] text-muted"><span>−12 h</span><span>ora</span></div>
        </template>
        <p v-else class="text-muted">Lettura in corso…</p>
      </div>
    </section>

    <section>
      <h3 class="hud-title mb-2.5 flex items-center justify-between">
        Personaggi
        <button type="button" class="font-mono text-[10px] tracking-[0.06em] normal-case hover:text-ink" @click="emit('refreshCharacters')">rileggi</button>
      </h3>
      <div class="grid grid-cols-3 gap-2">
        <div
          v-for="pack in characters?.packs ?? []"
          :key="pack.id"
          class="grid justify-items-center gap-1 rounded-[10px] border bg-surface-2 px-1 pt-2 pb-1.5 text-center text-[11px]"
          :class="wornBy(pack.id).length > 0 ? 'border-accent text-ink' : 'border-line text-muted'"
          :title="[pack.source, wornBy(pack.id).length > 0 ? `in uso: ${wornBy(pack.id).join(', ')}` : ''].filter(Boolean).join(' · ')"
        >
          <PixelAgent :choice="previewOf(pack.id)" pose="idle" :scale="1" />
          <span class="w-full truncate">{{ pack.name }}</span>
        </div>
      </div>
      <ul v-if="(characters?.refused.length ?? 0) > 0" class="mt-2 flex flex-col gap-1 text-[11px] text-warn">
        <li v-for="item in characters?.refused" :key="item.pack"><span class="font-mono">{{ item.pack }}</span>: {{ item.reason }}</li>
      </ul>
      <p class="mt-2 text-[11.5px] leading-snug text-muted">
        Per aggiungere un pacchetto copia la sua cartella in <span class="font-mono">data/characters</span>, fuori da git, poi scegli chi lo indossa in
        <span class="font-mono">[characters]</span> di <span class="font-mono">arianna.toml</span>.
      </p>
    </section>

    <!-- Out of the panel: its transform would make the fixed window relative to it. -->
    <Teleport to="body">
      <PendingDecisions
        v-if="showPending"
        :signal="pendingSignal"
        @close="showPending = false"
        @open="(id) => emit('open', id)"
      />
    </Teleport>
  </aside>
</template>
