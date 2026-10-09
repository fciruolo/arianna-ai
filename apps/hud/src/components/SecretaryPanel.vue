<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { ApiError, listCommitments, markCommitmentDone } from '../lib/api.ts';
import { dueCount, groupCommitments } from '../lib/commitments.ts';
import type { Commitment } from '../lib/types.ts';
import Icon from './Icon.vue';

/**
 * The commitments beside the secretary's conversation (I-12, D-144): the open
 * ones by day, the late ones first, those of today already done; "Fatto" on
 * each open one. Read from the core (written from SQL, never by a model) and
 * again whenever one changes (`version`, from the live feed).
 */
const props = defineProps<{ version: number }>();

const items = ref<Commitment[]>([]);
const today = ref('');
const loaded = ref(false);
const error = ref<string | null>(null);
const busy = ref<string | null>(null);
/** Folded, the list takes one line: the conversation gets the room. */
const folded = ref(false);

const groups = computed(() => groupCommitments(items.value, today.value));
const due = computed(() => dueCount(items.value, today.value));

async function refresh(): Promise<void> {
  try {
    const read = await listCommitments();
    items.value = read.commitments;
    today.value = read.today;
    error.value = null;
  } catch {
    error.value = 'Non riesco a leggere gli impegni.';
  } finally {
    loaded.value = true;
  }
}

async function done(item: Commitment): Promise<void> {
  busy.value = item.id;
  try {
    await markCommitmentDone(item.id);
    await refresh();
  } catch (cause) {
    // Marked meanwhile (another tab, the chat): the list says how it is now.
    error.value = cause instanceof ApiError && cause.status === 409 ? null : 'Non sono riuscita a segnarlo fatto.';
    await refresh();
  } finally {
    busy.value = null;
  }
}

onMounted(refresh);
watch(
  () => props.version,
  () => void refresh(),
);
</script>

<template>
  <section class="mx-4 mt-3 flex max-h-[38vh] min-h-0 shrink-0 flex-col rounded-[12px] border border-line bg-surface md:mx-5.5" aria-label="Impegni della segretaria">
    <header class="flex items-center gap-2 px-3.5 py-2.5" :class="{ 'border-b border-line': !folded }">
      <Icon name="calendar" :size="15" />
      <h2 class="hud-title flex-1">Impegni</h2>
      <span v-if="due > 0" class="font-mono text-[11px] text-warn">{{ due === 1 ? '1 da fare' : `${String(due)} da fare` }}</span>
      <button type="button" class="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" :aria-expanded="!folded" :aria-label="folded ? 'Mostra gli impegni' : 'Nascondi gli impegni'" @click="folded = !folded">
        <span class="inline-grid transition-transform" :class="{ 'rotate-90': !folded }"><Icon name="expand" :size="14" /></span>
      </button>
    </header>
    <div v-if="!folded" class="min-h-0 overflow-y-auto px-3.5 py-2.5">
      <p v-if="error !== null" role="alert" class="mb-2 text-xs text-warn">{{ error }}</p>
      <p v-if="loaded && groups.length === 0" class="text-[13px] text-muted">Nessun impegno aperto. Scrivi qui sotto, per esempio «giovedì alle 15 devo andare in banca».</p>
      <div v-for="group in groups" :key="group.title" class="mb-2 last:mb-0">
        <h3 class="mb-1 text-[11.5px] font-semibold tracking-[0.04em] uppercase" :class="group.late ? 'text-warn' : 'text-muted'">{{ group.title }}</h3>
        <ul class="flex flex-col gap-1">
          <li v-for="item in group.items" :key="item.id" class="flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-[13.5px] hover:bg-surface-2">
            <span v-if="item.time !== null" class="w-11 shrink-0 font-mono text-[12px] text-muted">{{ item.time }}</span>
            <span v-else class="w-11 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 break-words" :class="{ 'text-muted line-through': item.status === 'done' }">{{ item.body }}</span>
            <button v-if="item.status === 'open'" type="button" class="btn shrink-0 px-2 py-0.5 text-[12px]" :disabled="busy === item.id" :aria-label="`Fatto: ${item.body}`" @click="done(item)">
              <Icon name="approve" :size="13" />Fatto
            </button>
            <span v-else-if="item.status === 'done'" class="shrink-0 font-mono text-[11px] text-ok">fatto</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
