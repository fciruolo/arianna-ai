<script setup lang="ts">
/**
 * A description of the catalog in Italian (D-185, D-196), with «Originale»
 * to read the text as its authors wrote it, and «In italiano» to go back.
 * Without a translation the original shows, with no button.
 */
import { ref } from 'vue';

const props = defineProps<{ original: string; italian?: string | undefined }>();
const showOriginal = ref(false);
</script>

<template>
  <span>
    {{ props.italian === undefined || showOriginal ? props.original : props.italian }}
    <button
      v-if="props.italian !== undefined"
      type="button"
      class="ml-1 text-[12px] text-accent hover:underline"
      :title="showOriginal ? 'Torna alla traduzione italiana' : 'Mostra il testo come l’hanno scritto gli autori'"
      @click.stop="showOriginal = !showOriginal"
    >{{ showOriginal ? 'In italiano' : 'Originale' }}</button>
  </span>
</template>
