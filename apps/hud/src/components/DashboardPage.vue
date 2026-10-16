<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { ApiError, cancelTileRefresh, loadTiles, orderTiles, refreshTile, removeTile, updateTile } from '../lib/api.ts';
import {
  anyRunning,
  answeredByText,
  CANCEL_TEXT,
  canRefresh,
  cloudNote,
  countText,
  DASHBOARD_EMPTY_TEXT,
  DASHBOARD_EMPTY_TITLE,
  DASHBOARD_LOAD_ERROR,
  DASHBOARD_PRIVACY,
  DASHBOARD_TITLE,
  dashboardErrorText,
  droppedOn,
  elapsedText,
  moved,
  REFRESH_ALL_HINT,
  REFRESH_ALL_TEXT,
  REFRESH_ERROR_TEXT,
  refreshable,
  refreshButtonText,
  REFRESHING_TEXT,
  REMOVE_CONFIRM_TEXT,
  REMOVE_TEXT,
  REMOVED_TEXT,
  SECRET_NO_REFRESH,
  whenText,
  WIDTH_TEXT,
  type DashboardTile,
} from '../lib/dashboard.ts';
import type { RowMenuItem } from '../lib/projects-page.ts';
import Icon from './Icon.vue';
import LabelBadge from './LabelBadge.vue';
import MarkdownText from './MarkdownText.vue';
import PageHeader from './PageHeader.vue';
import RowMenu from './RowMenu.vue';

/**
 * The page «Cruscotto» (D-248): the answers pinned from the chat as tiles,
 * in the user's order, narrow or wide. Each shows its label (always), when it
 * was refreshed, who wrote it and the conversation it came from; «Aggiorna»
 * asks its question again on the local model. While a tile is at work the
 * page reads the tiles again every few seconds.
 */
const emit = defineEmits<{ open: [conversationId: string]; chat: [] }>();

const tiles = ref<DashboardTile[]>([]);
const loaded = ref(false);
const problem = ref<string | null>(null);
const now = ref(new Date());
const editing = ref<string | null>(null);
const draftTitle = ref('');
const confirming = ref<string | null>(null);
const busy = ref<Set<string>>(new Set());
const dragging = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const notice = ref<{ text: string; undo?: () => void } | null>(null);
const shownQuestion = ref<string | null>(null);
let poll: ReturnType<typeof setTimeout> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const count = computed(() => countText(tiles.value.length));

async function load(): Promise<void> {
  clearTimeout(poll);
  try {
    tiles.value = await loadTiles();
    problem.value = null;
  } catch {
    problem.value = DASHBOARD_LOAD_ERROR;
  } finally {
    loaded.value = true;
  }
  if (alive && anyRunning(tiles.value)) poll = setTimeout(() => void load(), 3000);
}

function replace(tile: DashboardTile): void {
  tiles.value = tiles.value.map((item) => (item.id === tile.id ? tile : item));
}

function say(text: string, undo?: () => void): void {
  clearTimeout(noticeTimer);
  notice.value = undo === undefined ? { text } : { text, undo };
  noticeTimer = setTimeout(() => (notice.value = null), 5000);
}

function failed(error: unknown, fallback: string): void {
  say(error instanceof ApiError ? dashboardErrorText(error.status, fallback) : fallback);
}

async function work(id: string, action: () => Promise<void>): Promise<void> {
  if (busy.value.has(id)) return;
  busy.value = new Set([...busy.value, id]);
  try {
    await action();
  } finally {
    const next = new Set(busy.value);
    next.delete(id);
    busy.value = next;
  }
}

async function refresh(tile: DashboardTile): Promise<void> {
  await work(tile.id, async () => {
    try {
      replace(await refreshTile(tile.id));
      void load();
    } catch (error) {
      failed(error, 'Non riesco ad avviare l’aggiornamento.');
    }
  });
}

async function refreshAll(): Promise<void> {
  // The core queues them: the local model answers one at a time.
  for (const tile of refreshable(tiles.value)) {
    try {
      replace(await refreshTile(tile.id));
    } catch (error) {
      failed(error, 'Non riesco ad avviare un aggiornamento.');
    }
  }
  void load();
}

