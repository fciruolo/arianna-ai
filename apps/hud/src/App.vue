<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import CallView from './components/CallView.vue';
import ChatView from './components/ChatView.vue';
import IncomingCall from './components/IncomingCall.vue';
import KnowledgePage from './components/KnowledgePage.vue';
import ConversationList from './components/ConversationList.vue';
import FailureDialog from './components/FailureDialog.vue';
import Icon from './components/Icon.vue';
import NewConversation from './components/NewConversation.vue';
import PixelAgent from './components/PixelAgent.vue';
import SettingsPage from './components/SettingsPage.vue';
import StatusPanel from './components/StatusPanel.vue';
import ThoughtsPage from './components/ThoughtsPage.vue';
import VoiceTrial from './components/VoiceTrial.vue';
import { callBlocker, inAnHour, localDateTime } from './lib/calls.ts';
import type { CommandAction } from './lib/commands.ts';
import { agentName } from './lib/italian.ts';
import { LABEL_TEXT, MODE_TEXT } from './lib/labels.ts';
import { gridColumns, loadLayout, saveLayout } from './lib/layout.ts';
import {
  conversationFromPath,
  documentTitle,
  isKnowledgePath,
  isSettingsPath,
  isThoughtsPath,
  isVoiceTrialPath,
  KNOWLEDGE_PATH,
  knowledgeFocus,
  knowledgePathFor,
  pathFor,
  SETTINGS_PATH,
  THOUGHTS_PATH,
  VOICE_TRIAL_PATH,
} from './lib/route.ts';
import { conversationState, poseOf, POSE_TEXT, type Pose } from './lib/sprites.ts';
import { loadTheme, nextTheme, saveTheme, THEME_TEXT, themeAttribute, type Theme } from './lib/theme.ts';
import type { Activity, Approval } from './lib/types.ts';
import { createChatStore } from './store.ts';

const store = createChatStore();
const { conversations, archived, systemChats, failure, chat, current, tasks, credits, activityCounts, approvals, models, projects, remoteDecisions, status, characters, live, error, sending, notice } = store;
const { calls, voiceState, callSession, callStarting, callError, strayCall, incoming } = store;

// "Chiamami alle…" (D-066): a small form under the clock button.
const showSchedule = ref(false);
const scheduleAt = ref('');
function openSchedule(): void {
  scheduleAt.value = inAnHour();
  showSchedule.value = !showSchedule.value;
}
async function confirmSchedule(): Promise<void> {
  const at = localDateTime(scheduleAt.value);
  if (at === undefined) return;
  if (await store.scheduleCall(at)) showSchedule.value = false;
}

// Calls (D-066): the phone in the top bar calls Arianna from the open conversation.
const callBlocked = computed(() =>
  current.value === undefined ? 'Apri una conversazione' : callBlocker(voiceState.value, current.value.archivedAt !== null, callSession.value !== null),
);

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

// The voice trial page (D-066) and the settings page (D-071) have an address of their own and replace the chat.
const page = ref<'chat' | 'voice-trial' | 'settings' | 'knowledge' | 'thoughts'>('chat');

function openPage(name: 'voice-trial' | 'settings' | 'knowledge' | 'thoughts', path: string, title: string): void {
  showSidebar.value = false;
  page.value = name;
  if (chat.value !== null) store.close();
  if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path);
  document.title = documentTitle(title);
}

function openVoiceTrial(): void {
  openPage('voice-trial', VOICE_TRIAL_PATH, 'Provino della voce');
}

function openSettings(): void {
  openPage('settings', SETTINGS_PATH, 'Impostazioni');
}

/** The node the knowledge page selects when it opens (D-090: "Apri nel grafo"). */
const knowledgeNode = ref<string | undefined>(undefined);

/** The graph of the knowledge base (D-087), with a node selected when given. */
function openKnowledge(nodeId?: string): void {
  knowledgeNode.value = nodeId;
  openPage('knowledge', nodeId === undefined ? KNOWLEDGE_PATH : knowledgePathFor(nodeId), 'Conoscenza');
}

/** The thoughts (D-090). */
function openThoughts(): void {
  openPage('thoughts', THOUGHTS_PATH, 'Pensieri');
}

