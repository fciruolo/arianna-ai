<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { bandCenters, bars, chartSummary, colorOf, formatValue, linePoints, pieSlices, scaleY, shareText, shortLabel, valueAxis, type ChartData } from '../lib/chart.ts';

/**
 * A chart of the Dashboard (D-248), drawn in SVG of our own: bars, lines or
 * a pie, in the colours of the theme, with a legend, the values readable on
 * the chart and the table of the data on request (accessibility). It scales
 * with the width of its tile; nothing leaves the page.
 */
const props = defineProps<{ chart: ChartData }>();

// The drawing is as wide as its tile in pixels, so the texts keep their size in a narrow and in a wide tile.
const root = ref<HTMLElement | null>(null);
const width = ref(560);
const W = computed(() => Math.max(260, Math.round(width.value)));
const H = 260;
const box = computed(() => ({ left: 52, right: W.value - 10, top: 18, bottom: H - 36 }));
const showTable = ref(false);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (root.value === null) return;
  width.value = root.value.clientWidth;
  if (typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry !== undefined) width.value = entry.contentRect.width;
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
/** The pie on the left, its legend on the right while there is room, else under it. */
const pieSide = computed(() => W.value >= 420);
const pieRadius = computed(() => Math.min(105, (pieSide.value ? W.value * 0.45 : W.value) / 2 - 12));

const all = computed(() => props.chart.series.flatMap((series) => series.values));
const axis = computed(() => valueAxis(all.value));
const barList = computed(() => (props.chart.kind === 'bar' ? bars(props.chart, axis.value, box.value) : []));
const centers = computed(() => bandCenters(props.chart.labels.length, box.value.left, box.value.right));
const slices = computed(() =>
  props.chart.kind === 'pie' ? pieSlices(props.chart.series[0]?.values ?? [], pieSide.value ? pieRadius.value + 12 : W.value / 2, H / 2, pieRadius.value) : [],
);
/** Values written on the bars only while they fit. */
const barValues = computed(() => props.chart.labels.length * props.chart.series.length <= 12);
/** Every label under the axis while they fit (about 7 px a character), else one every few. */
const labelEvery = computed(() => Math.max(1, Math.ceil(props.chart.labels.length / Math.max(2, Math.floor((box.value.right - box.value.left) / 56)))));
const labelMax = computed(() => Math.max(4, Math.floor(((box.value.right - box.value.left) / Math.max(1, props.chart.labels.length)) * labelEvery.value / 7)));
/** Values written on the bars only while each bar is wide enough for them. */
const barRoom = computed(() => (barList.value[0]?.width ?? 0) >= 26);
const legend = computed(() =>
  props.chart.kind === 'pie'
    ? props.chart.labels.map((label, index) => ({ name: label, color: colorOf(index), extra: shareText(slices.value.find((slice) => slice.index === index)?.share ?? 0) }))
    : props.chart.series.map((series, index) => ({ name: series.name, color: colorOf(index), extra: '' })),
);
</script>

