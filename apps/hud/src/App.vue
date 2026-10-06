<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import CallView from './components/CallView.vue';
import ChatView from './components/ChatView.vue';
import IncognitoClosed from './components/IncognitoClosed.vue';
import IncognitoEndDialog from './components/IncognitoEndDialog.vue';
import IncomingCall from './components/IncomingCall.vue';
import NoticeToasts from './components/NoticeToasts.vue';
import KnowledgePage from './components/KnowledgePage.vue';
import DraftChat from './components/DraftChat.vue';
import FailureDialog from './components/FailureDialog.vue';
import Icon from './components/Icon.vue';
import InstallationBadge from './components/InstallationBadge.vue';
import LabelLegend from './components/LabelLegend.vue';
import NewConversationDialog from './components/NewConversationDialog.vue';
import OfficePage from './components/OfficePage.vue';
import ProjectsPage from './components/ProjectsPage.vue';
import PixelAgent from './components/PixelAgent.vue';
import SearchDialog from './components/SearchDialog.vue';
import ChangelogPage from './components/ChangelogPage.vue';
import NewAgentPage from './components/NewAgentPage.vue';
import DevProgressPage from './components/DevProgressPage.vue';
import SettingsPage from './components/SettingsPage.vue';
import SideBar from './components/SideBar.vue';
import StatusPanel from './components/StatusPanel.vue';
import ThoughtsPage from './components/ThoughtsPage.vue';
import VoiceTrial from './components/VoiceTrial.vue';
import { loadDevPending, loadInstallation } from './lib/api.ts';
import { pendingText } from './lib/dev-progress.ts';
import { callBlocker, inAnHour, localDateTime } from './lib/calls.ts';
import { FOCUS_EVENT, messageAnchor, requestFocus } from './lib/chat-focus.ts';
import type { CommandAction } from './lib/commands.ts';
import { draftFromAddress, draftPath, draftProjectProblem, sameChoice, type DraftChoice } from './lib/draft.ts';
import { entryFromState, INCOGNITO_PATH, incognitoState, isIncognitoPath, splitApprovals, withoutIncognito, type IncognitoEntry } from './lib/incognito.ts';
import { markTitle, type InstallationInfo } from './lib/installation.ts';
import { LABEL_TEXT, MODE_TEXT } from './lib/labels.ts';
import type { SearchTarget } from './lib/search.ts';
import { isProjectsPath, PROJECTS_PATH } from './lib/projects.ts';
import { callTarget } from './lib/sidebar.ts';
import { gridColumns, loadLayout, saveLayout } from './lib/layout.ts';
import {
  CHANGELOG_PATH,
  conversationFromPath,
  DEV_PATH,
  documentTitle,
  isChangelogPath,
  isDevPath,
  isKnowledgePath,
  isNewAgentPath,
  isOfficePath,
  isSettingsPath,
  isThoughtsPath,
  isVoiceTrialPath,
  KNOWLEDGE_PATH,
  knowledgeFocus,
  knowledgePathFor,
  NEW_AGENT_PATH,
  OFFICE_PATH,
  pathFor,
  settingsPathFor,
  settingsSlug,
  THOUGHTS_PATH,
  VOICE_TRIAL_PATH,
} from './lib/route.ts';
import { conversationState, poseOf, type Pose } from './lib/sprites.ts';
import { loadTheme, saveTheme, themeAttribute, type Theme } from './lib/theme.ts';
import type { Activity, Approval } from './lib/types.ts';
import { createChatStore } from './store.ts';

const store = createChatStore();
const { officeSignals, conversations, archived, systemChats, failure, chat, draft, current, tasks, credits, activityCounts, approvals, participants, models, projects, directAgents, remoteDecisions, status, characters, live, error, sending, notice, toasts } = store;
const { calls, voiceState, callSession, callStarting, callError, strayCall, incoming } = store;
const { incognitoEnd, incognitoSoon, ending } = store;

