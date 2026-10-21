<script setup lang="ts">
import type RFB from '@novnc/novnc';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiError, openBrowserScreen } from '../lib/api.ts';
import { canRetry, SCREEN_HINT, SCREEN_TEXT, screenRefusal, screenUrl, type ScreenState } from '../lib/browser-screen.ts';

/**
 * The live screen of Arianna's browser (D-264, passo 4), view only: noVNC
 * over the core's stream, never a click, a key or the clipboard (no handler
 * for `clipboard`; the core drops keys and mouse too). The 1280×800 screen is
 * scaled to the width of the panel. It opens only when the user asks (the
 * «Browser» tab), and closes when the tab, the panel or the conversation
 * changes.
 */
const props = defineProps<{
  conversationId: string;
  /** The site of the newest browser line, when known. */
  site: string | null;
}>();

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

onMounted(() => void connect());
watch(
  () => props.conversationId,
  () => void connect(),
);
onBeforeUnmount(() => {
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
      <span v-if="site !== null" class="min-w-0 flex-1 truncate text-muted" :title="site">{{ site }}</span>
    </div>
    <!-- The screen keeps the 1280×800 proportion; noVNC scales the page into it. -->
    <div class="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-surface-2">
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
