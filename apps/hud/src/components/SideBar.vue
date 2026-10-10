<script setup lang="ts">
import { computed } from 'vue';

import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import type { LiveState } from '../lib/live.ts';
import type { Conversation, StatusSnapshot } from '../lib/types.ts';
import ConversationList from './ConversationList.vue';
import Icon from './Icon.vue';

/**
 * The left bar (D-097), as in Claude Code, from the top: fold button, the
 * name with the light of the link to the core; "Cerca"; the areas (Nuovo,
 * Segretaria, Pensieri, Conoscenza, Progetti, Cardwall, Ufficio, Impostazioni); the
 * conversations, pinned first. The theme and the agents are in the top bar
 * (D-158).
 */
const props = defineProps<{
  live: LiveState;
  page: 'chat' | 'voice-trial' | 'settings' | 'knowledge' | 'thoughts' | 'office' | 'projects' | 'cardwall';
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
}>();
const emit = defineEmits<{
  fold: [];
  home: [];
  search: [];
  create: [];
  secretary: [];
  thoughts: [];
  knowledge: [];
  projects: [];
  cardwall: [];
  office: [];
  settings: [];
  open: [id: string];
  archive: [id: string, archived: boolean];
  pin: [id: string, pinned: boolean];
  erase: [id: string];
}>();

const devDot = computed(() => pendingBadge(props.devPending));
const devLabel = computed(() => pendingText(props.devPending));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = isMac ? '⌘K' : 'Ctrl K';

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
      <span class="inline-flex shrink-0 items-center gap-1.5 pr-1 font-mono text-[10px] whitespace-nowrap text-muted" :title="live === 'open' ? 'Collegata al nucleo' : 'Riconnessione in corso'">
        <span class="size-[7px] rounded-full" :class="live === 'open' ? 'bg-ok shadow-[0_0_8px_var(--ok)]' : 'animate-hud-blink bg-warn'" />
        {{ live === 'open' ? 'IN LINEA' : 'RICONN.' }}
      </span>
    </div>

    <!-- Cerca: a window in the middle of the page. -->
    <button
      type="button"
      class="field flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-muted hover:border-line-strong"
      aria-haspopup="dialog"
      @click="emit('search')"
    >
      <Icon name="search" :size="15" />
      <span class="flex-1">Cerca</span>
      <kbd class="font-mono text-[10px] tracking-[0.04em]">{{ shortcut }}</kbd>
    </button>

    <!-- Areas -->
    <nav aria-label="Aree" class="flex flex-col gap-0.5 text-[13.5px]">
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-muted hover:bg-surface-2 hover:text-ink" aria-haspopup="dialog" @click="emit('create')">
        <span class="text-accent"><Icon name="new" :size="16" /></span>Nuovo
      </button>
      <!-- The secretary (I-12, D-144): always here, opens its one private conversation. -->
      <button
        type="button"
        class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
        :class="itemClass(secretaryOpen)"
        :aria-current="secretaryOpen ? 'page' : undefined"
        title="Di’ ad Arianna le cose da fare: le segna con il giorno"
        @click="emit('secretary')"
      >
        <Icon name="secretary" :size="16" />Segretaria
      </button>
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left" :class="itemClass(page === 'thoughts')" :aria-current="page === 'thoughts' ? 'page' : undefined" @click="emit('thoughts')">
        <Icon name="thoughts" :size="16" />Pensieri
      </button>
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left" :class="itemClass(page === 'knowledge')" :aria-current="page === 'knowledge' ? 'page' : undefined" @click="emit('knowledge')">
        <Icon name="knowledge" :size="16" />Conoscenza
      </button>
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left" :class="itemClass(page === 'projects')" :aria-current="page === 'projects' ? 'page' : undefined" @click="emit('projects')">
        <Icon name="project" :size="16" />Progetti
      </button>
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left" :class="itemClass(page === 'cardwall')" :aria-current="page === 'cardwall' ? 'page' : undefined" @click="emit('cardwall')">
        <Icon name="cardwall" :size="16" />Cardwall
      </button>
      <button type="button" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left" :class="itemClass(page === 'office')" :aria-current="page === 'office' ? 'page' : undefined" @click="emit('office')">
        <Icon name="office" :size="16" />Ufficio
      </button>
      <button
        type="button"
        class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left"
        :class="itemClass(page === 'settings' || page === 'voice-trial')"
        :aria-current="page === 'settings' || page === 'voice-trial' ? 'page' : undefined"
        @click="emit('settings')"
      >
        <Icon name="settings" :size="16" />Impostazioni
        <!-- Questions of "Sviluppo di Arianna" that wait for an answer (D-120). -->
        <span
          v-if="devDot !== null"
          role="img"
          class="ml-auto grid min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[10.5px] leading-5 font-semibold text-accent-ink"
          :title="devLabel ?? undefined"
          :aria-label="devLabel ?? undefined"
        >{{ devDot }}</span>
      </button>
    </nav>

    <ConversationList
      :conversations="conversations"
      :archived="archived"
      :system="systemChats"
      :selected="selected"
      :rename="rename"
      @open="(id) => emit('open', id)"
      @archive="(id, value) => emit('archive', id, value)"
      @pin="(id, value) => emit('pin', id, value)"
      @erase="(id) => emit('erase', id)"
    />

    <p v-if="status !== null" class="mt-auto px-1.5 font-mono text-[10px] leading-relaxed text-muted">
      Gateway attivo ·
      <template v-if="status.gateway.privateOut === 0">nessun dato Privato o Segreto è uscito oggi</template>
      <span v-else class="text-danger">{{ status.gateway.privateOut }} uscite di dati Privati o Segreti oggi: controlla il registro</span>
    </p>
  </aside>
</template>