/** The open conversation is incognito (D-136): dark header, "Termina", the address `/incognito`. */
const incognitoOpen = computed(() => current.value?.incognito === true);
/** The dark header: on an incognito conversation, its draft, or the card of one that closed. */
const incognitoHeader = computed(() => page.value === 'chat' && (incognitoOpen.value || draft.value?.incognito === true || incognitoEnd.value !== null));
const incognitoMode = computed(() => (incognitoOpen.value ? current.value?.mode : draft.value?.incognito === true ? draft.value.mode : undefined));
/** The project by name, as the core's notice and "+ Nuovo" call it; the folder's name when it is no longer approved. */
const incognitoProject = computed(() => {
  if (draft.value?.incognito === true) return draft.value.project;
  const workspace = incognitoOpen.value ? current.value?.workspace : undefined;
  if (workspace === undefined || workspace === null) return undefined;
  return projects.value.find((entry) => entry.path === workspace)?.name ?? workspace.split('/').at(-1);
});
/** "Termina" asks first. */
const showEnd = ref(false);
async function confirmEnd(): Promise<void> {
  await store.endIncognito();
  showEnd.value = false;
}
/** The address of an incognito conversation or draft (D-136): always `/incognito`, the rest in the state of the entry. */
function writeIncognito(entry: IncognitoEntry, how: 'push' | 'replace'): void {
  if (how === 'push') window.history.pushState(incognitoState(entry), '', INCOGNITO_PATH);
  else window.history.replaceState(incognitoState(entry), '', INCOGNITO_PATH);
}
/** From the card of a closed incognito conversation: the list, a new entry, so "back" finds it closed. */
function leaveClosed(): void {
  store.close();
  window.history.pushState(null, '', '/');
  setTitle(undefined);
}

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

// Calls (D-066): "Chiama" of the left bar (D-097) calls Arianna in the open private conversation, or in a new private one.
const callBlocked = computed(() => callBlocker(voiceState.value, false, callSession.value !== null));

/** True from the click on "Chiama" until the call started or failed: a second click does nothing. */
const calling = ref(false);

async function callArianna(): Promise<void> {
  if (callBlocked.value !== undefined || calling.value || callStarting.value) return;
  calling.value = true;
  try {
    const target = callTarget(current.value, page.value === 'chat');
    if (target === 'new') {
      const before = chat.value?.conversationId;
      await createConversation('private');
      // The core refused the new conversation: no call in the one that was open.
      if (chat.value === null || chat.value.conversationId === before) return;
    } else if (chat.value?.conversationId !== target.here) {
      return;
    }
    showSidebar.value = false;
    await store.startCall();
  } finally {
    calling.value = false;
  }
}

// Drawers on narrow screens; collapsed bars on wide ones, remembered in this browser (D-097).
const showSidebar = ref(false);
const showPanel = ref(false);
let storage: Storage | undefined;
try {
  storage = typeof window === 'undefined' ? undefined : window.localStorage;
} catch {
  // Blocked storage: the bars open at every load.
  storage = undefined;
}
const layout = ref(loadLayout(storage));
watch(layout, (value) => saveLayout(storage, value), { deep: true });

/** Wide enough for the bar to be a column (Tailwind md, xl) rather than a drawer. */
function wide(rem: number): boolean {
  return typeof window !== 'undefined' && window.matchMedia(`(min-width: ${String(rem)}rem)`).matches;
}
/** Followed live: a closed drawer is inert (out of Tab and of screen readers), a column never. */
const wideSidebar = ref(wide(48));
const widePanel = ref(wide(80));
function measureWidth(): void {
  wideSidebar.value = wide(48);
  widePanel.value = wide(80);
}

/** The fold button of the left bar: a thin column on wide screens, the drawer closes on narrow ones. */
function foldSidebar(): void {
  if (wide(48)) layout.value.sidebar = true;
  showSidebar.value = false;
}

/** The right bar: a column from xl, a drawer below. */
function openPanel(): void {
  showSidebar.value = false;
  if (wide(80)) layout.value.panel = false;
  else showPanel.value = true;
}
function closePanel(): void {
  if (wide(80)) layout.value.panel = true;
  showPanel.value = false;
}

