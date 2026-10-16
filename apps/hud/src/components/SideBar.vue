<script setup lang="ts">
import { computed, ref } from 'vue';

import type { IconName } from '../icons.ts';
import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import { NAV_GROUPS, NAV_STORAGE_KEY, groupOf, isOpen, parseOpen, toggle, type NavArea, type NavGroupId } from '../lib/nav-groups.ts';
import type { LiveState } from '../lib/live.ts';
import type { Conversation, StatusSnapshot } from '../lib/types.ts';
import ConversationList from './ConversationList.vue';
import Icon from './Icon.vue';

/**
 * The left bar (D-097), as in Claude Code, from the top: fold button, the
 * name with the light of the link to the core; "Cerca"; "Nuova conversazione";
 * the areas in three groups that fold (lib/nav-groups.ts); the
 * conversations, pinned first. The theme and the agents are in the top bar
 * (D-158).
 */
const props = defineProps<{
  live: LiveState;
  page: 'chat' | 'voice-trial' | 'settings' | 'knowledge' | 'thoughts' | 'god' | 'office' | 'projects' | 'clients' | 'finance' | 'cardwall' | 'studio' | 'dashboard';
  conversations: Conversation[];
  archived: Conversation[];
  systemChats: Conversation[];
  selected: string | null;
  rename: (id: string, title: string) => Promise<boolean>;
  status: StatusSnapshot | null;
  /** Open questions of "Sviluppo di Arianna" without an answer (D-120): a dot on "Impostazioni". */
  devPending: number;
  /** The secretary's conversation is the one open (D-144): its button is marked. */
  secretaryOpen: boolean;
  /** «Affianca» (D-234): the conversation beside the open one, and on which ones it is offered. */
  beside?: string | null | undefined;
  splittable?: ((conversation: Conversation) => boolean) | undefined;
}>();
const emit = defineEmits<{
  fold: [];
  home: [];
  search: [];
  create: [];
  secretary: [];
  god: [];
  thoughts: [];
  /** The Cruscotto (D-248). */
  dashboard: [];
  knowledge: [];
  projects: [];
  clients: [];
  finance: [];
  cardwall: [];
  studio: [];
  office: [];
  settings: [];
  open: [id: string];
  archive: [id: string, archived: boolean];
  pin: [id: string, pinned: boolean];
  erase: [id: string];
  /** «Affianca» on a conversation of the list (D-234). */
  split: [id: string];
}>();

const devDot = computed(() => pendingBadge(props.devPending));
const devLabel = computed(() => pendingText(props.devPending));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = isMac ? '⌘K' : 'Ctrl K';

const AREAS: Record<NavArea, { label: string; icon: IconName; title?: string }> = {
  // The Cruscotto (D-248): the answers pinned from the chat, refreshed on the local model.
  dashboard: { label: 'Cruscotto', icon: 'dashboard', title: 'Le risposte fissate dalla chat, da aggiornare col modello locale' },
  secretary: { label: 'Segretaria', icon: 'secretary', title: 'Di’ ad Arianna le cose da fare: le segna con il giorno' },
  projects: { label: 'Progetti', icon: 'project' },
  clients: { label: 'Clienti', icon: 'clients' },
  cardwall: { label: 'Cardwall', icon: 'cardwall' },
  // The Studio (I-19, D-184): the Designer's mockups, isolated, with comments and exports.
  studio: { label: 'Studio', icon: 'studio' },
  thoughts: { label: 'Pensieri', icon: 'thoughts' },
  knowledge: { label: 'Conoscenza', icon: 'knowledge' },
  // The finances (I-18, D-183): private, they never leave this Mac.
  finance: { label: 'Finanze', icon: 'finance' },
  // GOD (D-127): Arianna developed from inside Arianna, in a clone of its code.
  god: { label: 'GOD', icon: 'god', title: 'Sviluppa Arianna da dentro Arianna, in un clone del suo codice' },
  office: { label: 'Ufficio', icon: 'office' },
  settings: { label: 'Impostazioni', icon: 'settings' },
};

/** The area in view: the secretary is a conversation, the voice trial a part of the settings. */
const current = computed<NavArea | null>(() => {
  if (props.secretaryOpen) return 'secretary';
  if (props.page === 'voice-trial') return 'settings';
  return props.page === 'chat' ? null : props.page;
});

function readOpen(): NavGroupId[] {
  try {
    return parseOpen(localStorage.getItem(NAV_STORAGE_KEY));
  } catch {
    return parseOpen(null);
  }
}
const openGroups = ref<NavGroupId[]>(readOpen());

function fold(group: NavGroupId): void {
  openGroups.value = toggle(openGroups.value, group);
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(openGroups.value));
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
}

function go(area: NavArea): void {
  switch (area) {
    case 'dashboard': emit('dashboard'); break;
    case 'secretary': emit('secretary'); break;
    case 'projects': emit('projects'); break;
    case 'clients': emit('clients'); break;
    case 'cardwall': emit('cardwall'); break;
    case 'studio': emit('studio'); break;
    case 'thoughts': emit('thoughts'); break;
    case 'knowledge': emit('knowledge'); break;
    case 'finance': emit('finance'); break;
    case 'god': emit('god'); break;
    case 'office': emit('office'); break;
    case 'settings': emit('settings'); break;
  }
}

