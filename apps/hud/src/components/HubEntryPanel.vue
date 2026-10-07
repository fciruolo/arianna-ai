<script setup lang="ts">
/**
 * The part of the card of a model added from Hugging Face (I-10, D-139):
 * "Promuovi" lets it have the roles the user picks (it stays experimental),
 * "Togli dal catalogo" takes it out of config/models.user-catalog.yaml after
 * the id is typed. Assigning a role stays in the roles of the page, saved
 * with the bar.
 */
import { computed, ref, watch } from 'vue';

import { forgetModel, promoteModel } from '../lib/api.ts';
import { forgetBlocked, hubErrorText, lockedRoles, promoteLines } from '../lib/huggingface.ts';
import { ROLE_NAME, type LocalModelView } from '../lib/models-page.ts';
import { MODEL_ROLES, type ModelRole } from '../lib/settings.ts';

/** `assigned`: the roles `[roles]` gives the model as saved (they cannot be taken away here). */
const props = defineProps<{ view: LocalModelView; assigned: ModelRole[] }>();
/** `changed`: the catalog was written; `forgotten`: the model is no longer in it. */
const emit = defineEmits<{ changed: []; forgotten: [] }>();

const chosen = ref<ModelRole[]>([]);
const step = ref<'idle' | 'promote' | 'forget'>('idle');
const typed = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

watch(
  () => [props.view.id, props.view.suitedRoles.join(',')],
  () => {
    chosen.value = [...props.view.suitedRoles];
    step.value = 'idle';
    error.value = null;
  },
  { immediate: true },
);
watch(
  () => props.view.id,
  () => {
    notice.value = null;
  },
);

const locked = computed(() => lockedRoles(props.view, props.assigned));
const changedRoles = computed(() => chosen.value.length > 0 && [...chosen.value].sort().join(',') !== [...props.view.suitedRoles].sort().join(','));
const blocked = computed(() => forgetBlocked(props.view, props.assigned));

function flip(role: ModelRole): void {
  if (locked.value.includes(role)) return;
  chosen.value = chosen.value.includes(role) ? chosen.value.filter((item) => item !== role) : MODEL_ROLES.filter((item) => item === role || chosen.value.includes(item));
}

async function promote(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const roles = await promoteModel(props.view.id, chosen.value);
    notice.value = `Ora ${props.view.id} può avere: ${roles.map((role) => ROLE_NAME[role]).join(', ')}. Assegnalo nei ruoli qui sotto e salva.`;
    step.value = 'idle';
    emit('changed');
  } catch (cause) {
    error.value = hubErrorText(cause);
  } finally {
    busy.value = false;
  }
}

async function forget(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await forgetModel(props.view.id, typed.value.trim());
    step.value = 'idle';
    emit('forgotten');
  } catch (cause) {
    error.value = hubErrorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-[10px] border border-line px-3 py-2.5" aria-label="Modello aggiunto da Hugging Face">
    <h3 class="hud-title text-[10.5px]">Aggiunto da Hugging Face</h3>
    <p v-if="view.suitedRoles.length === 0" class="text-xs text-muted">
      È nel catalogo come sperimentale e senza ruoli: finché non lo promuovi non compare nei menu dei ruoli. Puoi già scaricarlo e verificarlo.
    </p>
    <p v-else class="text-xs text-muted">Promosso: può avere {{ view.suitedRoles.map((role) => ROLE_NAME[role]).join(', ') }}. Resta sperimentale finché non passa le prove.</p>
    <div class="flex flex-wrap gap-1.5" role="group" aria-label="Ruoli che può avere">
      <button
        v-for="role in MODEL_ROLES"
        :key="role"
        type="button"
        class="rounded-full border px-2.5 py-0.5 text-xs"
        :class="chosen.includes(role) ? 'border-accent bg-glow text-ink' : 'border-line-strong text-muted hover:text-ink'"
        :aria-pressed="chosen.includes(role)"
        :disabled="busy || locked.includes(role)"
        :title="locked.includes(role) ? 'Ha questo ruolo adesso: non si può togliere' : undefined"
        @click="flip(role)"
      >
        {{ ROLE_NAME[role] }}
      </button>
    </div>
    <div v-if="step === 'idle'" class="flex flex-wrap items-center gap-2">
      <button type="button" class="btn btn-primary px-3 py-1 text-[13px]" :disabled="busy || !changedRoles" @click="step = 'promote'">{{ view.suitedRoles.length === 0 ? 'Promuovi…' : 'Cambia i ruoli…' }}</button>
      <button type="button" class="btn btn-danger px-3 py-1 text-[13px]" :disabled="busy || blocked !== undefined" @click="step = 'forget'; typed = ''">Togli dal catalogo…</button>
    </div>
    <p v-if="step === 'idle' && blocked !== undefined" class="text-xs text-muted">{{ blocked }}</p>
    <div v-if="step === 'promote'" class="flex flex-col gap-1.5">
      <p v-for="line in promoteLines(view, chosen)" :key="line" class="text-[12.5px]">{{ line }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="step = 'idle'">Annulla</button>
        <button type="button" class="btn btn-primary px-2.5 py-1 text-xs" :disabled="busy" @click="promote">Promuovi</button>
      </div>
    </div>
    <form v-if="step === 'forget'" class="flex flex-col gap-1.5" @submit.prevent="forget">
      <p class="text-[12.5px]">Toglie {{ view.id }} da config/models.user-catalog.yaml. Sul disco non c’è niente da togliere; per riaverlo lo cerchi di nuovo.</p>
      <label class="flex flex-col gap-1 text-xs text-muted">
        Per confermare scrivi l’id del modello
        <input v-model="typed" class="field px-2 py-1.5 font-mono text-[13px] text-ink" :placeholder="view.id" autocomplete="off" spellcheck="false" />
      </label>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn px-2.5 py-1 text-xs" :disabled="busy" @click="step = 'idle'">Annulla</button>
        <button type="submit" class="btn btn-danger px-2.5 py-1 text-xs" :disabled="busy || typed.trim() !== view.id">Togli dal catalogo</button>
      </div>
    </form>
    <p v-if="error !== null" role="alert" class="text-xs text-danger">{{ error }}</p>
    <p v-if="notice !== null" role="status" class="text-xs text-ok">{{ notice }}</p>
  </div>
</template>
