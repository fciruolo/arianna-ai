<script setup lang="ts">
/**
 * «Le tue skill di Claude Code» in Impostazioni → Skill e stili (D-255): the
 * core copies the SKILL.md files of the skills folder of Claude Code only
 * when the user presses «Importa»/«Aggiorna»; «Togli» deletes the copy. Each
 * skill is private until the user marks it shareable, one by one, after
 * reading its text: a private one reaches only the agents on this computer.
 */
import { onMounted, ref } from 'vue';

import { importClaudeSkills, loadClaudeSkills, loadSkill, removeClaudeSkills, shareClaudeSkill } from '../lib/api.ts';
import { claudeErrorText, claudeLabelText, claudeSummaryText, importButtonText, rejectedText, type ClaudeSkillsStatus } from '../lib/claude-skills.ts';
import { otherFilesText } from '../lib/skills-catalog.ts';
import SettingsCard from './SettingsCard.vue';

const emit = defineEmits<{ changed: [] }>();

const status = ref<ClaudeSkillsStatus | null>(null);
const error = ref('');
const acting = ref<string | null>(null);

async function refresh(): Promise<void> {
  try {
    status.value = await loadClaudeSkills();
    error.value = '';
  } catch (cause) {
    error.value = claudeErrorText(cause);
  }
}
onMounted(refresh);

async function act(key: string, action: () => Promise<ClaudeSkillsStatus>): Promise<void> {
  if (acting.value !== null) return;
  acting.value = key;
  error.value = '';
  try {
    status.value = await action();
    emit('changed');
  } catch (cause) {
    error.value = claudeErrorText(cause);
  } finally {
    acting.value = null;
    confirming.value = null;
    removing.value = false;
  }
}

// «Togli» asks once more: the copy goes, with the marks of what is shareable.
const removing = ref(false);
// Sharing asks once more, after the text was opened: it lets the skill reach Claude and Codex.
const confirming = ref<string | null>(null);

/** «Rendi condivisibile»: the text opens below, to read before the confirmation. */
function askShare(id: string): void {
  confirming.value = id;
  if (opened.value !== id) void open(id);
}

const opened = ref<string | null>(null);
const text = ref<string | null>(null);
const textError = ref('');
async function open(id: string): Promise<void> {
  if (opened.value === id) {
    opened.value = null;
    return;
  }
  opened.value = id;
  text.value = null;
  textError.value = '';
  try {
    const skill = await loadSkill(id);
    if (opened.value === id) text.value = skill.text;
  } catch (cause) {
    if (opened.value === id) textError.value = claudeErrorText(cause);
  }
}
</script>

<template>
  <SettingsCard
    id="claude-skills"
    title="Le tue skill di Claude Code"
    description="Arianna copia le skill della tua cartella di Claude Code solo quando premi il pulsante: i soli SKILL.md e le licenze, mai script né altri file. Ognuna resta privata, e arriva solo agli agenti su questo computer, finché non la segni condivisibile."
  >
    <template #header><span title="Il testo può contenere dati tuoi: privato finché non decidi tu">privato finché non decidi tu</span></template>
    <div v-if="error" class="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-danger/50 bg-danger/9 px-3 py-2.5 text-[14px]" role="alert">
      <span class="min-w-[220px] flex-1">{{ error }}</span>
      <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="refresh">Riprova</button>
    </div>
    <p v-if="status === null && error === ''" class="text-[13px] text-muted">Leggo…</p>
    <template v-else-if="status !== null">
      <div class="flex flex-wrap items-center gap-2">
        <span class="min-w-[200px] flex-1 text-[14px] text-muted">{{ claudeSummaryText(status) }}</span>
        <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null" @click="act('import', importClaudeSkills)">{{ importButtonText(status, acting === 'import') }}</button>
        <template v-if="status.imported">
          <button v-if="!removing" type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null" @click="removing = true">Togli</button>
          <template v-else>
            <span class="text-[13px]">Tolgo la copia? La cartella di Claude Code resta com’è.</span>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" :disabled="acting !== null" @click="act('remove', removeClaudeSkills)">Sì, togli</button>
            <button type="button" class="btn px-2.5 py-1 text-[13px]" @click="removing = false">Annulla</button>
          </template>
        </template>
      </div>
      <p v-for="item in status.rejected" :key="item.path" class="text-[13px] text-warn">Non copiata: {{ rejectedText(item) }}</p>
      <ul v-if="status.skills.length > 0" class="m-0 flex list-none flex-col rounded-[10px] border border-line bg-surface p-0">
        <li v-for="item in status.skills" :key="item.id" class="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0">
          <div class="flex flex-wrap items-start gap-2">
            <button type="button" class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left" :aria-expanded="opened === item.id" @click="open(item.id)">
              <span class="truncate text-[14px] font-medium">{{ item.name }}</span>
              <span v-if="item.description" class="text-[13px] text-muted">{{ item.description }}</span>
              <span class="text-[12.5px]" :class="item.label === 'L1' ? 'text-warn' : 'text-muted'">{{ claudeLabelText(item.label) }}</span>
            </button>
            <button v-if="item.label === 'L1'" type="button" class="btn shrink-0 px-2 py-0.5 text-[13px]" :disabled="acting !== null" @click="act(item.id, () => shareClaudeSkill(item.slug, false))">Rendi privata</button>
            <button v-else-if="confirming !== item.id" type="button" class="btn shrink-0 px-2 py-0.5 text-[13px]" :disabled="acting !== null" @click="askShare(item.id)">Rendi condivisibile</button>
          </div>
          <div v-if="confirming === item.id" class="flex flex-wrap items-center gap-2 rounded-[8px] border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[13px]">
            <span class="min-w-[200px] flex-1">Il testo di questa skill, aperto qui sotto, potrà andare a Claude e a Codex, passando dal controllo dei dati personali. Leggilo prima: se contiene dati tuoi, lasciala privata.</span>
            <button type="button" class="btn px-2 py-0.5 text-[13px]" :disabled="acting !== null" @click="act(item.id, () => shareClaudeSkill(item.slug, true, item.sha256))">Sì, condivisibile</button>
            <button type="button" class="btn px-2 py-0.5 text-[13px]" @click="confirming = null">Annulla</button>
          </div>
          <template v-if="opened === item.id">
            <p v-if="otherFilesText(item.otherFiles)" class="text-[13px] text-muted">{{ otherFilesText(item.otherFiles)?.replace('nel repository', 'nella cartella') }}</p>
            <p v-if="textError" class="text-[13px] text-warn">{{ textError }}</p>
            <p v-else-if="text === null" class="text-[13px] text-muted">Leggo la skill…</p>
            <pre v-else class="max-h-[360px] overflow-auto rounded border border-line bg-surface-2 px-2.5 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre-wrap">{{ text }}</pre>
          </template>
        </li>
      </ul>
      <p v-else-if="status.imported" class="text-[13px] text-muted">Nessuna skill nella cartella skills di Claude Code.</p>
    </template>
  </SettingsCard>
</template>
