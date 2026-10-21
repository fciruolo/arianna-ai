<script setup lang="ts">
import type RFB from '@novnc/novnc';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, browserStatus, closeBrowser, openBrowserScreen, returnBrowserControl, takeBrowserControl } from '../lib/api.ts';
import { keysymsOf, SPECIAL_KEYS } from '../lib/browser-keys.ts';
import { accessText, accessWarning, blockedText, canRetry, CONTROL_PASSED, FORM_NOTE, CONTROL_POLL_MS, CONTROL_WARNING, SCREEN_HINT, SCREEN_TEXT, screenRefusal, screenUrl, type ControlState, type ScreenState } from '../lib/browser-screen.ts';
import { errorText } from '../lib/italian.ts';
import { browserPathFor } from '../lib/route.ts';
import Icon from './Icon.vue';

/**
 * The live screen of Arianna's browser (D-264, passo 4), view only: noVNC
 * over the core's stream, never a click, a key or the clipboard (no handler
 * for `clipboard`; the core drops keys and mouse too). The 1280×800 screen is
 * scaled to the width of the panel. It opens only when the user asks (the
 * «Browser» tab, or the page /browser/<id> in a tab of its own), and closes
 * when the tab, the panel or the conversation changes. «Schermo intero» uses
 * the Fullscreen API on the screen alone (hidden where the browser has none,
 * as Safari on the iPhone); «Chiudi il browser» closes Arianna's browser itself.
 *
 * «Prendi il controllo» (D-264, passo 5): the token of this screen names it
 * for the core, which then forwards keys and pointer of this screen only
 * (never the clipboard; F-keys and Super dropped). While it drives: a colored
 * border, the fixed warning, «Restituisci ad Arianna», and on a phone the
 * «Tastiera» button (a hidden field whose characters go as keysyms,
 * lib/browser-keys.ts). The core is asked every few seconds who drives and
 * which page it refused, so another screen taking the control, the minutes
 * without input or the end of the browser show here.
 */
const props = defineProps<{
  conversationId: string;
  /** The site of the newest browser line, when known. */
  site: string | null;
  /** The page of its own (/browser/<id>): fills the window, no «Apri in una nuova scheda». */
  standalone?: boolean;
}>();
const emit = defineEmits<{ closed: [] }>();

const ACTION = 'inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink hover:bg-surface-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent';
const state = ref<ScreenState>('connecting');
const target = ref<HTMLElement | null>(null);
let rfb: RFB | null = null;
/** The token of this screen: it names it for «Prendi il controllo». */
let screenToken: string | null = null;
const control = ref<ControlState | null>(null);
/** The site of an access made by the user (D-276). */
const access = ref<string | null>(null);
/** The screen of the Private chat of an access (D-281): there Arianna reads the pages. */
const chat = ref(false);
/** Asked, waiting for Arianna to end her action. */
const asking = ref(false);
const notice = ref<string | null>(null);
const controlProblem = ref<string | null>(null);
/** The last refused page shown, by its number: each is said once. */
let shownBlocked = 0;
let poll: ReturnType<typeof setInterval> | undefined;
const driving = (): boolean => control.value === 'you';

/** noVNC takes keys and pointer only while this screen drives. */
function applyControl(): void {
  const current = rfb;
  if (current === null) return;
  const you = driving();
  current.viewOnly = !you;
  current.focusOnClick = you;
  if (you) current.focus({ preventScroll: true });
}

async function readStatus(): Promise<void> {
  const token = screenToken;
  if (token === null) return;
  try {
    const status = await browserStatus(props.conversationId, token);
    if (token !== screenToken) return;
    const before = control.value;
    control.value = status.control;
    access.value = status.access;
    chat.value = status.chat;
    if (before === 'you' && status.control === 'other') notice.value = CONTROL_PASSED;
    if (before === 'you' && status.control === 'agent') notice.value = 'Il browser è tornato ad Arianna.';
    if (status.control === 'you' || !status.open) asking.value = false;
    if (status.blocked !== null && status.blocked.seq > shownBlocked) {
      shownBlocked = status.blocked.seq;
      if (status.control === 'you') notice.value = blockedText(status.blocked, status.access);
    }
    applyControl();
  } catch {
    // A core that does not answer: the next read tries again.
  }
}

function stopPolling(): void {
  clearInterval(poll);
  poll = undefined;
}
/** Each attempt has its number: an answer of an older one is dropped. */
let attempt = 0;

function stop(): void {
  const current = rfb;
  rfb = null;
  screenToken = null;
  control.value = null;
  access.value = null;
  chat.value = false;
  asking.value = false;
  stopPolling();
  current?.disconnect();
}

