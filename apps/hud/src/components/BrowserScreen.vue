<script setup lang="ts">
import type RFB from '@novnc/novnc';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, closeBrowser, openBrowserScreen } from '../lib/api.ts';
import { canRetry, SCREEN_HINT, SCREEN_TEXT, screenRefusal, screenUrl, type ScreenState } from '../lib/browser-screen.ts';
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
/** Each attempt has its number: an answer of an older one is dropped. */
let attempt = 0;

function stop(): void {
  const current = rfb;
  rfb = null;
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
    if (rfb === instance) state.value = 'live';
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
      <button type="button" :class="ACTION" :disabled="closing || state === 'refused' || state === 'closed'" title="Chiude il browser di Arianna in questa conversazione, dopo l'azione in corso" @click="closeIt"><Icon name="close" :size="13" />{{ closing ? 'Chiudo…' : 'Chiudi il browser' }}</button>
      <span v-if="closeProblem !== null" class="text-[12px] text-warn">{{ closeProblem }}</span>
    </div>
    <!-- The screen keeps the 1280×800 proportion; noVNC scales the page into it. Full screen: the box alone, on black. -->
    <div
      ref="screenBox"
      class="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-surface-2 [&:fullscreen]:rounded-none [&:fullscreen]:border-0 [&:fullscreen]:bg-black"
      :class="standalone === true ? 'mx-auto max-w-[calc((100dvh-9rem)*1.6)]' : ''"
    >
      <div ref="target" class="absolute inset-0" :class="state === 'live' ? '' : 'invisible'" aria-label="Schermo del browser di Arianna, sola visione"></div>
      <div v-if="state !== 'live'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p class="text-[14px] font-medium text-ink">{{ SCREEN_TEXT[state] }}<template v-if="state === 'connecting'">…</template></p>
        <p v-if="SCREEN_HINT[state] !== undefined" class="text-[12.5px] text-muted">{{ SCREEN_HINT[state] }}</p>
        <button v-if="canRetry(state)" type="button" class="mt-1 rounded-lg border border-line px-3 py-1 text-[13px] text-ink hover:bg-surface-2" @click="connect">Riprova</button>
      </div>
    </div>
    <p class="text-[12px] text-muted">Sola visione: clic e tasti sullo schermo non arrivano al browser. Il collegamento passa solo dal core e si chiude con il browser.</p>
  </div>
</template>
