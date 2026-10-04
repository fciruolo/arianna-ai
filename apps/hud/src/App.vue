<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import ChatView from './components/ChatView.vue';
import ConversationList from './components/ConversationList.vue';
import Icon from './components/Icon.vue';
import NewConversation from './components/NewConversation.vue';
import PixelAgent from './components/PixelAgent.vue';
import StatusPanel from './components/StatusPanel.vue';
import { agentName } from './lib/italian.ts';
import { LABEL_TEXT, MODE_TEXT } from './lib/labels.ts';
import { gridColumns, loadLayout, saveLayout } from './lib/layout.ts';
import { poseOf, POSE_TEXT, type Pose } from './lib/sprites.ts';
import { loadTheme, nextTheme, saveTheme, THEME_TEXT, themeAttribute, type Theme } from './lib/theme.ts';
import type { Activity, Approval } from './lib/types.ts';
import { createChatStore } from './store.ts';

const store = createChatStore();
const { conversations, archived, chat, current, tasks, approvals, models, projects, remoteDecisions, status, characters, live, error, sending } = store;

// Drawers on narrow screens; collapsed bars on wide ones, remembered in this browser.
const showSidebar = ref(false);
const showPanel = ref(false);
const storage = typeof window === 'undefined' ? undefined : window.localStorage;
const layout = ref(loadLayout(storage));
watch(layout, (value) => saveLayout(storage, value), { deep: true });

// Theme: the user's choice in this browser, or the system's.
const theme = ref<Theme>(loadTheme(storage));
watch(
  theme,
  (value) => {
    const attribute = themeAttribute(value);
    if (attribute === undefined) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', attribute);
    saveTheme(storage, value);
  },
  { immediate: true },
);
const themeIcon = computed(() => (theme.value === 'dark' ? 'theme-dark' : theme.value === 'light' ? 'theme-light' : 'theme-system'));

// The clock of the top bar, as on the mockup.
const now = ref(new Date());
let clock: number | undefined;
const DAYS = ['DOM', 'LUN', 'MAR', 'MER', 'GIO', 'VEN', 'SAB'];
const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const clockText = computed(() => {
  const date = now.value;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${DAYS[date.getDay()] ?? ''} ${pad(date.getDate())} ${MONTHS[date.getMonth()] ?? ''} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
});

onMounted(() => {
  store.start();
  clock = window.setInterval(() => {
    now.value = new Date();
  }, 15_000);
});
onBeforeUnmount(() => {
  store.stop();
  window.clearInterval(clock);
});

async function openConversation(id: string): Promise<void> {
  showSidebar.value = false;
  await store.open(id);
}

async function createConversation(mode: 'work' | 'private', project?: string): Promise<void> {
  showSidebar.value = false;
  await store.create(mode, project);
}

/** The last line of activity of a running task of the open conversation: it says what Arianna is doing. */
const activeLine = computed<Activity | undefined>(() => {
  const state = chat.value;
  if (state === null) return undefined;
  const running = Object.values(tasks.value).filter((task) => task.status === 'running' || task.status === 'ready');
  return running.map((task) => state.activity[task.id]?.at(-1)).find((line) => line !== undefined);
});

/** The agents to show: those the core knows, Arianna first. */
const agentIds = computed(() => {
  const ids = status.value?.agents.map((agent) => agent.id) ?? ['arianna', 'coder'];
  return [...ids].sort((a, b) => (a === 'arianna' ? -1 : b === 'arianna' ? 1 : a.localeCompare(b)));
});

function poseFor(id: string): Pose {
  const state = status.value?.agents.find((agent) => agent.id === id)?.state;
  return poseOf(state, id === 'arianna' ? activeLine.value : undefined);
}

/** Approvals of the open conversation's tasks are shown in the chat; the others in the panel. */
const inChat = computed(() => approvals.value.filter((approval) => approval.taskId !== null && approval.taskId in tasks.value));
const elsewhere = computed<Approval[]>(() => approvals.value.filter((approval) => !inChat.value.includes(approval)));

const crumb = computed(() => {
  const conversation = current.value;
  if (conversation === undefined) return [];
  const project = conversation.workspace?.split('/').at(-1);
  return [MODE_TEXT[conversation.mode], ...(project === undefined ? [] : [project])];
});

const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };
</script>