// "Cerca" (D-097) and "+ Nuovo": windows in the middle of the page.
const showSearch = ref(false);
/** The legend of the labels (etichette parlanti): from the header and from the foot of the chat. */
const showLegend = ref(false);
const showNew = ref(false);
/** The agent "+ Nuovo" opens on ("Apri una chat" in Impostazioni → Agenti, D-133); undefined: the usual first choice. */
const newWith = ref<string | undefined>(undefined);
function openSearch(): void {
  showSidebar.value = false;
  showSearch.value = true;
}
function openNew(agent?: string): void {
  showSidebar.value = false;
  void store.refreshProjects();
  newWith.value = agent;
  showNew.value = true;
}
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** ⌘K on the Mac, Ctrl+K elsewhere, opens "Cerca"; never over another window or during a call. */
function onShortcut(event: KeyboardEvent): void {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
  if (showSearch.value || showNew.value || callSession.value !== null || incoming.value !== null) return;
  if (document.querySelector('[aria-modal="true"]') !== null) return;
  event.preventDefault();
  openSearch();
}
/** After a choice in "Cerca" or "Nuovo": the focus goes to the field of the chat, once it is on the page. */
function focusComposer(): void {
  let tries = 0;
  const look = (): void => {
    const field = document.getElementById('composer');
    if (field instanceof HTMLTextAreaElement && !field.disabled) {
      field.focus();
      return;
    }
    if (++tries < 20) window.setTimeout(look, 100);
    // No field after 2 s (a page without one, an archived conversation): the main area takes the focus.
    else document.getElementById('main')?.focus();
  };
  window.setTimeout(look, 0);
}
/** "Nuovo" and "/nuova" (D-108): a draft only in the page; the conversation is created with the first message. */
function openDraft(choice: DraftChoice, replace = false): void {
  showSidebar.value = false;
  page.value = 'chat';
  store.openDraft(choice);
  if (choice.incognito === true) {
    // The choice in the state of the entry, never in the address; a draft's entry is taken over, as below.
    const entry: IncognitoEntry = { draft: { mode: choice.mode, ...(choice.mode === 'work' && choice.project !== undefined ? { project: choice.project } : {}) } };
    const here = entryFromState(window.history.state);
    const onDraft =
      draftFromAddress(window.location.pathname, window.location.search) !== undefined || (isIncognitoPath(window.location.pathname) && here !== undefined && 'draft' in here);
    writeIncognito(entry, replace || onDraft ? 'replace' : 'push');
    setTitle('Incognito');
    focusComposer();
    return;
  }
  const path = draftPath(choice);
  if (`${window.location.pathname}${window.location.search}` !== path) {
    if (replace) window.history.replaceState(null, '', path);
    // A conversation born from a draft takes the place of the draft in the history: "back" does not reopen an empty draft.
    else if (draftFromAddress(window.location.pathname, window.location.search) !== undefined) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  }
  setTitle('Nuova conversazione');
  focusComposer();
}
/** A result of "Cerca": a conversation (and the message in it) or a node of the knowledge graph. */
function goTo(target: SearchTarget): void {
  if ('graph' in target) {
    openKnowledge(target.graph);
    return;
  }
  if (target.message !== undefined) {
    requestFocus(target.conversation, messageAnchor(target.message));
    window.dispatchEvent(new Event(FOCUS_EVENT));
  }
  void openConversation(target.conversation).then(() => {
    // A message to bring into view keeps the scroll of the chat: the field still takes the focus.
    focusComposer();
  });
}

// What this installation is (D-098): SVILUPPO or PRODUZIONE in the top bar, "[DEV]" in the tab.
const installation = ref<InstallationInfo | undefined>(undefined);
let titleBase: string | null | undefined;
function setTitle(title: string | null | undefined): void {
  titleBase = title;
  document.title = markTitle(documentTitle(title), installation.value?.mode);
}
watch(installation, () => setTitle(titleBase));
function readInstallation(): void {
  loadInstallation()
    .then((info) => {
      installation.value = info;
    })
    .catch(() => undefined);
}
// The core may not have answered at the start (restarting): read again when the link is back.
watch(live, (state) => {
  if (state === 'open' && installation.value === undefined) readInstallation();
});

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
const page = ref<'chat' | 'voice-trial' | 'settings' | 'knowledge' | 'thoughts' | 'dev' | 'changelog' | 'office' | 'new-agent' | 'projects'>('chat');

function openPage(name: 'voice-trial' | 'settings' | 'knowledge' | 'thoughts' | 'dev' | 'changelog' | 'office' | 'new-agent' | 'projects', path: string, title: string): void {
  showSidebar.value = false;
  page.value = name;
  if (chat.value !== null || draft.value !== null || incognitoEnd.value !== null) store.close();
  if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path);
  setTitle(title);
}

function openVoiceTrial(): void {
  openPage('voice-trial', VOICE_TRIAL_PATH, 'Provino della voce');
}

/** "Sviluppo di Arianna" (D-102), reached from the settings. */
function openDevProgress(): void {
  openPage('dev', DEV_PATH, 'Sviluppo di Arianna');
}

