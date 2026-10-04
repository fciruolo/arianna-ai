<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { changeLines, countdown, exitLines, type PrivacyProposal } from '../lib/settings.ts';
import Icon from './Icon.vue';

/**
 * The confirmation card of a privacy change (D-071): what changes and every
 * exit after it, as the core prepared them. Only Conferma writes the file;
 * the id is valid a few minutes and once.
 */
const props = defineProps<{ proposal: PrivacyProposal; busy: boolean; spent: boolean; error: string | null }>();
const emit = defineEmits<{ confirm: []; close: [] }>();

const now = ref(Date.now());
let timer: number | undefined;
const dialog = ref<HTMLElement | null>(null);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.busy) emit('close');
}

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
  window.addEventListener('keydown', onKey);
  dialog.value?.focus();
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.removeEventListener('keydown', onKey);
});

const changes = computed(() => changeLines(props.proposal.changes));
const exits = computed(() => exitLines(props.proposal.exits));
const left = computed(() => countdown(props.proposal.expiresAt, now.value));
const expired = computed(() => Date.parse(props.proposal.expiresAt) <= now.value);
const MARK = { add: '+', remove: '−', change: '~' } as const;
const MARK_CLASS = { add: 'text-ok', remove: 'text-danger', change: 'text-warn' } as const;
</script>

<template>
  <div class="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4" @click.self="!busy && emit('close')">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-title"
      tabindex="-1"
      class="hud-card warn flex max-h-[90vh] w-full max-w-[560px] flex-col bg-surface outline-none"
    >
      <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
        <Icon name="gateway" :size="16" class="text-warn" />
        <h2 id="privacy-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] text-warn uppercase">Conferma le uscite</h2>
        <span class="font-mono text-[11px] text-muted" aria-live="off">{{ expired ? 'scaduta' : `scade fra ${left}` }}</span>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" :disabled="busy" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex min-h-0 flex-col gap-3.5 overflow-y-auto overscroll-contain px-4 py-3.5 text-[13.5px]">
        <div>
          <h3 class="hud-title mb-2">Cosa cambia</h3>
          <ul class="flex flex-col gap-1">
            <li v-for="line in changes" :key="line.text" class="flex gap-2 break-words" :class="MARK_CLASS[line.kind]">
              <span class="w-3 shrink-0 font-mono" aria-hidden="true">{{ MARK[line.kind] }}</span>
              <span class="min-w-0">{{ line.text }}</span>
            </li>
          </ul>
        </div>
        <div class="flex flex-col gap-1.5 rounded-[10px] border border-warn/35 bg-warn/8 px-3 py-2.5">
          <h3 class="hud-title text-warn">Dopo la modifica potrà uscire</h3>
          <p v-for="line in exits" :key="line" class="break-words">{{ line }}</p>
        </div>
        <p v-if="error !== null" role="alert" class="text-sm text-danger">{{ error }}</p>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
        <p class="mr-auto text-xs text-muted">Si applica solo con Conferma.</p>
        <button type="button" class="btn" :disabled="busy" @click="emit('close')">Annulla</button>
        <button type="button" class="btn btn-warn" :disabled="busy || expired || spent" @click="emit('confirm')">Conferma</button>
      </footer>
    </section>
  </div>
</template>
