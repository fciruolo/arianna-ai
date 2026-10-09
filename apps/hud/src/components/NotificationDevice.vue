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
  <section id="notifications-device" class="hud-card scroll-mt-4" aria-labelledby="notifications-device-title">
    <header class="flex items-center gap-2.5 border-b border-line px-4 py-3">
      <h2 id="notifications-device-title" class="flex-1 font-hud text-[12px] leading-none font-semibold tracking-[0.14em] uppercase">Questo dispositivo</h2>
    </header>
    <div class="flex flex-col gap-3 px-4 py-3.5">
      <h3 class="hud-title">Con la chat aperta in un’altra scheda</h3>
      <p v-if="permission === 'unsupported'" class="text-sm text-muted">Questo browser non mostra notifiche.</p>
      <p v-else-if="permission === 'denied'" class="text-sm text-muted">Le notifiche sono bloccate per questo sito: riattivale dalle impostazioni del browser.</p>
      <p v-else-if="permission === 'granted'" class="text-sm text-ok">Consentite in questo browser.</p>
      <button v-else type="button" class="btn self-start" @click="allow"><Icon name="bell" :size="16" />Consenti le notifiche in questo browser</button>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[13px] text-muted">Prova una notifica:</span>
        <button v-for="item in TRIALS" :key="item.kind" type="button" class="btn" :disabled="trying" @click="trial(item.kind)"><Icon name="bell" :size="16" />{{ item.label }}</button>
      </div>
      <p v-if="sent !== null" role="status" class="text-xs text-muted">{{ sent }}</p>

      <h3 class="hud-title mt-1">Con la chat chiusa (Web Push)</h3>
      <p v-if="push.state === 'off'" class="text-sm text-muted">Spente: servono le chiavi di Impostazioni → Voce → Notifiche push (<code class="font-mono text-[12.5px]">pnpm voice:vapid</code>).</p>
      <p v-else-if="push.state === 'unsupported'" class="text-sm text-muted">Questo browser non supporta le notifiche push (sul telefono servono HTTPS e la VPN).</p>
      <p v-else-if="push.state === 'denied'" class="text-sm text-muted">Le notifiche sono bloccate per questo sito nelle impostazioni del browser.</p>
      <p v-else-if="push.state === 'on'" class="text-sm text-ok">Questo dispositivo è iscritto.</p>
      <button v-else type="button" class="btn self-start" :disabled="working" @click="subscribe"><Icon name="bell" :size="16" />Iscrivi questo dispositivo</button>
      <p v-if="problem !== null" role="alert" class="text-sm text-danger">{{ problem }}</p>
      <p class="text-xs text-muted">
        La notifica dice solo “Arianna ha risposto”, “Arianna aspetta una tua decisione”, “Un lavoro è fallito” o “Arianna ha un promemoria”, con il link alla conversazione: mai il testo né il titolo.
        La push passa dal servizio del browser (Apple, Google o Mozilla) senza contenuto, e non parte mentre una pagina della chat è in primo piano.
      </p>
    </div>
  </section>
</template>