/**
 * Questions of "Sviluppo di Arianna" that wait for an answer (D-120): a dot on
 * "Impostazioni" and on the entry of the index. Only the number comes from the
 * core; read at the start, when the link is back and at every change of page,
 * and from the page itself after an answer. A core without the page gives 0.
 */
const devPending = ref(0);
/** With the left bar closed or folded, its button carries a plain dot and this text. */
const devPendingText = computed(() => pendingText(devPending.value));
function readDevPending(): void {
  loadDevPending()
    .then((count) => {
      devPending.value = count;
    })
    .catch(() => undefined);
}
watch(page, readDevPending);
watch(live, (state) => {
  if (state === 'open') readDevPending();
});

/** "Nuovo agente" (D-119, tappa T3), reached from the Agents section of the settings. */
function openNewAgent(): void {
  openPage('new-agent', NEW_AGENT_PATH, 'Nuovo agente');
}

/** "Novità": the register of the versions, reached from the settings. */
function openChangelog(): void {
  openPage('changelog', CHANGELOG_PATH, 'Novità');
}

/** The section of the settings in the address (D-105): `/impostazioni/<slug>`; undefined is the first one. */
const settingsSection = ref<string | undefined>(undefined);
/** The settings hold edits not saved (D-105): the back button of the browser asks before leaving them. */
const settingsDirty = ref(false);

