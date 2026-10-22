<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  browserErrorCode,
  pairWithCode,
  registerPasskey,
  rememberedPasskey,
  rememberPasskey,
  remoteErrorText,
  signIn,
  type CreationOptionsJson,
} from '../lib/remote.ts';

/**
 * The chat from the phone without a session (D-292, stage B): three screens.
 * «Scrivi il codice» (the 6 digits shown on the Mac), «Crea la passkey» (a
 * tap: iOS asks Face ID only from a gesture), «Entra con Face ID» (the
 * passkey already made). On success the page reloads into the chat.
 */
type Screen = 'code' | 'passkey' | 'signin';

const screen = ref<Screen>(rememberedPasskey() ? 'signin' : 'code');
const code = ref('');
const options = ref<CreationOptionsJson | null>(null);
const busy = ref(false);
const problem = ref<string | null>(null);

const codeReady = computed(() => /^\d{6}$/.test(code.value));

onMounted(() => {
  document.title = 'Arianna';
});

function fail(error: unknown): void {
  problem.value = remoteErrorText(browserErrorCode(error));
}

async function sendCode(): Promise<void> {
  if (!codeReady.value || busy.value) return;
  busy.value = true;
  problem.value = null;
  try {
    options.value = await pairWithCode(code.value);
    screen.value = 'passkey';
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}

async function createPasskey(): Promise<void> {
  if (options.value === null || busy.value) return;
  busy.value = true;
  problem.value = null;
  try {
    await registerPasskey(options.value);
    rememberPasskey();
    window.location.reload();
  } catch (error) {
    // The options are single use: a failed passkey needs a new code.
    options.value = null;
    code.value = '';
    screen.value = 'code';
    fail(error);
  } finally {
    busy.value = false;
  }
}

async function enter(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  problem.value = null;
  try {
    await signIn();
    window.location.reload();
  } catch (error) {
    fail(error);
  } finally {
    busy.value = false;
  }
}

function pairAgain(): void {
  screen.value = 'code';
  code.value = '';
  problem.value = null;
}

function onCodeInput(event: Event): void {
  code.value = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
}
</script>

<template>
  <main class="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-ink">
    <section class="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 text-center">
      <img src="/logo.svg" alt="" class="size-14 rounded-2xl" />

      <template v-if="screen === 'code'">
        <h1 class="text-[18px] font-semibold">Scrivi il codice</h1>
        <p class="text-[14.5px] leading-relaxed text-muted">
          Sul Mac apri Impostazioni → Dispositivi e premi «Nuovo codice». Scrivi qui le 6 cifre: valgono 5 minuti.
        </p>
        <form class="flex w-full flex-col items-center gap-3" @submit.prevent="sendCode">
          <label for="remote-code" class="sr-only">Codice di 6 cifre</label>
          <input
            id="remote-code"
            :value="code"
            class="field w-48 px-3 py-2 text-center font-mono text-[26px] tracking-[0.3em] text-ink"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength="6"
            placeholder="000000"
            :disabled="busy"
            @input="onCodeInput"
          />
          <button type="submit" class="btn btn-primary" :disabled="!codeReady || busy">{{ busy ? 'Controllo…' : 'Continua' }}</button>
        </form>
        <button v-if="rememberedPasskey()" type="button" class="text-[14px] text-accent hover:underline" @click="screen = 'signin'">Ho già la passkey: entra con Face ID</button>
      </template>

      <template v-else-if="screen === 'passkey'">
        <h1 class="text-[18px] font-semibold">Crea la passkey</h1>
        <p class="text-[14.5px] leading-relaxed text-muted">
          Il codice è giusto. Ora il telefono crea una passkey per Arianna, protetta da Face ID: resta nel telefono, e da qui in avanti entri con il viso, senza codici.
        </p>
        <button type="button" class="btn btn-primary" :disabled="busy" @click="createPasskey">{{ busy ? 'Attendo Face ID…' : 'Crea la passkey' }}</button>
      </template>

      <template v-else>
        <h1 class="text-[18px] font-semibold">Entra con Face ID</h1>
        <p class="text-[14.5px] leading-relaxed text-muted">Questo telefono è abbinato ad Arianna. Usa la passkey per entrare: la sessione dura al massimo 12 ore, e si chiude dopo 30 minuti senza uso.</p>
        <button type="button" class="btn btn-primary" :disabled="busy" @click="enter">{{ busy ? 'Attendo Face ID…' : 'Entra con Face ID' }}</button>
        <button type="button" class="text-[14px] text-accent hover:underline" @click="pairAgain">Abbina con un nuovo codice</button>
      </template>

      <p v-if="problem !== null" role="alert" class="text-[14px] leading-relaxed text-danger">{{ problem }}</p>
    </section>
  </main>
</template>