<template>
  <div class="grid h-full grid-cols-1" :class="gridColumns(layout)">
    <!-- Icon rail -->
    <nav class="hidden flex-col items-center gap-1.5 border-r border-line bg-surface py-3.5 md:flex" aria-label="Sezioni">
      <div class="mb-2.5 grid size-9 place-items-center" aria-hidden="true">
        <svg viewBox="0 0 34 34" width="30" height="30">
          <circle cx="17" cy="17" r="14" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 3" />
          <path d="M8 22c5-10 13 2 18-9" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" />
          <circle cx="17" cy="17" r="3" fill="var(--accent)" />
        </svg>
      </div>
      <button type="button" class="grid size-[38px] place-items-center rounded-[9px] border border-line-strong bg-surface-2 text-accent" aria-label="Chat" aria-current="page">
        <Icon name="chat" />
      </button>
      <div class="flex-1" />
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border border-transparent text-muted hover:bg-surface-2 hover:text-ink"
        :aria-label="`${THEME_TEXT[theme]}: cambia tema`"
        :title="THEME_TEXT[theme]"
        @click="theme = nextTheme(theme)"
      >
        <Icon :name="themeIcon" />
      </button>
    </nav>

    <!-- Sidebar: brand, new conversation, agents, conversations -->
    <aside
      class="fixed inset-y-0 left-0 z-30 flex w-[min(290px,86vw)] flex-col gap-4 overflow-y-auto border-r border-line bg-surface px-3.5 py-4 transition-transform md:static md:z-auto md:w-auto md:translate-x-0"
      :class="[showSidebar ? 'translate-x-0' : '-translate-x-full', { 'md:hidden': layout.sidebar }]"
      aria-label="Conversazioni e agenti"
    >
      <div class="flex items-baseline gap-2 px-1.5">
        <span class="font-hud text-[19px] leading-none font-semibold tracking-[0.06em] uppercase">Arianna</span>
        <span class="font-mono text-[10px] tracking-[0.12em] text-muted">LOCALE</span>
        <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] whitespace-nowrap text-muted" :title="live === 'open' ? 'Collegata al nucleo' : 'Riconnessione in corso'">
          <span class="size-[7px] rounded-full" :class="live === 'open' ? 'bg-ok shadow-[0_0_8px_var(--ok)]' : 'animate-hud-blink bg-warn'" />
          {{ live === 'open' ? 'IN LINEA' : 'RICONN.' }}
        </span>
        <button type="button" class="ml-1 rounded-md p-1 text-muted hover:text-ink md:hidden" aria-label="Chiudi il menu" @click="showSidebar = false">
          <Icon name="close" />
        </button>
      </div>

      <NewConversation :projects="projects" @create="createConversation" @refresh="store.refreshProjects" />

      <section>
        <h2 class="hud-title mx-1.5 mb-1.5">Agenti</h2>
        <ul class="flex flex-col gap-0.5">
          <li v-for="id in agentIds" :key="id" class="flex items-center gap-2.5 rounded-lg px-2 py-1">
            <PixelAgent :choice="characters?.agents[id]" :pose="poseFor(id)" :scale="1" />
            <span class="min-w-0 flex-1 truncate">{{ agentName(id) }}</span>
            <span
              class="size-[7px] shrink-0 rounded-full"
              :class="
                poseFor(id) === 'waiting'
                  ? 'bg-warn shadow-[0_0_8px_var(--warn)]'
                  : poseFor(id) === 'idle'
                    ? 'bg-muted'
                    : 'bg-accent shadow-[0_0_8px_var(--accent)]'
              "
              :title="POSE_TEXT[poseFor(id)]"
            />
          </li>
        </ul>
      </section>

      <ConversationList
        :conversations="conversations"
        :archived="archived"
        :selected="chat?.conversationId ?? null"
        :rename="store.rename"
        @open="openConversation"
        @archive="store.archive"
        @purge="store.purge"
      />

      <p v-if="status !== null" class="mt-auto px-1.5 font-mono text-[10px] leading-relaxed text-muted">
        Gateway attivo ·
        <template v-if="status.gateway.privateOut === 0">nessun dato L2/L3 è uscito oggi</template>
        <span v-else class="text-danger">{{ status.gateway.privateOut }} uscite L2/L3 oggi: controlla il registro</span>
      </p>
    </aside>
    <div v-if="showSidebar" class="fixed inset-0 z-20 bg-black/50 md:hidden" aria-hidden="true" @click="showSidebar = false" />

    <!-- Main -->
    <main class="flex min-h-0 min-w-0 flex-col">
      <header class="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-line bg-bg/85 px-4 backdrop-blur-sm md:px-5.5">
        <button
          type="button"
          class="grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 md:hidden"
          aria-label="Apri il menu"
          @click="showSidebar = true"
        >
          <Icon name="menu" />
        </button>
        <button
          type="button"
          class="hidden size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 text-muted hover:text-ink md:grid"
          :aria-label="layout.sidebar ? 'Mostra le conversazioni' : 'Nascondi le conversazioni'"
          :title="layout.sidebar ? 'Mostra le conversazioni' : 'Nascondi le conversazioni'"
          :aria-expanded="!layout.sidebar"
          @click="layout.sidebar = !layout.sidebar"
        >
          <Icon :name="layout.sidebar ? 'sidebar-expand' : 'sidebar-collapse'" />
        </button>
        <p class="min-w-0 flex-1 truncate text-[12.5px] text-muted">
          <template v-if="current !== undefined">
            <span v-for="part in crumb" :key="part">{{ part }} / </span>
            <b class="font-medium text-ink">{{ current.title ?? 'Nuova conversazione' }}</b>
          </template>
          <template v-else>Arianna</template>
        </p>
        <span v-if="current !== undefined" class="lab" :class="labelClass[current.clearance]" :title="LABEL_TEXT[current.clearance]">
          {{ current.clearance }} · {{ current.mode === 'work' ? 'può uscire' : 'resta qui' }}
        </span>
        <span class="hidden font-mono text-[11px] tracking-[0.08em] whitespace-nowrap text-muted sm:inline">{{ clockText }}</span>
        <button
          type="button"
          class="relative grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 xl:hidden"
          :aria-label="showPanel ? 'Chiudi il pannello di stato' : 'Apri il pannello di stato'"
          @click="showPanel = !showPanel"
        >
          <Icon name="panel" />
          <span
            v-if="elsewhere.length > 0"
            class="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-warn px-1 font-mono text-[10px] leading-4 font-semibold text-accent-ink"
          >{{ elsewhere.length }}</span>
        </button>
        <button
          type="button"
          class="relative hidden size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 text-muted hover:text-ink xl:grid"
          :aria-label="layout.panel ? 'Mostra il pannello di stato' : 'Nascondi il pannello di stato'"
          :title="layout.panel ? 'Mostra il pannello di stato' : 'Nascondi il pannello di stato'"
          :aria-expanded="!layout.panel"
          @click="layout.panel = !layout.panel"
        >
          <Icon :name="layout.panel ? 'panel-expand' : 'panel-collapse'" />
          <span
            v-if="layout.panel && elsewhere.length > 0"
            class="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-warn px-1 font-mono text-[10px] leading-4 font-semibold text-accent-ink"
          >{{ elsewhere.length }}</span>
        </button>
      </header>

      <p v-if="error !== null" role="alert" class="mx-4 mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
        {{ error }}
      </p>

      <ChatView
        v-if="chat !== null && current !== undefined"
        class="min-h-0 flex-1"
        :chat="chat"
        :conversation="current"
        :tasks="tasks"
        :sending="sending"
        :models="models"
        :approvals="inChat"
        :decide="store.decide"
        :arianna="{ choice: characters?.agents.arianna, pose: poseFor('arianna') }"
        :status="status"
        @send="store.send"
        @choose-model="store.chooseModel"
        @restore="store.archive(current.id, false)"
      />
      <div v-else class="flex flex-1 items-center justify-center p-8 text-center">
        <div class="flex max-w-sm flex-col items-center gap-4">
          <PixelAgent :choice="characters?.agents.arianna" :pose="poseFor('arianna')" :scale="3" bubble label="Arianna" />
          <p class="font-hud text-lg font-semibold tracking-[0.05em]">Apri o crea una conversazione</p>
          <p class="text-sm text-muted">
            Una conversazione <strong class="text-ink">privata</strong> resta sul modello locale; una <strong class="text-ink">di lavoro</strong> può usare
            il cloud ma non vede dati privati.
          </p>
        </div>
      </div>
    </main>

    <!-- Status panel: on the right on wide screens, a drawer otherwise -->
    <StatusPanel
      class="fixed inset-y-0 right-0 z-30 w-[min(320px,90vw)] transition-transform xl:static xl:z-auto xl:w-auto xl:translate-x-0"
      :class="[showPanel ? 'translate-x-0' : 'translate-x-full', { 'xl:hidden': layout.panel }]"
      :status="status"
      :characters="characters"
      :agent-ids="agentIds"
      :pose-for="poseFor"
      :approvals="elsewhere"
      :remote-decisions="remoteDecisions"
      :decide="store.decide"
      @dismiss="store.dismissDecision"
      @refresh-characters="store.refreshCharacters"
      @close="showPanel = false"
    />
    <div v-if="showPanel" class="fixed inset-0 z-20 bg-black/50 xl:hidden" aria-hidden="true" @click="showPanel = false" />
  </div>
</template>