/** A "/" command of the chat (D-090). */
function runCommand(action: Exclude<CommandAction, { kind: 'note' | 'help' | 'search' }>): void {
  if (action.kind === 'new-conversation') {
    const conversation = current.value;
    if (conversation === undefined) return;
    const project = projects.value.find((entry) => entry.path === conversation.workspace)?.name;
    // A work conversation on a project no longer approved: say so, never open one without it silently.
    if (conversation.mode === 'work' && conversation.workspace !== null && project === undefined) {
      error.value = 'Il progetto di questa conversazione non è più fra quelli approvati: apri la nuova conversazione dal pulsante e scegli il progetto.';
      return;
    }
    void createConversation(conversation.mode, conversation.mode === 'work' ? project : undefined);
    return;
  }
  if (action.page === 'thoughts') openThoughts();
  else if (action.page === 'knowledge') openKnowledge();
  else openSettings();
}

/** A save of the settings page: the chat shows the new characters and projects (models follow the live feed). */
function settingsChanged(sections: string[]): void {
  if (sections.includes('characters')) void store.refreshCharacters();
  if (sections.includes('projects')) void store.refreshProjects();
  if (sections.includes('voice')) void store.refreshVoice();
}

// The address follows the open conversation (/c/<id>), so a reload comes back to it.
function followAddress(): void {
  if (isVoiceTrialPath(window.location.pathname)) {
    openVoiceTrial();
    return;
  }
  if (isSettingsPath(window.location.pathname)) {
    openSettings();
    return;
  }
  if (isKnowledgePath(window.location.pathname)) {
    openKnowledge(knowledgeFocus(window.location.search));
    return;
  }
  if (isThoughtsPath(window.location.pathname)) {
    openThoughts();
    return;
  }
  page.value = 'chat';
  const id = conversationFromPath(window.location.pathname);
  if (id === undefined) {
    if (chat.value !== null) store.close();
    if (window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  } else if (chat.value?.conversationId !== id) {
    void store.open(id);
  }
}
watch(
  () => chat.value?.conversationId ?? null,
  (id) => {
    if (id !== null) page.value = 'chat';
    else if (page.value !== 'chat') return;
    const path = pathFor(id);
    if (window.location.pathname === path) return;
    if (id === null) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  },
);
watch(
  () => current.value?.title,
  (title) => {
    if (page.value === 'chat') document.title = documentTitle(title);
  },
  { immediate: true },
);

onMounted(() => {
  followAddress();
  window.addEventListener('popstate', followAddress);
  store.start();
  clock = window.setInterval(() => {
    now.value = new Date();
  }, 15_000);
});
onBeforeUnmount(() => {
  window.removeEventListener('popstate', followAddress);
  store.stop();
  window.clearInterval(clock);
});

async function openConversation(id: string): Promise<void> {
  showSidebar.value = false;
  page.value = 'chat';
  await store.open(id);
}

async function createConversation(mode: 'work' | 'private', project?: string): Promise<void> {
  showSidebar.value = false;
  page.value = 'chat';
  await store.create(mode, project);
}

function openChat(): void {
  if (page.value === 'chat') return;
  page.value = 'chat';
  window.history.pushState(null, '', '/');
  document.title = documentTitle(undefined);
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

/** Arianna in the header of the open conversation: its tasks only, not the whole core. */
const ariannaHere = computed<Pose>(() => poseOf(conversationState(Object.values(tasks.value), chat.value?.conversationId, approvals.value), activeLine.value));

/** Approvals of the open conversation's tasks are shown in the chat; the others in the panel. */
const inChat = computed(() => approvals.value.filter((approval) => approval.taskId !== null && approval.taskId in tasks.value));
const elsewhere = computed<Approval[]>(() => approvals.value.filter((approval) => !inChat.value.includes(approval)));

const crumb = computed(() => {
  const conversation = current.value;
  if (conversation === undefined) return [];
  const project = conversation.workspace?.split('/').at(-1);
  return [...(conversation.origin === 'system' ? ['Chat di sistema'] : []), MODE_TEXT[conversation.mode], ...(project === undefined ? [] : [project])];
});

const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };
</script>

<template>
  <div class="grid h-full grid-cols-1" :class="gridColumns(layout)">
    <!-- Icon rail -->
    <nav class="hidden flex-col items-center gap-1.5 border-r border-line bg-surface py-3.5 md:flex" aria-label="Sezioni">
      <!-- The logo: the A of the name, as in the sidebar; it also folds the sidebar away. -->
      <button
        type="button"
        class="mb-2.5 grid size-9 place-items-center rounded-[9px] font-hud text-[24px] leading-none font-semibold text-accent hover:bg-surface-2"
        :aria-label="layout.sidebar ? 'Mostra le conversazioni' : 'Nascondi le conversazioni'"
        :title="layout.sidebar ? 'Mostra le conversazioni' : 'Nascondi le conversazioni'"
        :aria-expanded="!layout.sidebar"
        @click="layout.sidebar = !layout.sidebar"
      >
        A
      </button>
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border"
        :class="page === 'chat' ? 'border-line-strong bg-surface-2 text-accent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink'"
        aria-label="Chat"
        title="Chat"
        :aria-current="page === 'chat' ? 'page' : undefined"
        @click="openChat"
      >
        <Icon name="chat" />
      </button>
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border"
        :class="page === 'knowledge' ? 'border-line-strong bg-surface-2 text-accent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink'"
        aria-label="Conoscenza"
        title="Conoscenza"
        :aria-current="page === 'knowledge' ? 'page' : undefined"
        @click="openKnowledge()"
      >
        <Icon name="knowledge" />
      </button>
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border"
        :class="page === 'thoughts' ? 'border-line-strong bg-surface-2 text-accent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink'"
        aria-label="Pensieri"
        title="Pensieri"
        :aria-current="page === 'thoughts' ? 'page' : undefined"
        @click="openThoughts"
      >
        <Icon name="thoughts" />
      </button>
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border"
        :class="page === 'voice-trial' ? 'border-line-strong bg-surface-2 text-accent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink'"
        aria-label="Provino della voce"
        title="Provino della voce"
        :aria-current="page === 'voice-trial' ? 'page' : undefined"
        @click="openVoiceTrial"
      >
        <Icon name="mic" />
      </button>
      <button
        type="button"
        class="grid size-[38px] place-items-center rounded-[9px] border"
        :class="page === 'settings' ? 'border-line-strong bg-surface-2 text-accent' : 'border-transparent text-muted hover:bg-surface-2 hover:text-ink'"
        aria-label="Impostazioni"
        title="Impostazioni"
        :aria-current="page === 'settings' ? 'page' : undefined"
        @click="openSettings"
      >
        <Icon name="settings" />
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
      <!-- On narrow screens the icon rail is hidden: the voice trial is reached from here. -->
      <button type="button" class="btn md:hidden" @click="openKnowledge()"><Icon name="knowledge" :size="16" />Conoscenza</button>
      <button type="button" class="btn md:hidden" @click="openThoughts"><Icon name="thoughts" :size="16" />Pensieri</button>
      <button type="button" class="btn md:hidden" @click="openVoiceTrial"><Icon name="mic" :size="16" />Provino della voce</button>
      <button type="button" class="btn md:hidden" @click="openSettings"><Icon name="settings" :size="16" />Impostazioni</button>

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
        :system="systemChats"
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
          <template v-else-if="page === 'voice-trial'">Voce / <b class="font-medium text-ink">Provino</b></template>
          <template v-else-if="page === 'settings'">Arianna / <b class="font-medium text-ink">Impostazioni</b></template>
          <template v-else-if="page === 'knowledge'">Arianna / <b class="font-medium text-ink">Conoscenza</b></template>
          <template v-else-if="page === 'thoughts'">Arianna / <b class="font-medium text-ink">Pensieri</b></template>
          <template v-else>Arianna</template>
        </p>
        <span v-if="current !== undefined" class="lab" :class="labelClass[current.clearance]" :title="LABEL_TEXT[current.clearance]">
          {{ current.clearance }} · {{ current.mode === 'work' ? 'può uscire' : 'resta qui' }}
        </span>
        <button
          v-if="current !== undefined && page === 'chat'"
          type="button"
          class="grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 text-accent disabled:text-muted disabled:opacity-60"
          :disabled="callBlocked !== undefined || callStarting"
          :aria-label="callBlocked ?? 'Chiama Arianna'"
          :title="callBlocked ?? 'Chiama Arianna'"
          @click="store.startCall"
        >
          <Icon name="phone" />
        </button>
        <div v-if="current !== undefined && page === 'chat'" class="relative">
          <button
            type="button"
            class="grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 text-muted hover:text-ink disabled:opacity-60"
            :disabled="voiceState === 'off' || current.archivedAt !== null"
            aria-label="Fatti chiamare da Arianna più tardi"
            title="Fatti chiamare da Arianna più tardi"
            :aria-expanded="showSchedule"
            @click="openSchedule"
          >
            <Icon name="clock" />
          </button>
          <form v-if="showSchedule" class="hud-card absolute top-11 right-0 z-40 flex w-64 flex-col gap-2 bg-surface p-3 text-sm" @submit.prevent="confirmSchedule">
            <label class="flex flex-col gap-1">
              Arianna ti chiama alle
              <input v-model="scheduleAt" type="datetime-local" required class="rounded-md border border-line bg-surface-2 px-2 py-1" />
            </label>
            <p class="text-xs text-muted">Anche nelle fasce di silenzio; conta nel massimo di chiamate al giorno.</p>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn px-2.5 py-1 text-xs" @click="showSchedule = false">Annulla</button>
              <button type="submit" class="btn btn-primary px-2.5 py-1 text-xs">Programma</button>
            </div>
          </form>
        </div>
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
      <p v-if="notice !== null" role="status" class="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm">
        <Icon name="saved" :size="14" />
        <span class="flex-1 font-mono text-xs">{{ notice }}</span>
        <button type="button" class="rounded-md p-1 hover:bg-surface-2" aria-label="Chiudi" @click="notice = null"><Icon name="close" :size="14" /></button>
      </p>
      <p v-if="callError !== null" role="alert" class="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span class="flex-1">{{ callError }}</span>
        <button type="button" class="rounded-md p-1 hover:bg-danger/20" aria-label="Chiudi" @click="callError = null"><Icon name="close" :size="14" /></button>
      </p>
      <p v-if="callStarting" class="mx-4 mt-3 text-sm text-muted" aria-live="polite">Chiamo Arianna… la prima volta i modelli si caricano.</p>
      <p v-if="strayCall !== null && callSession === null" role="status" class="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
        <Icon name="phone" :size="14" />
        <span class="flex-1">Una chiamata risulta ancora aperta (forse da una pagina chiusa o ricaricata).</span>
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="store.closeStrayCall">Chiudila</button>
      </p>

      <VoiceTrial v-if="page === 'voice-trial'" />
      <SettingsPage v-else-if="page === 'settings'" @changed="settingsChanged" />
      <KnowledgePage v-else-if="page === 'knowledge'" :focus="knowledgeNode" />
      <ThoughtsPage v-else-if="page === 'thoughts'" @open-graph="openKnowledge" />
      <ChatView
        v-else-if="chat !== null && current !== undefined"
        class="min-h-0 flex-1"
        :chat="chat"
        :conversation="current"
        :tasks="tasks"
        :credits="credits"
        :activity-counts="activityCounts"
        :sending="sending"
        :models="models"
        :approvals="inChat"
        :decide="store.decide"
        :arianna="{ choice: characters?.agents.arianna, pose: ariannaHere }"
        :status="status"
        :calls="calls"
        @send="store.send"
        @save-to-inbox="store.saveToInbox"
        @call-when-done="store.callWhenDone"
        @cancel-call="store.cancelScheduled"
        @choose-model="store.chooseModel"
        @restore="store.archive(current.id, false)"
        @explain="store.explain"
        @retry="store.retry"
        @attach-question="store.attachQuestion"
        @open="openConversation"
        @command="runCommand"
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
      @open="(id) => { showPanel = false; void openConversation(id); }"
    />
    <div v-if="showPanel" class="fixed inset-0 z-20 bg-black/50 xl:hidden" aria-hidden="true" @click="showPanel = false" />

    <IncomingCall
      v-if="incoming !== null && callSession === null"
      :reason="incoming.reason"
      :title="conversations.find((item) => item.id === incoming?.conversationId)?.title ?? 'Conversazione'"
      :choice="characters?.agents.arianna"
      @answer="store.answerIncoming"
      @decline="store.declineIncoming"
    />
    <CallView
      v-if="callSession !== null"
      :session="callSession"
      :title="conversations.find((item) => item.id === callSession?.call.conversationId)?.title ?? 'Chiamata'"
      :messages="chat?.conversationId === callSession.call.conversationId ? chat.messages : []"
      :choice="characters?.agents.arianna"
      @hang-up="store.hangUp"
    />

    <FailureDialog
      v-if="failure !== null"
      :task="failure.task"
      :failure="failure.error"
      :loading="failure.loading"
      :claude-answers="failure.claudeAnswers"
      @close="store.closeFailure"
      @retry="store.retry"
      @chat="store.openSystemChat"
    />
  </div>
</template>
