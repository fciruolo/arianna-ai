<script setup lang="ts">
import type { LiveEdit } from '../lib/chat-state.ts';
import { EDIT_TOOL_TEXT, LIVE_EDIT_ERROR_TEXT } from '../lib/italian.ts';

/**
 * The Coder's changes to files while it works (D-117, second stage): one
 * small diff per call to Edit, MultiEdit or Write, removed lines in red and
 * added ones in green, the latest open. Live only: they are not saved, and
 * the full diff of the files appears under the report at the end. A Write
 * shows the whole new text as added, without the version before.
 */
defineProps<{ edits: LiveEdit[] }>();

const rowClass = { added: 'bg-ok/10', removed: 'bg-danger/10', context: '', gap: 'text-muted' } as const;
const signOf = { added: '+', removed: '−', context: ' ', gap: '⋯' } as const;
</script>

<template>
  <div class="flex flex-col gap-1.5 border-t border-line px-[15px] py-2.5" aria-label="Modifiche dal vivo del Coder">
    <details v-for="(edit, at) in edits" :key="edit.editId" class="rounded border border-line" :open="at === edits.length - 1">
      <summary class="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px]">
        <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">{{ edit.path }}</span>
        <span class="shrink-0 text-[11px] text-muted">{{ EDIT_TOOL_TEXT[edit.tool] }}</span>
        <span v-if="edit.error === undefined" class="shrink-0 font-mono text-[11px]">
          <span class="text-ok">+{{ edit.added }}</span> <span class="text-danger">−{{ edit.removed }}</span>
        </span>
      </summary>
      <p v-if="edit.error !== undefined" class="border-t border-line px-2 py-1 text-xs text-warn">{{ LIVE_EDIT_ERROR_TEXT[edit.error] }}</p>
      <p v-else-if="(edit.rows ?? []).length === 0" class="border-t border-line px-2 py-1 text-xs text-muted">Nessuna riga cambiata.</p>
      <div v-else class="max-h-[200px] overflow-auto border-t border-line bg-surface font-mono text-[11.5px] leading-[1.45]">
        <table class="w-full border-collapse">
          <tbody>
            <tr v-for="(row, index) in edit.rows ?? []" :key="index" :class="rowClass[row.kind]">
              <td
                class="w-px px-1.5 select-none"
                :class="row.kind === 'added' ? 'text-ok' : row.kind === 'removed' ? 'text-danger' : 'text-muted'"
                aria-hidden="true"
              >
                {{ signOf[row.kind] }}
              </td>
              <td class="pr-3 whitespace-pre">
                <span v-if="row.kind === 'added'" class="sr-only">aggiunta: </span>
                <span v-else-if="row.kind === 'removed'" class="sr-only">tolta: </span>
                <span>{{ row.text }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>
