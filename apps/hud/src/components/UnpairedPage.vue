<script setup lang="ts">
import { onMounted } from 'vue';

/**
 * The chat from the phone before stage B of D-292: the remote port serves the
 * page but no device can be paired yet, so nothing of the chat is read.
 */
const emit = defineEmits<{ retry: [] }>();

onMounted(() => {
  document.title = 'Arianna';
});
</script>

<template>
  <main class="grid min-h-dvh place-items-center bg-bg px-6 py-10 text-ink">
    <section class="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
      <img src="/logo.svg" alt="" class="size-14 rounded-2xl" />
      <h1 class="text-[18px] font-semibold">Dispositivo non abbinato</h1>
      <p class="text-[14.5px] leading-relaxed text-muted">
        Questo telefono raggiunge Arianna, ma non è ancora abbinato al Mac. L'abbinamento, con un codice mostrato sul Mac e Face ID, arriva con la tappa B.
      </p>
      <p class="text-[13px] leading-relaxed text-muted">Fino ad allora la chat si usa dal Mac.</p>
      <button type="button" class="btn" @click="emit('retry')">Riprova</button>
    </section>
  </main>
</template>
