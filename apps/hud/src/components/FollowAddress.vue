<script setup lang="ts">
/**
 * The one field «Segui» of «Seguiti» (D-272): the address of a GitHub
 * repository (a project, D-202) or of an account (D-271). Reads nothing from
 * GitHub: the first check is the user's «Controlla».
 */
import { computed, ref } from 'vue';

import { addFollowedProject } from '../lib/api.ts';
import { followedKind, followedUrlProblem } from '../lib/followed-projects.ts';
import { errorText } from '../lib/italian.ts';

const props = defineProps<{ projects: number; maxProjects: number; accounts: number; maxAccounts: number }>();
const emit = defineEmits<{ added: [] }>();

const url = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);
const problem = computed(() => (url.value.trim() === '' ? undefined : followedUrlProblem(url.value)));
/** The cap the address in the field would pass: projects or accounts. */
const full = computed(() => (followedKind(url.value) === 'account' ? props.accounts >= props.maxAccounts : props.projects >= props.maxProjects));

async function add(): Promise<void> {
  if (busy.value || followedUrlProblem(url.value) !== undefined || full.value) return;
  busy.value = true;
  failure.value = null;
  try {
    await addFollowedProject(url.value.trim());
    url.value = '';
    emit('added');
  } catch (cause) {
    failure.value = errorText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="grid gap-x-3 gap-y-1 sm:grid-cols-6" @submit.prevent="add">
    <label class="flex flex-col gap-1 text-[13px] text-muted sm:col-span-5">
      <span class="text-[14px] font-medium text-ink">Segui un progetto ({{ projects }} su {{ maxProjects }}) o un account ({{ accounts }} su {{ maxAccounts }})</span>
      <input v-model="url" type="url" class="field px-2.5 py-1.5 text-[14px]" placeholder="Per esempio https://github.com/different-ai/openwork o https://github.com/copilotkit" :aria-invalid="problem !== undefined" />
      <span v-if="problem" class="text-warn">{{ problem }}</span>
      <span v-if="failure !== null" role="alert" class="text-danger">{{ failure }}</span>
    </label>
    <div class="flex items-end sm:col-span-1">
      <button type="submit" class="btn btn-primary w-full px-3 py-1.5 text-[14px]" :disabled="busy || followedUrlProblem(url) !== undefined || full">{{ busy ? 'Aggiungo…' : 'Segui' }}</button>
    </div>
  </form>
</template>