<template>
  <figure ref="root" class="m-0 flex min-w-0 flex-col gap-2">
    <figcaption class="text-[13.5px] font-medium">{{ chart.title }}<span v-if="chart.unit !== ''" class="text-muted"> · {{ chart.unit }}</span></figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H" class="block h-auto max-w-full" role="img" :aria-label="chartSummary(chart)">
      <template v-if="chart.kind !== 'pie'">
        <g class="text-[11px]" fill="var(--muted)">
          <template v-for="tick in axis.ticks" :key="tick">
            <line :x1="box.left" :x2="box.right" :y1="scaleY(tick, axis, box.top, box.bottom)" :y2="scaleY(tick, axis, box.top, box.bottom)" stroke="var(--line)" :stroke-width="tick === 0 ? 1.4 : 1" />
            <text :x="box.left - 6" :y="scaleY(tick, axis, box.top, box.bottom) + 4" text-anchor="end">{{ formatValue(tick, '', true) }}</text>
          </template>
          <template v-for="(label, index) in chart.labels" :key="`l-${index}`">
            <text v-if="index % labelEvery === 0" :x="centers[index]" :y="box.bottom + 18" text-anchor="middle"><title>{{ label }}</title>{{ shortLabel(label, labelMax) }}</text>
          </template>
        </g>
        <g v-if="chart.kind === 'bar'">
          <rect v-for="bar in barList" :key="`${bar.series}-${bar.label}`" :x="bar.x" :y="bar.y" :width="bar.width" :height="Math.max(bar.height, 0.5)" rx="2" :fill="colorOf(bar.series)">
            <title>{{ chart.labels[bar.label] }} · {{ chart.series[bar.series]?.name }}: {{ formatValue(bar.value, chart.unit) }}</title>
          </rect>
          <template v-if="barValues && barRoom">
            <text
              v-for="bar in barList"
              :key="`v-${bar.series}-${bar.label}`"
              :x="bar.x + bar.width / 2"
              :y="bar.value >= 0 ? bar.y - 4 : bar.y + bar.height + 12"
              text-anchor="middle"
              class="text-[10.5px]"
              fill="var(--ink)"
            >{{ formatValue(bar.value, '', true) }}</text>
          </template>
        </g>
        <g v-else>
          <template v-for="(series, s) in chart.series" :key="`s-${s}`">
            <polyline :points="linePoints(series.values, axis, box)" fill="none" :stroke="colorOf(s)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
            <circle v-for="(value, index) in series.values" :key="`p-${s}-${index}`" :cx="centers[index]" :cy="scaleY(value, axis, box.top, box.bottom)" r="3.2" :fill="colorOf(s)">
              <title>{{ chart.labels[index] }} · {{ series.name }}: {{ formatValue(value, chart.unit) }}</title>
            </circle>
          </template>
        </g>
      </template>
      <g v-else>
        <path v-for="slice in slices" :key="slice.index" :d="slice.path" :fill="colorOf(slice.index)" stroke="var(--surface-2)" stroke-width="1.5">
          <title>{{ chart.labels[slice.index] }}: {{ formatValue(slice.value, chart.unit) }} ({{ shareText(slice.share) }})</title>
        </path>
        <g v-if="pieSide" class="text-[12px]" fill="var(--ink)">
          <text v-for="(label, index) in chart.labels.slice(0, 10)" :key="`pl-${index}`" :x="pieRadius * 2 + 40" :y="40 + index * 22">
            <tspan :fill="colorOf(index)">■</tspan> {{ shortLabel(label, Math.max(8, Math.floor((W - pieRadius * 2 - 60) / 7) - 12)) }} · {{ formatValue(chart.series[0]?.values[index] ?? 0, chart.unit, true) }}
          </text>
        </g>
      </g>
    </svg>
    <ul v-if="chart.kind !== 'pie' || !pieSide || chart.labels.length > 10" class="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12.5px] text-muted">
      <li v-for="item in legend" :key="item.name" class="inline-flex min-w-0 items-center gap-1.5">
        <i class="inline-block size-2.5 shrink-0 rounded-sm" :style="{ background: item.color }" aria-hidden="true" /><span class="truncate">{{ item.name }}</span><span v-if="item.extra !== ''">{{ item.extra }}</span>
      </li>
    </ul>
    <div>
      <button type="button" class="text-[12.5px] text-accent hover:underline" :aria-expanded="showTable" @click="showTable = !showTable">{{ showTable ? 'Nascondi i dati' : 'Mostra i dati' }}</button>
      <div v-if="showTable" class="mt-1.5 max-w-full overflow-x-auto">
        <table class="w-full border-collapse text-[13px]">
          <caption class="sr-only">{{ chart.title }}</caption>
          <thead>
            <tr>
              <th scope="col" class="border-b border-line-strong px-2 py-1 text-left font-semibold text-muted">Voce</th>
              <th v-for="series in chart.series" :key="series.name" scope="col" class="border-b border-line-strong px-2 py-1 text-right font-semibold text-muted">{{ series.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(label, index) in chart.labels" :key="`r-${index}`">
              <th scope="row" class="border-b border-line px-2 py-1 text-left font-normal">{{ label }}</th>
              <td v-for="series in chart.series" :key="series.name" class="border-b border-line px-2 py-1 text-right tabular-nums">{{ formatValue(series.values[index] ?? 0, chart.unit) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </figure>
</template>
