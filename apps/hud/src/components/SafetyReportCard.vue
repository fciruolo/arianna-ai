<script setup lang="ts">
/**
 * The safety report of Opus (D-196), as in the approved preview
 * (docs/mockups/rapporto-sicurezza.html): nessun problema, da guardare, in
 * corso, non disponibile. The same block for a role of the catalog, for a
 * role chosen in «Nuovo agente → Dal catalogo» and for an agent (its role and
 * its skills together). With `gate`, the line and the buttons to turn the
 * agent on: «Accendi» with nothing to look at, otherwise one more
 * confirmation from the page, never a block.
 */
import { computed } from 'vue';

import { checkRows, gateText, highlight, metaText, pendingPartsText, readText, reasonText, retriesByItself, severityText, whereText, type SafetyView } from '../lib/safety-report.ts';

const props = defineProps<{
  safety: SafetyView;
  /** The agent's gate: shown when set; `on` hides the buttons to turn it on. */
  gate?: { on: boolean; maxLabel: string; busy: boolean };
  /** «Apri le righe» goes to the text of the role. */
  lines?: boolean;
  redoing?: boolean;
}>();
const emit = defineEmits<{ activate: []; redo: []; lines: [] }>();

const EDGE: Record<SafetyView['state'], string> = { ok: 'border-l-ok', warn: 'border-l-warn', running: 'border-l-info', unavailable: 'border-l-line-strong' };
const report = computed(() => props.safety.report);
const shownState = computed(() => (props.safety.state === 'running' && report.value !== undefined && report.value.findings.length > 0 ? 'warn' : props.safety.state));
const pending = computed(() => pendingPartsText(props.safety.parts));
function runningText(): string {
  const running = props.safety.running;
  if (running?.scope === 'changes') return 'Solo le righe cambiate del ruolo';
  const text = readText({ path: running?.role ?? '' }, running?.skills ?? 0);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
</script>

<template>
  <section class="flex flex-col gap-2.5 rounded-xl border border-l-4 border-line bg-surface-2 p-4" :class="EDGE[shownState]" aria-label="Rapporto di sicurezza">
    <!-- Nessun problema / da guardare -->
    <template v-if="(shownState === 'ok' || shownState === 'warn') && report">
      <h3 v-if="shownState === 'ok'" class="flex items-center gap-2 text-[15.5px] font-semibold"><span class="text-ok">✓</span> Nessuna istruzione sospetta</h3>
      <h3 v-else class="flex items-center gap-2 text-[15.5px] font-semibold">
        <span class="text-warn">●</span>
        {{ report.findings.length === 0 ? 'Da guardare' : report.findings.length === 1 ? '1 punto da guardare' : `${report.findings.length} punti da guardare` }}{{ gate ? ' prima di accenderlo' : '' }}
      </h3>
      <p class="text-[13px] text-muted">{{ metaText(report) }}</p>
      <p v-if="report.summary" class="text-[14.5px]">{{ report.summary }}</p>
      <div v-for="(finding, index) in report.findings" :key="index" class="flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface px-3 py-2.5">
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[14px]">
          <span class="rounded-full border px-[7px] text-[12px] font-semibold" :class="finding.severity === 'suspect' ? 'border-danger text-danger' : 'border-warn text-warn'">{{ severityText(finding.severity) }}</span>
          <strong class="font-semibold">{{ finding.title }}</strong>
          <span class="text-[12.5px] text-muted">{{ whereText(finding) }}</span>
        </div>
        <div class="rounded-[6px] bg-bg px-2 py-1.5 font-mono text-[12.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          <div v-for="row in finding.lines" :key="row.n">
            <span class="text-muted select-none">{{ String(row.n).padEnd(4) }}</span
            ><template v-if="row.n === finding.line && highlight(row.text, finding.quote).mark !== ''"
              >{{ highlight(row.text, finding.quote).before }}<mark class="rounded-[3px] bg-warn/28 px-0.5 text-ink">{{ highlight(row.text, finding.quote).mark }}</mark>{{ highlight(row.text, finding.quote).after }}</template
            ><template v-else>{{ row.text }}</template>
          </div>
        </div>
        <p v-if="finding.explanation" class="text-[13.5px] text-muted">{{ finding.explanation }}</p>
        <p v-if="!finding.exact" class="text-[12.5px] text-muted">Il pezzo citato da Opus non corrisponde esattamente al testo: guarda tu la riga.</p>
      </div>
      <ul class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-1 p-0 text-[13.5px]">
        <li v-for="row in checkRows(report)" :key="row.text"><span :class="row.ok ? 'text-ok' : 'font-semibold text-warn'">{{ row.ok ? '✓' : '!' }}</span> {{ row.text }}</li>
      </ul>
      <p v-if="report.discarded > 0" class="text-[12.5px] text-muted">
        {{ report.discarded === 1 ? '1 segnalazione di Opus è stata scartata' : `${report.discarded} segnalazioni di Opus sono state scartate` }}: non corrispondevano al testo. Leggilo tu prima di usarlo.
      </p>
      <p v-if="pending" class="text-[12.5px] text-muted">{{ pending }}</p>
      <div v-if="gate || (lines && shownState === 'warn')" class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2 text-[13.5px]">
        <span class="min-w-[200px] flex-1 text-muted">{{
          !gate ? 'Il testo del ruolo è qui sopra.' : gate.on ? 'L’agente è acceso.' : shownState === 'warn' ? 'Puoi riadottare la versione di prima, togliere il ruolo o accenderlo lo stesso.' : gateText(gate.maxLabel)
        }}</span>
        <button v-if="lines && shownState === 'warn'" type="button" class="btn px-2.5 py-1 text-[13.5px]" @click="emit('lines')">Apri le righe</button>
        <button v-if="gate && !gate.on" type="button" class="btn px-2.5 py-1 text-[13.5px]" :class="{ 'btn-primary': shownState === 'ok' }" :disabled="gate.busy" @click="emit('activate')">
          {{ shownState === 'ok' ? 'Accendi' : 'Accendi lo stesso…' }}
        </button>
      </div>
    </template>
    <!-- In corso -->
    <template v-else-if="shownState === 'running'">
      <h3 class="flex items-center gap-2 text-[15.5px] font-semibold"><span class="report-spin" aria-hidden="true"></span> Opus sta leggendo il testo</h3>
      <p class="text-[13px] text-muted">{{ runningText() }} · di solito meno di un minuto · si legge una volta sola per versione</p>
      <p class="text-[14.5px]">{{ gate ? 'Puoi intanto leggere il testo nella scheda «Scheda e prompt». Il rapporto compare qui appena arriva; se non vuoi aspettare, c’è «Accendi senza aspettare».' : 'Puoi intanto leggere il testo. Il rapporto compare qui appena arriva.' }}</p>
      <div v-if="gate" class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2 text-[13.5px]">
        <span class="min-w-[200px] flex-1 text-muted">Costo: circa mezzo punto della sessione di 5 ore.</span>
        <button v-if="!gate.on" type="button" class="btn px-2.5 py-1 text-[13.5px]" :disabled="gate.busy" @click="emit('activate')">Accendi senza aspettare…</button>
      </div>
    </template>
    <!-- Non disponibile -->
    <template v-else>
      <h3 class="text-[15.5px] font-semibold">Nessun rapporto</h3>
      <p class="text-[13px] text-muted">{{ reasonText(report?.reason?.code) }}</p>
      <p class="text-[14.5px]">
        Senza rapporto, leggi tu il testo prima di usarlo.
        {{ retriesByItself(report?.reason?.code) ? 'Il rapporto si farà da solo quando Claude torna disponibile.' : 'Per riprovare premi «Rifai il rapporto».' }}
      </p>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2 text-[13.5px]">
        <span class="min-w-[200px] flex-1 text-muted">{{ !gate ? '' : gate.on ? 'L’agente è acceso.' : gateText(gate.maxLabel) }}</span>
        <button type="button" class="btn px-2.5 py-1 text-[13.5px]" :disabled="redoing" @click="emit('redo')">Rifai il rapporto</button>
        <button v-if="gate && !gate.on" type="button" class="btn px-2.5 py-1 text-[13.5px]" :disabled="gate.busy" @click="emit('activate')">Accendi senza rapporto…</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* The wheel of a report being read (D-196), as in the preview; still for who asks for less motion. */
.report-spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  border-top-color: var(--info);
  animation: report-turn 1s linear infinite;
}
@keyframes report-turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .report-spin {
    animation: none;
  }
}
</style>
