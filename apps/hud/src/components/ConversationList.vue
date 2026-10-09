<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import { groupByDay } from '../lib/day-groups.ts';
import { SESSION_COPY } from '../lib/draft.ts';
import { agentName } from '../lib/italian.ts';
import { MODE_TEXT } from '../lib/labels.ts';
import { splitPinned } from '../lib/sidebar.ts';
import type { Conversation } from '../lib/types.ts';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';

const props = defineProps<{
  conversations: Conversation[];
  archived: Conversation[];
  /** System chats (D-064): their own section, under the conversations and above the archive. */
  system: Conversation[];
  selected: string | null;
  rename: (id: string, title: string) => Promise<boolean>;
}>();
const emit = defineEmits<{ open: [id: string]; archive: [id: string, archived: boolean]; pin: [id: string, pinned: boolean]; purge: [id: string] }>();

/** "Fissate" on top (D-089, no limit of number), then the others by day. */
const groups = computed(() => {
  const { pinned, others } = splitPinned(props.conversations);
  return [...(pinned.length > 0 ? [{ title: 'Fissate', conversations: pinned }] : []), ...groupByDay(others, new Date())];
});

function titleOf(conversation: Conversation): string {
  return conversation.title ?? 'Nuova conversazione';
}

/** The conversation whose title is being edited, and the draft. */
const editing = ref<string | null>(null);
const draft = ref('');
const input = ref<HTMLInputElement[]>([]);
/** The conversation waiting for the user to confirm the archive. */
const confirming = ref<string | null>(null);
const showArchived = ref(false);
/** The archived conversation waiting for the user to confirm its deletion. */
const purging = ref<string | null>(null);

function confirmPurge(): void {
  if (purging.value !== null) emit('purge', purging.value);
  purging.value = null;
}

async function startRename(conversation: Conversation): Promise<void> {
  confirming.value = null;
  editing.value = conversation.id;
  draft.value = conversation.title ?? '';
  await nextTick();
  input.value[0]?.focus();
  input.value[0]?.select();
}

async function saveRename(conversation: Conversation): Promise<void> {
  if (editing.value !== conversation.id) return;
  const title = draft.value.trim();
  editing.value = null;
  if (title === '' || title === conversation.title) return;
  if (!(await props.rename(conversation.id, title))) {
    editing.value = conversation.id;
    draft.value = title;
    await nextTick();
    input.value[0]?.focus();
  }
}

function onRenameKey(event: KeyboardEvent, conversation: Conversation): void {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    void saveRename(conversation);
  } else if (event.key === 'Escape') {
    editing.value = null;
  }
}

function confirmArchive(id: string): void {
  emit('archive', id, true);
  confirming.value = null;
}
</script>

