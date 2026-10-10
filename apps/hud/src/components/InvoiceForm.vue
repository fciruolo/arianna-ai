<script setup lang="ts">
import { computed, reactive } from 'vue';

import { moneyText, parseAmount, todayInput, type Money, type NewInvoice } from '../lib/im-billing.ts';

/**
 * Registering an invoice the user made with their own program (D-169), in the
 * tab IM of a project and in the dashboard of a client (D-170): number, date,
 * the total of the document as it is on the invoice (VAT, withholding and
 * stamp included: what the dashboard adds up), an optional due date (empty:
 * from the payment terms of the client) and a note.
 */
// `blocked`: why the IM chosen cannot make an invoice yet (none, or more currencies); what was typed stays.
const props = defineProps<{ ims: readonly number[]; taxable: Money | undefined; busy: boolean; blocked?: string | null }>();
const emit = defineEmits<{ submit: [invoice: NewInvoice]; cancel: [] }>();

const form = reactive({ number: '', issuedOn: todayInput(), document: '', dueOn: '', note: '' });
const documentCents = computed(() => parseAmount(form.document));
const valid = computed(() => form.number.trim() !== '' && form.issuedOn !== '' && typeof documentCents.value === 'number');

function submit(): void {
  const cents = documentCents.value;
  if (!valid.value || typeof cents !== 'number' || (props.blocked ?? null) !== null) return;
  emit('submit', { number: form.number.trim(), issuedOn: form.issuedOn, documentCents: cents, dueOn: form.dueOn === '' ? null : form.dueOn, note: form.note.trim() === '' ? null : form.note.trim() });
}
</script>

<template>
  <form class="flex flex-col gap-3 border-b border-line bg-surface-2 px-4 py-3.5" @submit.prevent="submit">
    <p v-if="props.blocked" class="text-[13px] text-warn">{{ props.blocked }}</p>
    <p v-else class="text-[13px]">
      Registri la fattura che hai fatto col tuo programma, con {{ props.ims.map((n) => `IM-${String(n)}`).join(', ') }}<template v-if="props.taxable">, imponibile {{ moneyText(props.taxable.cents, props.taxable.currency) }}</template>.
    </p>
    <div class="grid gap-3 sm:grid-cols-[150px_150px_170px_150px]">
      <label class="flex flex-col gap-1 text-xs text-muted">Numero
        <input v-model="form.number" maxlength="40" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="12/2026" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">Data
        <input v-model="form.issuedOn" type="date" class="field px-2 py-1.5 text-[13px] text-ink" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">Totale documento
        <input v-model="form.document" inputmode="decimal" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="549,00" :aria-invalid="form.document !== '' && typeof documentCents !== 'number'" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted">Scadenza (facoltativa)
        <input v-model="form.dueOn" type="date" class="field px-2 py-1.5 text-[13px] text-ink" />
      </label>
    </div>
    <label class="flex flex-col gap-1 text-xs text-muted">Nota (facoltativa)
      <input v-model="form.note" maxlength="2000" class="field px-2 py-1.5 text-[13px] text-ink" placeholder="IM di ottobre" />
    </label>
    <p class="text-xs text-muted">
      Il totale documento è quello scritto sulla fattura, con IVA, ritenuta e bollo: è la cifra che conta nella dashboard del cliente.
      <template v-if="form.document !== '' && typeof documentCents !== 'number'"><span class="text-danger">Non è un importo valido (per esempio 549,00).</span></template>
      Senza scadenza vale quella calcolata dai giorni di pagamento del cliente.
    </p>
    <div class="flex justify-end gap-2">
      <button type="button" class="btn px-3 py-1 text-[13px]" :disabled="props.busy" @click="emit('cancel')">Annulla</button>
      <button type="submit" class="btn btn-primary px-3 py-1 text-[13px] font-semibold" :disabled="props.busy || !valid || (props.blocked ?? null) !== null">Registra la fattura</button>
    </div>
  </form>
</template>