async function connect(): Promise<void> {
  const run = ++attempt;
  stop();
  state.value = 'connecting';
  let token: string;
  try {
    token = await openBrowserScreen(props.conversationId);
  } catch (cause) {
    if (run === attempt) state.value = cause instanceof ApiError ? screenRefusal(cause.status, cause.message) : 'error';
    return;
  }
  // noVNC is loaded only when a screen opens: the chat without it stays as light as before.
  let Client: typeof RFB;
  try {
    Client = (await import('@novnc/novnc')).default;
  } catch {
    if (run === attempt) state.value = 'error';
    return;
  }
  if (run !== attempt || target.value === null) return;
  let instance: RFB;
  try {
    instance = new Client(target.value, screenUrl(window.location, token));
  } catch {
    state.value = 'error';
    return;
  }
  // Set before the connection completes: with viewOnly the keyboard is never grabbed.
  instance.viewOnly = true;
  instance.scaleViewport = true;
  instance.clipViewport = false;
  instance.resizeSession = false;
  instance.focusOnClick = false;
  instance.qualityLevel = 6;
  instance.compressionLevel = 2;
  let connected = false;
  instance.addEventListener('connect', () => {
    connected = true;
    if (rfb !== instance) return;
    state.value = 'live';
    stopPolling();
    poll = setInterval(() => void readStatus(), CONTROL_POLL_MS);
    void readStatus();
  });
  instance.addEventListener('disconnect', () => {
    if (rfb !== instance) return;
    rfb = null;
    // Closed after it was live: the browser closed or the connection broke (noVNC does not give the code). Never live: the stream did not open.
    state.value = connected ? 'ended' : 'error';
  });
  instance.addEventListener('securityfailure', () => {
    if (rfb === instance) state.value = 'error';
  });
  rfb = instance;
  screenToken = token;
  notice.value = null;
}

// «Prendi il controllo» and «Restituisci ad Arianna».
async function takeIt(): Promise<void> {
  const token = screenToken;
  if (token === null) return;
  controlProblem.value = null;
  notice.value = null;
  asking.value = true;
  try {
    const answer = await takeBrowserControl(props.conversationId, token);
    if (token !== screenToken) return;
    if (answer === 'you') {
      control.value = 'you';
      asking.value = false;
      applyControl();
    }
  } catch (cause) {
    asking.value = false;
    controlProblem.value = cause instanceof ApiError && cause.message === 'no-screen' ? 'Lo schermo non è più collegato: premi «Riprova».' : errorText(cause);
  }
}

async function giveBack(): Promise<void> {
  controlProblem.value = null;
  try {
    await returnBrowserControl(props.conversationId);
    control.value = 'agent';
    applyControl();
  } catch (cause) {
    controlProblem.value = errorText(cause);
  }
}

// «Tastiera» on a phone: a hidden field takes the text, each character goes to the browser as a keysym.
const keyboard = ref<HTMLInputElement | null>(null);
const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
function openKeyboard(): void {
  keyboard.value?.focus();
}
function sendText(event: Event): void {
  const field = event.target as HTMLInputElement;
  const current = rfb;
  if (current !== null && driving()) for (const keysym of keysymsOf(field.value)) current.sendKey(keysym, null);
  field.value = '';
}
function sendSpecial(event: KeyboardEvent): void {
  const key = SPECIAL_KEYS[event.key];
  const current = rfb;
  if (key === undefined || current === null || !driving()) return;
  event.preventDefault();
  current.sendKey(key.keysym, key.code);
}

// «Schermo intero»: the screen alone, Esc to leave it.
const screenBox = ref<HTMLElement | null>(null);
const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
async function enterFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement === null) await screenBox.value?.requestFullscreen();
  } catch {
    // Refused by the browser: the screen stays as it is.
  }
}

// «Chiudi il browser»: Arianna's browser closes after the action under way, the screen with it.
const closing = ref(false);
const closeProblem = ref<string | null>(null);
async function closeIt(): Promise<void> {
  closing.value = true;
  closeProblem.value = null;
  try {
    await closeBrowser(props.conversationId);
    attempt += 1;
    stop();
    state.value = 'closed';
    emit('closed');
  } catch (cause) {
    closeProblem.value = errorText(cause);
  } finally {
    closing.value = false;
  }
}

