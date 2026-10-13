<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { answerImClosing, readImClosing } from '../lib/api.ts';
import {
  answeredText,
  CLOSING_CHANGED_TEXT,
  closingHint,
  closingTitle,
  type ImClosing,
  type ImDetail,
  imErrorText,
  type ImItem,
  IM_OUTCOME_TEXT,
  IM_OUTCOMES,
  type ImOutcome,
  isStale,
  itemRef,
} from '../lib/im.ts';
import Icon from './Icon.vue';

/**
 * The closing of an IM in the secretary conversation (D-167, I-11 tappa P4b):
 * under the message of Arianna that asks it, one row per item of the IM; an
 * item still open (Da fare, In corso) has three buttons, "Fatta", "In parte"
 * (the next IM gets the next part), "Non fatta" (it moves to the next IM); the
 * others show how they ended. The last answer closes the IM. Read from the
 * core when shown and whenever the chat lists the closings again; a 409 (the
 * item changed in the file, or the closing is over) reads it again.
 */
const props = defineProps<{ closing: ImClosing }>();

const current = ref<ImClosing>(props.closing);
const im = ref<ImDetail | null>(null);
const closed = ref(false);
const busy = ref(false);
const problem = ref<string | null>(null);
const notice = ref<string | null>(null);

const over = computed(() => closed.value || current.value.closedAt !== null);

let latest = 0;
async function load(): Promise<void> {
  const request = ++latest;
  try {
    const read = await readImClosing(props.closing.id);
    if (request !== latest) return;
    current.value = read.closing;
    im.value = read.im;
    problem.value = null;
  } catch (cause) {
    if (request === latest) problem.value = `Non riesco a leggere l’IM: ${imErrorText(cause)}`;
  }
}

watch(
  () => props.closing,
  (closing) => {
    current.value = closing;
    void load();
  },
  { immediate: true },
);

async function answer(item: ImItem, outcome: ImOutcome): Promise<void> {
  if (busy.value || over.value) return;
  busy.value = true;
  problem.value = null;
  notice.value = null;
  latest += 1;
  try {
    const result = await answerImClosing(current.value.id, itemRef(item), outcome);
    current.value = result.closing;
    im.value = result.im;
    closed.value = result.closed;
  } catch (cause) {
    if (isStale(cause)) {
      await load();
      notice.value = CLOSING_CHANGED_TEXT;
    } else {
      problem.value = imErrorText(cause);
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <article class="hud-card" :class="{ warn: !over }" :aria-label="`Chiusura dell’IM: ${closingTitle(current)}`">
    <header class="flex items-center gap-2.5 border-b border-line px-[15px] py-3">
      <span :class="over ? 'text-ok' : 'text-warn'"><Icon name="calendar" /></span>
      <h3 class="min-w-0 flex-1 truncate font-semibold">{{ closingTitle(current) }}</h3>
      <span class="font-mono text-[12px] tracking-[0.08em] whitespace-nowrap uppercase" :class="over ? 'text-ok' : 'text-warn'">{{ over ? 'IM chiuso' : 'In attesa' }}</span>
    </header>

    <div class="flex min-w-0 flex-col gap-2 px-[15px] py-3">
      <p v-if="notice !== null" role="status" class="text-[14px] text-warn">{{ notice }}</p>
      <p v-if="problem !== null" role="alert" class="text-[14px] text-danger">{{ problem }}</p>
      <p v-if="im === null && problem === null" class="text-[14px] text-muted">Carico l’IM…</p>
      <p v-else-if="im !== null && im.items.length === 0" class="text-[14px] text-muted">Questo IM non ha voci.</p>
      <ul v-if="im !== null && im.items.length > 0" class="flex flex-col gap-1.5">
        <li v-for="item in im.items" :key="`${item.line}:${item.title}`" class="rounded-lg border border-line bg-bg px-3 py-2">
          <p class="flex flex-wrap items-baseline gap-x-2 break-words">
            <span class="min-w-0 flex-1" :class="{ 'text-muted line-through': item.state === 'cancelled' }">{{ item.title }}</span>
            <span v-if="item.part !== null" class="chip text-[12.5px] text-info">Parte {{ item.part }}</span>
            <strong v-if="answeredText(item) !== undefined" class="text-[14px]" :class="item.state === 'done' ? 'text-ok' : item.state === 'postponed' ? 'text-warn' : 'text-muted'">{{
              answeredText(item)
            }}</strong>
          </p>
          <template v-if="answeredText(item) === undefined && !over">
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5" role="group" :aria-label="`Com’è andata: ${item.title}`">
              <button
                v-for="outcome in IM_OUTCOMES"
                :key="outcome"
                type="button"
                class="btn px-2.5 py-1 text-[13.5px]"
                :class="{ 'btn-primary': outcome === 'done' }"
                :disabled="busy"
                @click="answer(item, outcome)"
              >
                {{ IM_OUTCOME_TEXT[outcome] }}
              </button>
            </div>
            <p class="mt-1 text-xs text-muted">{{ closingHint(item) }}</p>
          </template>
        </li>
      </ul>
    </div>

    <div v-if="over" class="flex items-center gap-2 rounded-b-[14px] border-t border-line bg-surface-2 px-[15px] py-2.5 text-[14px] text-ok">
      <Icon name="approve" :size="16" />IM chiuso
    </div>
  </article>
</template>