async function cancel(tile: DashboardTile): Promise<void> {
  await work(tile.id, async () => {
    try {
      replace(await cancelTileRefresh(tile.id));
    } catch (error) {
      failed(error, 'Non riesco a fermare l’aggiornamento.');
    }
  });
}

async function startRename(tile: DashboardTile): Promise<void> {
  editing.value = tile.id;
  draftTitle.value = tile.title;
  await nextTick();
  const input = document.getElementById(`tile-title-${tile.id}`);
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
  }
}

async function finishRename(tile: DashboardTile, save: boolean): Promise<void> {
  if (editing.value !== tile.id) return;
  editing.value = null;
  const title = draftTitle.value.replace(/\s+/g, ' ').trim();
  if (!save || title === '' || title === tile.title) return;
  await work(tile.id, async () => {
    try {
      replace(await updateTile(tile.id, { title }));
    } catch (error) {
      failed(error, 'Non riesco a rinominarlo.');
    }
  });
}

async function setWidth(tile: DashboardTile, width: 'narrow' | 'wide'): Promise<void> {
  if (tile.width === width) return;
  replace({ ...tile, width });
  try {
    replace(await updateTile(tile.id, { width }));
  } catch (error) {
    replace(tile);
    failed(error, 'Non riesco a cambiare la larghezza.');
  }
}

async function saveOrder(ids: string[]): Promise<void> {
  const before = tiles.value;
  const byId = new Map(before.map((tile) => [tile.id, tile]));
  tiles.value = ids.map((id) => byId.get(id)).filter((tile): tile is DashboardTile => tile !== undefined);
  try {
    tiles.value = await orderTiles(ids);
  } catch (error) {
    tiles.value = before;
    failed(error, 'Non riesco a spostarlo.');
  }
}

