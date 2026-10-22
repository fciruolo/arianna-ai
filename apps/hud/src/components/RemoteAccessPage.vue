<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from './Icon.vue';
import { watchViewport } from '../lib/viewport.ts';

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

/** The step of the three dashes (D-293): code, passkey, Face ID. */
const step = computed(() => (screen.value === 'code' ? 1 : screen.value === 'passkey' ? 2 : 3));
/** The name of the Mac on the tailnet, as the address shows it. */
const host = window.location.hostname;
let stopViewport: (() => void) | undefined;

onMounted(() => {
  document.title = 'Arianna';
  // The page follows the keyboard of the phone, as the chat does (D-293).
  stopViewport = watchViewport(window.visualViewport, document.documentElement, () => window.innerHeight);
});
onBeforeUnmount(() => stopViewport?.());

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
  <!-- D-293: the text up, the button down where the thumb is, the step and the name of the Mac at the foot. -->
  <main class="flex h-full min-h-dvh flex-col overflow-y-auto bg-bg px-6 pt-[calc(var(--safe-top)+1.5rem)] pb-[calc(var(--safe-bottom)+1rem)] text-ink phone:min-h-0">
    <section class="mx-auto flex w-full max-w-sm flex-1 flex-col">
      <div class="flex flex-1 flex-col items-center justify-center gap-3.5 text-center">
        <div class="flex items-end gap-3.5">
          <img src="/logo.svg" alt="" class="size-[76px] rounded-[20px] shadow-[0_0_0_1px_var(--line-strong),0_0_40px_var(--glow)]" />
        </div>
        <ol class="flex gap-1.5" :aria-label="`Passo ${String(step)} di 3`">
          <li v-for="index in 3" :key="index" class="h-1 w-[22px] rounded-sm" :class="index <= step ? 'bg-accent' : 'bg-line-strong'" />
        </ol>

        <template v-if="screen === 'code'">
          <h1 class="mt-1 text-[24px] font-semibold">Scrivi il codice</h1>
          <p class="text-[16px] leading-relaxed text-muted">Sul Mac apri Impostazioni → Dispositivi e premi «Nuovo codice». Scrivi qui le 6 cifre: valgono 5 minuti.</p>
          <form id="remote-code-form" class="flex w-full flex-col items-center gap-3" @submit.prevent="sendCode">
            <label for="remote-code" class="sr-only">Codice di 6 cifre</label>
            <input
              id="remote-code"
              :value="code"
              class="field w-full max-w-[18rem] px-3 py-3 text-center font-mono text-[28px] tracking-[0.4em] text-ink"
              inputmode="numeric"
              autocomplete="one-time-code"
              data-own-size
              pattern="[0-9]{6}"
              maxlength="6"
              placeholder="000000"
              :disabled="busy"
              @input="onCodeInput"
            />
          </form>
        </template>

        <template v-else-if="screen === 'passkey'">
          <h1 class="mt-1 text-[24px] font-semibold">Crea la passkey</h1>
          <p class="text-[16px] leading-relaxed text-muted">
            Il codice è giusto. Ora il telefono crea una passkey per Arianna, protetta da Face ID: resta nel telefono, e da qui in avanti entri con il viso, senza codici.
          </p>
        </template>

        <template v-else>
          <h1 class="mt-1 text-[24px] font-semibold">Entra con Face ID</h1>
          <p class="text-[16px] leading-relaxed text-muted">Questo telefono è abbinato ad Arianna. Usa la passkey per entrare: la sessione dura al massimo 12 ore, e si chiude dopo 30 minuti senza uso.</p>
        </template>
      </div>

      <div class="flex flex-col items-stretch gap-2.5 pt-6">
        <p v-if="problem !== null" role="alert" class="text-center text-[15px] leading-relaxed text-danger">{{ problem }}</p>
        <template v-if="screen === 'code'">
          <button type="submit" form="remote-code-form" class="btn btn-primary min-h-[50px] w-full text-[17px]" :disabled="!codeReady || busy">{{ busy ? 'Controllo…' : 'Continua' }}</button>
          <button v-if="rememberedPasskey()" type="button" class="min-h-11 text-[16px] text-accent hover:underline" @click="screen = 'signin'">Ho già la passkey: entra con Face ID</button>
        </template>
        <button v-else-if="screen === 'passkey'" type="button" class="btn btn-primary min-h-[50px] w-full text-[17px]" :disabled="busy" @click="createPasskey">
          <Icon name="face-id" :size="20" />{{ busy ? 'Attendo Face ID…' : 'Crea la passkey' }}
        </button>
        <template v-else>
          <button type="button" class="btn btn-primary min-h-[50px] w-full text-[17px]" :disabled="busy" @click="enter">
            <Icon name="face-id" :size="20" />{{ busy ? 'Attendo Face ID…' : 'Entra con Face ID' }}
          </button>
          <button type="button" class="min-h-11 text-[16px] text-accent hover:underline" @click="pairAgain">Abbina con un nuovo codice</button>
        </template>
        <p class="flex items-center justify-center gap-1.5 pt-1 font-mono text-[12px] text-muted"><Icon name="gateway" :size="14" />Tailscale · {{ host }}</p>
      </div>
    </section>
  </main>
</template>
