<script setup lang="ts">
import { computed } from 'vue';

import { agentName } from '../lib/italian.ts';
import { BASE_NAME, BASE_THEME, themeProperties, type ChatTheme, type ThemeListing } from '../lib/themes.ts';
import type { CharacterChoice, CharacterListing } from '../lib/types.ts';
import PixelAgent from './PixelAgent.vue';

/**
 * The themes of the chat (D-103) in Impostazioni → Aspetto: one card per
 * theme with a small live preview (background, a bubble, the L2 label, the
 * accent, Arianna in the costume), Base first. A click chooses: the page
 * saves `[appearance]` at once, for every device. Names and descriptions are
 * shown as text, never as HTML.
 */
const props = defineProps<{
  listing: ThemeListing | null;
  /** The theme in `[appearance]`, as the page holds it. */
  chosen: string;
  characters: CharacterListing | null;
  /** The mode on screen: the preview shows the colours of that one. */
  mode: 'dark' | 'light';
  busy: boolean;
}>();
const emit = defineEmits<{ choose: [id: string] }>();

interface Card {
  id: string;
  name: string;
  description: string;
  style: Record<string, string>;
  arianna: CharacterChoice;
}

function cardOf(theme: ChatTheme | undefined): Card {
  const style: Record<string, string> = {};
  for (const [name, value] of themeProperties(theme, props.mode)) style[name] = value;
  const costume = theme?.characters.arianna?.split('/');
  const pack = props.characters?.packs.find((entry) => entry.id === costume?.[0]);
  const found = pack?.characters.find((entry) => entry.id === costume?.[1]);
  return {
    id: theme?.id ?? BASE_THEME,
    name: theme?.name ?? BASE_NAME,
    description: theme?.description ?? 'La chat com’è: verde acqua sul fondo scuro, caldo nel chiaro.',
    style,
    arianna: found !== undefined && pack !== undefined ? { pack: pack.id, character: found.id, rows: found.rows } : { pack: 'originali', character: 'arianna', rows: 4 },
  };
}

const cards = computed<Card[]>(() => [cardOf(undefined), ...(props.listing?.themes ?? []).map(cardOf)]);
const missing = computed(() => (props.listing !== null && props.chosen !== BASE_THEME && props.listing.current === BASE_THEME ? props.chosen : null));

/** Who wears what, and where it comes from (D-103, punto 6). */
const SOURCE_TEXT = { theme: 'costume del tema', choice: 'scelto da te in Agenti', original: 'originale' } as const;
const wearers = computed(() =>
  Object.entries(props.characters?.agents ?? {})
    .filter(([agent]) => agent === 'arianna' || agent === 'coder')
    .map(([agent, choice]) => ({ agent, name: agentName(agent), from: SOURCE_TEXT[choice.from ?? 'original'] })),
);
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="missing !== null" class="text-[14px] text-warn">Il tema «{{ missing }}» non c’è o non è valido: è in uso Base.</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Tema">
      <button
        v-for="card in cards"
        :key="card.id"
        type="button"
        role="radio"
        :aria-checked="chosen === card.id"
        :disabled="busy"
        class="flex flex-col overflow-hidden rounded-xl border text-left transition-colors"
        :class="chosen === card.id ? 'border-accent ring-1 ring-accent' : 'border-line-strong hover:border-accent/60'"
        @click="emit('choose', card.id)"
      >
        <!-- The preview: the tokens of the theme on this box only. -->
        <div class="flex items-end gap-3 px-3 pt-3 pb-2" :style="{ ...card.style, background: 'var(--bg)', color: 'var(--ink)' }" aria-hidden="true">
          <PixelAgent :choice="card.arianna" pose="idle" :scale="2" />
          <div class="flex min-w-0 flex-1 flex-col items-end gap-1.5 pb-1">
            <span class="rounded-[10px] px-2.5 py-1 text-[13px]" style="background: var(--bubble); color: var(--bubble-ink)">Ciao Arianna</span>
            <span class="flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[12.5px]" style="background: var(--surface); color: var(--ink)">
              <span class="lab" style="color: var(--l2)">L2</span>
              <span class="h-2 w-2 rounded-full" style="background: var(--accent)" />
              <span style="color: var(--muted)">Privata</span>
            </span>
          </div>
        </div>
        <div class="flex flex-col gap-0.5 border-t border-line bg-surface px-3 py-2">
          <span class="flex items-center gap-2 text-[14.5px] font-semibold">
            {{ card.name }}
            <span v-if="chosen === card.id" class="pill text-ok border-ok/50">in uso</span>
          </span>
          <span class="text-[13px] text-muted">{{ card.description }}</span>
        </div>
      </button>
    </div>
    <p class="text-[13px] text-muted">
      Il tema vale su tutti i dispositivi; chiaro o scuro resta di questo browser. Contrasto dei temi verificato (WCAG AA).
      <template v-for="(wearer, index) in wearers" :key="wearer.agent">{{ index === 0 ? ' ' : ' · ' }}{{ wearer.name }}: {{ wearer.from }}</template>
    </p>
    <p v-if="(listing?.refused.length ?? 0) > 0" class="text-[13px] text-muted">
      Temi non validi:
      <template v-for="(item, index) in listing?.refused ?? []" :key="item.theme">{{ index === 0 ? '' : '; ' }}{{ item.theme }} ({{ item.reason }})</template>
    </p>
  </div>
</template>