async function remove(tile: DashboardTile): Promise<void> {
  confirming.value = null;
  await work(tile.id, async () => {
    const index = tiles.value.findIndex((item) => item.id === tile.id);
    tiles.value = tiles.value.filter((item) => item.id !== tile.id);
    // Five seconds to change idea: the tile leaves the core only after them.
    let undone = false;
    say(REMOVED_TEXT, () => {
      undone = true;
      const next = [...tiles.value];
      next.splice(Math.min(index, next.length), 0, tile);
      tiles.value = next;
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (undone) return;
    try {
      await removeTile(tile.id);
    } catch (error) {
      failed(error, 'Non riesco a toglierlo.');
      void load();
    }
  });
}

function menuOf(tile: DashboardTile): RowMenuItem[] {
  const ids = tiles.value.map((item) => item.id);
  const at = ids.indexOf(tile.id);
  const running = tile.refreshState === 'running';
  return [
    { id: 'rename', text: 'Rinomina' },
    { id: 'narrow', text: `${WIDTH_TEXT.narrow}${tile.width === 'narrow' ? ' ✓' : ''}` },
    { id: 'wide', text: `${WIDTH_TEXT.wide}${tile.width === 'wide' ? ' ✓' : ''}` },
    { id: 'up', text: 'Sposta prima', disabled: at <= 0 },
    { id: 'down', text: 'Sposta dopo', disabled: at < 0 || at >= ids.length - 1 },
    { id: 'open', text: 'Apri la conversazione d’origine' },
    { id: 'question', text: 'Vedi la domanda per gli aggiornamenti' },
    { id: 'remove', text: REMOVE_TEXT, danger: true, disabled: running },
  ];
}

function choose(tile: DashboardTile, id: string): void {
  const ids = tiles.value.map((item) => item.id);
  if (id === 'rename') void startRename(tile);
  else if (id === 'narrow' || id === 'wide') void setWidth(tile, id);
  else if (id === 'up') void saveOrder(moved(ids, tile.id, -1));
  else if (id === 'down') void saveOrder(moved(ids, tile.id, 1));
  else if (id === 'open') emit('open', tile.sourceConversationId);
  else if (id === 'question') shownQuestion.value = shownQuestion.value === tile.id ? null : tile.id;
  else if (id === 'remove') confirming.value = tile.id;
}

function onDragStart(event: DragEvent, tile: DashboardTile): void {
  dragging.value = tile.id;
  event.dataTransfer?.setData('text/plain', tile.id);
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
}
function onDragOver(event: DragEvent, tile: DashboardTile): void {
  if (dragging.value === null || dragging.value === tile.id) return;
  event.preventDefault();
  dropTarget.value = tile.id;
}
function onDrop(event: DragEvent, tile: DashboardTile): void {
  event.preventDefault();
  const id = dragging.value;
  dragging.value = null;
  dropTarget.value = null;
  if (id === null || id === tile.id) return;
  void saveOrder(droppedOn(tiles.value.map((item) => item.id), id, tile.id));
}
function onDragEnd(): void {
  dragging.value = null;
  dropTarget.value = null;
}

onMounted(() => {
  void load();
  clock = setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(poll);
  clearInterval(clock);
  clearTimeout(noticeTimer);
});
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1240px] flex-col gap-4 px-4 pt-5 pb-10 md:px-6">
        <PageHeader :title="DASHBOARD_TITLE" title-id="dashboard-title">
          {{ DASHBOARD_PRIVACY }}
          <template #actions>
            <span v-if="tiles.length > 0" class="pill">{{ count }}</span>
            <button v-if="refreshable(tiles).length > 0" type="button" class="btn px-2.5 py-1 text-[13.5px]" :title="REFRESH_ALL_HINT" @click="refreshAll">
              <Icon name="retry" :size="14" />{{ REFRESH_ALL_TEXT }}
            </button>
          </template>
        </PageHeader>

        <p v-if="problem !== null" class="rounded-lg border border-danger/40 px-3 py-2 text-[14px] text-danger" role="alert">
          {{ problem }} <button type="button" class="underline" @click="load">Riprova</button>
        </p>

        <div v-if="loaded && tiles.length === 0 && problem === null" class="rounded-xl border border-dashed border-line-strong px-5 py-9 text-center text-muted">
          <b class="mb-1.5 block text-[16px] text-ink">{{ DASHBOARD_EMPTY_TITLE }}</b>
          {{ DASHBOARD_EMPTY_TEXT }}
          <div class="mt-4"><button type="button" class="btn px-3 py-1 text-[14px]" @click="emit('chat')">Vai alla chat</button></div>
        </div>

        <div v-else class="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2" aria-labelledby="dashboard-title">
          <article
            v-for="tile in tiles"
            :key="tile.id"
            class="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2"
            :class="[tile.width === 'wide' ? 'md:col-span-2' : '', dragging === tile.id ? 'opacity-50' : '', dropTarget === tile.id ? 'outline-2 outline-offset-2 outline-dashed outline-accent' : '']"
            :aria-label="tile.title"
            @dragover="onDragOver($event, tile)"
            @dragleave="dropTarget = dropTarget === tile.id ? null : dropTarget"
            @drop="onDrop($event, tile)"
          >
            <header class="flex items-center gap-2 border-b border-line py-2 pr-3 pl-2">
              <span
                class="cursor-grab rounded p-1 text-muted hover:text-ink"
                draggable="true"
                title="Trascina per spostare (o ⋯ → Sposta prima / dopo)"
                aria-hidden="true"
                @dragstart="onDragStart($event, tile)"
                @dragend="onDragEnd"
              ><Icon name="drag" :size="15" /></span>
              <input
                v-if="editing === tile.id"
                :id="`tile-title-${tile.id}`"
                v-model="draftTitle"
                class="field min-w-0 flex-1 px-1.5 py-0.5 text-[15px] font-semibold"
                maxlength="80"
                aria-label="Titolo del riquadro"
                @keydown.enter.prevent="finishRename(tile, true)"
                @keydown.esc.prevent="finishRename(tile, false)"
                @blur="finishRename(tile, true)"
              />
              <button
                v-else
                type="button"
                class="min-w-0 flex-1 truncate rounded-md border border-transparent px-1.5 py-0.5 text-left text-[15px] font-semibold hover:border-line"
                title="Clic per rinominare"
                @click="startRename(tile)"
              >{{ tile.title }}</button>
              <LabelBadge class="shrink-0 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-[12.5px]" :label="tile.label" />
              <RowMenu :items="menuOf(tile)" :label="`Altro per ${tile.title}`" @choose="choose(tile, $event)" />
            </header>

            <div v-if="confirming === tile.id" class="mx-3.5 mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-[13px]" role="alertdialog" :aria-label="REMOVE_CONFIRM_TEXT">
              <span class="flex-1">{{ REMOVE_CONFIRM_TEXT }}</span>
              <button type="button" class="rounded-md px-2 py-0.5 text-muted hover:text-ink" @click="confirming = null">Annulla</button>
              <button type="button" class="btn btn-danger px-2.5 py-0.5 text-[13px]" @click="remove(tile)">Togli</button>
            </div>

            <div v-if="tile.refreshState === 'running'" class="mx-3.5 mt-2.5 flex items-center gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[13px]" role="status">
              <span class="spinner" aria-hidden="true" />
              <span>{{ REFRESHING_TEXT }} <span class="text-muted">{{ elapsedText(tile.refreshStartedAt, now) }}</span></span>
              <span class="flex-1" />
              <button type="button" class="rounded-md px-2 py-0.5 text-muted hover:text-ink" :disabled="busy.has(tile.id)" @click="cancel(tile)">{{ CANCEL_TEXT }}</button>
            </div>

            <div v-else-if="tile.refreshState === 'failed' && tile.refreshError !== null" class="mx-3.5 mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-danger/45 bg-danger/8 px-2.5 py-2 text-[13px]" role="status">
              <span><b class="font-semibold text-danger">Aggiornamento non riuscito</b>: {{ REFRESH_ERROR_TEXT[tile.refreshError] }}. Sotto resta la risposta di {{ whenText(tile.refreshedAt, now) }}.</span>
            </div>

            <p v-if="cloudNote(tile) !== null" class="mx-3.5 mt-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-muted">{{ cloudNote(tile) }}</p>
            <p v-if="shownQuestion === tile.id" class="mx-3.5 mt-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">
              <span class="text-muted">Domanda per gli aggiornamenti:</span> {{ tile.question }}
            </p>

            <MarkdownText class="min-w-0 flex-1 px-3.5 pt-3 pb-1 text-[14.5px]" :class="tile.refreshState === 'running' ? 'opacity-50' : ''" :source="tile.body" />

            <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dashed border-line px-3.5 py-2 text-[12.5px] text-muted">
              <span>Aggiornato {{ whenText(tile.refreshedAt, now) }}</span>
              <span>· da <button type="button" class="text-accent hover:underline" @click="emit('open', tile.sourceConversationId)">«{{ tile.sourceTitle ?? 'conversazione' }}»</button><template v-if="tile.sourceArchived"> (archiviata)</template></span>
              <span class="font-mono text-[11.5px]">{{ answeredByText(tile) }}</span>
              <span class="flex-1" />
              <span v-if="tile.label === 'L3'">{{ SECRET_NO_REFRESH }}</span>
              <button
                v-else
                type="button"
                class="btn px-2.5 py-0.5 text-[13px]"
                :disabled="!canRefresh(tile) || busy.has(tile.id)"
                @click="refresh(tile)"
              ><Icon name="retry" :size="13" />{{ refreshButtonText(tile) }}</button>
            </footer>
          </article>
        </div>
      </div>
    </div>
    <div v-if="notice !== null" class="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-3.5 py-2 text-[14px] text-bg" role="status">
      {{ notice.text }}
      <button v-if="notice.undo !== undefined" type="button" class="font-semibold text-accent" @click="notice.undo(); notice = null">Annulla</button>
    </div>
  </div>
</template>

<style scoped>
.spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
</style>
