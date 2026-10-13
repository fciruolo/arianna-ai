<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { testNotice } from '../lib/api.ts';
import { askPermission, permissionNow } from '../lib/notices.ts';
import { enablePush, pushState, type PushState } from '../lib/push.ts';
import Icon from './Icon.vue';

/**
 * This browser and the notifications (I-1): what it allows, and whether it
 * is subscribed to Web Push for when the chat is closed. Nothing here goes in
 * arianna.toml: each browser and each phone answers for itself. Permission is
 * asked only from these buttons.
 */
const permission = ref<NotificationPermission | 'unsupported'>('default');
const push = ref<{ state: PushState; key: string | null }>({ state: 'off', key: null });
const problem = ref<string | null>(null);
const working = ref(false);
/** What the last trial did. */
const sent = ref<string | null>(null);
const trying = ref(false);

onMounted(() => {
  permission.value = permissionNow();
  void pushState()
    .then((value) => {
      push.value = value;
    })
    .catch(() => undefined);
});

async function allow(): Promise<void> {
  problem.value = null;
  permission.value = await askPermission();
}

const TRIALS = [
  { kind: 'reply', label: 'Risposta' },
  { kind: 'approval', label: 'Approvazione' },
  { kind: 'failure', label: 'Lavoro fallito' },
] as const;

/** Asks the core for a trial notice: it comes back over the live feed and shows as a real one. */
async function trial(kind: (typeof TRIALS)[number]['kind']): Promise<void> {
  if (trying.value) return;
  problem.value = null;
  sent.value = null;
  trying.value = true;
  try {
    const pages = await testNotice(kind);
    if (pages === 0) sent.value = 'Nessuna pagina collegata al core: ricarica la chat.';
    else if (permission.value === 'granted') sent.value = 'Mandata: l’avviso compare nella chat e anche fra le notifiche del Mac. Se quella non arriva, controlla “Non disturbare” e il browser in Impostazioni di Sistema → Notifiche.';
    else sent.value = 'Mandata: l’avviso compare nella chat. Per la notifica del Mac serve il permesso del browser.';
  } catch {
    problem.value = 'Il core non ha mandato la notifica di prova.';
  } finally {
    trying.value = false;
  }
}

async function subscribe(): Promise<void> {
  if (push.value.key === null) return;
  problem.value = null;
  working.value = true;
  try {
    push.value = { ...push.value, state: await enablePush(push.value.key) };
    permission.value = permissionNow();
  } catch {
    problem.value = 'Il browser non ha completato l’iscrizione alle notifiche.';
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <!-- Revised in D-192: «Questo browser», applied at once without Salva; the keys for the chat closed come in the slot (Avanzate). -->
  <section id="notifications-device" class="min-w-0 scroll-mt-4 rounded-xl border border-line bg-surface-2 p-4" aria-labelledby="notifications-device-title">
    <h2 class="mb-1 flex flex-wrap items-center gap-2.5 text-[16px] font-semibold">
      <span id="notifications-device-title">Questo browser</span>
      <span class="pill ml-auto border-ok/50 font-normal text-ok">Vale subito, solo qui</span>
    </h2>
    <p class="mb-3 text-[14px] text-muted">Queste scelte valgono solo per il browser che stai usando ora e non hanno bisogno di «Salva».</p>
    <div class="flex flex-col">
      <div class="flex flex-wrap items-center gap-3 pb-2.5">
        <div class="min-w-[220px] flex-1">
          <b class="font-semibold">Con la chat aperta in un’altra scheda</b>
          <p v-if="permission === 'unsupported'" class="text-[13px] text-muted">Questo browser non mostra notifiche.</p>
          <p v-else-if="permission === 'denied'" class="text-[13px] text-muted">Bloccate per questo sito: riattivale dalle impostazioni del browser.</p>
          <p v-else-if="permission === 'granted'" class="text-[13px] text-ok">Consentite</p>
          <p v-else class="text-[13px] text-muted">Non ancora consentite.</p>
        </div>
        <button v-if="permission === 'default'" type="button" class="btn px-2.5 py-1 text-[13px]" @click="allow"><Icon name="bell" :size="14" />Consenti</button>
      </div>
      <div class="flex flex-wrap items-center gap-2 border-t border-line py-2.5">
        <span class="text-[14px] text-muted">Prova una notifica:</span>
        <button v-for="item in TRIALS" :key="item.kind" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="trying" @click="trial(item.kind)">{{ item.label }}</button>
      </div>
      <p v-if="sent !== null" role="status" class="pb-2 text-[13px] text-muted">{{ sent }}</p>
      <div class="flex flex-wrap items-center gap-3 border-t border-line py-2.5">
        <div class="min-w-[220px] flex-1">
          <b class="font-semibold">Con la chat chiusa, anche sul telefono</b>
          <p v-if="push.state === 'off'" class="text-[13px] text-muted">Spente: manca la chiave del Mac (vedi Avanzate qui sotto).</p>
          <p v-else-if="push.state === 'unsupported'" class="text-[13px] text-muted">Questo browser non le supporta (sul telefono servono HTTPS e la VPN).</p>
          <p v-else-if="push.state === 'denied'" class="text-[13px] text-muted">Bloccate per questo sito nelle impostazioni del browser.</p>
          <p v-else-if="push.state === 'on'" class="text-[13px] text-ok">Questo dispositivo è iscritto.</p>
          <p v-else class="text-[13px] text-muted">Pronte: iscrivi questo dispositivo per riceverle.</p>
        </div>
        <button v-if="push.state !== 'on'" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="working || push.state !== 'available'" @click="subscribe">Iscrivi questo dispositivo</button>
      </div>
    </div>
    <p v-if="problem !== null" role="alert" class="text-[14px] text-danger">{{ problem }}</p>
    <p class="mt-1 text-[13px] text-muted">
      La notifica dice solo «Arianna ha risposto», «Arianna aspetta una tua decisione», «Un lavoro è fallito» o «Arianna ha un promemoria», con il link alla conversazione: mai il testo
      né il titolo. Con la chat chiusa passa dal servizio del browser (Apple, Google o Mozilla), senza contenuto.
    </p>
    <slot />
  </section>
</template>
