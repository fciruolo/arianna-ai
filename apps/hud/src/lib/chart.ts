/**
 * The charts of the Dashboard (D-248): the data the core checked
 * (dashboard-chart.ts) drawn in SVG of our own, no library. Pure helpers: the
 * scale, the ticks, the bars, the line, the slices of a pie, the numbers in
 * Italian. The colours are the tokens of the theme (light and dark).
 */

export type ChartKind = 'bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  kind: ChartKind;
  title: string;
  unit: string;
  labels: string[];
  series: ChartSeries[];
}

/** One colour per series (or per slice of a pie), from the tokens of the theme. */
export const SERIES_COLORS = ['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--ok)', 'var(--danger)', 'var(--muted)'] as const;

export function colorOf(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? 'var(--accent)';
}

const FORMAT = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
const COMPACT = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });

/** «1.234,5 €», «12 ore», «40 %»: the unit after the number, as Italian writes it. */
export function formatValue(value: number, unit: string, compact = false): string {
  const number = (compact && Math.abs(value) >= 10_000 ? COMPACT : FORMAT).format(value);
  return unit === '' ? number : `${number} ${unit}`;
}

/** A «nice» step for about `count` ticks: 1, 2 or 5 times a power of ten. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** The axis of the values: from at most 0 to at least 0, nice ticks; a flat series still has a span. */
export function valueAxis(values: readonly number[], count = 4): { min: number; max: number; ticks: number[] } {
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (low === high) high = low + 1;
  const step = niceStep(high - low, count);
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
  return { min: low, max: high, ticks };
}

/** Where a value falls between `top` and `bottom` (SVG y grows downwards). */
export function scaleY(value: number, axis: { min: number; max: number }, top: number, bottom: number): number {
  return bottom - ((value - axis.min) / (axis.max - axis.min)) * (bottom - top);
}

export interface Bar {
  series: number;
  label: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

/** The bars of a grouped chart, inside [left, right] × [top, bottom]; a negative value hangs under zero. */
export function bars(chart: Pick<ChartData, 'labels' | 'series'>, axis: { min: number; max: number }, box: { left: number; right: number; top: number; bottom: number }): Bar[] {
  const groups = chart.labels.length;
  const band = (box.right - box.left) / Math.max(1, groups);
  const inner = band * 0.72;
  const width = inner / Math.max(1, chart.series.length);
  const zero = scaleY(0, axis, box.top, box.bottom);
  const out: Bar[] = [];
  chart.series.forEach((series, s) => {
    series.values.forEach((value, l) => {
      const y = scaleY(value, axis, box.top, box.bottom);
      out.push({ series: s, label: l, x: box.left + band * l + (band - inner) / 2 + width * s, y: Math.min(y, zero), width: Math.max(1, width - 2), height: Math.abs(zero - y), value });
    });
  });
  return out;
}

/** The x of the centre of each label's band. */
export function bandCenters(count: number, left: number, right: number): number[] {
  const band = (right - left) / Math.max(1, count);
  return Array.from({ length: count }, (_, index) => left + band * index + band / 2);
}

/** The points of a line, as the `points` of an SVG polyline. */
export function linePoints(values: readonly number[], axis: { min: number; max: number }, box: { left: number; right: number; top: number; bottom: number }): string {
  const xs = bandCenters(values.length, box.left, box.right);
  return values.map((value, index) => `${(xs[index] ?? 0).toFixed(1)},${scaleY(value, axis, box.top, box.bottom).toFixed(1)}`).join(' ');
}

export interface Slice {
  index: number;
  value: number;
  share: number;
  path: string;
}

/** The slices of a pie centred in (cx, cy): one path each, the share of the total; a single slice is the whole circle. */
export function pieSlices(values: readonly number[], cx: number, cy: number, radius: number): Slice[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];
  let angle = -Math.PI / 2;
  const out: Slice[] = [];
  values.forEach((raw, index) => {
    const value = Math.max(0, raw);
    if (value === 0) return;
    const share = value / total;
    const end = angle + share * Math.PI * 2;
    const point = (at: number): string => `${(cx + radius * Math.cos(at)).toFixed(2)} ${(cy + radius * Math.sin(at)).toFixed(2)}`;
    const path =
      share >= 0.9999
        ? `M ${point(angle)} A ${String(radius)} ${String(radius)} 0 1 1 ${point(angle + Math.PI)} A ${String(radius)} ${String(radius)} 0 1 1 ${point(angle)} Z`
        : `M ${String(cx)} ${String(cy)} L ${point(angle)} A ${String(radius)} ${String(radius)} 0 ${share > 0.5 ? '1' : '0'} 1 ${point(end)} Z`;
    out.push({ index, value, share, path });
    angle = end;
  });
  return out;
}

/** «38 %» of a slice. */
export function shareText(share: number): string {
  return `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: share < 0.1 ? 1 : 0 }).format(share * 100)} %`;
}

/** A label cut to `max` characters for the axis; the whole one stays in the table and the title. */
export function shortLabel(label: string, max: number): string {
  const chars = Array.from(label);
  return chars.length <= max ? label : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** What a screen reader hears of a chart: kind, title, how many labels and series. */
export function chartSummary(chart: ChartData): string {
  const kind = chart.kind === 'bar' ? 'Grafico a barre' : chart.kind === 'line' ? 'Grafico a linee' : 'Grafico a torta';
  const series = chart.series.length === 1 ? '1 serie' : `${String(chart.series.length)} serie`;
  return `${kind}: ${chart.title}, ${String(chart.labels.length)} voci, ${series}. I dati sono nella tabella «Mostra i dati».`;
}