function itemClass(on: boolean): string {
  return on ? 'bg-surface-2 text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'text-muted hover:bg-surface-2 hover:text-ink';
}
</script>

<template>
  <aside class="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-line bg-surface px-3 py-3.5" aria-label="Barra di Arianna">
    <!-- Fold, logo and name, light of the core. -->
    <div class="flex items-center gap-1.5">
      <button
        type="button"
        class="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
        aria-label="Chiudi la barra"
        title="Chiudi la barra"
        @click="emit('fold')"
      >
        <span class="hidden md:inline"><Icon name="sidebar-collapse" /></span><span class="md:hidden"><Icon name="close" /></span>
      </button>
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-2" title="Torna alla chat" @click="emit('home')">
        <span class="font-hud text-[17px] leading-none font-semibold tracking-[0.08em] uppercase">Arianna</span>
      </button>
      <span class="inline-flex shrink-0 items-center gap-1.5 pr-1 font-mono text-[12px] whitespace-nowrap text-muted" :title="live === 'open' ? 'Collegata ad Arianna' : 'Riconnessione in corso'">
        <span class="size-[7px] rounded-full" :class="live === 'open' ? 'bg-ok shadow-[0_0_8px_var(--ok)]' : 'animate-hud-blink bg-warn'" />
        {{ live === 'open' ? 'IN LINEA' : 'RICONN.' }}
      </span>
    </div>

    <!-- Cerca: a window in the middle of the page. -->
    <button
      type="button"
      class="field flex items-center gap-2 px-2.5 py-1.5 text-left text-[14px] text-muted hover:border-line-strong"
      aria-haspopup="dialog"
      @click="emit('search')"
    >
      <Icon name="search" :size="15" />
      <span class="flex-1">Cerca</span>
      <kbd class="font-mono text-[12px] tracking-[0.04em]">{{ shortcut }}</kbd>
    </button>

    <button
      type="button"
      class="flex items-center justify-center gap-2 rounded-lg bg-accent px-2 py-1.5 text-[14.5px] font-semibold text-accent-ink hover:opacity-90"
      aria-haspopup="dialog"
      @click="emit('create')"
    >
      <Icon name="new" :size="16" />Nuova conversazione
    </button>

    <!-- Areas in three groups that fold; the group of the page in view stays open. -->
    <nav aria-label="Aree" class="flex flex-col gap-1 text-[14.5px]">
      <div v-for="group in NAV_GROUPS" :key="group.id" class="flex flex-col gap-0.5">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md px-2 pt-1 pb-0.5 text-left text-[12px] font-semibold tracking-[0.08em] text-muted uppercase hover:text-ink"
          :aria-expanded="isOpen(group.id, openGroups, current)"
          :title="groupOf(current) === group.id ? 'Resta aperto finché sei in una sua pagina' : undefined"
          @click="fold(group.id)"
        >
          <span class="transition-transform" :class="isOpen(group.id, openGroups, current) ? 'rotate-90' : ''"><Icon name="expand" :size="12" /></span>
          {{ group.title }}
          <!-- Questions of "Sviluppo di Arianna" still visible with "Sistema" folded. -->
          <span v-if="group.id === 'system' && devDot !== null && !isOpen(group.id, openGroups, current)" role="img" class="ml-auto size-2 rounded-full bg-accent" :title="devLabel ?? undefined" :aria-label="devLabel ?? undefined" />
        </button>
        <template v-if="isOpen(group.id, openGroups, current)">
          <button
            v-for="area in group.areas"
            :key="area"
            type="button"
            class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
            :class="itemClass(current === area)"
            :aria-current="current === area ? 'page' : undefined"
            :title="AREAS[area].title"
            @click="go(area)"
          >
            <Icon :name="AREAS[area].icon" :size="16" />{{ AREAS[area].label }}
            <!-- Questions of "Sviluppo di Arianna" that wait for an answer (D-120). -->
            <span
              v-if="area === 'settings' && devDot !== null"
              role="img"
              class="ml-auto grid min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[12px] leading-5 font-semibold text-accent-ink"
              :title="devLabel ?? undefined"
              :aria-label="devLabel ?? undefined"
            >{{ devDot }}</span>
          </button>
        </template>
      </div>
    </nav>

    <ConversationList
      :conversations="conversations"
      :archived="archived"
      :system="systemChats"
      :selected="selected"
      :rename="rename"
      :beside="beside"
      :splittable="splittable"
      @split="(id) => emit('split', id)"
      @open="(id) => emit('open', id)"
      @archive="(id, value) => emit('archive', id, value)"
      @pin="(id, value) => emit('pin', id, value)"
      @erase="(id) => emit('erase', id)"
    />

    <p v-if="status !== null" class="mt-auto px-1.5 font-mono text-[12px] leading-relaxed text-muted">
      Gateway attivo ·
      <template v-if="status.gateway.privateOut === 0">nessun dato Privato o Segreto è uscito oggi</template>
      <span v-else class="text-danger">{{ status.gateway.privateOut }} uscite di dati Privati o Segreti oggi: controlla il registro</span>
    </p>
  </aside>
</template>