<template>
  <nav aria-label="Conversazioni" class="flex flex-col gap-4">
    <p v-if="conversations.length === 0" class="px-1.5 text-sm text-muted">Nessuna conversazione.</p>

    <section v-for="group in groups" :key="group.title">
      <h2 class="hud-title mx-1.5 mb-1.5">{{ group.title }}</h2>
      <ul class="flex flex-col gap-0.5">
        <li v-for="conversation in group.conversations" :key="conversation.id" class="group relative">
          <div v-if="editing === conversation.id" class="px-1 py-1">
            <label :for="`title-${conversation.id}`" class="sr-only">Titolo della conversazione</label>
            <input
              :id="`title-${conversation.id}`"
              ref="input"
              v-model="draft"
              type="text"
              maxlength="200"
              class="field w-full px-2 py-1.5 text-sm"
              @keydown="onRenameKey($event, conversation)"
              @blur="saveRename(conversation)"
            />
          </div>
          <div
            v-else-if="confirming === conversation.id"
            class="flex items-center gap-2 rounded-lg border border-warn/50 bg-warn/10 px-2 py-2 text-sm"
            role="group"
            :aria-label="`Archiviare ${titleOf(conversation)}?`"
          >
            <span class="min-w-0 flex-1" title="Sparisce dalla lista; i messaggi restano e la ritrovi in Archiviate. I task già avviati finiscono il loro lavoro.">
              Archiviare? <span class="text-xs text-muted">I task avviati finiscono.</span>
            </span>
            <button type="button" class="btn px-2 py-1 text-xs" @click="confirmArchive(conversation.id)">Archivia</button>
            <button type="button" class="rounded-md px-1.5 py-1 text-xs text-muted hover:text-ink" @click="confirming = null">Annulla</button>
          </div>
          <template v-else>
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2 py-2 pr-[5.5rem] text-left md:pr-2 md:group-focus-within:pr-[4.5rem] md:group-hover:pr-[4.5rem] 3xl:group-focus-within:pr-[5.5rem] 3xl:group-hover:pr-[5.5rem]"
              :class="conversation.id === selected ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-2'"
              :aria-current="conversation.id === selected ? 'true' : undefined"
              :title="titleOf(conversation)"
              @click="emit('open', conversation.id)"
            >
              <span class="shrink-0" :class="conversation.mode === 'private' ? 'text-l2' : 'text-l1'" :title="conversation.agent !== null ? `Con ${agentName(conversation.agent)}` : MODE_TEXT[conversation.mode]">
                <Icon :name="conversation.telegram ? 'telegram' : conversation.agent !== null ? 'coder' : conversation.mode" :size="14" />
              </span>
              <span class="min-w-0 flex-1 truncate" :class="conversation.title === null ? 'text-muted' : ''">{{ titleOf(conversation) }}</span>
              <!-- D-150: from md to 3xl (a laptop) only the coloured dot, so the title keeps the room; the word in the title and for screen readers. -->
              <span class="hidden shrink-0 md:inline-flex 3xl:hidden"><LabelBadge :label="conversation.clearance" dot /></span>
              <span class="shrink-0 md:hidden 3xl:inline-flex"><LabelBadge :label="conversation.clearance" /></span>
            </button>
            <div class="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md bg-surface-2 transition md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 [&>button]:md:p-0.5 [&>button]:3xl:p-1">
              <button
                type="button"
                class="rounded-md p-1 hover:text-ink"
                :class="conversation.pinnedAt === null ? 'text-muted' : 'text-accent'"
                :aria-label="conversation.pinnedAt === null ? `Fissa ${titleOf(conversation)} in alto` : `Togli ${titleOf(conversation)} dalle fissate`"
                :title="conversation.pinnedAt === null ? 'Fissa in alto' : 'Togli dalle fissate'"
                :aria-pressed="conversation.pinnedAt !== null"
                @click="emit('pin', conversation.id, conversation.pinnedAt === null)"
              >
                <Icon :name="conversation.pinnedAt === null ? 'pin' : 'unpin'" :size="15" />
              </button>
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:text-ink"
                :aria-label="`Rinomina ${titleOf(conversation)}`"
                title="Rinomina"
                @click="startRename(conversation)"
              >
                <Icon name="rename" :size="15" />
              </button>
              <button
                v-if="!conversation.telegram"
                type="button"
                class="rounded-md p-1 text-muted hover:text-ink"
                :aria-label="`Archivia ${titleOf(conversation)}`"
                title="Archivia"
                @click="confirming = conversation.id"
              >
                <Icon name="archive" :size="15" />
              </button>
            </div>
          </template>
        </li>
      </ul>
    </section>

    <section v-if="system.length > 0" aria-label="Chat di sistema">
      <h2 class="hud-title mx-1.5 mb-1.5">Chat di sistema</h2>
      <ul class="flex flex-col gap-0.5">
        <li v-for="conversation in system" :key="conversation.id" class="group relative">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2 py-2 pr-9 text-left md:pr-2 md:group-focus-within:pr-9 md:group-hover:pr-9"
            :class="conversation.id === selected ? 'border-line-strong bg-surface-2' : 'border-transparent hover:bg-surface-2'"
            :aria-current="conversation.id === selected ? 'true' : undefined"
            :title="titleOf(conversation)"
            @click="emit('open', conversation.id)"
          >
            <span class="shrink-0 text-warn" title="Chat di sistema"><Icon name="system" :size="14" /></span>
            <span class="min-w-0 flex-1 truncate">{{ titleOf(conversation) }}</span>
            <span class="hidden shrink-0 md:inline-flex 3xl:hidden"><LabelBadge :label="conversation.clearance" dot /></span>
            <span class="shrink-0 md:hidden 3xl:inline-flex"><LabelBadge :label="conversation.clearance" /></span>
          </button>
          <button
            type="button"
            class="absolute top-1.5 right-1.5 rounded-md bg-surface-2 p-1 text-muted transition hover:text-ink md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            :aria-label="`Archivia ${titleOf(conversation)}`"
            title="Archivia: la ritrovi in Archiviate"
            @click="emit('archive', conversation.id, true)"
          >
            <Icon name="archive" :size="15" />
          </button>
        </li>
      </ul>
    </section>

    <section v-if="archived.length > 0">
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-muted hover:bg-surface-2 hover:text-ink"
        :aria-expanded="showArchived"
        @click="showArchived = !showArchived"
      >
        <Icon name="archive" :size="16" />
        <span class="flex-1">Archiviate ({{ archived.length }})</span>
        <span class="transition" :class="showArchived ? 'rotate-90' : ''"><Icon name="expand" :size="14" /></span>
      </button>
      <ul v-if="showArchived" class="mt-1 flex flex-col gap-0.5">
        <li v-for="conversation in archived" :key="conversation.id">
          <div
            v-if="purging === conversation.id"
            class="flex flex-col gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm"
            role="group"
            aria-label="Conferma dell'eliminazione definitiva"
          >
            <p class="font-medium">Eliminare per sempre “{{ titleOf(conversation) }}”?</p>
            <p class="text-xs leading-snug text-muted">
              Spariscono messaggi, titoli, passi di Arianna, brief e rapporti del Coder, testi delle schede e le chat di sistema sui suoi task; i task
              ancora aperti si chiudono. Resta il
              registro di controllo senza testi (cosa è uscito verso il cloud e con quale regola). Restano anche le carte e le pagine della base di
              conoscenza create da questa conversazione, i messaggi già arrivati su Telegram e le sessioni di Claude Code dei lavori delegati. Non si
              può annullare.
            </p>
            <p v-if="conversation.agent !== null && conversation.workspace !== null" class="text-xs leading-snug text-warn">{{ SESSION_COPY }}</p>
            <div class="flex gap-2">
              <button type="button" class="btn btn-danger px-2 py-1 text-xs" @click="confirmPurge"><Icon name="delete" :size="14" />Elimina per sempre</button>
              <button type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:text-ink" @click="purging = null">Annulla</button>
            </div>
          </div>
          <div v-else class="flex items-center gap-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm text-muted"
              :class="conversation.id === selected ? 'border-line-strong bg-surface-2 text-ink' : 'border-transparent hover:bg-surface-2'"
              :aria-current="conversation.id === selected ? 'true' : undefined"
              :title="titleOf(conversation)"
              @click="emit('open', conversation.id)"
            >
              <span class="truncate">{{ titleOf(conversation) }}</span>
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-muted hover:text-ink"
              :aria-label="`Ripristina ${titleOf(conversation)}`"
              title="Ripristina"
              @click="emit('archive', conversation.id, false)"
            >
              <Icon name="restore" :size="15" />
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-muted hover:text-danger"
              :aria-label="`Elimina definitivamente ${titleOf(conversation)}`"
              title="Elimina per sempre"
              @click="purging = conversation.id"
            >
              <Icon name="delete" :size="15" />
            </button>
          </div>
        </li>
      </ul>
    </section>
  </nav>
</template>
