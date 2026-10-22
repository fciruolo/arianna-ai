<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { groupByDay } from '../lib/day-groups.ts';
import { SESSION_COPY } from '../lib/draft.ts';
import { agentLabelLine } from '../lib/character-names.ts';
import { castLook, conversationCharacter } from '../lib/character-chat.ts';
import { MODE_TEXT } from '../lib/labels.ts';
import { canErase, ERASE_CONVERSATION_TEXT } from '../lib/erase.ts';
import { splitPinned } from '../lib/sidebar.ts';
import { longPress } from '../lib/long-press.ts';
import type { Conversation } from '../lib/types.ts';
import DeleteConfirm from './DeleteConfirm.vue';
import LabelBadge from './LabelBadge.vue';
import Icon from './Icon.vue';

const props = defineProps<{
  conversations: Conversation[];
  archived: Conversation[];
  /** System chats (D-064): their own section, under the conversations and above the archive. */
  system: Conversation[];
  selected: string | null;
  rename: (id: string, title: string) => Promise<boolean>;
  /** The conversation beside the open one (D-234), marked in the list; null when there is none. */
  beside?: string | null | undefined;
  /** Whether «Affianca» is offered on a conversation (D-234); without it, never. */
  splittable?: ((conversation: Conversation) => boolean) | undefined;
  /** The list of the phone (D-293): rows for a finger, the actions in a sheet. */
  touch?: boolean;
}>();
const emit = defineEmits<{ open: [id: string]; archive: [id: string, archived: boolean]; pin: [id: string, pinned: boolean]; erase: [id: string]; split: [id: string] }>();

/** «Affianca» on this row (D-234). */
function offersSplit(conversation: Conversation): boolean {
  return props.splittable?.(conversation) === true;
}

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
/** The conversation waiting for the user to confirm its deletion for good (D-157), in any list. */
const erasing = ref<string | null>(null);

function confirmErase(): void {
  if (erasing.value !== null) emit('erase', erasing.value);
  erasing.value = null;
}

/** Who the user talks with here: the person of the series Claude plays (D-225, tappa B), else the agent. */
function withWhom(conversation: Conversation, agent: string): string {
  const character = conversationCharacter(conversation);
  return character === null ? agentLabelLine(agent) : castLook(character).name;
}