onMounted(() => void connect());
watch(
  () => props.conversationId,
  () => void connect(),
);
onBeforeUnmount(() => {
  stopPolling();
  if (document.fullscreenElement !== null && document.fullscreenElement === screenBox.value) void document.exitFullscreen().catch(() => undefined);
  attempt += 1;
  stop();
});
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2 text-[13px]">
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-[12px]"
        :class="state === 'live' ? 'text-ok' : state === 'connecting' ? 'text-muted' : 'text-warn'"
        aria-live="polite"
      >
        <span class="size-2 rounded-full" :class="state === 'live' ? 'animate-pulse bg-ok' : state === 'connecting' ? 'bg-muted' : 'bg-warn'" aria-hidden="true"></span>
        {{ SCREEN_TEXT[state] }}
      </span>
      <span class="min-w-0 flex-1 truncate text-muted" :title="site ?? undefined">{{ site ?? '' }}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <button v-if="canFullscreen" type="button" :class="ACTION" :disabled="state !== 'live'" title="Lo schermo a tutto schermo: Esc per uscire" @click="enterFullscreen"><Icon name="fullscreen" :size="13" />Schermo intero</button>
      <a v-if="standalone !== true" :class="ACTION" :href="browserPathFor(conversationId)" target="_blank" rel="noopener" title="Lo schermo in una scheda tutta sua: conta fra i 3 schermi del browser"><Icon name="external" :size="13" />Apri in una nuova scheda</a>
      <button
        v-if="control !== 'you'"
        type="button"
        :class="ACTION"
        :disabled="state !== 'live' || asking || control === null"
        title="Usi tu il browser: tasti e clic da questo schermo, Arianna aspetta"
        @click="takeIt"
      ><Icon name="computer" :size="13" />{{ asking ? 'Aspetto che Arianna finisca…' : 'Prendi il controllo' }}</button>
      <button v-else type="button" :class="ACTION" title="Il browser torna ad Arianna, che rilegge la pagina alla prossima richiesta" @click="giveBack"><Icon name="approve" :size="13" />Restituisci ad Arianna</button>
      <button v-if="control === 'you' && touch" type="button" :class="ACTION" title="Apre la tastiera del telefono: ogni carattere va al browser" @click="openKeyboard">Tastiera</button>
      <button type="button" :class="ACTION" :disabled="closing || state === 'refused' || state === 'closed'" title="Chiude il browser di Arianna in questa conversazione, dopo l'azione in corso" @click="closeIt"><Icon name="close" :size="13" />{{ closing ? 'Chiudo…' : 'Chiudi il browser' }}</button>
      <span v-if="closeProblem !== null" class="text-[12px] text-warn">{{ closeProblem }}</span>
      <span v-if="controlProblem !== null" class="text-[12px] text-warn">{{ controlProblem }}</span>
    </div>
    <div v-if="control === 'you'" class="rounded-lg border border-warn px-3 py-1.5 text-[13px] text-warn" role="status">
      <p class="font-medium">{{ access === null ? CONTROL_WARNING : accessWarning(access) }}</p>
      <p v-if="access === null" class="text-[12.5px]">{{ FORM_NOTE }}</p>
    </div>
    <p v-if="access !== null" class="text-[12.5px] text-muted" role="status">{{ accessText(access, chat) }}</p>
    <p v-if="notice !== null" class="text-[12.5px] text-muted" role="status">{{ notice }}</p>
    <!-- The keyboard of a phone: off screen, never shown; what it receives goes as keys and is cleared. -->
    <input
      v-if="control === 'you' && touch"
      ref="keyboard"
      class="pointer-events-none fixed -left-[200vw] top-0 h-px w-px opacity-0"
      type="text"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      aria-label="Tastiera del browser"
      @input="sendText"
      @keydown="sendSpecial"
    />
    <!-- The screen keeps the 1280×800 proportion; noVNC scales the page into it. Full screen: the box alone, on black. -->
    <div
      ref="screenBox"
      class="relative aspect-[16/10] w-full overflow-hidden rounded-lg border bg-surface-2 [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:bg-black"
      :class="[standalone === true ? 'mx-auto max-w-[calc((100dvh-9rem)*1.6)]' : '', control === 'you' ? 'border-2 border-warn' : 'border-line']"
    >
      <div ref="target" class="absolute inset-0" :class="state === 'live' ? '' : 'invisible'" :aria-label="control === 'you' ? 'Schermo del browser di Arianna: lo guidi tu' : 'Schermo del browser di Arianna, sola visione'"></div>
      <div v-if="state !== 'live'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p class="text-[14px] font-medium text-ink">{{ SCREEN_TEXT[state] }}<template v-if="state === 'connecting'">…</template></p>
        <p v-if="SCREEN_HINT[state] !== undefined" class="text-[12.5px] text-muted">{{ SCREEN_HINT[state] }}</p>
        <button v-if="canRetry(state)" type="button" class="mt-1 rounded-lg border border-line px-3 py-1 text-[13px] text-ink hover:bg-surface-2" @click="connect">Riprova</button>
      </div>
    </div>
    <p v-if="control === 'you'" class="text-[12px] text-muted">Guidi tu: tasti e clic di questo schermo arrivano al browser, gli appunti mai. Dopo 5 minuti senza tasti né clic il browser torna ad Arianna.</p>
    <p v-else class="text-[12px] text-muted">Sola visione: clic e tasti sullo schermo non arrivano al browser finché non prendi il controllo. Il collegamento passa solo dal core e si chiude con il browser.</p>
  </div>
</template>
