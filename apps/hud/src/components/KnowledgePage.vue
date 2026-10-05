<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import { ApiError, loadKnowledgeGraph, loadKnowledgePage } from '../lib/api.ts';
import {
  advanceOrbit,
  blendView,
  breathOffset,
  centerOn,
  createSimulation,
  fitView,
  folderName,
  folderSlots,
  frameDue,
  frameInterval,
  hubGlow,
  isSettled,
  makeStars,
  matchesFilter,
  neighbours,
  nodeAt,
  pulseProgress,
  reheat,
  resolveWikilink,
  rotatePoint,
  sceneMode,
  seededRandom,
  starPosition,
  step,
  themeIsDark,
  toScreen,
  toWorld,
  updatePulses,
  wheelFactor,
  withAlpha,
  zoomAt,
  type GraphData,
  type KnowledgePage,
  type Pulse,
  type Simulation,
  type Star,
  type View,
} from '../lib/graph.ts';
import {
  blendCamera,
  copyCamera,
  createSimulation3,
  depthOrder,
  driftWeight,
  driftYaw,
  emptyProjection,
  fitCamera,
  flyTarget,
  fogAlpha,
  hitTest3,
  isSettled3,
  makeProjector,
  NEAR,
  NEAR_FADE,
  nearFade,
  orbitBy,
  projectInto,
  projectNodes,
  projectSegment,
  readViewMode,
  step3,
  updateProjector,
  wrapAngle,
  zoomCamera,
  type Camera,
  type Point3,
  type Projected,
  type Projector,
  type Segment,
  type Simulation3,
} from '../lib/graph3d.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import Icon from './Icon.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * "Conoscenza" (D-087): the pages of kb/ up to L2 as a force graph drawn on a
 * <canvas>, wikilinks and shared tags as edges. A click opens the page in the
 * panel on the right; its wikilinks jump to their node.
 *
 * D-087b: a control room. With the dark theme it is always black, with its
 * own palette (the CSS variables are redefined on the root of the page); with
 * the light theme it follows the platform unless "Sfondo scuro" is on. Stars
 * drift on a background canvas, a graph that keeps breathing after it settles, pulses
 * running along the edges, an optional slow orbit and full screen.
 *
 * D-104: a 3D view on request (2D/3D switch, remembered in this browser).
 * The same graph in a 3D force simulation, seen through an orbital camera
 * with a perspective projection on the same canvas: drag to turn, wheel or
 * pinch to zoom, a click on a node flies there; nodes fade with distance
 * (fog), painted from the farthest; a slow drift when nobody touches it.
 */

const props = defineProps<{
  /** A node to select once the graph is loaded (D-090, `/conoscenza?nota=…`). */
  focus?: string | undefined;
}>();

const root = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const backdrop = ref<HTMLCanvasElement | null>(null);
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
const focusNotice = ref<string | null>(null);
/** The focus asked by the address, applied once. */
let pendingFocus = props.focus;
const canFullscreen = ref(false);
const fullscreen = ref(false);
const orbiting = ref(false);
const reducedMotion = ref(false);
/** The theme the chat shows, as style.css decides it. */
const themeDark = ref(true);
/** "Sfondo scuro" with the light theme: a convenience of this browser (localStorage). */
const darkChoice = ref(false);
const mode = computed(() => sceneMode(themeDark.value, darkChoice.value));
const DARK_KEY = 'arianna.knowledge.dark';
/** "2d" or "3d" (D-104): a convenience of this browser (localStorage). */
const VIEW_KEY = 'arianna.knowledge.view';
const view3d = ref(false);
/** The slow drift of the 3D camera when the graph is left alone. */
const drifting = ref(true);

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
/** A drawing was asked for (an event, a change): it happens even when the loop would rest. */
let dirty = true;
let reduced = false;
/** After an interaction the page draws at full rate for this long. */
const INTERACT_MS = 1_500;
let lastInteraction = 0;
let windowFocused = true;
/** When the simulation settled (0: not settled); the breath fades in from there. */
let settledAt = 0;
let orbitAngle = 0;
let pulses: readonly Pulse[] = [];
const pulseRandom = seededRandom(87);
let stars: Star[] = [];
let maxDegree = 0;
/** Where each node is drawn this frame: turned by the orbit, plus its breath. */
let px = new Float64Array(0);
let py = new Float64Array(0);
/** Screen pixels of the breath. */
const BREATH_PX = 2.4;

// The 3D view (D-104).
let sim3: Simulation3 | null = null;
let camera: Camera = { target: { x: 0, y: 0, z: 0 }, yaw: 0.6, pitch: -0.35, distance: 600 };
let flight: { from: Camera; to: Camera; start: number } | null = null;
/** The camera follows the graph while it settles, until the user moves it. */
let autoFit3 = true;
let projector: Projector | null = null;
let proj3 = emptyProjection(0);
let fog3 = new Float64Array(0);
let order3: Uint32Array = new Uint32Array(0);
/** The titles chosen this frame, nearest first. */
let labelPick = new Uint32Array(0);
/** Pixels the centre of the 3D view moves (left, negative) to leave room for the panel. */
let shift3 = 0;
/** The stars follow the turns of the camera without jumping where the yaw wraps. */
let starPanX = 0;
let lastStarYaw = 0;
const FLIGHT_MS = 900;

/** True when the 3D view is on and its simulation exists. */
function is3d(): boolean {
  return view3d.value && sim3 !== null;
}

/** The room the note panel takes on wide screens, as a shift of the centre. */
function panelShift(): number {
  return selected.value >= 0 && width > 900 ? -400 : 0;
}

/** The palette of the black control room: luminous on black (D-087b). */
const SCENE = {
  bg: '#02050a',
  surface: '#07111a',
  ink: '#d6f4ff',
  muted: '#7690a8',
  tag: '#8aa0c4',
  accent: '#3ee8ff',
  violet: '#a879ff',
  folders: ['#3ee8ff', '#5cffb1', '#a879ff', '#ffb547', '#5b9dff', '#ff6bcb'],
} as const;

interface Palette {
  /** Black control room (light on black, additive glows) or the light platform. */
  dark: boolean;
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  tag: string;
  accent: string;
  violet: string;
  folders: readonly string[];
  /** A soft glow per colour, drawn as an image: cheaper than a gradient per node. */
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
  if (node.kind === 'tag') return palette.tag;
  return palette.folders[slots.value.get(node.folder) ?? 0] ?? palette.accent;
}

function glowSprite(color: string, dark: boolean): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = 64;
  sprite.height = 64;
  const ctx = sprite.getContext('2d');
  if (ctx !== null) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, withAlpha(color, dark ? 0.8 : 0.45));
    gradient.addColorStop(0.3, withAlpha(color, dark ? 0.3 : 0.16));
    gradient.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  return sprite;
}

