<script setup lang="ts">
/**
 * The confirmation of a change of permissions (D-119, tappa T3b): what the
 * card was and what it becomes, the three sides of the trifecta and what
 * leaves for the cloud. Only "Conferma" sends the confirmation id back; it
 * is bound to these exact files, so a card changed meanwhile is refused by
 * the core and the page prepares again.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { changeRows, cloudLines, trifectaRows, type AgentProposal } from '../lib/user-agents.ts';

const props = defineProps<{ proposal: AgentProposal; busy: boolean; error: string; action: string }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const confirmButton = ref<HTMLButtonElement | null>(null);
/** Where the focus was before the window opened: it goes back there when it closes. */
let opener: HTMLElement | null = null;

function cancel(): void {
  // While the request is in flight the card may be written anyway: the window stays.
  if (!props.busy) emit('cancel');
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
}
onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmButton.value?.focus();
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  if (opener?.isConnected === true) opener.focus();
});

const rows = computed(() => changeRows(props.proposal));
const sides = computed(() => trifectaRows(props.proposal.trifecta));
const exits = computed(() => cloudLines(props.proposal.cloud));
const isNew = computed(() => props.proposal.before === null);
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="permission-confirm-title">
    <div class="hud-card flex max-h-[90vh] w-full max-w-xl flex-col gap-3 p-4">
      <h2 id="permission-confirm-title" class="font-hud text-[12px] font-semibold tracking-[0.14em] uppercase">
        {{ isNew ? `Creare ${proposal.name} con questi permessi?` : `Cambiare i permessi di ${proposal.name}?` }}
      </h2>
      <div class="flex min-h-0 flex-col gap-3 overflow-y-auto">
        <table class="w-full text-left text-[13px]">
          <caption class="sr-only">Cosa cambia</caption>
          <thead class="text-xs text-muted">
            <tr>
              <th scope="col" class="py-1 pr-3 font-normal">Cosa</th>
              <th v-if="!isNew" scope="col" class="py-1 pr-3 font-normal">Prima</th>
              <th scope="col" class="py-1 font-normal">{{ isNew ? 'Valore' : 'Dopo' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.field" class="border-t border-line align-top">
              <th scope="row" class="py-1.5 pr-3 font-normal text-muted">{{ row.field }}</th>
              <td v-if="!isNew" class="py-1.5 pr-3 text-muted line-through decoration-muted/60">{{ row.before }}</td>
              <td class="py-1.5">{{ row.after }}</td>
            </tr>
          </tbody>
        </table>

        <div class="flex flex-col gap-1.5">
          <p class="text-xs text-muted">Trifecta letale: i tre lati non sono mai aperti insieme</p>
          <ul class="flex flex-col gap-1 text-[13px]">
            <li v-for="side in sides" :key="side.side" class="flex gap-2">
              <span class="chip shrink-0" :class="side.open ? 'text-warn' : 'text-ok'">{{ side.open ? 'aperto' : 'chiuso' }}</span>
              <span><span class="font-semibold">{{ side.side }}</span> · {{ side.why }}</span>
            </li>
          </ul>
        </div>

        <div class="flex flex-col gap-1.5">
          <p class="text-xs text-muted">Cosa esce verso il cloud</p>
          <p v-for="line in exits" :key="line" class="text-[13px]">{{ line }}</p>
        </div>
        <p class="text-xs text-muted">Finché resta in <code class="font-mono">data/agents</code> vale comunque il tetto: al massimo Interno e A1, niente deleghe, canali né approvazioni.</p>
      </div>
      <p v-if="error" class="text-xs text-danger" role="alert">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="cancel">Annulla</button>
        <button ref="confirmButton" type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="emit('confirm')">{{ action }}</button>
      </div>
    </div>
  </div>
</template>
