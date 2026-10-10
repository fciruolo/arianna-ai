<script setup lang="ts">
/**
 * One card of the settings page (D-071): title, what kind of change it is,
 * its fields, and a footer with Annulla and Salva (or "Rivedi le uscite…"
 * for a privacy section), active only once the card was changed.
 */
defineProps<{
  id: string;
  title: string;
  /** `browser`: a choice of this browser only, applied at the click, without Salva (D-158). */
  kind: 'now' | 'privacy' | 'read' | 'browser';
  changed?: boolean;
  busy?: boolean;
  /** Saved a moment ago: the footer says so until the card changes again. */
  saved?: boolean;
  error?: string | null | undefined;
  /** Why the card cannot be saved as it is. */
  invalid?: string | undefined;
}>();
const emit = defineEmits<{ cancel: []; save: [] }>();

const TAG = { now: 'SUBITO', privacy: 'CON CONFERMA', read: 'SOLO LETTURA', browser: 'IN QUESTO BROWSER' } as const;
const TAG_CLASS = { now: 'text-ok', privacy: 'text-warn', read: 'text-muted', browser: 'text-ok' } as const;
</script>

<template>
  <section :id="id" class="hud-card scroll-mt-4" :class="{ warn: kind === 'privacy' }" :aria-labelledby="`${id}-title`">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 :id="`${id}-title`" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">{{ title }}</h2>
      <slot name="header" />
      <span class="rounded-[5px] border border-current px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.06em]" :class="TAG_CLASS[kind]">{{ TAG[kind] }}</span>
    </header>
    <!-- Locked while saving: what is typed meanwhile would be overwritten by the answer. -->
    <fieldset :disabled="busy" class="m-0 flex min-w-0 flex-col gap-3 border-0 px-4 py-3.5">
      <slot />
    </fieldset>
    <footer v-if="kind !== 'read' && kind !== 'browser'" class="flex flex-wrap items-center gap-2.5 rounded-b-[14px] border-t border-line bg-surface-2 px-4 py-2.5">
      <p class="min-w-0 flex-1 text-xs" :class="error || (changed && invalid) ? 'text-danger' : changed ? 'text-warn' : saved ? 'text-ok' : 'text-muted'" :role="error ? 'alert' : undefined">
        {{ error ?? (busy ? 'Un momento…' : changed && invalid ? invalid : changed ? (kind === 'privacy' ? 'Modifica da confermare' : 'Modifiche non salvate') : saved ? (kind === 'privacy' ? 'Confermato e salvato' : 'Salvato') : 'Nessuna modifica') }}
      </p>
      <button type="button" class="btn px-3 py-1.5 text-[13px]" :disabled="!changed || busy" @click="emit('cancel')">Annulla</button>
      <button
        type="button"
        class="btn px-3 py-1.5 text-[13px]"
        :class="kind === 'privacy' ? 'btn-warn' : 'btn-primary'"
        :disabled="!changed || busy || invalid !== undefined"
        @click="emit('save')"
      >
        {{ kind === 'privacy' ? 'Rivedi le uscite…' : 'Salva' }}
      </button>
    </footer>
  </section>
</template>
