<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import { ApiError, loadKnowledgeGraph, loadKnowledgePage } from '../lib/api.ts';
import {
  blendView,
  centerOn,
  createSimulation,
  fitView,
  folderName,
  folderSlots,
  isSettled,
  matchesFilter,
  neighbours,
  nodeAt,
  reheat,
  resolveWikilink,
  step,
  toScreen,
  toWorld,
  wheelFactor,
  withAlpha,
  zoomAt,
  type GraphData,
  type KnowledgePage,
  type Simulation,
  type View,
} from '../lib/graph.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * "Conoscenza" (D-087): the pages of kb/ up to L2 as a force graph drawn on a
 * <canvas>, wikilinks and shared tags as edges. A click opens the page in the
 * panel on the right; its wikilinks jump to their node.
 */

const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref<HTMLDivElement | null>(null);
const graph = shallowRef<GraphData | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const filter = ref('');
const selected = ref(-1);
const hovered = ref(-1);
const page = ref<KnowledgePage | null>(null);
const pageLoading = ref(false);
const pageError = ref<string | null>(null);
const jumpNotice = ref<string | null>(null);

let sim: Simulation | null = null;
let adjacency: Set<number>[] = [];
let view: View = { x: 0, y: 0, k: 1 };
let glide: { from: View; to: View; start: number } | null = null;
/** The view follows the graph while it settles, until the user moves it. */
let autoFit = true;
let width = 0;
let height = 0;
let dpr = 1;
let frame = 0;
let lastDraw = 0;
let reduced = false;
/** Pulses and particles stop a few seconds after the last interaction, or when the window loses focus. */
const IDLE_MS = 6_000;
let lastInteraction = 0;
let windowFocused = true;

interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  grid: string;
  folders: string[];
  dark: boolean;
  /** A soft glow per folder colour, drawn as an image: cheaper than a gradient per node. */
  glows: Map<string, HTMLCanvasElement>;
}
let palette: Palette | null = null;

const nodes = computed(() => graph.value?.nodes ?? []);
const pageIds = computed(() => nodes.value.filter((node) => node.kind !== 'tag').map((node) => node.id));
const slots = computed(() => folderSlots(nodes.value.map((node) => node.folder)));
const matches = computed(() => nodes.value.map((node) => matchesFilter(node, filter.value)));
const filtering = computed(() => filter.value.trim() !== '');
const results = computed(() => (filtering.value ? nodes.value.map((node, index) => ({ node, index })).filter(({ index }) => matches.value[index]).slice(0, 8) : []));
const counts = computed(() => ({
  notes: pageIds.value.length,
  links: graph.value?.edges.length ?? 0,
  hidden: graph.value?.hidden ?? 0,
}));
const legend = computed(() => {
  const byFolder = new Map<string, number>();
  for (const node of nodes.value) byFolder.set(node.folder, (byFolder.get(node.folder) ?? 0) + 1);
  return [...byFolder].map(([folder, count]) => ({ folder, count, slot: slots.value.get(folder) ?? -1 })).sort((a, b) => (a.folder === '#' ? 1 : b.folder === '#' ? -1 : a.folder.localeCompare(b.folder)));
});
const selectedNode = computed(() => nodes.value[selected.value]);
const selectedNeighbours = computed(() => [...(adjacency[selected.value] ?? [])].map((index) => ({ index, node: nodes.value[index] })).filter((item) => item.node !== undefined));

const labelClass: Record<string, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };

function folderVar(folder: string): string {
  const slot = slots.value.get(folder);
  return slot === undefined ? 'var(--muted)' : `var(--graph-${String(slot + 1)})`;
}

function colorOf(index: number): string {
  const node = nodes.value[index];
  if (palette === null || node === undefined) return '#888888';
  if (node.kind === 'tag') return palette.muted;
  return palette.folders[slots.value.get(node.folder) ?? 0] ?? palette.accent;
}