function openSettings(slug?: string): void {
  settingsSection.value = slug;
  openPage('settings', settingsPathFor(slug), 'Impostazioni');
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

/** The office (D-106). */
function openOffice(): void {
  openPage('office', OFFICE_PATH, 'Ufficio');
}

/** An approved project, read only (D-134). */
function openProjects(): void {
  openPage('projects', PROJECTS_PATH, 'Progetti');
}

/** A "/" command of the chat (D-090). */
function runCommand(action: Exclude<CommandAction, { kind: 'note' | 'help' }>): void {
  if (action.kind === 'search') {
    openSearch();
    return;
  }
  if (action.kind === 'new-conversation') {
    const conversation = current.value;
    if (conversation === undefined) return;
    const project = projects.value.find((entry) => entry.path === conversation.workspace)?.name;
    // A work conversation on a project no longer approved: say so, never open one without it silently.
    if (conversation.mode === 'work' && conversation.workspace !== null && project === undefined) {
      error.value = 'Il progetto di questa conversazione non è più fra quelli approvati: apri la nuova conversazione dal pulsante e scegli il progetto.';
      return;
    }
    // From an incognito conversation (D-136), a new one is incognito too.
    const incognito = conversation.incognito === true ? { incognito: true } : {};
    openDraft(
      conversation.mode === 'work'
        ? { mode: 'work', project, ...(conversation.agent !== null && project !== undefined ? { agent: conversation.agent } : {}), ...incognito }
        : { mode: conversation.mode, ...incognito },
    );
    return;
  }
  if (action.page === 'thoughts') openThoughts();
  else if (action.page === 'knowledge') openKnowledge();
  else openSettings();
}

/** A save of the settings page: the chat shows the new characters, projects and agents (models follow the live feed). */
function settingsChanged(sections: string[]): void {
  if (sections.includes('characters')) void store.refreshCharacters();
  if (sections.includes('projects')) void store.refreshProjects();
  if (sections.includes('voice')) void store.refreshVoice();
  // An agent activated or deactivated from the Agents page (D-119): the status panel lists the running ones.
  if (sections.includes('userAgents')) store.refreshStatus().catch(() => undefined);
}

// The address follows the open conversation (/c/<id>), so a reload comes back to it.
function followAddress(): void {
  // Back out of the settings with edits not saved (D-105): ask, and stay when the user says no.
  if (page.value === 'settings' && settingsDirty.value && !isSettingsPath(window.location.pathname)) {
    if (!window.confirm('Ci sono modifiche non salvate nelle Impostazioni: uscendo si perdono. Vuoi uscire?')) {
      window.history.pushState(null, '', settingsPathFor(settingsSection.value));
      return;
    }
  }
  if (isVoiceTrialPath(window.location.pathname)) {
    openVoiceTrial();
    return;
  }
  if (isNewAgentPath(window.location.pathname)) {
    openNewAgent();
    return;
  }
  if (isSettingsPath(window.location.pathname)) {
    openSettings(settingsSlug(window.location.pathname));
    return;
  }
  if (isKnowledgePath(window.location.pathname)) {
    openKnowledge(knowledgeFocus(window.location.search));
    return;
  }
  if (isDevPath(window.location.pathname)) {
    openDevProgress();
    return;
  }
  if (isChangelogPath(window.location.pathname)) {
    openChangelog();
    return;
  }
  if (isThoughtsPath(window.location.pathname)) {
    openThoughts();
    return;
  }
  if (isOfficePath(window.location.pathname)) {
    openOffice();
    return;
  }
  if (isProjectsPath(window.location.pathname)) {
    openProjects();
    return;
  }
  page.value = 'chat';
  // Incognito (D-136): the address never names the conversation; its entry's state does.
  if (isIncognitoPath(window.location.pathname)) {
    const entry = entryFromState(window.history.state);
    if (entry !== undefined && 'conversationId' in entry) {
      if (chat.value?.conversationId !== entry.conversationId) void store.openIncognito(entry.conversationId);
      return;
    }
    // A draft, or the bare address: a new private incognito draft.
    const choice = { ...(entry?.draft ?? { mode: 'private' as const }), incognito: true };
    if (draft.value === null || !sameChoice(draft.value, choice)) openDraft(choice, true);
    return;
  }
  const asked = draftFromAddress(window.location.pathname, window.location.search);
  if (asked !== undefined) {
    // From the address: the same entry of the history, written in its normal form (`/nuova` → `/nuova?tipo=privata`).
    if (draft.value === null || !sameChoice(draft.value, asked)) openDraft(asked, true);
    else if (`${window.location.pathname}${window.location.search}` !== draftPath(asked)) window.history.replaceState(null, '', draftPath(asked));
    return;
  }
  const id = conversationFromPath(window.location.pathname);
  if (id === undefined) {
    if (chat.value !== null || draft.value !== null || incognitoEnd.value !== null) store.close();
    if (window.location.pathname !== '/') window.history.replaceState(null, '', '/');
  } else if (chat.value?.conversationId !== id) {
    void store.open(id);
  }
}
watch(
  () => [chat.value?.conversationId ?? null, current.value !== undefined] as const,
  ([id, known]) => {
    if (id !== null) page.value = 'chat';
    else if (page.value !== 'chat') return;
    // Not yet read (opened by id, in no list): the address waits, so an incognito id never reaches the history (D-136).
    if (id !== null && !known) return;
    // A draft has its own address (/nuova?tipo=…): the root would lose it.
    if (id === null && draft.value !== null) return;
    // The card of a closed incognito conversation stays on its entry: "back" from the list finds it closed (D-136).
    if (id === null && incognitoEnd.value !== null) return;
    // An incognito conversation: `/incognito`, its id only in the entry's state; born from its draft, it takes the draft's entry.
    if (id !== null && incognitoOpen.value) {
      const here = isIncognitoPath(window.location.pathname) ? entryFromState(window.history.state) : undefined;
      if (here !== undefined && 'conversationId' in here && here.conversationId === id) return;
      writeIncognito({ conversationId: id }, here !== undefined && 'draft' in here ? 'replace' : 'push');
      return;
    }
    const path = pathFor(id);
    if (window.location.pathname === path) return;
    if (id === null) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
  },
);
watch(
  () => [current.value?.title, incognitoOpen.value, incognitoEnd.value !== null] as const,
  ([title, incognito, closed]) => {
    if (page.value !== 'chat') return;
    if (incognito || closed || draft.value?.incognito === true) setTitle('Incognito');
    else setTitle(draft.value !== null ? 'Nuova conversazione' : title);
  },
  { immediate: true },
);
// An incognito conversation reached by its id (a link, a notice): the address loses the id at once.
watch(incognitoOpen, (incognito) => {
  const id = chat.value?.conversationId;
  if (incognito && id !== undefined && !isIncognitoPath(window.location.pathname)) writeIncognito({ conversationId: id }, 'replace');
});

onMounted(() => {
  followAddress();
  window.addEventListener('popstate', followAddress);
  window.addEventListener('keydown', onShortcut);
  window.addEventListener('resize', measureWidth);
  store.start();
  readInstallation();
  readDevPending();
  clock = window.setInterval(() => {
    now.value = new Date();
  }, 15_000);
});
onBeforeUnmount(() => {
  window.removeEventListener('popstate', followAddress);
  window.removeEventListener('keydown', onShortcut);
  window.removeEventListener('resize', measureWidth);
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
  if (page.value === 'chat' && draft.value === null && incognitoEnd.value === null) return;
  if (draft.value !== null || incognitoEnd.value !== null) store.close();
  page.value = 'chat';
  window.history.pushState(null, '', '/');
  setTitle(undefined);
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
/** An incognito conversation's approvals only in its own page, never elsewhere nor counted there (D-136). */
const placed = computed(() => splitApprovals(approvals.value, new Set(Object.keys(tasks.value)), chat.value?.conversationId));
const inChat = computed(() => placed.value.inChat);
const elsewhere = computed<Approval[]>(() => placed.value.elsewhere);

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
    <!-- Left bar (D-097): a column on wide screens, a drawer otherwise. -->
    <SideBar
      class="fixed inset-y-0 left-0 z-30 w-[min(290px,86vw)] transition-transform md:static md:z-auto md:w-auto md:translate-x-0"
      :class="[showSidebar ? 'translate-x-0' : '-translate-x-full', { 'md:hidden': layout.sidebar }]"
      :inert="!showSidebar && !wideSidebar"
      :live="live"
      :page="page === 'dev' || page === 'changelog' || page === 'new-agent' ? 'settings' : page"
      :theme="theme"
      :conversations="conversations"
      :archived="archived"
      :system-chats="systemChats"
      :selected="chat?.conversationId ?? null"
      :rename="store.rename"
      :agent-ids="agentIds"
      :characters="characters"
      :pose-for="poseFor"
      :status="status"
      :call-blocked="callBlocked"
      :call-starting="callStarting || calling"
      :dev-pending="devPending"
      @fold="foldSidebar"
      @home="openChat(); showSidebar = false"
      @search="openSearch"
      @create="openNew"
      @thoughts="openThoughts"
      @knowledge="openKnowledge()"
      @office="openOffice"
      @projects="openProjects"
      @call="callArianna"
      @settings="openSettings"
      @theme="(value) => (theme = value)"
      @agents="openPanel"
      @open="openConversation"
      @archive="store.archive"
      @pin="store.pin"
      @purge="store.purge"
    />
    <div v-if="showSidebar" class="fixed inset-0 z-20 bg-black/50 md:hidden" aria-hidden="true" @click="showSidebar = false" />

    <!-- Main -->
    <main id="main" tabindex="-1" class="flex min-h-0 min-w-0 flex-col outline-none">
      <header
        class="flex h-[60px] shrink-0 items-center gap-3.5 border-b px-4 backdrop-blur-sm md:px-5.5"
        :class="incognitoHeader ? 'border-incognito-line bg-incognito text-incognito-ink' : 'border-line bg-bg/85'"
      >
        <button
          type="button"
          class="relative grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 md:hidden"
          :aria-label="devPendingText === null ? 'Apri il menu' : `Apri il menu. ${devPendingText}`"
          @click="showSidebar = true"
        >
          <Icon name="menu" />
          <span v-if="devPendingText !== null" class="absolute -top-1 -right-1 size-2.5 rounded-full bg-accent" aria-hidden="true" />
        </button>
        <!-- Left bar folded (D-097): only its icon, here in the top bar; the page takes the whole width. -->
        <button
          v-if="layout.sidebar"
          type="button"
          class="relative -ml-1.5 hidden size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink md:grid"
          :aria-label="devPendingText === null ? 'Apri la barra' : `Apri la barra. ${devPendingText}`"
          :title="devPendingText === null ? 'Apri la barra' : `Apri la barra. ${devPendingText}`"
          @click="layout.sidebar = false"
        >
          <Icon name="sidebar-expand" />
          <span v-if="devPendingText !== null" class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent" aria-hidden="true" />
        </button>
        <!-- Incognito (D-136): the mask and the word, never a title. -->
        <p v-if="incognitoHeader" class="flex min-w-0 flex-1 items-center gap-2 truncate text-[12.5px]">
          <Icon name="incognito" :size="18" />
          <b class="font-hud text-[13px] font-semibold tracking-[0.08em]">Incognito</b>
          <span v-if="incognitoMode !== undefined" class="truncate opacity-80">· {{ MODE_TEXT[incognitoMode] }}<template v-if="incognitoProject"> · {{ incognitoProject }}</template></span>
        </p>
        <p v-else class="min-w-0 flex-1 truncate text-[12.5px] text-muted">
          <template v-if="current !== undefined">
            <span v-for="part in crumb" :key="part">{{ part }} / </span>
            <b class="font-medium text-ink">{{ current.title ?? 'Nuova conversazione' }}</b>
          </template>
          <template v-else-if="page === 'voice-trial'">Impostazioni / <b class="font-medium text-ink">Provino della voce</b></template>
          <template v-else-if="page === 'settings'">Arianna / <b class="font-medium text-ink">Impostazioni</b></template>
          <template v-else-if="page === 'dev'">Impostazioni / <b class="font-medium text-ink">Sviluppo di Arianna</b></template>
          <template v-else-if="page === 'changelog'">Impostazioni / <b class="font-medium text-ink">Novità</b></template>
          <template v-else-if="page === 'new-agent'">Impostazioni / Agenti / <b class="font-medium text-ink">Nuovo agente</b></template>
          <template v-else-if="page === 'knowledge'">Arianna / <b class="font-medium text-ink">Conoscenza</b></template>
          <template v-else-if="page === 'thoughts'">Arianna / <b class="font-medium text-ink">Pensieri</b></template>
          <template v-else-if="page === 'office'">Arianna / <b class="font-medium text-ink">Ufficio</b></template>
          <template v-else-if="page === 'projects'">Arianna / <b class="font-medium text-ink">Progetti</b></template>
          <template v-else-if="draft !== null">{{ MODE_TEXT[draft.mode] }} / <template v-if="draft.project">{{ draft.project }} / </template><b class="font-medium text-ink">Nuova conversazione</b></template>
          <template v-else>Arianna</template>
        </p>
        <button
          v-if="current !== undefined"
          type="button"
          class="lab inline-flex items-center gap-1"
          :class="labelClass[current.clearance]"
          :title="`${LABEL_TEXT[current.clearance]} · ${current.mode === 'work' ? 'può uscire' : 'resta qui'}: cosa vogliono dire le etichette`"
          :aria-label="`Etichetta ${LABEL_TEXT[current.clearance]}, ${current.mode === 'work' ? 'può uscire' : 'resta qui'}: apri la legenda delle etichette`"
          aria-haspopup="dialog"
          @click="showLegend = true"
        >
          <i class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[current.clearance] }} · {{ current.mode === 'work' ? 'può uscire' : 'resta qui' }}
        </button>
        <button
          v-if="incognitoOpen && page === 'chat'"
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-incognito-line px-2.5 py-1 text-[12.5px] font-medium text-incognito-ink hover:bg-white/10 disabled:opacity-60"
          :disabled="ending"
          title="Termina: Arianna ferma il lavoro in corso e cancella testi, riassunti e attività"
          aria-haspopup="dialog"
          @click="showEnd = true"
        >
          <Icon name="close" :size="14" />{{ ending ? 'Cancello…' : 'Termina' }}
        </button>
        <!-- No call later from an incognito conversation (D-136): the core skips its outgoing calls. -->
        <div v-if="current !== undefined && page === 'chat' && !incognitoOpen" class="relative">
          <button
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-lg text-muted enabled:hover:bg-surface-2 enabled:hover:text-ink disabled:opacity-60"
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
        <InstallationBadge v-if="installation !== undefined" :info="installation" />
        <span class="hidden font-mono text-[11px] tracking-[0.08em] whitespace-nowrap text-muted sm:inline">{{ clockText }}</span>
        <button
          type="button"
          class="relative grid size-9 place-items-center rounded-lg border border-line-strong bg-surface-2 xl:hidden"
          :aria-label="showPanel ? 'Chiudi la barra degli agenti' : 'Apri la barra degli agenti'"
          @click="showPanel = !showPanel"
        >
          <Icon name="panel" />
          <span
            v-if="elsewhere.length > 0"
            class="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-warn px-1 font-mono text-[10px] leading-4 font-semibold text-accent-ink"
          >{{ elsewhere.length }}</span>
        </button>
        <!-- Right bar folded (D-097): only its icon, with what waits elsewhere as a badge. -->
        <button
          v-if="layout.panel"
          type="button"
          class="relative -mr-1.5 hidden size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink xl:grid"
          aria-label="Apri la barra degli agenti"
          title="Apri la barra degli agenti"
          @click="layout.panel = false"
        >
          <Icon name="panel-expand" />
          <span
            v-if="elsewhere.length > 0"
            class="absolute -top-1 -right-1 grid min-w-4 place-items-center rounded-full bg-warn px-1 font-mono text-[10px] leading-4 font-semibold text-accent-ink"
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
      <p v-if="incognitoSoon !== null && (incognitoOpen || draft?.incognito === true)" role="alert" class="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn">
        <Icon name="incognito" :size="14" />
        <span class="flex-1">{{ incognitoSoon }}</span>
      </p>
      <p v-if="callStarting" class="mx-4 mt-3 text-sm text-muted" aria-live="polite">Chiamo Arianna… la prima volta i modelli si caricano.</p>
      <p v-if="strayCall !== null && callSession === null" role="status" class="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
        <Icon name="phone" :size="14" />
        <span class="flex-1">Una chiamata risulta ancora aperta (forse da una pagina chiusa o ricaricata).</span>
        <button type="button" class="btn px-2.5 py-1 text-xs" @click="store.closeStrayCall">Chiudila</button>
      </p>

      <VoiceTrial v-if="page === 'voice-trial'" />
      <SettingsPage v-else-if="page === 'settings'" :installation="installation" :direct-agents="directAgents" :section="settingsSection" :dev-pending="devPending" @section="openSettings" @dirty="settingsDirty = $event" @changed="settingsChanged" @voice-trial="openVoiceTrial" @dev-progress="openDevProgress" @changelog="openChangelog" @new-agent="openNewAgent" @chat="openNew" />
      <DevProgressPage v-else-if="page === 'dev'" @pending="devPending = $event" />
      <ChangelogPage v-else-if="page === 'changelog'" />
      <NewAgentPage v-else-if="page === 'new-agent'" @done="openSettings('agenti')" @changed="settingsChanged(['userAgents', 'characters'])" />
      <KnowledgePage v-else-if="page === 'knowledge'" :focus="knowledgeNode" />
      <ThoughtsPage v-else-if="page === 'thoughts'" @open-graph="openKnowledge" />
      <ProjectsPage v-else-if="page === 'projects'" />
      <OfficePage
        v-else-if="page === 'office'"
        :status="status"
        :approvals="withoutIncognito(approvals)"
        :projects="projects"
        :conversations="conversations"
        :characters="characters"
        :signals="officeSignals"
        @open="openConversation"
        @draft="(mode, project) => openDraft({ mode, project })"
      />
      <IncognitoClosed v-else-if="incognitoEnd !== null" :end="incognitoEnd" @back="leaveClosed" />
      <DraftChat
        v-else-if="draft !== null"
        :key="draft.key"
        :draft="draft"
        :project-problem="draftProjectProblem(draft, projects.length > 0 ? projects.map((entry) => entry.name) : undefined)"
        :sending="sending"
        :send="store.sendDraft"
        :arianna="characters?.agents.arianna"
        :characters="characters?.agents"
        :agents="directAgents"
      />
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
        :participants="participants"
        :characters="characters?.agents"
        :direct-agents="directAgents"
        @send="store.send"
        @remove-participant="store.removeParticipant"
        @call-when-done="store.callWhenDone"
        @cancel-call="store.cancelScheduled"
        @choose-model="store.chooseModel"
        @restore="store.archive(current.id, false)"
        @explain="store.explain"
        @retry="store.retry"
        @attach-question="store.attachQuestion"
        @open="openConversation"
        @command="runCommand"
        @legend="showLegend = true"
        @open-knowledge="openKnowledge"
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
      :inert="!showPanel && !widePanel"
      :status="status"
      :characters="characters"
      :agent-ids="agentIds"
      :pose-for="poseFor"
      :approvals="elsewhere"
      :remote-decisions="remoteDecisions"
      :decide="store.decide"
      @dismiss="store.dismissDecision"
      @refresh-characters="store.refreshCharacters"
      @close="closePanel"
      @open="(id) => { showPanel = false; void openConversation(id); }"
    />
    <div v-if="showPanel" class="fixed inset-0 z-20 bg-black/50 xl:hidden" aria-hidden="true" @click="showPanel = false" />

    <SearchDialog v-if="showSearch" @close="showSearch = false" @go="goTo" />
    <LabelLegend v-if="showLegend" @close="showLegend = false" />
    <IncognitoEndDialog
      v-if="showEnd && incognitoOpen && current !== undefined"
      :mode="current.mode"
      :project="incognitoProject"
      :ending="ending"
      @close="showEnd = false"
      @confirm="confirmEnd"
    />
    <NewConversationDialog
      v-if="showNew"
      :projects="projects"
      :agents="directAgents"
      :characters="characters?.agents"
      :initial-agent="newWith"
      @close="showNew = false"
      @create="openDraft"
      @refresh="store.refreshProjects"
    />

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
    <NoticeToasts :toasts="toasts" @open="store.openToast" @dismiss="store.dismissToast" />
  </div>
</template>