/** The black palette, or the light theme's colours read from the CSS variables of <html>. */
function buildPalette(): void {
  let base: Omit<Palette, 'glows'>;
  if (mode.value.dark) {
    base = { dark: true, ...SCENE };
  } else {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const folders = ['#1f8a7d', '#3f8a56', '#3a6cb0', '#b07612', '#8a52c4', '#c0447a'].map((fallback, i) => v(`--graph-${String(i + 1)}`, fallback));
    const muted = v('--muted', '#687673');
    base = { dark: false, bg: v('--bg', '#f5f4f0'), surface: v('--surface', '#fbfaf7'), ink: v('--ink', '#24302e'), muted, tag: muted, accent: v('--accent', '#23887c'), violet: folders[4] ?? '#8a52c4', folders };
  }
  const glows = new Map<string, HTMLCanvasElement>();
  for (const color of [...base.folders, base.tag, base.accent]) glows.set(color, glowSprite(color, base.dark));
  palette = { ...base, glows };
  requestFrame();
}

function readTheme(): void {
  const systemLight = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
  themeDark.value = themeIsDark(document.documentElement.getAttribute('data-theme'), systemLight);
}

function loadDarkChoice(): boolean {
  try {
    return window.localStorage.getItem(DARK_KEY) === '1';
  } catch {
    return false;
  }
}

