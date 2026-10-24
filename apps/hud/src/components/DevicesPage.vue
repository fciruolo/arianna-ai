<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { ApiError, loadDevices, newPairingCode, unlinkDevice, type DevicesView, type RemoteDevice } from '../lib/api.ts';
import { codeLeftText, codeText, lastSeenText, phoneAddress } from '../lib/devices.ts';
import { onRemoteOrigin } from '../lib/remote.ts';
import ConfirmDialog from './ConfirmDialog.vue';
import FormField from './FormField.vue';

/**
 * Impostazioni → Dispositivi (D-292, stage B), on the Mac only: the phones
 * paired with the remote port, their last access, «Scollega» (sessions and
 * passkeys end at once) and «Nuovo codice» (6 digits, 5 minutes, one use),
 * with an optional name for the phone. From the phone the core refuses all
 * of it: the page says so instead.
 */
const remote = onRemoteOrigin(window.location);
const view = ref<DevicesView | null | undefined>(undefined);
const loadProblem = ref<string | null>(null);
const name = ref('');
const code = ref<{ code: string; expiresAt: string } | null>(null);
const codeBusy = ref(false);
const codeProblem = ref<string | null>(null);
const unlinking = ref<RemoteDevice | null>(null);
const unlinkBusy = ref(false);
const unlinkProblem = ref<string | null>(null);
const now = ref(Date.now());
let timer: number | undefined;

function problemOf(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return 'Il nome va da 1 a 60 caratteri, senza a capo.';
  return 'Il core non risponde: riprova.';
}

async function reload(): Promise<void> {
  try {
    view.value = await loadDevices();
    loadProblem.value = null;
  } catch (error) {
    loadProblem.value = problemOf(error);
  }
}

onMounted(() => {
  if (!remote) void reload();
  timer = window.setInterval(() => {
    now.value = Date.now();
    if (code.value !== null && codeLeftText(code.value.expiresAt, now.value) === null) {
      code.value = null;
      void reload();
    }
  }, 1000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
});

async function makeCode(): Promise<void> {
  codeBusy.value = true;
  codeProblem.value = null;
  try {
    code.value = await newPairingCode(name.value);
    name.value = '';
  } catch (error) {
    codeProblem.value = problemOf(error);
  } finally {
    codeBusy.value = false;
  }
}

async function unlink(): Promise<void> {
  const device = unlinking.value;
  if (device === null) return;
  unlinkBusy.value = true;
  unlinkProblem.value = null;
  try {
    await unlinkDevice(device.id);
    unlinking.value = null;
    await reload();
  } catch (error) {
    unlinkProblem.value = error instanceof ApiError && error.status === 404 ? 'Il dispositivo era già scollegato.' : problemOf(error);
  } finally {
    unlinkBusy.value = false;
  }
}

const input = 'field w-full min-w-0 px-2.5 py-1.5 text-[14px] text-ink';
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <p v-if="remote" class="hud-card px-4 py-3 text-[14.5px] text-muted">I dispositivi si abbinano e si scollegano solo dal Mac: apri Arianna sul Mac per gestirli.</p>
    <p v-else-if="loadProblem !== null" role="alert" class="hud-card px-4 py-3 text-[14.5px] text-danger">
      {{ loadProblem }} <button type="button" class="text-accent hover:underline" @click="reload">Riprova</button>
    </p>
    <p v-else-if="view === undefined" class="text-[14px] text-muted">Carico…</p>
    <section v-else-if="view === null" class="hud-card flex flex-col gap-2 px-4 py-3 text-[14.5px]">
      <h3 class="font-semibold">La porta per il telefono non è configurata</h3>
      <p class="text-muted">
        Per aprire Arianna dal telefono serve <code class="font-mono text-[13px]">[server.remote]</code> in <code class="font-mono text-[13px]">config/arianna.toml</code>, con il nome
        <code class="font-mono text-[13px]">*.ts.net</code> del Mac in Tailscale, poi un riavvio di Arianna. I passi sono in docs/SECURITY.md, «Accesso dal telefono».
      </p>
    </section>
    <template v-else>
      <section class="hud-card flex flex-col gap-3 px-4 py-3">
        <h3 class="text-[15px] font-semibold">Abbina un telefono</h3>
        <template v-if="code !== null && codeLeftText(code.expiresAt, now) !== null">
          <p class="font-mono text-[34px] font-semibold tracking-[0.15em]" aria-live="polite">{{ codeText(code.code) }}</p>
          <p class="text-[14px] text-muted">Vale ancora {{ codeLeftText(code.expiresAt, now) }} minuti, una volta sola.</p>
          <ol class="list-decimal pl-5 text-[14.5px] leading-relaxed">
            <li>Sul telefono, con Tailscale acceso, apri <span class="font-mono text-[13.5px]">{{ phoneAddress(view.host) }}</span> in Safari.</li>
            <li>Scrivi queste 6 cifre in «Scrivi il codice».</li>
            <li>Premi «Crea la passkey» e conferma con Face ID: il telefono compare qui sotto.</li>
          </ol>
        </template>
        <p v-else class="text-[14.5px] text-muted">
          Un codice di 6 cifre vale 5 minuti e una volta sola; un codice nuovo annulla quello prima.
          <template v-if="view.code !== null && codeLeftText(view.code.expiresAt, now) !== null"> C’è già un codice in attesa: crearne uno nuovo lo sostituisce.</template>
        </p>
        <form class="flex flex-wrap items-end gap-2.5" @submit.prevent="makeCode">
          <FormField id="device-name" label="Nome del telefono (facoltativo)" :span="4" class="min-w-[200px] flex-1">
            <input id="device-name" v-model="name" :class="input" maxlength="60" placeholder="iPhone" autocomplete="off" :disabled="codeBusy" />
          </FormField>
          <button type="submit" class="btn btn-primary" :disabled="codeBusy">{{ codeBusy ? 'Creo…' : 'Nuovo codice' }}</button>
        </form>
        <p v-if="codeProblem !== null" role="alert" class="text-[14px] text-danger">{{ codeProblem }}</p>
      </section>

      <section class="hud-card flex flex-col gap-2 px-4 py-3">
        <h3 class="text-[15px] font-semibold">Telefoni abbinati</h3>
        <p v-if="view.devices.length === 0" class="text-[14.5px] text-muted">Nessuno, per ora.</p>
        <ul v-else class="flex flex-col divide-y divide-line">
          <li v-for="device in view.devices" :key="device.id" class="flex flex-wrap items-center gap-2.5 py-2">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[14.5px] font-medium">{{ device.name }}</span>
              <span class="block text-[13px] text-muted">Ultimo accesso: {{ lastSeenText(device.lastSeenAt, now) }}</span>
            </span>
            <button type="button" class="btn btn-danger" @click="unlinking = device; unlinkProblem = null">Scollega</button>
          </li>
        </ul>
      </section>
    </template>

    <ConfirmDialog
      v-if="unlinking !== null"
      title="Scollegare il telefono?"
      confirm-text="Scollega"
      danger
      :busy="unlinkBusy"
      :problem="unlinkProblem"
      @confirm="unlink"
      @cancel="unlinking = null"
    >
      <p class="text-[14.5px] leading-relaxed">
        «{{ unlinking.name }}» esce subito da Arianna: le sessioni aperte si chiudono, la sua passkey non vale più e smette di ricevere le notifiche. Per usarlo di nuovo serve un nuovo codice.
      </p>
    </ConfirmDialog>
  </div>
</template>