function luminance(hex: string): number {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (match === null) return 0;
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => parseInt(part ?? '0', 16) / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function glowSprite(color: string, dark: boolean): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = 64;
  sprite.height = 64;
  const ctx = sprite.getContext('2d');
  if (ctx !== null) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, withAlpha(color, dark ? 0.75 : 0.45));
    gradient.addColorStop(0.3, withAlpha(color, dark ? 0.28 : 0.16));
    gradient.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  return sprite;
}

/** The colours of the theme in use, read from the CSS variables. */
function readPalette(): void {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const bg = v('--bg') || '#0a1316';
  const dark = luminance(bg) < 0.4;
  const folders = [1, 2, 3, 4, 5, 6].map((i) => v(`--graph-${String(i)}`) || '#4fd1c1');
  const muted = v('--muted') || '#7f9b98';
  const glows = new Map<string, HTMLCanvasElement>();
  for (const color of [...folders, muted, v('--accent')]) glows.set(color, glowSprite(color, dark));
  palette = { bg, surface: v('--surface'), ink: v('--ink'), muted, accent: v('--accent') || '#4fd1c1', grid: v('--grid'), folders, dark, glows };
  requestFrame();
}

function resize(): void {
  const element = canvas.value;
  const parent = box.value;
  if (element === null || parent === null) return;
  const rect = parent.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  const first = width === 0;
  width = rect.width;
  height = rect.height;
  element.width = Math.max(1, Math.round(width * dpr));
  element.height = Math.max(1, Math.round(height * dpr));
  element.style.width = `${String(width)}px`;
  element.style.height = `${String(height)}px`;
  if (first && sim !== null) view = fitView(sim.nodes, width, height);
  requestFrame();
}

function requestFrame(): void {
  if (frame !== 0 || typeof document === 'undefined' || document.hidden) return;
  frame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  frame = 0;
  if (sim === null || document.hidden) return;
  if (window.devicePixelRatio !== dpr) resize();
  const settled = isSettled(sim);
  if (!settled) {
    step(sim);
    if (autoFit && glide === null) view = blendView(view, fitView(sim.nodes, width, height), 0.08);
  }
  if (glide !== null) {
    const t = (now - glide.start) / 450;
    view = blendView(glide.from, glide.to, t);
    if (t >= 1) glide = null;
  }
  const animating = !reduced && windowFocused && now - lastInteraction < IDLE_MS;
  // Settled and only pulsing: half the frame rate is enough.
  if (settled && glide === null && drag === null && animating && now - lastDraw < 32) {
    requestFrame();
    return;
  }
  lastDraw = now;
  draw(now);
  if (!isSettled(sim) || glide !== null || animating) requestFrame();
}

function drawGrid(ctx: CanvasRenderingContext2D, colors: Palette): void {
  let spacing = 40 * view.k;
  while (spacing < 22) spacing *= 2;
  while (spacing > 90) spacing /= 2;
  const ox = ((view.x % spacing) + spacing) % spacing;
  const oy = ((view.y % spacing) + spacing) % spacing;
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid || withAlpha(colors.accent, 0.05);
  ctx.beginPath();
  for (let x = ox; x < width; x += spacing) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = oy; y < height; y += spacing) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
  // A soft halo at the centre of the world, as a reactor glow.
  const centre = toScreen(view, 0, 0);
  const radius = Math.max(width, height) * 0.6;
  const halo = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
  halo.addColorStop(0, withAlpha(colors.accent, colors.dark ? 0.07 : 0.05));
  halo.addColorStop(1, withAlpha(colors.accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);
}

