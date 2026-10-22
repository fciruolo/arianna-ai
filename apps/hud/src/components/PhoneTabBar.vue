<script setup lang="ts">
import { PHONE_TABS, type PhoneTab } from '../lib/phone-nav.ts';
import Icon from './Icon.vue';

/**
 * The bar at the bottom of the phone (D-293, tappa 2): five entries, the one
 * of the page in view lit. It sits over the line of home (safe area) and
 * only exists below `md`; App.vue hides it inside a conversation and while
 * the keyboard is open.
 */
defineProps<{
  current: PhoneTab;
  /** The number on «Attende te», or null. */
  pending: string | null;
  /** A plain dot on «Altro»: questions of «Sviluppo», a new oMLX. */
  moreDot: string | null;
}>();
const emit = defineEmits<{ select: [tab: PhoneTab] }>();
</script>

<template>
  <nav
    aria-label="Sezioni"
    class="grid shrink-0 grid-cols-5 border-t border-line bg-surface/95 px-1 pb-[var(--safe-bottom)] backdrop-blur-md md:hidden"
  >
    <button
      v-for="tab in PHONE_TABS"
      :key="tab.id"
      type="button"
      class="relative flex h-[56px] min-w-0 flex-col items-center justify-center gap-[3px] text-[12px] font-medium"
      :class="current === tab.id ? 'text-accent' : 'text-muted'"
      :aria-current="current === tab.id ? 'page' : undefined"
      :aria-label="tab.id === 'pending' && pending !== null ? `${tab.label}: ${pending}` : tab.id === 'more' && moreDot !== null ? `${tab.label}. ${moreDot}` : tab.label"
      @click="emit('select', tab.id)"
    >
      <span
        v-if="current === tab.id"
        class="absolute top-[-1px] right-[26%] left-[26%] h-[2px] rounded-b-[2px] bg-accent shadow-[0_0_10px_var(--accent)]"
        aria-hidden="true"
      />
      <Icon :name="tab.icon" :size="24" />
      <span class="max-w-full truncate">{{ tab.label }}</span>
      <span
        v-if="tab.id === 'pending' && pending !== null"
        class="absolute top-[5px] left-[calc(50%+6px)] grid h-[19px] min-w-[19px] place-items-center rounded-full bg-warn px-[5px] font-mono text-[12px] leading-none font-semibold text-[#2a1c02]"
        aria-hidden="true"
      >{{ pending }}</span>
      <span v-if="tab.id === 'more' && moreDot !== null" class="absolute top-[8px] left-[calc(50%+8px)] size-2 rounded-full bg-accent" aria-hidden="true" />
    </button>
  </nav>
</template>
