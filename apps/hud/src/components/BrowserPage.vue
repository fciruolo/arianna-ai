<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { browserStatus } from '../lib/api.ts';
import { BROWSER_POLL_MS } from '../lib/browser-screen.ts';
import BrowserScreen from './BrowserScreen.vue';

/**
 * The screen of Arianna's browser in a tab of its own (D-264, passo 4),
 * `/browser/<conversationId>`: the screen alone on a dark page, with the site
 * and the state above. Without the chat: no WebSocket of the chat, no list of
 * conversations; its own token, one of the 3 screens of the browser.
 */
const props = defineProps<{ conversationId: string }>();

const site = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
async function readSite(): Promise<void> {
  try {
    site.value = (await browserStatus(props.conversationId)).site;
  } catch {
    // Keeps the last one: the next read tries again.
  }
}

onMounted(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.title = 'Browser di Arianna';
  void readSite();
  timer = setInterval(() => void readSite(), BROWSER_POLL_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <main class="min-h-dvh bg-bg px-4 py-3 text-ink">
    <h1 class="mb-2 text-[14px] font-semibold">Browser di Arianna</h1>
    <BrowserScreen :conversation-id="conversationId" :site="site" standalone @closed="site = null" />
  </main>
</template>
