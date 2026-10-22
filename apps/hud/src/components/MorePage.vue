<script setup lang="ts">
import { computed } from 'vue';

import { pendingBadge, pendingText } from '../lib/dev-progress.ts';
import type { InstallationInfo } from '../lib/installation.ts';
import type { LiveState } from '../lib/live.ts';
import { AREAS, type NavArea } from '../lib/nav-groups.ts';
import { moreGroups } from '../lib/phone-nav.ts';
import { THEME_TEXT, type Theme } from '../lib/theme.ts';
import type { StatusSnapshot } from '../lib/types.ts';
import Icon from './Icon.vue';
import InstallationBadge from './InstallationBadge.vue';

/**
 * «Altro» on the phone (D-293, tappa 2): the areas of the left bar in their
 * groups, without those already in the bar at the bottom; the state of the
 * link and of the gateway, the theme (on the Mac it is a button of the top
 * bar) and what this installation is.
 */
const props = defineProps<{
  live: LiveState;
  status: StatusSnapshot | null;
  installation?: InstallationInfo | undefined;
  devPending: number;
  omlxUpdate?: string | null;
  theme: Theme;
}>();
const emit = defineEmits<{ go: [area: NavArea]; theme: [theme: Theme] }>();

const groups = moreGroups();
const devDot = computed(() => pendingBadge(props.devPending));
const devLabel = computed(() => pendingText(props.devPending));
const THEME_ORDER: readonly Theme[] = ['light', 'dark', 'system'];
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-xl flex-col gap-2 px-4 pt-3 pb-8">
      <div class="flex items-center gap-2">
        <span class="inline-flex flex-1 items-center gap-1.5 font-mono text-[12px] tracking-[0.06em] text-muted">
          <span class="size-[7px] rounded-full" :class="live === 'open' ? 'bg-ok shadow-[0_0_8px_var(--ok)]' : 'animate-hud-blink bg-warn'" aria-hidden="true" />
          {{ live === 'open' ? 'IN LINEA' : 'RICONNESSIONE…' }}
        </span>
        <InstallationBadge v-if="installation !== undefined" :info="installation" />
      </div>
      <p v-if="status !== null" class="flex items-start gap-2 rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-[14px] text-muted">
        <span :class="status.gateway.privateOut === 0 ? 'text-ok' : 'text-danger'"><Icon name="gateway" :size="18" /></span>
        <span v-if="status.gateway.privateOut === 0">Gateway attivo · nessun dato Privato o Segreto è uscito oggi</span>
        <span v-else class="text-danger">{{ status.gateway.privateOut }} uscite di dati Privati o Segreti oggi: controlla il registro</span>
      </p>

      <section v-for="group in groups" :key="group.id" :aria-labelledby="`more-${group.id}`">
        <h2 :id="`more-${group.id}`" class="hud-title px-1 pt-3 pb-1.5">{{ group.title }}</h2>
        <ul class="overflow-hidden rounded-[14px] border border-line bg-surface">
          <li v-for="area in group.areas" :key="area" class="border-b border-line last:border-b-0">
            <button type="button" class="flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2 text-left text-[16px]" @click="emit('go', area)">
              <span class="grid size-8 shrink-0 place-items-center rounded-[9px] border border-line bg-surface-2 text-accent"><Icon :name="AREAS[area].icon" :size="18" /></span>
              <span class="min-w-0 flex-1 truncate">{{ AREAS[area].label }}</span>
              <span
                v-if="area === 'settings' && devDot !== null"
                role="img"
                class="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[12px] leading-5 font-semibold text-accent-ink"
                :aria-label="devLabel ?? undefined"
              >{{ devDot }}</span>
              <span v-if="area === 'followed' && omlxUpdate" role="img" class="size-2 rounded-full bg-accent" :aria-label="omlxUpdate" />
              <span class="text-muted"><Icon name="expand" :size="18" /></span>
            </button>
          </li>
        </ul>
      </section>

      <section aria-labelledby="more-theme">
        <h2 id="more-theme" class="hud-title px-1 pt-3 pb-1.5">Tema</h2>
        <div class="flex rounded-xl border border-line bg-surface-2 p-[3px]" role="radiogroup" aria-labelledby="more-theme">
          <button
            v-for="choice in THEME_ORDER"
            :key="choice"
            type="button"
            role="radio"
            :aria-checked="theme === choice"
            class="h-10 flex-1 rounded-[9px] text-[15px]"
            :class="theme === choice ? 'bg-surface font-semibold text-ink shadow-[0_1px_3px_#0003]' : 'text-muted'"
            @click="emit('theme', choice)"
          >
            {{ THEME_TEXT[choice] }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