function draw(now: number): void {
  const element = canvas.value;
  const data = graph.value;
  const colors = palette;
  if (element === null || sim === null || data === null || colors === null) return;
  const ctx = element.getContext('2d');
  if (ctx === null) return;
  const time = now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, colors);

  const focus = hovered.value >= 0 ? hovered.value : selected.value;
  const lit = focus >= 0 ? new Set([focus, ...(adjacency[focus] ?? [])]) : null;
  const showFilter = filtering.value;
  const visible = (i: number): boolean => (lit === null || lit.has(i)) && (!showFilter || matches.value[i] === true);
  const simNodes = sim.nodes;

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  const pixel = 1 / view.k;

  // Edges, grouped by phase so the pulse costs a few strokes, not one per edge.
  const PHASES = 6;
  for (const type of ['link', 'tag'] as const) {
    ctx.setLineDash(type === 'tag' ? [3 * pixel, 4 * pixel] : []);
    for (let phase = 0; phase < PHASES; phase += 1) {
      const pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(time * 1.6 + phase * 1.05);
      for (const bright of [false, true]) {
        ctx.beginPath();
        let any = false;
        sim.links.forEach((link, index) => {
          if (index % PHASES !== phase || data.edges[link.edge]?.type !== type) return;
          const on = lit !== null && (link.source === focus || link.target === focus);
          if (on !== bright) return;
          const a = simNodes[link.source];
          const b = simNodes[link.target];
          if (a === undefined || b === undefined) return;
          if (!bright && (lit !== null || showFilter) && !(visible(link.source) && visible(link.target))) return;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          any = true;
        });
        if (!any) continue;
        const base = bright ? 0.85 : type === 'link' ? 0.32 : 0.2;
        ctx.strokeStyle = withAlpha(bright ? colors.accent : type === 'link' ? colors.accent : colors.muted, base * pulse);
        ctx.lineWidth = (bright ? 1.6 : 1) * pixel;
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  // Faded edges when something is in focus or filtered: one stroke.
  if (lit !== null || showFilter) {
    ctx.beginPath();
    sim.links.forEach((link) => {
      if (visible(link.source) && visible(link.target)) return;
      if (lit !== null && (link.source === focus || link.target === focus)) return;
      const a = simNodes[link.source];
      const b = simNodes[link.target];
      if (a === undefined || b === undefined) return;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    });
    ctx.strokeStyle = withAlpha(colors.muted, 0.07);
    ctx.lineWidth = pixel;
    ctx.stroke();
  }

  // Particles flowing out of the selected node along its edges.
  if (!reduced && selected.value >= 0) {
    const from = selected.value;
    ctx.fillStyle = colors.accent;
    sim.links.forEach((link, index) => {
      if (link.source !== from && link.target !== from) return;
      const a = simNodes[from];
      const b = simNodes[link.source === from ? link.target : link.source];
      if (a === undefined || b === undefined) return;
      for (let j = 0; j < 3; j += 1) {
        const t = (time * 0.45 + j / 3 + index * 0.137) % 1;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const size = Math.max(1.2, 2.2 * pixel) * (1 - Math.abs(t - 0.5));
        ctx.globalAlpha = 0.35 + 0.65 * Math.sin(t * Math.PI);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }

  // Glows: additive light on the dark theme.
  const many = simNodes.length > 1200;
  ctx.globalCompositeOperation = colors.dark ? 'lighter' : 'source-over';
  simNodes.forEach((node, i) => {
    const on = visible(i);
    if (many && !(lit?.has(i) ?? false)) return;
    const sprite = colors.glows.get(colorOf(i));
    if (sprite === undefined) return;
    const breathe = reduced ? 1 : 1 + 0.06 * Math.sin(time * 2 + i);
    const radius = node.r * (i === focus ? 4.4 : 3.2) * breathe;
    ctx.globalAlpha = on ? 1 : 0.12;
    ctx.drawImage(sprite, node.x - radius, node.y - radius, radius * 2, radius * 2);
  });
  ctx.globalCompositeOperation = 'source-over';

  // Cores.
  simNodes.forEach((node, i) => {
    const color = colorOf(i);
    const on = visible(i);
    ctx.globalAlpha = on ? 1 : 0.18;
    const isTag = nodes.value[i]?.kind === 'tag';
    ctx.beginPath();
    if (isTag) {
      // A hexagon for the tag nodes.
      for (let side = 0; side < 6; side += 1) {
        const angle = (Math.PI / 3) * side + Math.PI / 6;
        const x = node.x + Math.cos(angle) * node.r;
        const y = node.y + Math.sin(angle) * node.r;
        if (side === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4 * pixel;
      ctx.stroke();
    } else {
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(colors.dark ? '#ffffff' : colors.bg, colors.dark ? 0.55 : 0.7);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;

  // The reticle of the selected node and the ring of the hovered one.
  const ring = (i: number, spin: boolean) => {
    const node = simNodes[i];
    if (node === undefined) return;
    const radius = node.r + 5 * pixel + 3;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.3 * pixel;
    if (spin) {
      const turn = reduced ? 0 : time * 0.8;
      for (let q = 0; q < 4; q += 1) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, turn + (q * Math.PI) / 2, turn + (q * Math.PI) / 2 + Math.PI / 3.2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 6 * pixel, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(colors.accent, 0.25);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  if (selected.value >= 0) ring(selected.value, true);
  if (hovered.value >= 0 && hovered.value !== selected.value) ring(hovered.value, false);
  ctx.restore();

  // Titles in screen space, crisp at any zoom.
  ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let shown = 0;
  simNodes.forEach((node, i) => {
    const special = i === focus || i === selected.value;
    const near = lit?.has(i) ?? false;
    const matched = showFilter && matches.value[i] === true;
    const zoomed = view.k >= 1.15 && visible(i) && node.r * view.k >= 6;
    if (!(special || near || (matched && shown < 40) || zoomed)) return;
    const at = toScreen(view, node.x, node.y + node.r);
    if (at.x < -100 || at.x > width + 100 || at.y < -20 || at.y > height + 20) return;
    const title = nodes.value[i]?.title ?? '';
    const text = title.length > 32 ? `${title.slice(0, 31)}…` : title;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = special ? 1 : 0.85;
    ctx.fillStyle = withAlpha(colors.surface || colors.bg, 0.78);
    ctx.fillRect(at.x - w / 2 - 4, at.y + 4, w + 8, 16);
    ctx.fillStyle = special ? colors.accent : colors.ink;
    ctx.fillText(text, at.x, at.y + 6.5);
    shown += 1;
  });
  ctx.globalAlpha = 1;
}

// Pointer: drag a node, pan the background, pinch with two fingers, click to select.
const pointers = new Map<number, { x: number; y: number }>();
type Drag =
  | { kind: 'node'; index: number; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'pinch'; distance: number; mid: { x: number; y: number }; view: View };
let drag: Drag | null = null;

function local(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function hit(x: number, y: number, touch: boolean): number {
  if (sim === null) return -1;
  const world = toWorld(view, x, y);
  return nodeAt(sim.nodes, world.x, world.y, (touch ? 14 : 4) / view.k);
}

function pinchOf(): { distance: number; mid: { x: number; y: number } } | undefined {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return undefined;
  return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function release(): void {
  if (drag?.kind === 'node' && sim !== null) {
    const node = sim.nodes[drag.index];
    if (node !== undefined) node.fixed = false;
    sim.alphaTarget = 0;
  }
}

function onPointerDown(event: PointerEvent): void {
  if (sim === null) return;
  canvas.value?.setPointerCapture(event.pointerId);
  const at = local(event);
  pointers.set(event.pointerId, at);
  autoFit = false;
  glide = null;
  if (pointers.size === 2) {
    release();
    const pinch = pinchOf();
    if (pinch !== undefined) drag = { kind: 'pinch', ...pinch, view };
    return;
  }
  if (pointers.size > 2) return;
  const index = hit(at.x, at.y, event.pointerType === 'touch');
  if (index >= 0) {
    drag = { kind: 'node', index, startX: at.x, startY: at.y, moved: false };
  } else {
    drag = { kind: 'pan', startX: at.x, startY: at.y, view, moved: false };
  }
  requestFrame();
}

function onPointerMove(event: PointerEvent): void {
  const at = local(event);
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, at);
  if (drag === null) {
    const index = event.pointerType === 'touch' ? -1 : hit(at.x, at.y, false);
    if (index !== hovered.value) {
      hovered.value = index;
      if (canvas.value !== null) canvas.value.style.cursor = index >= 0 ? 'pointer' : 'grab';
      requestFrame();
    }
    return;
  }
  if (drag.kind === 'pinch') {
    const pinch = pinchOf();
    if (pinch === undefined) return;
    const zoomed = zoomAt(drag.view, drag.mid.x, drag.mid.y, pinch.distance / drag.distance);
    view = { ...zoomed, x: zoomed.x + pinch.mid.x - drag.mid.x, y: zoomed.y + pinch.mid.y - drag.mid.y };
  } else if (drag.kind === 'pan') {
    if (Math.hypot(at.x - drag.startX, at.y - drag.startY) > 3) drag.moved = true;
    view = { ...drag.view, x: drag.view.x + at.x - drag.startX, y: drag.view.y + at.y - drag.startY };
    if (canvas.value !== null) canvas.value.style.cursor = 'grabbing';
  } else if (sim !== null) {
    if (!drag.moved && Math.hypot(at.x - drag.startX, at.y - drag.startY) > 3) {
      drag.moved = true;
      const node = sim.nodes[drag.index];
      if (node !== undefined) node.fixed = true;
      sim.alphaTarget = 0.3;
      reheat(sim);
    }
    if (drag.moved) {
      const node = sim.nodes[drag.index];
      const world = toWorld(view, at.x, at.y);
      if (node !== undefined) {
        node.x = world.x;
        node.y = world.y;
      }
    }
  }
  requestFrame();
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  const done = drag;
  if (done?.kind === 'pinch') {
    // One finger left: it pans from here.
    const rest = [...pointers.values()][0];
    drag = rest === undefined ? null : { kind: 'pan', startX: rest.x, startY: rest.y, view, moved: true };
    return;
  }
  release();
  drag = null;
  if (canvas.value !== null) canvas.value.style.cursor = hovered.value >= 0 ? 'pointer' : 'grab';
  if (done?.kind === 'node' && !done.moved) void select(done.index);
  else if (done?.kind === 'pan' && !done.moved && event.type === 'pointerup') void select(-1);
  requestFrame();
}

function onPointerLeave(): void {
  if (drag === null && hovered.value !== -1) {
    hovered.value = -1;
    requestFrame();
  }
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const at = local(event);
  autoFit = false;
  glide = null;
  view = zoomAt(view, at.x, at.y, wheelFactor(event.deltaY, event.deltaMode));
  requestFrame();
}

function onDoubleClick(event: MouseEvent): void {
  const at = local(event);
  if (hit(at.x, at.y, false) < 0) fit();
}

function glideTo(to: View): void {
  if (reduced) {
    view = to;
    glide = null;
  } else {
    glide = { from: view, to, start: performance.now() };
  }
  autoFit = false;
  requestFrame();
}

function fit(): void {
  if (sim !== null) glideTo(fitView(sim.nodes, width - (selected.value >= 0 && width > 900 ? 400 : 0), height));
}

function focusOn(index: number): void {
  const node = sim?.nodes[index];
  if (node === undefined) return;
  void select(index);
  // Leave room for the panel on wide screens.
  const panel = width > 900 ? 400 : 0;
  glideTo(centerOn(width - panel, height, node.x, node.y, Math.max(view.k, 1.4)));
}

let pageRequest = 0;
async function select(index: number): Promise<void> {
  selected.value = index;
  jumpNotice.value = null;
  requestFrame();
  const node = nodes.value[index];
  page.value = null;
  pageError.value = null;
  if (node === undefined || node.kind === 'tag') return;
  const request = ++pageRequest;
  pageLoading.value = true;
  try {
    const loaded = await loadKnowledgePage(node.id);
    if (request === pageRequest) page.value = loaded;
  } catch (failure) {
    if (request === pageRequest) pageError.value = failure instanceof ApiError && failure.status === 404 ? 'Pagina non più disponibile.' : 'Non riesco a leggere la pagina.';
  } finally {
    if (request === pageRequest) pageLoading.value = false;
  }
}

function followWikilink(target: string): void {
  const id = resolveWikilink(target, pageIds.value);
  const index = id === undefined ? -1 : nodes.value.findIndex((node) => node.id === id);
  if (index < 0) {
    jumpNotice.value = `«${target}» non è nel grafo.`;
    return;
  }
  focusOn(index);
}

function chooseResult(): void {
  const first = results.value[0];
  if (first !== undefined) focusOn(first.index);
}

function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await loadKnowledgeGraph();
    const previousIds = graph.value?.nodes.map((node) => node.id) ?? [];
    const previous = new Map(sim?.nodes.map((node, i) => [previousIds[i] ?? '', { x: node.x, y: node.y }]) ?? []);
    const selectedId = selectedNode.value?.id;
    graph.value = data;
    sim = createSimulation(data.nodes, data.edges, previous);
    adjacency = neighbours(data.nodes.length, sim.links);
    // A head start, so the first frame is not a tangle.
    if (previous.size === 0) {
      const warm = Math.min(120, Math.floor(60_000 / Math.max(1, data.nodes.length)));
      for (let i = 0; i < warm; i += 1) step(sim);
      autoFit = true;
      if (width > 0) view = fitView(sim.nodes, width, height);
    }
    selected.value = selectedId === undefined ? -1 : data.nodes.findIndex((node) => node.id === selectedId);
    hovered.value = -1;
    if (selected.value < 0) page.value = null;
    requestFrame();
  } catch (failure) {
    error.value = failure instanceof ApiError ? `Non riesco a caricare il grafo (${failure.message}).` : 'Non riesco a caricare il grafo.';
  } finally {
    loading.value = false;
  }
}

watch([filter, selected], () => wake());

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selected.value >= 0) void select(-1);
}

function onVisibility(): void {
  if (!document.hidden) wake();
}

/** Any interaction: the animation resumes for IDLE_MS. */
function wake(): void {
  lastInteraction = performance.now();
  windowFocused = document.hasFocus();
  requestFrame();
}

function onBlur(): void {
  windowFocused = false;
}

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focus'] as const;
let observer: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
const motion = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
const scheme = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: light)');
const onMotion = () => {
  reduced = motion?.matches ?? false;
  requestFrame();
};

onMounted(() => {
  reduced = motion?.matches ?? false;
  motion?.addEventListener('change', onMotion);
  scheme?.addEventListener('change', readPalette);
  themeObserver = new MutationObserver(readPalette);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  readPalette();
  observer = new ResizeObserver(resize);
  if (box.value !== null) observer.observe(box.value);
  resize();
  canvas.value?.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  for (const name of WAKE_EVENTS) window.addEventListener(name, wake, { passive: true });
  wake();
  void load();
});

onBeforeUnmount(() => {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  observer?.disconnect();
  themeObserver?.disconnect();
  motion?.removeEventListener('change', onMotion);
  scheme?.removeEventListener('change', readPalette);
  canvas.value?.removeEventListener('wheel', onWheel);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('blur', onBlur);
  for (const name of WAKE_EVENTS) window.removeEventListener(name, wake);
  sim = null;
});
</script>

<template>
  <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <div ref="box" class="absolute inset-0">
      <canvas
        ref="canvas"
        class="block touch-none select-none"
        style="cursor: grab"
        role="img"
        :aria-label="`Grafo della conoscenza: ${counts.notes} note e ${counts.links} collegamenti. Usa il filtro per cercare una nota.`"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @dblclick="onDoubleClick"
      />
    </div>

    <!-- Title, counter, filter -->
    <div class="pointer-events-none absolute top-3 left-3 flex w-[min(340px,calc(100%-24px))] flex-col gap-2">
      <div class="hud-card pointer-events-auto bg-surface/85 p-3 backdrop-blur-sm">
        <div class="flex items-center gap-2">
          <Icon name="knowledge" :size="16" />
          <h1 class="font-hud text-[15px] font-semibold tracking-[0.12em] uppercase">Conoscenza</h1>
          <button type="button" class="ml-auto rounded-md p-1 text-muted hover:text-ink" title="Ricentra" aria-label="Ricentra il grafo" @click="fit">
            <Icon name="focus" :size="15" />
          </button>
          <button type="button" class="rounded-md p-1 text-muted hover:text-ink" title="Aggiorna" aria-label="Aggiorna il grafo" :disabled="loading" @click="load">
            <Icon name="retry" :size="15" />
          </button>
        </div>
        <p class="mt-1.5 font-mono text-[11px] tracking-[0.04em] text-muted" aria-live="polite">
          <span class="text-ink">{{ counts.notes }}</span> note · <span class="text-ink">{{ counts.links }}</span> collegamenti ·
          <span :class="counts.hidden > 0 ? 'text-l3' : ''">{{ counts.hidden }}</span> nascoste (L3)
          <template v-if="graph?.truncated"> · troppe pagine, mostrate le prime</template>
        </p>
        <label class="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 focus-within:border-accent">
          <Icon name="search" :size="14" />
          <input
            v-model="filter"
            type="search"
            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            placeholder="Filtra per titolo o #tag"
            aria-label="Filtra le note per titolo o tag"
            @keydown.enter.prevent="chooseResult"
          />
        </label>
        <ul v-if="filtering" class="mt-1.5 flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          <li v-for="{ node, index } in results" :key="node.id">
            <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface-2" @click="focusOn(index)">
              <span class="size-2 shrink-0 rounded-full" :style="{ background: folderVar(node.folder) }" />
              <span class="min-w-0 flex-1 truncate">{{ node.title }}</span>
              <span class="font-mono text-[10px] text-muted">{{ folderName(node.folder) }}</span>
            </button>
          </li>
          <li v-if="results.length === 0" class="px-2 py-1 text-[13px] text-muted">Nessuna nota corrisponde.</li>
        </ul>
      </div>
      <p v-if="error !== null" role="alert" class="pointer-events-auto rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    </div>

    <!-- Legend -->
    <div v-if="legend.length > 0" class="hud-card pointer-events-auto absolute bottom-3 left-3 max-w-[calc(100%-24px)] bg-surface/85 px-3 py-2.5 backdrop-blur-sm">
      <h2 class="hud-title mb-1.5">Legenda</h2>
      <ul class="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px]">
        <li v-for="item in legend" :key="item.folder" class="flex items-center gap-1.5">
          <span
            v-if="item.folder === '#'"
            class="inline-block size-2.5 rotate-45 border border-muted"
          />
          <span v-else class="inline-block size-2.5 rounded-full" :style="{ background: folderVar(item.folder), boxShadow: `0 0 8px ${folderVar(item.folder)}` }" />
          <button type="button" class="hover:text-accent" :title="`Filtra: ${folderName(item.folder)}`" @click="filter = item.folder === '#' ? 'tag:' : item.folder === '' ? '' : `${item.folder}/`">
            {{ folderName(item.folder) }} <span class="text-muted">{{ item.count }}</span>
          </button>
        </li>
      </ul>
      <p class="mt-1.5 flex flex-wrap gap-x-3.5 font-mono text-[10.5px] text-muted">
        <span class="flex items-center gap-1.5"><span class="inline-block h-px w-5 bg-accent" />collegamento</span>
        <span class="flex items-center gap-1.5"><span class="inline-block w-5 border-t border-dashed border-muted" />tag in comune</span>
      </p>
    </div>

    <!-- Empty -->
    <div v-if="!loading && error === null && nodes.length === 0" class="pointer-events-none absolute inset-0 grid place-items-center p-8 text-center">
      <div class="max-w-sm">
        <p class="font-hud text-lg font-semibold tracking-[0.05em]">La rete è ancora vuota</p>
        <p class="mt-2 text-sm text-muted">Salva un pensiero con «/nota» o «Salva in inbox»: ogni nota diventa un nodo, i collegamenti fra note diventano archi.</p>
      </div>
    </div>
    <p v-if="loading && nodes.length === 0" class="absolute inset-0 grid place-items-center font-mono text-xs tracking-[0.12em] text-muted">CARICO LA RETE…</p>

    <!-- The page of the selected node -->
    <aside
      v-if="selectedNode !== undefined"
      class="hud-card absolute top-3 right-3 bottom-3 flex w-[min(400px,calc(100%-24px))] flex-col bg-surface/95 backdrop-blur-sm"
      aria-label="Nota selezionata"
    >
      <header class="flex items-start gap-2 border-b border-line px-4 pt-3.5 pb-3">
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.06em] text-muted uppercase">
            <span class="inline-block size-2 rounded-full" :style="{ background: folderVar(selectedNode.folder) }" />
            {{ folderName(selectedNode.folder) }}
            <template v-if="selectedNode.kind !== null && selectedNode.kind !== 'tag'"> · {{ selectedNode.kind }}</template>
          </p>
          <h2 class="mt-1 font-hud text-[17px] leading-snug font-semibold break-words">{{ selectedNode.title }}</h2>
        </div>
        <span class="lab mt-0.5" :class="labelClass[selectedNode.label]" :title="LABEL_TEXT[selectedNode.label]">{{ selectedNode.label }}</span>
        <button type="button" class="rounded-md p-1 text-muted hover:text-ink" aria-label="Chiudi la nota" @click="select(-1)">
          <Icon name="close" :size="16" />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p v-if="selectedNode.updatedAt !== null" class="font-mono text-[10.5px] text-muted">Aggiornata {{ formatDate(selectedNode.updatedAt) }}</p>
        <div v-if="selectedNode.tags.length > 0" class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="tag in selectedNode.tags"
            :key="tag"
            type="button"
            class="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[11px] text-muted hover:border-accent hover:text-accent"
            :title="`Filtra #${tag}`"
            @click="filter = `#${tag}`"
          >
            #{{ tag }}
          </button>
        </div>
        <p v-if="jumpNotice !== null" class="mt-2 text-xs text-warn" role="status">{{ jumpNotice }}</p>
        <p v-if="pageLoading" class="mt-3 font-mono text-xs text-muted">Leggo la nota…</p>
        <p v-else-if="pageError !== null" class="mt-3 text-sm text-danger">{{ pageError }}</p>
        <MarkdownText v-else-if="page !== null && page.id === selectedNode.id" class="mt-3" :source="page.body" :wikilink="followWikilink" />
        <section v-if="selectedNeighbours.length > 0" class="mt-4 border-t border-line pt-3">
          <h3 class="hud-title mb-1.5">{{ selectedNode.kind === 'tag' ? 'Note con questo tag' : 'Collegata a' }} · {{ selectedNeighbours.length }}</h3>
          <ul class="flex flex-col gap-0.5">
            <li v-for="item in selectedNeighbours" :key="item.node?.id">
              <button type="button" class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface-2" @click="focusOn(item.index)">
                <span class="size-2 shrink-0 rounded-full" :style="{ background: item.node?.kind === 'tag' ? 'var(--muted)' : folderVar(item.node?.folder ?? '') }" />
                <span class="min-w-0 flex-1 truncate">{{ item.node?.title }}</span>
              </button>
            </li>
          </ul>
        </section>
      </div>
    </aside>
  </div>
</template>