/** A direct chat on Claude or Codex keeps its session in the user's home: the confirmation says it. */
function sessionNote(conversation: Conversation): string | null {
  return conversation.agent !== null && conversation.workspace !== null ? SESSION_COPY : null;
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

/**
 * The phone (D-293, tappa 3): the actions of a row in a sheet at the bottom,
 * opened by a long press or by its «⋯», instead of the icons that the Mac
 * shows on hover.
 */
const sheet = ref<{ conversation: Conversation; system: boolean } | null>(null);
let pressed: { conversation: Conversation; system: boolean } | null = null;
const press = longPress(
  () => {
    sheet.value = pressed;
  },
  { set: (callback, ms) => window.setTimeout(callback, ms), clear: (handle) => window.clearTimeout(handle as number) },
);
function onDown(event: PointerEvent, conversation: Conversation, system = false): void {
  if (props.touch !== true) return;
  pressed = { conversation, system };
  press.down(event);
}
function onRowClick(id: string): void {
  // The click of the finger lifted after a long press opens the sheet only.
  if (press.consumeFired()) return;
  emit('open', id);
}
function closeSheet(): void {
  sheet.value = null;
}
/** The sheet takes the focus when it opens and gives it back to what opened it (review of D-293). */
const sheetBox = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
watch(
  () => sheet.value !== null,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      sheetBox.value?.querySelector<HTMLElement>('button')?.focus();
    } else if (opener !== null && opener.isConnected && editing.value === null) {
      opener.focus();
      opener = null;
    }
  },
);
/** Tab stays inside the sheet while it is open. */
function trapTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || sheetBox.value === null) return;
  const buttons = [...sheetBox.value.querySelectorAll<HTMLElement>('button')];
  const first = buttons[0];
  const last = buttons.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function sheetAction(action: 'pin' | 'rename' | 'archive' | 'erase'): void {
  const chosen = sheet.value;
  sheet.value = null;
  if (chosen === null) return;
  const conversation = chosen.conversation;
  if (action === 'pin') emit('pin', conversation.id, conversation.pinnedAt === null);
  else if (action === 'rename') void startRename(conversation);
  else if (action === 'archive') {
    // A system chat goes to the archive at once, as on the Mac; the others ask first, in the row.
    if (chosen.system) emit('archive', conversation.id, true);
    else {
      erasing.value = null;
      confirming.value = conversation.id;
    }
  } else {
    confirming.value = null;
    erasing.value = conversation.id;
  }
}
function onSheetKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && sheet.value !== null) closeSheet();
}
onMounted(() => window.addEventListener('keydown', onSheetKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onSheetKey));

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
          <DeleteConfirm
            v-else-if="erasing === conversation.id"
            :subject="titleOf(conversation)"
            :text="ERASE_CONVERSATION_TEXT"
            :extra="sessionNote(conversation)"
            @confirm="confirmErase"
            @cancel="erasing = null"
          />
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
              class="flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2 py-2 text-left md:pr-2"
              :class="[
                conversation.id === selected ? 'border-line-strong bg-surface-2' : conversation.id === beside ? 'border-dashed border-line-strong' : 'border-transparent hover:bg-surface-2',
                touch
                  ? 'min-h-[52px] pr-12 text-[16px] select-none [-webkit-touch-callout:none]'
                  : offersSplit(conversation)
                    ? 'pr-[8.5rem] md:group-focus-within:pr-[7rem] md:group-hover:pr-[7rem] 3xl:group-focus-within:pr-[8.5rem] 3xl:group-hover:pr-[8.5rem]'
                    : 'pr-[7rem] md:group-focus-within:pr-[5.75rem] md:group-hover:pr-[5.75rem] 3xl:group-focus-within:pr-[7rem] 3xl:group-hover:pr-[7rem]',
              ]"
              :aria-current="conversation.id === selected ? 'true' : undefined"
              :title="titleOf(conversation)"
              @click="onRowClick(conversation.id)"
              @pointerdown="onDown($event, conversation)"
              @pointermove="press.move"
              @pointerup="press.up"
              @pointercancel="press.up"
              @contextmenu="touch ? $event.preventDefault() : undefined"
            >
              <span class="shrink-0" :class="conversation.mode === 'private' ? 'text-l2' : 'text-l1'" :title="conversation.agent !== null ? `Con ${withWhom(conversation, conversation.agent)}` : MODE_TEXT[conversation.mode]">
                <Icon :name="conversation.telegram ? 'telegram' : conversation.agent !== null ? 'coder' : conversation.mode" :size="14" />
              </span>
              <span class="min-w-0 flex-1 truncate" :class="conversation.title === null ? 'text-muted' : ''">{{ titleOf(conversation) }}</span>
              <!-- The chat of a routine (D-110, risposta 3; D-254): an «R», the reports arrive here at its time. -->
              <span
                v-if="conversation.routine === true"
                class="grid size-[18px] shrink-0 place-items-center rounded border border-line-strong font-mono text-[11px] leading-none font-semibold text-muted"
                title="Conversazione di una routine: qui arrivano i suoi resoconti"
              ><span aria-hidden="true">R</span><span class="sr-only">, routine</span></span>
              <span v-if="conversation.id === beside" class="sr-only">, affiancata</span>
              <!-- D-150: from md to 3xl (a laptop) only the coloured dot, so the title keeps the room; the word in the title and for screen readers. -->
              <span class="hidden shrink-0 md:inline-flex 3xl:hidden"><LabelBadge :label="conversation.clearance" dot /></span>
              <span class="shrink-0 md:hidden 3xl:inline-flex"><LabelBadge :label="conversation.clearance" /></span>
            </button>
            <button
              v-if="touch"
              type="button"
              class="absolute top-1/2 right-0.5 grid size-11 -translate-y-1/2 place-items-center rounded-lg text-muted"
              :aria-label="`Azioni su ${titleOf(conversation)}`"
              aria-haspopup="dialog"
              @click="sheet = { conversation, system: false }"
            >
              <Icon name="more" :size="20" />
            </button>
            <div v-else class="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md bg-surface-2 transition md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 [&>button]:md:p-0.5 [&>button]:3xl:p-1">
              <button
                v-if="offersSplit(conversation)"
                type="button"
                class="rounded-md p-1 text-muted hover:text-ink"
                :aria-label="`Affianca ${titleOf(conversation)} alla conversazione aperta`"
                title="Affianca: aprila accanto alla conversazione aperta"
                @click="emit('split', conversation.id)"
              >
                <Icon name="compare" :size="15" />
              </button>
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
                @click="
                  erasing = null;
                  confirming = conversation.id;
                "
              >
                <Icon name="archive" :size="15" />
              </button>
              <button
                v-if="canErase(conversation)"
                type="button"
                class="rounded-md p-1 text-muted hover:text-danger"
                :aria-label="`Elimina per sempre ${titleOf(conversation)}`"
                title="Elimina per sempre"
                @click="
                  confirming = null;
                  erasing = conversation.id;
                "
              >
                <Icon name="delete" :size="15" />
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
          <DeleteConfirm v-if="erasing === conversation.id" :subject="titleOf(conversation)" :text="ERASE_CONVERSATION_TEXT" @confirm="confirmErase" @cancel="erasing = null" />
          <template v-else>
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2 py-2 text-left md:pr-2"
              :class="[
                conversation.id === selected ? 'border-line-strong bg-surface-2' : conversation.id === beside ? 'border-dashed border-line-strong' : 'border-transparent hover:bg-surface-2',
                touch
                  ? 'min-h-[52px] pr-12 text-[16px] select-none [-webkit-touch-callout:none]'
                  : offersSplit(conversation)
                    ? 'pr-24 md:group-focus-within:pr-24 md:group-hover:pr-24'
                    : 'pr-16 md:group-focus-within:pr-16 md:group-hover:pr-16',
              ]"
              :aria-current="conversation.id === selected ? 'true' : undefined"
              :title="titleOf(conversation)"
              @click="onRowClick(conversation.id)"
              @pointerdown="onDown($event, conversation, true)"
              @pointermove="press.move"
              @pointerup="press.up"
              @pointercancel="press.up"
              @contextmenu="touch ? $event.preventDefault() : undefined"
            >
              <span class="shrink-0 text-warn" title="Chat di sistema"><Icon name="system" :size="14" /></span>
              <span class="min-w-0 flex-1 truncate">{{ titleOf(conversation) }}</span>
              <span v-if="conversation.id === beside" class="sr-only">, affiancata</span>
              <span class="hidden shrink-0 md:inline-flex 3xl:hidden"><LabelBadge :label="conversation.clearance" dot /></span>
              <span class="shrink-0 md:hidden 3xl:inline-flex"><LabelBadge :label="conversation.clearance" /></span>
            </button>
            <button
              v-if="touch"
              type="button"
              class="absolute top-1/2 right-0.5 grid size-11 -translate-y-1/2 place-items-center rounded-lg text-muted"
              :aria-label="`Azioni su ${titleOf(conversation)}`"
              aria-haspopup="dialog"
              @click="sheet = { conversation, system: true }"
            >
              <Icon name="more" :size="20" />
            </button>
            <div v-else class="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md bg-surface-2 transition md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
              <button
                v-if="offersSplit(conversation)"
                type="button"
                class="rounded-md p-1 text-muted hover:text-ink"
                :aria-label="`Affianca ${titleOf(conversation)} alla conversazione aperta`"
                title="Affianca: aprila accanto alla conversazione aperta"
                @click="emit('split', conversation.id)"
              >
                <Icon name="compare" :size="15" />
              </button>
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:text-ink"
                :aria-label="`Archivia ${titleOf(conversation)}`"
                title="Archivia: la ritrovi in Archiviate"
                @click="emit('archive', conversation.id, true)"
              >
                <Icon name="archive" :size="15" />
              </button>
              <button
                type="button"
                class="rounded-md p-1 text-muted hover:text-danger"
                :aria-label="`Elimina per sempre ${titleOf(conversation)}`"
                title="Elimina per sempre"
                @click="erasing = conversation.id"
              >
                <Icon name="delete" :size="15" />
              </button>
            </div>
          </template>
        </li>
      </ul>
    </section>

    <section v-if="archived.length > 0">
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-muted hover:bg-surface-2 hover:text-ink touch:min-h-11"
        :aria-expanded="showArchived"
        @click="showArchived = !showArchived"
      >
        <Icon name="archive" :size="16" />
        <span class="flex-1">Archiviate ({{ archived.length }})</span>
        <span class="transition" :class="showArchived ? 'rotate-90' : ''"><Icon name="expand" :size="14" /></span>
      </button>
      <ul v-if="showArchived" class="mt-1 flex flex-col gap-0.5">
        <li v-for="conversation in archived" :key="conversation.id">
          <DeleteConfirm
            v-if="erasing === conversation.id"
            :subject="titleOf(conversation)"
            :text="ERASE_CONVERSATION_TEXT"
            :extra="sessionNote(conversation)"
            @confirm="confirmErase"
            @cancel="erasing = null"
          />
          <div v-else class="flex items-center gap-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm text-muted touch:min-h-11"
              :class="conversation.id === selected ? 'border-line-strong bg-surface-2 text-ink' : 'border-transparent hover:bg-surface-2'"
              :aria-current="conversation.id === selected ? 'true' : undefined"
              :title="titleOf(conversation)"
              @click="emit('open', conversation.id)"
            >
              <span class="truncate">{{ titleOf(conversation) }}</span>
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-muted hover:text-ink touch:grid touch:size-11 touch:place-items-center"
              :aria-label="`Ripristina ${titleOf(conversation)}`"
              title="Ripristina"
              @click="emit('archive', conversation.id, false)"
            >
              <Icon name="restore" :size="15" />
            </button>
            <button
              type="button"
              class="shrink-0 rounded-md p-1 text-muted hover:text-danger touch:grid touch:size-11 touch:place-items-center"
              :aria-label="`Elimina per sempre ${titleOf(conversation)}`"
              title="Elimina per sempre"
              @click="erasing = conversation.id"
            >
              <Icon name="delete" :size="15" />
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- The actions of a row on the phone (D-293): a sheet at the bottom, over the line of home. -->
    <Teleport to="body">
      <div v-if="sheet !== null" class="fixed inset-0 z-50 bg-black/50" aria-hidden="true" @click="closeSheet" />
      <div
        v-if="sheet !== null"
        ref="sheetBox"
        role="dialog"
        @keydown="trapTab"
        aria-modal="true"
        :aria-label="`Azioni su ${titleOf(sheet.conversation)}`"
        class="fixed inset-x-2 bottom-[calc(var(--safe-bottom)+0.5rem)] z-50 flex flex-col gap-2"
      >
        <div class="overflow-hidden rounded-2xl border border-line-strong bg-surface">
          <p class="truncate border-b border-line px-4 py-3 text-center text-[14px] text-muted">{{ titleOf(sheet.conversation) }}</p>
          <button v-if="!sheet.system" type="button" class="flex min-h-[54px] w-full items-center gap-3 border-b border-line px-5 text-left text-[17px]" @click="sheetAction('pin')">
            <Icon :name="sheet.conversation.pinnedAt === null ? 'pin' : 'unpin'" :size="20" />{{ sheet.conversation.pinnedAt === null ? 'Fissa in alto' : 'Togli dalle fissate' }}
          </button>
          <button v-if="!sheet.system" type="button" class="flex min-h-[54px] w-full items-center gap-3 border-b border-line px-5 text-left text-[17px]" @click="sheetAction('rename')">
            <Icon name="rename" :size="20" />Rinomina
          </button>
          <button v-if="!sheet.conversation.telegram" type="button" class="flex min-h-[54px] w-full items-center gap-3 border-b border-line px-5 text-left text-[17px]" @click="sheetAction('archive')">
            <Icon name="archive" :size="20" />Archivia
          </button>
          <button v-if="sheet.system || canErase(sheet.conversation)" type="button" class="flex min-h-[54px] w-full items-center gap-3 px-5 text-left text-[17px] text-danger" @click="sheetAction('erase')">
            <Icon name="delete" :size="20" />Elimina per sempre…
          </button>
        </div>
        <button type="button" class="min-h-[56px] rounded-2xl border border-line-strong bg-surface-2 text-[17px] font-semibold text-accent" @click="closeSheet">Annulla</button>
      </div>
    </Teleport>
  </nav>
</template>
