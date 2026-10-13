<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { NEVER_OUT } from '../lib/settings-copy.ts';
import { changeLines, countdown, exitLines, type PrivacyProposal } from '../lib/settings.ts';
import Icon from './Icon.vue';

/**
 * The confirmation of a change that lets data out (D-071, words revised in
 * D-192): what changes and every exit after it, as the core prepared them,
 * then what never leaves the Mac. Only «Conferma e salva» writes the file;
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
      class="flex max-h-[90vh] w-full max-w-[580px] flex-col rounded-[14px] border border-warn bg-surface-2 outline-none"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3.5">
        <Icon name="private" :size="16" class="text-warn" />
        <h2 id="privacy-title" class="flex-1 text-[16px] font-semibold">Conferma cosa può uscire dal Mac</h2>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi" :disabled="busy" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3.5 text-[14.5px]">
        <div>
          <h3 class="mb-1 text-[14px] font-semibold">Cosa cambia</h3>
          <ul class="flex flex-col gap-1">
            <li v-for="line in changes" :key="line.text" class="flex gap-2 break-words">
              <span class="w-3 shrink-0 font-semibold" :class="MARK_CLASS[line.kind]" aria-hidden="true">{{ MARK[line.kind] }}</span>
              <span class="min-w-0">{{ line.text }}</span>
            </li>
          </ul>
        </div>
        <div class="flex flex-col gap-1.5 rounded-[10px] border border-warn/45 bg-warn/9 px-3 py-2.5">
          <h3 class="text-[14px] font-semibold">Dopo la modifica potrà uscire</h3>
          <p v-for="line in exits" :key="line" class="break-words">{{ line }}</p>
        </div>
        <div class="rounded-[10px] border border-line px-3 py-2.5">
          <h3 class="mb-1 text-[14px] font-semibold">Non esce mai</h3>
          <p class="text-muted">{{ NEVER_OUT }}</p>
        </div>
        <p v-if="error !== null" role="alert" class="text-sm text-danger">{{ error }}</p>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
        <p class="mr-auto text-[13px] text-muted" aria-live="off">{{ expired ? 'Scaduta: chiudi e rivedi di nuovo.' : `Vale ancora ${left}. Si applica solo con «Conferma e salva».` }}</p>
        <button type="button" class="btn px-3 py-1.5 text-[14px]" :disabled="busy" @click="emit('close')">Annulla</button>
        <button type="button" class="btn btn-warn px-3 py-1.5 text-[14px] font-semibold" :disabled="busy || expired || spent" @click="emit('confirm')">Conferma e salva</button>
      </footer>
    </section>
  </div>
</template>
