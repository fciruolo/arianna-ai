<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { loadGod, syncGodClone } from '../lib/api.ts';
import { cloneText, godBlocker, type GodStatus } from '../lib/god.ts';
import { errorText } from '../lib/italian.ts';
import Icon from './Icon.vue';

/**
 * The page of GOD (D-127): Arianna developed from inside Arianna. The clone
 * GOD reads (repos/arianna/main, never the installation), "Crea/Aggiorna il
 * clone", the conversations with GOD and "Nuova conversazione". Everything
 * shown comes from GET /api/god: names, paths of the container, counts.
 */
const emit = defineEmits<{
  /** A new conversation with GOD on this part of the container. */
  chat: [workspace: string];
  open: [id: string];
}>();

const status = ref<GodStatus | null>(null);
const loading = ref(true);
const syncing = ref(false);
const loadError = ref<string | null>(null);

const blocker = computed(() => (status.value === null ? null : godBlocker(status.value)));

async function refresh(): Promise<void> {
  try {
    status.value = await loadGod();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Non riesco a leggere lo stato di GOD. ${errorText(cause)}`;
  } finally {
    loading.value = false;
  }
}

async function sync(): Promise<void> {
  syncing.value = true;
  try {
    status.value = await syncGodClone();
    loadError.value = null;
  } catch (cause) {
    loadError.value = `Il clone non si è aggiornato. ${errorText(cause)}`;
  } finally {
    syncing.value = false;
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

onMounted(refresh);
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-[860px] flex-col gap-5 px-4 pt-5 pb-10 md:px-6">
      <section class="hud-card p-4" aria-labelledby="god-title">
        <div class="flex flex-wrap items-center gap-2">
          <Icon name="god" :size="16" />
          <h1 id="god-title" class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">GOD</h1>
          <span class="font-mono text-[10.5px] tracking-[0.06em] text-muted">Arianna sviluppata da dentro Arianna</span>
          <button type="button" class="ml-auto rounded-md p-1.5 text-muted hover:text-ink" title="Rileggi" aria-label="Rileggi" @click="refresh">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p class="mt-2 text-[13.5px] text-muted">
          GOD lavora in un clone del codice di Arianna con soli dati finti: non vede mai il database, la cassaforte né le tue conversazioni. I lavori tornano qui solo come rami git che unisci tu.
        </p>
        <p v-if="loadError !== null" role="alert" class="mt-3 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ loadError }}</p>
        <p v-else-if="loading" class="py-4 text-center font-mono text-xs tracking-[0.12em] text-muted">LEGGO LO STATO…</p>
        <template v-else-if="status !== null">
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <Icon name="branch" :size="14" />
            <span class="min-w-0 flex-1 font-mono text-[12px] break-words">{{ cloneText(status.main) }}</span>
            <button
              type="button"
              class="rounded-lg border border-line px-2.5 py-1 text-[12.5px] hover:border-line-strong disabled:opacity-50"
              :disabled="syncing || status.project === 'wrong-path'"
              @click="sync"
            >
              {{ syncing ? 'Aggiorno…' : status.main.exists ? 'Aggiorna il clone' : 'Crea il clone' }}
            </button>
          </div>
          <p v-if="blocker !== null" class="mt-3 rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">{{ blocker }}</p>
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink disabled:opacity-50"
              :disabled="blocker !== null"
              @click="emit('chat', status.workspace)"
            >
              <Icon name="new" :size="15" />Nuova conversazione con GOD
            </button>
            <span class="text-xs text-muted">Ogni messaggio va al cloud (Claude o Codex, a scelta nel selettore del modello) con il fascicolo di sviluppo del clone.</span>
          </div>
        </template>
      </section>

      <section v-if="status !== null && status.conversations.length > 0" class="hud-card p-4" aria-labelledby="god-chats">
        <h2 id="god-chats" class="mb-2 font-hud text-[13px] font-semibold tracking-[0.12em] uppercase">Conversazioni con GOD</h2>
        <ul class="flex flex-col">
          <li v-for="conversation in status.conversations" :key="conversation.id">
            <button type="button" class="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" @click="emit('open', conversation.id)">
              <span class="min-w-0 flex-1 truncate text-[13.5px]">{{ conversation.title ?? 'Conversazione senza titolo' }}</span>
              <span class="shrink-0 font-mono text-[11px] text-muted">{{ when(conversation.lastAt) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