function toggleDark(): void {
  darkChoice.value = !darkChoice.value;
  try {
    window.localStorage.setItem(DARK_KEY, darkChoice.value ? '1' : '0');
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
  wake();
}

function loadViewChoice(): boolean {
  try {
    return readViewMode(window.localStorage.getItem(VIEW_KEY)) === '3d';
  } catch {
    return false;
  }
}

function setView3d(on: boolean): void {
  if (view3d.value === on) return;
  view3d.value = on;
  try {
    window.localStorage.setItem(VIEW_KEY, on ? '3d' : '2d');
  } catch {
    // Private window or blocked storage: the choice lasts until the page closes.
  }
  if (on) ensureSim3();
  hovered.value = -1;
  drag = null;
  pointers.clear();
  glide = null;
  flight = null;
  if (canvas.value !== null) canvas.value.style.cursor = 'grab';
  wake();
}

/** The 3D simulation of the loaded graph, made the first time it is needed; positions kept from `previous`. */
function ensureSim3(previous?: ReadonlyMap<string, Point3>): void {
  const data = graph.value;
  if (data === null || sim3 !== null) return;
  sim3 = createSimulation3(data.nodes, data.edges, previous);
  if (previous === undefined || previous.size === 0) {
    // A head start, as in 2D, so the first frame is not a tangle.
    const warm = Math.min(120, Math.floor(60_000 / Math.max(1, data.nodes.length)));
    for (let i = 0; i < warm; i += 1) step3(sim3);
    autoFit3 = true;
    if (width > 0) camera = fitCamera(camera, sim3.nodes, width + panelShift(), height);
  }
}

watch(() => mode.value.dark, () => buildPalette());

function sizeCanvas(element: HTMLCanvasElement | null): void {
  if (element === null) return;
  element.width = Math.max(1, Math.round(width * dpr));
  element.height = Math.max(1, Math.round(height * dpr));
  element.style.width = `${String(width)}px`;
  element.style.height = `${String(height)}px`;
}

function resize(): void {
  const parent = box.value;
  if (parent === null) return;
  const rect = parent.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  const first = width === 0;
  width = rect.width;
  height = rect.height;
  sizeCanvas(canvas.value);
  sizeCanvas(backdrop.value);
  // A few hundred stars, fewer on a small screen; the same ones at every size.
  const count = Math.min(360, Math.round((width * height) / 5200));
  if (count !== stars.length) stars = makeStars(count);
  if (first && sim !== null) view = fitView(turnedNodes(), width, height);
  if (first && sim3 !== null) camera = fitCamera(camera, sim3.nodes, width + panelShift(), height);
  requestFrame();
}

/** The nodes as the orbit shows them, for fitting and centring. */
function turnedNodes(): { x: number; y: number; r: number }[] {
  return (sim?.nodes ?? []).map((node) => ({ ...rotatePoint(node.x, node.y, orbitAngle), r: node.r }));
}

function requestFrame(): void {
  dirty = true;
  schedule();
}

function schedule(): void {
  if (frame !== 0 || typeof document === 'undefined' || document.hidden) return;
  frame = requestAnimationFrame(tick);
}

function tick(now: number): void {
  frame = 0;
  if (sim === null || document.hidden) return;
  if (window.devicePixelRatio !== dpr) resize();
  const three = is3d();
  const settled = three && sim3 !== null ? isSettled3(sim3) : isSettled(sim);
  // The 3D drift runs at full rate while the window has the focus: at 30 fps a slow turn shudders.
  const driftOn = three && drifting.value && !reduced && windowFocused && driftWeight(now - lastInteraction) > 0;
  const interval = frameInterval({
    hidden: document.hidden,
    focused: windowFocused,
    reduced,
    busy: !settled || glide !== null || flight !== null || drag !== null || driftOn || (three && shift3 !== panelShift()),
    interacting: now - lastInteraction < INTERACT_MS,
  });
  // Resting (reduced motion, nothing to do): wait for the next request.
  if (interval === undefined && !dirty) return;
  if (!dirty && interval !== undefined && !frameDue(now, lastDraw, interval)) {
    schedule();
    return;
  }
  dirty = false;
  if (three && sim3 !== null) {
    advance3(sim3, now, settled);
  } else {
    if (!settled) {
      step(sim);
      settledAt = 0;
      if (autoFit && glide === null) view = blendView(view, fitView(turnedNodes(), width, height), 0.08);
    } else if (settledAt === 0) {
      settledAt = now;
    }
    if (glide !== null) {
      const t = (now - glide.start) / 450;
      view = blendView(glide.from, glide.to, t);
      if (t >= 1) glide = null;
    }
    if (orbiting.value && !reduced && drag === null) orbitAngle = advanceOrbit(orbitAngle, now - lastDraw);
  }
  lastDraw = now;
  drawBackdrop(now);
  if (three) draw3d(now);
  else draw(now);
  const still = three && sim3 !== null ? isSettled3(sim3) : isSettled(sim);
  if (interval !== undefined || glide !== null || flight !== null || !still) schedule();
}

/** One frame of the 3D view: the simulation, the camera's flight, the panel's room and the drift. */
function advance3(s: Simulation3, now: number, settled: boolean): void {
  if (!settled) {
    step3(s);
    // Only while the graph settles: the fit allocates a little, the blend writes into the camera.
    if (autoFit3 && flight === null) blendCamera(camera, fitCamera(camera, s.nodes, width + panelShift(), height), 0.08, camera);
  }
  if (flight !== null) {
    const t = (now - flight.start) / FLIGHT_MS;
    blendCamera(flight.from, flight.to, t, camera);
    if (t >= 1) flight = null;
  }
  const goal = panelShift();
  shift3 = reduced || Math.abs(goal - shift3) < 0.5 ? goal : shift3 + (goal - shift3) * 0.16;
  if (drifting.value && !reduced && drag === null && flight === null) {
    camera.yaw = driftYaw(camera.yaw, now - lastDraw, driftWeight(now - lastInteraction));
  }
  projector = projector === null ? makeProjector(camera, width, height, shift3) : updateProjector(projector, camera, width, height, shift3);
}

/** Black, a halo at the centre of the world, a grid of dots and the drifting stars. */
function drawBackdrop(now: number): void {
  const ctx = backdrop.value?.getContext('2d');
  const colors = palette;
  if (ctx === null || ctx === undefined || colors === null) return;
  const dark = colors.dark;
  const time = reduced ? 0 : now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  const three = is3d() && projector !== null;
  let panX = view.x;
  let panY = view.y;
  if (three) {
    // Turning the camera slides the sky: the accumulated yaw, so a full turn has no seam.
    starPanX += wrapAngle(camera.yaw - lastStarYaw) * width * 1.5;
    lastStarYaw = camera.yaw;
    panX = starPanX;
    panY = -camera.pitch * height * 1.5;
  }

  // The halo, as a reactor glow under the graph.
  const centre = three && projector !== null ? { x: projector.cx, y: projector.cy } : toScreen(view, 0, 0);
  const radius = Math.max(width, height) * 0.55;
  const halo = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
  halo.addColorStop(0, withAlpha(colors.accent, dark ? 0.11 : 0.06));
  halo.addColorStop(0.45, withAlpha(colors.violet, dark ? 0.045 : 0.025));
  halo.addColorStop(1, withAlpha(colors.violet, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  // Stars behind everything, deeper ones dimmer and slower; faint specks on the light theme.
  for (const star of stars) {
    const at = starPosition(star, time, panX, panY, width, height);
    const twinkle = reduced ? 0 : 0.22 * Math.sin(time * 1.3 + star.phase);
    ctx.globalAlpha = Math.max(0.08, Math.min(1, 0.25 + 0.5 * star.depth + twinkle)) * (dark ? 1 : 0.3);
    ctx.fillStyle = dark ? (star.depth > 0.9 ? '#e6fbff' : star.phase > 4.5 ? '#c9b8ff' : '#9fdcff') : star.phase > 4.5 ? colors.violet : colors.accent;
    ctx.fillRect(at.x, at.y, star.size, star.size);
  }
  ctx.globalAlpha = 1;

  if (three && projector !== null) {
    drawFloor(ctx, projector, colors.accent, dark);
    return;
  }

  // The grid of dots moves with the world; every fourth one is a little cross.
  let spacing = 40 * view.k;
  while (spacing < 22) spacing *= 2;
  while (spacing > 90) spacing /= 2;
  const ox = ((view.x % spacing) + spacing) % spacing;
  const oy = ((view.y % spacing) + spacing) % spacing;
  const firstColumn = Math.round((ox - view.x) / spacing);
  const firstRow = Math.round((oy - view.y) / spacing);
  ctx.fillStyle = withAlpha(colors.accent, dark ? 0.13 : 0.16);
  const crosses: [number, number][] = [];
  let column = firstColumn;
  for (let x = ox; x < width; x += spacing, column += 1) {
    let row = firstRow;
    for (let y = oy; y < height; y += spacing, row += 1) {
      if (column % 4 === 0 && row % 4 === 0) crosses.push([x, y]);
      else ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }
  ctx.strokeStyle = withAlpha(colors.accent, dark ? 0.22 : 0.2);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, y] of crosses) {
    const cx = Math.round(x) + 0.5;
    const cy = Math.round(y) + 0.5;
    ctx.moveTo(cx - 3, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 3);
    ctx.lineTo(cx, cy + 4);
  }
  ctx.stroke();
}

/** The floor's rings: share of the graph's radius and opacity. */
const FLOOR_RINGS: readonly (readonly [number, number])[] = [
  [0.35, 0.1],
  [0.7, 0.12],
  [1.05, 0.16],
];
const FLOOR_SEGMENTS = 72;
const FLOOR_SPOKES = 12;
/** The floor's colours, made once per palette (rings, then the spokes). */
let floorStyles: string[] = [];
let floorStylesKey = '';
/** Scratch of the 3D drawing, reused every frame. */
const segment: Segment = { x0: 0, y0: 0, x1: 0, y1: 0 };
const scratchPoint: Projected = { x: 0, y: 0, scale: 0, depth: 0 };

/**
 * The 3D view's "holotable": rings and spokes on a plane under the graph,
 * turning with the camera, so the eye reads the space. A few strokes, each
 * piece cut at the camera's near plane; nothing allocated per frame.
 */
function drawFloor(ctx: CanvasRenderingContext2D, p: Projector, accent: string, dark: boolean): void {
  if (sim3 === null || sim3.nodes.length === 0) return;
  const key = `${accent}|${String(dark)}`;
  if (key !== floorStylesKey) {
    floorStylesKey = key;
    floorStyles = [...FLOOR_RINGS.map(([, alpha]) => withAlpha(accent, alpha * (dark ? 1 : 0.8))), withAlpha(accent, 0.06 * (dark ? 1 : 0.8))];
  }
  let cx = 0;
  let cz = 0;
  let low = -Infinity;
  for (const node of sim3.nodes) {
    cx += node.x;
    cz += node.z;
    low = Math.max(low, node.y);
  }
  cx /= sim3.nodes.length;
  cz /= sim3.nodes.length;
  let radius = 60;
  for (const node of sim3.nodes) radius = Math.max(radius, Math.hypot(node.x - cx, node.z - cz));
  const y = low + 40;
  ctx.lineWidth = 1;
  FLOOR_RINGS.forEach(([share], ring) => {
    const r = radius * share;
    ctx.beginPath();
    for (let k = 0; k < FLOOR_SEGMENTS; k += 1) {
      const a0 = (k / FLOOR_SEGMENTS) * Math.PI * 2;
      const a1 = ((k + 1) / FLOOR_SEGMENTS) * Math.PI * 2;
      if (!projectSegment(p, cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r, segment)) continue;
      ctx.moveTo(segment.x0, segment.y0);
      ctx.lineTo(segment.x1, segment.y1);
    }
    ctx.strokeStyle = floorStyles[ring] ?? accent;
    ctx.stroke();
  });
  ctx.beginPath();
  for (let spoke = 0; spoke < FLOOR_SPOKES; spoke += 1) {
    const angle = (spoke / FLOOR_SPOKES) * Math.PI * 2;
    const c = Math.cos(angle) * radius;
    const s = Math.sin(angle) * radius;
    if (!projectSegment(p, cx + c * 0.1, y, cz + s * 0.1, cx + c * 1.05, y, cz + s * 1.05, segment)) continue;
    ctx.moveTo(segment.x0, segment.y0);
    ctx.lineTo(segment.x1, segment.y1);
  }
  ctx.strokeStyle = floorStyles[FLOOR_RINGS.length] ?? accent;
  ctx.stroke();
}

/** A point at share `t` of the way from node a to node b, on the screen, into scratchPoint; false when it is not in front of the camera. */
function alongLink(s: Simulation3, p: Projector, a: number, b: number, t: number): boolean {
  const na = s.nodes[a];
  const nb = s.nodes[b];
  if (na === undefined || nb === undefined) return false;
  projectInto(scratchPoint, p, na.x + (nb.x - na.x) * t, na.y + (nb.y - na.y) * t, na.z + (nb.z - na.z) * t);
  return scratchPoint.depth >= NEAR_FADE;
}

/** Where every node is drawn this frame: the orbit, then the breath once the graph has settled. */
function placeNodes(now: number): void {
  if (sim === null) return;
  const count = sim.nodes.length;
  if (px.length !== count) {
    px = new Float64Array(count);
    py = new Float64Array(count);
  }
  const weight = reduced || settledAt === 0 ? 0 : Math.min(1, (now - settledAt) / 1500);
  const amplitude = (BREATH_PX / view.k) * weight;
  const time = now / 1000;
  sim.nodes.forEach((node, i) => {
    const turned = rotatePoint(node.x, node.y, orbitAngle);
    const breath = amplitude > 0 && !node.fixed ? breathOffset(i, time, amplitude) : { dx: 0, dy: 0 };
    px[i] = turned.x + breath.dx;
    py[i] = turned.y + breath.dy;
  });
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
  placeNodes(now);

  const focus = hovered.value >= 0 ? hovered.value : selected.value;
  const lit = focus >= 0 ? new Set([focus, ...(adjacency[focus] ?? [])]) : null;
  const showFilter = filtering.value;
  const visible = (i: number): boolean => (lit === null || lit.has(i)) && (!showFilter || matches.value[i] === true);
  const simNodes = sim.nodes;
  const X = (i: number): number => px[i] ?? 0;
  const Y = (i: number): number => py[i] ?? 0;

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  const pixel = 1 / view.k;

  // Edges, grouped by phase so the shimmer costs a few strokes, not one per edge.
  const PHASES = 6;
  for (const type of ['link', 'tag'] as const) {
    ctx.setLineDash(type === 'tag' ? [3 * pixel, 4 * pixel] : []);
    for (let phase = 0; phase < PHASES; phase += 1) {
      const shimmer = reduced ? 1 : 0.75 + 0.25 * Math.sin(time * 1.6 + phase * 1.05);
      for (const bright of [false, true]) {
        ctx.beginPath();
        let any = false;
        sim.links.forEach((link, index) => {
          if (index % PHASES !== phase || data.edges[link.edge]?.type !== type) return;
          const on = lit !== null && (link.source === focus || link.target === focus);
          if (on !== bright) return;
          if (!bright && (lit !== null || showFilter) && !(visible(link.source) && visible(link.target))) return;
          ctx.moveTo(X(link.source), Y(link.source));
          ctx.lineTo(X(link.target), Y(link.target));
          any = true;
        });
        if (!any) continue;
        const base = bright ? 0.9 : type === 'link' ? 0.3 : 0.2;
        ctx.strokeStyle = withAlpha(bright || type === 'link' ? colors.accent : colors.tag, base * shimmer);
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
      ctx.moveTo(X(link.source), Y(link.source));
      ctx.lineTo(X(link.target), Y(link.target));
    });
    ctx.strokeStyle = withAlpha(colors.muted, 0.08);
    ctx.lineWidth = pixel;
    ctx.stroke();
  }

  ctx.globalCompositeOperation = colors.dark ? 'lighter' : 'source-over';
  if (!reduced) {
    // Lights travelling at random along the edges, a few at a time, with a short tail.
    pulses = updatePulses(pulses, now, pulseRandom, sim.links.length);
    for (const pulse of pulses) {
      const t = pulseProgress(pulse, now);
      const link = sim.links[pulse.link];
      if (t === undefined || link === undefined) continue;
      const dim = (lit !== null || showFilter) && !(visible(link.source) && visible(link.target));
      const from = pulse.reverse ? link.target : link.source;
      ctx.fillStyle = colorOf(from);
      const fade = Math.sin(Math.min(1, Math.max(0, pulse.reverse ? 1 - t : t)) * Math.PI);
      for (let j = 0; j < 5; j += 1) {
        const at = t + (pulse.reverse ? j : -j) * 0.025;
        if (at < 0 || at > 1) continue;
        const x = X(link.source) + (X(link.target) - X(link.source)) * at;
        const y = Y(link.source) + (Y(link.target) - Y(link.source)) * at;
        ctx.globalAlpha = (dim ? 0.15 : 0.9) * fade * (1 - j / 5);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, 2 * pixel) * (1 - j * 0.15), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Particles flowing out of the selected node along its edges.
  if (!reduced && selected.value >= 0) {
    const from = selected.value;
    ctx.fillStyle = colors.accent;
    sim.links.forEach((link, index) => {
      if (link.source !== from && link.target !== from) return;
      const to = link.source === from ? link.target : link.source;
      for (let j = 0; j < 3; j += 1) {
        const t = (time * 0.45 + j / 3 + index * 0.137) % 1;
        const x = X(from) + (X(to) - X(from)) * t;
        const y = Y(from) + (Y(to) - Y(from)) * t;
        const size = Math.max(1.2, 2.2 * pixel) * (1 - Math.abs(t - 0.5));
        ctx.globalAlpha = 0.35 + 0.65 * Math.sin(t * Math.PI);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }

  // Glows: additive light; the most connected nodes pulse.
  const many = simNodes.length > 1200;
  simNodes.forEach((node, i) => {
    const on = visible(i);
    if (many && !(lit?.has(i) ?? false)) return;
    const sprite = colors.glows.get(colorOf(i));
    if (sprite === undefined) return;
    const pulse = reduced ? 1 : hubGlow(data.nodes[i]?.degree ?? 0, maxDegree, time, i);
    const radius = node.r * (i === focus ? 4.4 : 3.2) * pulse;
    ctx.globalAlpha = on ? 1 : 0.12;
    ctx.drawImage(sprite, X(i) - radius, Y(i) - radius, radius * 2, radius * 2);
  });
  ctx.globalCompositeOperation = 'source-over';

  // Cores.
  simNodes.forEach((node, i) => {
    const color = colorOf(i);
    const x = X(i);
    const y = Y(i);
    ctx.globalAlpha = visible(i) ? 1 : 0.18;
    ctx.beginPath();
    if (nodes.value[i]?.kind === 'tag') {
      // A hexagon for the tag nodes.
      for (let side = 0; side < 6; side += 1) {
        const angle = (Math.PI / 3) * side + Math.PI / 6;
        const hx = x + Math.cos(angle) * node.r;
        const hy = y + Math.sin(angle) * node.r;
        if (side === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4 * pixel;
      ctx.stroke();
    } else {
      ctx.arc(x, y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, node.r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(colors.dark ? '#ffffff' : colors.bg, colors.dark ? 0.6 : 0.7);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;

  // The reticle of the selected node and the ring of the hovered one.
  const ring = (i: number, spin: boolean) => {
    const node = simNodes[i];
    if (node === undefined) return;
    const x = X(i);
    const y = Y(i);
    const radius = node.r + 5 * pixel + 3;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.3 * pixel;
    if (spin) {
      const turn = reduced ? 0 : time * 0.8;
      for (let q = 0; q < 4; q += 1) {
        ctx.beginPath();
        ctx.arc(x, y, radius, turn + (q * Math.PI) / 2, turn + (q * Math.PI) / 2 + Math.PI / 3.2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, radius + 6 * pixel, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(colors.accent, 0.25);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
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
    const at = toScreen(view, X(i), Y(i) + node.r);
    if (at.x < -100 || at.x > width + 100 || at.y < -20 || at.y > height + 20) return;
    const title = nodes.value[i]?.title ?? '';
    const text = title.length > 32 ? `${title.slice(0, 31)}…` : title;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = special ? 1 : 0.85;
    ctx.fillStyle = withAlpha(colors.surface, 0.8);
    ctx.fillRect(at.x - w / 2 - 4, at.y + 4, w + 8, 16);
    ctx.fillStyle = special ? colors.accent : colors.ink;
    ctx.fillText(text, at.x, at.y + 6.5);
    shown += 1;
  });
  ctx.globalAlpha = 1;
}

/** Depth bands of the 3D edges: one stroke per band, type and brightness instead of one per edge. */
const FOG_BANDS = 4;

/**
 * The 3D view (D-104): nodes projected with perspective, edges and glows
 * fading with depth, cores painted from the farthest so the near ones cover
 * the far ones; additive glows need no order.
 */
function draw3d(now: number): void {
  const element = canvas.value;
  const data = graph.value;
  const colors = palette;
  const s = sim3;
  const p = projector;
  if (element === null || s === null || p === null || data === null || colors === null) return;
  const ctx = element.getContext('2d');
  if (ctx === null) return;
  const time = now / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const count = s.nodes.length;
  if (proj3.x.length !== count) {
    proj3 = emptyProjection(count);
    fog3 = new Float64Array(count);
  }
  projectNodes(p, s.nodes, proj3);
  order3 = depthOrder(proj3.depth, count, order3);
  let front = Infinity;
  let back = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const depth = proj3.depth[i] ?? 0;
    if (depth < NEAR) continue;
    front = Math.min(front, depth);
    back = Math.max(back, depth);
  }
  // Fog with the distance, and a fade to nothing for a node grazing the camera.
  for (let i = 0; i < count; i += 1) {
    const depth = proj3.depth[i] ?? 0;
    fog3[i] = fogAlpha(depth, front, back) * nearFade(depth);
  }
  const X = (i: number): number => proj3.x[i] ?? 0;
  const Y = (i: number): number => proj3.y[i] ?? 0;
  const R = (i: number): number => proj3.r[i] ?? 0;
  const F = (i: number): number => fog3[i] ?? 1;

  const focus = hovered.value >= 0 ? hovered.value : selected.value;
  const lit = focus >= 0 ? new Set([focus, ...(adjacency[focus] ?? [])]) : null;
  const showFilter = filtering.value;
  const visible = (i: number): boolean => (lit === null || lit.has(i)) && (!showFilter || matches.value[i] === true);

  // Edges by depth band: the far ones dim, the near ones bright.
  ctx.lineCap = 'round';
  for (const type of ['link', 'tag'] as const) {
    ctx.setLineDash(type === 'tag' ? [3, 4] : []);
    for (const bright of [false, true]) {
      for (let band = 0; band < FOG_BANDS; band += 1) {
        ctx.beginPath();
        let any = false;
        for (const link of s.links) {
          if (data.edges[link.edge]?.type !== type) continue;
          if (R(link.source) <= 0 || R(link.target) <= 0) continue;
          const on = lit !== null && (link.source === focus || link.target === focus);
          if (on !== bright) continue;
          if (!bright && (lit !== null || showFilter) && !(visible(link.source) && visible(link.target))) continue;
          const fog = (F(link.source) + F(link.target)) / 2;
          if (Math.min(FOG_BANDS - 1, Math.floor((1 - fog) * FOG_BANDS)) !== band) continue;
          ctx.moveTo(X(link.source), Y(link.source));
          ctx.lineTo(X(link.target), Y(link.target));
          any = true;
        }
        if (!any) continue;
        const shimmer = reduced ? 1 : 0.8 + 0.2 * Math.sin(time * 1.6 + band * 1.3);
        const depthAlpha = 1 - (band + 0.5) / FOG_BANDS * 0.8;
        const base = bright ? 0.9 : type === 'link' ? 0.42 : 0.26;
        ctx.strokeStyle = withAlpha(bright || type === 'link' ? colors.accent : colors.tag, base * depthAlpha * shimmer);
        ctx.lineWidth = bright ? 1.6 : band === 0 ? 1.2 : 1;
        ctx.stroke();
      }
    }
  }
  ctx.setLineDash([]);
  if (lit !== null || showFilter) {
    ctx.beginPath();
    for (const link of s.links) {
      if (R(link.source) <= 0 || R(link.target) <= 0) continue;
      if (visible(link.source) && visible(link.target)) continue;
      if (lit !== null && (link.source === focus || link.target === focus)) continue;
      ctx.moveTo(X(link.source), Y(link.source));
      ctx.lineTo(X(link.target), Y(link.target));
    }
    ctx.strokeStyle = withAlpha(colors.muted, 0.07);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.globalCompositeOperation = colors.dark ? 'lighter' : 'source-over';
  if (!reduced) {
    pulses = updatePulses(pulses, now, pulseRandom, s.links.length);
    for (const pulse of pulses) {
      const t = pulseProgress(pulse, now);
      const link = s.links[pulse.link];
      if (t === undefined || link === undefined) continue;
      const dim = (lit !== null || showFilter) && !(visible(link.source) && visible(link.target));
      ctx.fillStyle = colorOf(pulse.reverse ? link.target : link.source);
      const fade = Math.sin(Math.min(1, Math.max(0, pulse.reverse ? 1 - t : t)) * Math.PI);
      const fog = (F(link.source) + F(link.target)) / 2;
      for (let j = 0; j < 5; j += 1) {
        const share = t + (pulse.reverse ? j : -j) * 0.025;
        if (share < 0 || share > 1) continue;
        if (!alongLink(s, p, link.source, link.target, share)) continue;
        const at = scratchPoint;
        ctx.globalAlpha = (dim ? 0.15 : 0.9) * fade * fog * (1 - j / 5);
        ctx.beginPath();
        ctx.arc(at.x, at.y, Math.min(8, Math.max(1, 2.2 * at.scale)) * (1 - j * 0.15), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  if (!reduced && selected.value >= 0) {
    const from = selected.value;
    ctx.fillStyle = colors.accent;
    for (let index = 0; index < s.links.length; index += 1) {
      const link = s.links[index];
      if (link === undefined || (link.source !== from && link.target !== from)) continue;
      const to = link.source === from ? link.target : link.source;
      for (let j = 0; j < 3; j += 1) {
        const t = (time * 0.45 + j / 3 + index * 0.137) % 1;
        if (!alongLink(s, p, from, to, t)) continue;
        const at = scratchPoint;
        ctx.globalAlpha = 0.35 + 0.65 * Math.sin(t * Math.PI);
        ctx.beginPath();
        ctx.arc(at.x, at.y, Math.min(9, Math.max(1.2, 2.4 * at.scale)) * (1 - Math.abs(t - 0.5)), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Glows: additive light, so the order does not matter; far ones are fainter.
  const many = count > 1200;
  for (let i = 0; i < count; i += 1) {
    const r = R(i);
    if (r <= 0 || F(i) < 0.01 || (many && !(lit?.has(i) ?? false))) continue;
    const sprite = colors.glows.get(colorOf(i));
    if (sprite === undefined) continue;
    const pulse = reduced ? 1 : hubGlow(data.nodes[i]?.degree ?? 0, maxDegree, time, i);
    const radius = Math.max(3, r * (i === focus ? 4.6 : 3.4) * pulse);
    ctx.globalAlpha = F(i) * (visible(i) ? 1 : 0.12);
    ctx.drawImage(sprite, X(i) - radius, Y(i) - radius, radius * 2, radius * 2);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Cores from the farthest to the nearest.
  for (let k = 0; k < count; k += 1) {
    const i = order3[k] ?? 0;
    const r = R(i);
    if (r <= 0) continue;
    const x = X(i);
    const y = Y(i);
    const color = colorOf(i);
    ctx.globalAlpha = F(i) * (visible(i) ? 1 : 0.18);
    ctx.beginPath();
    if (nodes.value[i]?.kind === 'tag') {
      for (let side = 0; side < 6; side += 1) {
        const angle = (Math.PI / 3) * side + Math.PI / 6;
        if (side === 0) ctx.moveTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
        else ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
      }
      ctx.closePath();
      ctx.fillStyle = colors.bg;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    } else {
      ctx.arc(x, y, Math.max(0.9, r), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (r > 2.2) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(colors.dark ? '#ffffff' : colors.bg, colors.dark ? 0.6 : 0.7);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  const ring = (i: number, spin: boolean) => {
    const r = R(i);
    if (r <= 0) return;
    const x = X(i);
    const y = Y(i);
    const radius = r + 8;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.3;
    if (spin) {
      const turn = reduced ? 0 : time * 0.8;
      for (let q = 0; q < 4; q += 1) {
        ctx.beginPath();
        ctx.arc(x, y, radius, turn + (q * Math.PI) / 2, turn + (q * Math.PI) / 2 + Math.PI / 3.2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(colors.accent, 0.25);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  if (selected.value >= 0) ring(selected.value, true);
  if (hovered.value >= 0 && hovered.value !== selected.value) ring(hovered.value, false);

  // Titles: chosen from the nearest (the focus and its neighbours always, up
  // to 40 matches or nodes big enough on the screen), drawn from the farthest
  // so the near ones stay on top.
  ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (labelPick.length < count) labelPick = new Uint32Array(count);
  let picked = 0;
  let extra = 0;
  for (let k = count - 1; k >= 0; k -= 1) {
    const i = order3[k] ?? 0;
    const r = R(i);
    if (r <= 0) continue;
    const special = i === focus || i === selected.value;
    const near = (lit?.has(i) ?? false) && F(i) > 0.05;
    const matched = showFilter && matches.value[i] === true && F(i) > 0.05;
    const big = r >= 7 && F(i) > 0.55 && visible(i);
    if (!(special || near || ((matched || big) && extra < 40))) continue;
    const x = X(i);
    const y = Y(i) + r;
    if (x < -100 || x > width + 100 || y < -20 || y > height + 20) continue;
    if (!(special || near)) extra += 1;
    labelPick[picked] = i;
    picked += 1;
  }
  const plate = withAlpha(colors.surface, 0.8);
  for (let k = picked - 1; k >= 0; k -= 1) {
    const i = labelPick[k] ?? 0;
    const special = i === focus || i === selected.value;
    const x = X(i);
    const y = Y(i) + R(i);
    const title = nodes.value[i]?.title ?? '';
    const text = title.length > 32 ? `${title.slice(0, 31)}…` : title;
    const w = ctx.measureText(text).width;
    ctx.globalAlpha = special ? 1 : 0.85 * Math.max(0.4, F(i));
    ctx.fillStyle = plate;
    ctx.fillRect(x - w / 2 - 4, y + 4, w + 8, 16);
    ctx.fillStyle = special ? colors.accent : colors.ink;
    ctx.fillText(text, x, y + 6.5);
  }
  ctx.globalAlpha = 1;
}

// Pointer: drag a node, pan the background, pinch with two fingers, click to select.
// In 3D: drag to turn the camera, pinch to zoom, click a node to fly there.
const pointers = new Map<number, { x: number; y: number }>();
type Drag =
  | { kind: 'node'; index: number; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'pinch'; distance: number; mid: { x: number; y: number }; view: View }
  | { kind: 'turn'; index: number; startX: number; startY: number; camera: Camera; moved: boolean }
  | { kind: 'pinch3'; distance: number; camera: Camera };
let drag: Drag | null = null;

function local(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

/** The world point under a screen point, before the orbit turned it. */
function worldAt(x: number, y: number): { x: number; y: number } {
  const world = toWorld(view, x, y);
  return rotatePoint(world.x, world.y, -orbitAngle);
}

function hit(x: number, y: number, touch: boolean): number {
  if (is3d() && sim3 !== null) return hitTest3(proj3, Math.min(proj3.x.length, sim3.nodes.length), x, y, touch ? 14 : 4);
  if (sim === null) return -1;
  const world = worldAt(x, y);
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
  if (is3d()) {
    autoFit3 = false;
    flight = null;
    if (pointers.size === 2) {
      const pinch = pinchOf();
      if (pinch !== undefined) drag = { kind: 'pinch3', distance: pinch.distance, camera: copyCamera(camera) };
    } else if (pointers.size === 1) {
      drag = { kind: 'turn', index: hit(at.x, at.y, event.pointerType === 'touch'), startX: at.x, startY: at.y, camera: copyCamera(camera), moved: false };
    }
    requestFrame();
    return;
  }
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
  if (drag.kind === 'turn') {
    if (Math.hypot(at.x - drag.startX, at.y - drag.startY) > 3) drag.moved = true;
    if (drag.moved) {
      camera = orbitBy(drag.camera, at.x - drag.startX, at.y - drag.startY);
      if (canvas.value !== null) canvas.value.style.cursor = 'grabbing';
    }
  } else if (drag.kind === 'pinch3') {
    const pinch = pinchOf();
    if (pinch !== undefined) camera = zoomCamera(drag.camera, pinch.distance / drag.distance);
  } else if (drag.kind === 'pinch') {
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
      const world = worldAt(at.x, at.y);
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
  if (done?.kind === 'pinch3') {
    // One finger left: it turns from here.
    const rest = [...pointers.values()][0];
    drag = rest === undefined ? null : { kind: 'turn', index: -1, startX: rest.x, startY: rest.y, camera: copyCamera(camera), moved: true };
    return;
  }
  if (done?.kind === 'turn') {
    drag = null;
    if (canvas.value !== null) canvas.value.style.cursor = hovered.value >= 0 ? 'pointer' : 'grab';
    if (!done.moved && event.type === 'pointerup') {
      if (done.index >= 0) focusOn(done.index);
      else void select(-1);
    }
    requestFrame();
    return;
  }
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
  if (is3d()) {
    autoFit3 = false;
    flight = null;
    camera = zoomCamera(camera, wheelFactor(event.deltaY, event.deltaMode));
  } else {
    view = zoomAt(view, at.x, at.y, wheelFactor(event.deltaY, event.deltaMode));
  }
  requestFrame();
}

function onDoubleClick(event: MouseEvent): void {
  const at = local(event);
  const index = hit(at.x, at.y, false);
  if (index < 0) fit();
  else if (is3d()) focusOn(index);
}

/** The 3D camera flies to `to`; with reduced motion it jumps. */
function flyTo(to: Camera): void {
  autoFit3 = false;
  if (reduced) {
    camera = to;
    flight = null;
  } else {
    // A copy: the flight writes into `camera` every frame.
    flight = { from: copyCamera(camera), to, start: performance.now() };
  }
  requestFrame();
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
  if (is3d() && sim3 !== null) {
    flyTo(fitCamera(camera, sim3.nodes, width + panelShift(), height));
    return;
  }
  if (sim !== null) glideTo(fitView(turnedNodes(), width - (selected.value >= 0 && width > 900 ? 400 : 0), height));
}

function focusOn(index: number): void {
  const node3 = is3d() ? sim3?.nodes[index] : undefined;
  if (node3 !== undefined) {
    void select(index);
    flyTo(flyTarget(camera, node3));
    return;
  }
  const node = sim?.nodes[index];
  if (node === undefined) return;
  void select(index);
  // Leave room for the panel on wide screens.
  const panel = width > 900 ? 400 : 0;
  const at = rotatePoint(node.x, node.y, orbitAngle);
  glideTo(centerOn(width - panel, height, at.x, at.y, Math.max(view.k, 1.4)));
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
    const previous3 = new Map(sim3?.nodes.map((node, i) => [previousIds[i] ?? '', { x: node.x, y: node.y, z: node.z }]) ?? []);
    const selectedId = selectedNode.value?.id;
    graph.value = data;
    sim = createSimulation(data.nodes, data.edges, previous);
    sim3 = null;
    if (view3d.value || previous3.size > 0) ensureSim3(previous3);
    adjacency = neighbours(data.nodes.length, sim.links);
    maxDegree = data.nodes.reduce((most, node) => Math.max(most, node.degree), 0);
    pulses = [];
    settledAt = 0;
    // A head start, so the first frame is not a tangle.
    if (previous.size === 0) {
      const warm = Math.min(120, Math.floor(60_000 / Math.max(1, data.nodes.length)));
      for (let i = 0; i < warm; i += 1) step(sim);
      autoFit = true;
      if (width > 0) view = fitView(turnedNodes(), width, height);
    }
    selected.value = selectedId === undefined ? -1 : data.nodes.findIndex((node) => node.id === selectedId);
    hovered.value = -1;
    if (selected.value < 0) page.value = null;
    applyFocus();
    requestFrame();
  } catch (failure) {
    error.value = failure instanceof ApiError ? `Non riesco a caricare il grafo (${failure.message}).` : 'Non riesco a caricare il grafo.';
  } finally {
    loading.value = false;
  }
}

/** Selects the node the address asks for (a thought opened "in the graph"), once. */
function applyFocus(): void {
  const id = pendingFocus;
  if (id === undefined) return;
  pendingFocus = undefined;
  const index = nodes.value.findIndex((node) => node.id === id);
  if (index < 0) {
    focusNotice.value = 'Questa nota non è ancora nel grafo: aggiornalo fra qualche secondo.';
    return;
  }
  focusNotice.value = null;
  focusOn(index);
}

watch(
  () => props.focus,
  (id) => {
    if (id === undefined) return;
    pendingFocus = id;
    if (graph.value !== null) applyFocus();
  },
);

watch([filter, selected], () => wake());

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

function onKey(event: KeyboardEvent): void {
  if (typing(event.target)) return;
  if (event.key === 'Escape') {
    if (selected.value >= 0) void select(-1);
    else if (document.fullscreenElement !== null && document.fullscreenElement === root.value) void document.exitFullscreen().catch(() => undefined);
    return;
  }
  if ((event.key === 'f' || event.key === 'F') && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && canFullscreen.value) {
    event.preventDefault();
    void toggleFullscreen();
  }
}

async function toggleFullscreen(): Promise<void> {
  const element = root.value;
  if (element === null || !canFullscreen.value) return;
  try {
    if (document.fullscreenElement === element) await document.exitFullscreen();
    else await element.requestFullscreen();
  } catch {
    // Refused (no user gesture, a policy): the page stays as it is.
  }
}

function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement !== null && document.fullscreenElement === root.value;
  resize();
  wake();
}

function toggleOrbit(): void {
  // In 3D the button drives the slow drift of the camera, in 2D the orbit of the view.
  if (view3d.value) drifting.value = !drifting.value;
  else orbiting.value = !orbiting.value;
  wake();
}

/**
 * Arrows turn the 3D camera, + and - zoom it: only while the canvas has the
 * focus (it is focusable), so the keys keep their meaning everywhere else.
 */
function onCanvasKey(event: KeyboardEvent): void {
  if (!is3d() || event.metaKey || event.ctrlKey || event.altKey) return;
  const turns: Record<string, [number, number]> = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] };
  const turn = turns[event.key];
  if (turn !== undefined) camera = orbitBy(camera, turn[0], turn[1]);
  else if (event.key === '+' || event.key === '=') camera = zoomCamera(camera, 1.2);
  else if (event.key === '-') camera = zoomCamera(camera, 1 / 1.2);
  else return;
  event.preventDefault();
  autoFit3 = false;
  flight = null;
  wake();
}

function onVisibility(): void {
  if (!document.hidden) wake();
}

/** Any interaction: full frame rate for INTERACT_MS, then 30 fps (10 without focus); with reduced motion, one drawing. */
function wake(): void {
  if (!reduced) lastInteraction = performance.now();
  windowFocused = document.hasFocus();
  requestFrame();
}

function onBlur(): void {
  windowFocused = false;
  requestFrame();
}

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focus'] as const;
let observer: ResizeObserver | undefined;
const motion = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
const scheme = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: light)');
let themeObserver: MutationObserver | undefined;
const onTheme = () => {
  readTheme();
  // The light palette is read from the CSS: read it again even if the mode stays.
  buildPalette();
};
const onMotion = () => {
  reduced = motion?.matches ?? false;
  reducedMotion.value = reduced;
  if (reduced) {
    orbiting.value = false;
    pulses = [];
  }
  requestFrame();
};

onMounted(() => {
  onMotion();
  motion?.addEventListener('change', onMotion);
  canFullscreen.value = document.fullscreenEnabled && typeof root.value?.requestFullscreen === 'function';
  darkChoice.value = loadDarkChoice();
  view3d.value = loadViewChoice();
  readTheme();
  buildPalette();
  scheme?.addEventListener('change', onTheme);
  themeObserver = new MutationObserver(onTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  observer = new ResizeObserver(resize);
  if (box.value !== null) observer.observe(box.value);
  resize();
  canvas.value?.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  for (const name of WAKE_EVENTS) window.addEventListener(name, wake, { passive: true });
  wake();
  void load();
});

onBeforeUnmount(() => {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  if (fullscreen.value && document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
  observer?.disconnect();
  themeObserver?.disconnect();
  scheme?.removeEventListener('change', onTheme);
  motion?.removeEventListener('change', onMotion);
  canvas.value?.removeEventListener('wheel', onWheel);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('blur', onBlur);
  for (const name of WAKE_EVENTS) window.removeEventListener(name, wake);
  sim = null;
  sim3 = null;
});
</script>

<template>
  <div ref="root" class="relative flex min-h-0 flex-1 overflow-hidden" :class="{ 'kp-dark': mode.dark }">
    <div ref="box" class="absolute inset-0">
      <canvas ref="backdrop" class="pointer-events-none absolute inset-0 block" aria-hidden="true" />
      <canvas
        ref="canvas"
        class="relative block touch-none outline-none select-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
        style="cursor: grab"
        role="img"
        tabindex="0"
        :aria-label="
          view3d
            ? `Grafo della conoscenza in 3D: ${counts.notes} note e ${counts.links} collegamenti. Frecce per ruotare, + e − per lo zoom. Usa il filtro per cercare una nota.`
            : `Grafo della conoscenza: ${counts.notes} note e ${counts.links} collegamenti. Usa il filtro per cercare una nota.`
        "
        @keydown="onCanvasKey"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @dblclick="onDoubleClick"
      />
      <div class="kp-vignette pointer-events-none absolute inset-0" :class="{ light: !mode.dark }" aria-hidden="true" />
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
        <p v-if="view3d" class="mt-1 font-mono text-[10.5px] text-muted">Trascina per ruotare · rotella o pizzico per lo zoom · clic su un nodo per volarci · frecce e +/− dopo un clic sul grafo</p>
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
      <p v-if="focusNotice !== null" role="status" class="pointer-events-auto rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-sm">{{ focusNotice }}</p>
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
      class="hud-card absolute top-14 right-3 bottom-3 flex w-[min(400px,calc(100%-24px))] flex-col bg-surface/95 backdrop-blur-sm"
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

    <!-- Orbit and full screen -->
    <div class="absolute top-3 right-3 flex items-center gap-1.5">
      <div class="kp-seg" role="group" aria-label="Vista del grafo">
        <button type="button" :class="{ on: !view3d }" :aria-pressed="!view3d" title="Grafo piatto (2D)" @click="setView3d(false)">2D</button>
        <button
          type="button"
          :class="{ on: view3d }"
          :aria-pressed="view3d"
          title="Grafo nello spazio (3D): trascina per ruotare, rotella per lo zoom, clic su un nodo per volarci"
          @click="setView3d(true)"
        >
          3D
        </button>
      </div>
      <button
        v-if="mode.toggle"
        type="button"
        class="kp-tool"
        :class="{ on: darkChoice }"
        :aria-pressed="darkChoice"
        title="Sfondo scuro: la sala di controllo nera anche col tema chiaro"
        @click="toggleDark"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M8 9.5l.01 0M15.5 8l.01 0M12 14l.01 0M17 15.5l.01 0" />
        </svg>
        <span>Sfondo scuro</span>
      </button>
      <button
        v-if="!reducedMotion"
        type="button"
        class="kp-tool"
        :class="{ on: view3d ? drifting : orbiting }"
        :aria-pressed="view3d ? drifting : orbiting"
        :title="view3d ? 'Orbita: la camera gira piano quando non tocchi il grafo' : 'Orbita: rotazione lentissima della vista'"
        @click="toggleOrbit"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="2.6" />
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)" />
          <circle cx="20.2" cy="8.4" r="1.1" fill="currentColor" stroke="none" />
        </svg>
        <span>Orbita</span>
      </button>
      <button
        v-if="canFullscreen"
        type="button"
        class="kp-tool"
        :class="{ on: fullscreen }"
        :title="fullscreen ? 'Esci dallo schermo intero (F o Esc)' : 'Schermo intero (F)'"
        :aria-label="fullscreen ? 'Esci dallo schermo intero' : 'Schermo intero'"
        @click="toggleFullscreen"
      >
        <svg v-if="!fullscreen" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * D-087b: in the dark mode the page is a black control room. The theme
 * variables are redefined here, so the cards, the panel and the legend
 * (Tailwind colours read them) turn dark with luminous accents. Without
 * .kp-dark the page keeps the platform's colours.
 */
.kp-dark {
  --bg: #02050a;
  --surface: #07111a;
  --surface-2: #0c1a26;
  --line: #12283a;
  --line-strong: #1f4058;
  --ink: #d6f4ff;
  --muted: #7690a8;
  --accent: #3ee8ff;
  --accent-ink: #00222a;
  --glow: #3ee8ff33;
  --warn: #ffb547;
  --danger: #ff6b5b;
  --ok: #5cffb1;
  --info: #5b9dff;
  --l0: #5cffb1;
  --l1: #3ee8ff;
  --l2: #ffb547;
  --l3: #ff6b5b;
  --graph-1: #3ee8ff;
  --graph-2: #5cffb1;
  --graph-3: #a879ff;
  --graph-4: #ffb547;
  --graph-5: #5b9dff;
  --graph-6: #ff6bcb;
  color-scheme: dark;
  background: var(--bg);
  color: var(--ink);
}

.kp-vignette {
  background:
    radial-gradient(ellipse at center, transparent 52%, rgb(0 0 0 / 0.55) 88%, rgb(0 0 0 / 0.8) 100%),
    linear-gradient(to bottom, rgb(62 232 255 / 0.04), transparent 18%, transparent 82%, rgb(168 121 255 / 0.04));
}

.kp-vignette.light {
  background: radial-gradient(ellipse at center, transparent 60%, rgb(36 48 46 / 0.06) 100%);
}

.kp-tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  color: var(--muted);
  font: 600 10.5px/1 var(--font-hud);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  backdrop-filter: blur(4px);
  transition:
    color 0.15s,
    border-color 0.15s,
    box-shadow 0.15s;
}

.kp-tool:hover,
.kp-tool:focus-visible {
  color: var(--ink);
  border-color: var(--accent);
}

.kp-seg {
  display: inline-flex;
  height: 32px;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  backdrop-filter: blur(4px);
}

.kp-seg button {
  min-width: 34px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--muted);
  font: 600 10.5px/1 var(--font-hud);
  letter-spacing: 0.14em;
  transition:
    color 0.15s,
    background 0.15s,
    box-shadow 0.15s;
}

.kp-seg button:hover,
.kp-seg button:focus-visible {
  color: var(--ink);
}

.kp-seg button.on {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 25%, transparent);
}

.kp-tool.on {
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 30%, transparent);
}
</style>
