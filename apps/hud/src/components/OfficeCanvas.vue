<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { renderSheet } from '../../characters/compose.ts';
import { USER } from '../../characters/art/user.ts';
import { sheetUrl } from '../lib/api.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import { drawOffice, readColors, type Colors, type Figure } from '../lib/office/draw.ts';
import {
  archivePoint,
  archiveTiles,
  decisionsPoint,
  DESK_TALK_REACH,
  DESK_WALK_REACH,
  TALK_REACH,
  TILE,
  tileCenter,
  tilesNear,
  WALK_REACH,
  type OfficeMap,
  type Point,
  type Room,
} from '../lib/office/map.ts';
import { advance, followPath, retarget, seated, walkFrame, type Actor, type Facing } from '../lib/office/motion.ts';
import { findPath, moveFree, tileOf } from '../lib/office/path.ts';
import { bubbleOf, POSE_SHORT, UNKNOWN_AGENT, type OfficeSnapshot } from '../lib/office/snapshot.ts';
import { archiveCount, areaTags, hitsArchive, isShortcut, keepDrawing, nameTagTop, snapshotKey } from '../lib/office/view.ts';
import { frameAt, poseFrames, type Pose } from '../lib/sprites.ts';
import type { CharacterChoice, Label } from '../lib/types.ts';

/**
 * The office on a canvas (D-106, stage 1). It receives only the photograph
 * (lib/office/snapshot.ts: who, pose, place, label, counts) and the map,
 * plus which sheet each agent wears (pack, character, rows); never a
 * conversation, a title or a message. Arrows or WASD walk, a click walks
 * along a path of tiles, E or Enter near an agent asks the page to open its
 * conversation, near the Decisioni desk the window of D-091, near the archive
 * its list. Esc leaves the canvas. Paused while the tab is hidden; with
 * reduced motion still frames, drawn again only when something changes.
 */
const props = defineProps<{
  map: OfficeMap;
  snapshot: OfficeSnapshot;
  sheets: Record<string, CharacterChoice | undefined>;
}>();
const emit = defineEmits<{ talk: [agentId: string]; decisions: []; archive: []; escape: [] }>();

const W = props.map.width * TILE;
const H = props.map.height * TILE;
const canvas = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLElement | null>(null);
const scale = ref(2);
/** The name tags of the agents, by id: written every frame, outside Vue's reactivity. */
const nameTags = new Map<string, HTMLElement>();
const youTag = ref<HTMLElement | null>(null);
const hint = ref<HTMLElement | null>(null);

const motionQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionQuery?.matches ?? false;

// Engine state: plain objects, outside Vue's reactivity (60 frames a second).
interface AgentActor {
  actor: Actor;
  pose: Pose;
  since: number;
}
const actors = new Map<string, AgentActor>();
const you = { x: 0, y: 0, facing: 'up' as Facing, moving: false, path: [] as Point[], then: null as string | null };
const keys = new Set<'up' | 'down' | 'left' | 'right'>();
let colors: Colors | undefined;
let clock = 0;
let last = 0;
let frame = 0;
let running = false;
let scheduled = false;
const images = new Map<string, HTMLImageElement | HTMLCanvasElement>();
let userSheet: HTMLCanvasElement | null = null;

const KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

const DECISIONS = decisionsPoint(props.map);
const ARCHIVE = archivePoint(props.map);
const ARCHIVE_TILES = archiveTiles(props.map);

let lastKey = '';
/** The page makes a new photograph every second: the actors change, and the canvas wakes, only when it differs. */
function syncActors(): void {
  const key = snapshotKey(props.snapshot);
  if (key === lastKey) return;
  lastKey = key;
  const present = new Set<string>();
  for (const agent of props.snapshot.agents) {
    present.add(agent.id);
    const known = actors.get(agent.id);
    if (known === undefined) {
      actors.set(agent.id, { actor: seated(props.map, agent.place), pose: agent.pose, since: clock });
      continue;
    }
    known.actor = retarget(known.actor, props.map, agent.place, reduceMotion);
    if (known.pose !== agent.pose) {
      known.pose = agent.pose;
      known.since = clock;
    }
  }
  for (const id of [...actors.keys()]) if (!present.has(id)) actors.delete(id);
  wake();
}
watch(() => props.snapshot, syncActors, { deep: true });

function loadSheets(): void {
  for (const [id, choice] of Object.entries(props.sheets)) {
    if (choice === undefined) continue;
    const url = sheetUrl(choice);
    if (images.get(id)?.dataset.src === url) continue;
    const image = new Image();
    image.dataset.src = url;
    image.onload = () => {
      images.set(id, image);
      wake();
    };
    image.src = url;
  }
}
watch(() => props.sheets, loadSheets, { deep: true });

function buildUserSheet(): void {
  const { width, height, rgba } = renderSheet(USER);
  const sheet = document.createElement('canvas');
  sheet.width = width;
  sheet.height = height;
  const context = sheet.getContext('2d');
  if (context === null) return;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  userSheet = sheet;
}

function rowsOf(id: string): 3 | 4 {
  return props.sheets[id]?.rows ?? 3;
}

/** The frame of a seated agent: its pose facing down; facing up it types or stands. */
function seatedFrame(state: AgentActor, id: string): { column: number; row: number; mirror: boolean } {
  const { actor, pose } = state;
  if (actor.facing === 'up') {
    const typing = pose === 'working' && !reduceMotion ? Math.floor((clock - state.since) / 180) % 2 : 0;
    return { column: pose === 'working' ? 3 + typing : 1, row: 1, mirror: false };
  }
  if (actor.facing !== 'down') return { column: 1, row: 2, mirror: actor.facing === 'left' };
  const at = frameAt(poseFrames(pose, rowsOf(id)), clock - state.since, reduceMotion);
  return { ...at, mirror: false };
}

function others(): Point[] {
  return [...actors.values()].map(({ actor }): Point => [actor.x, actor.y]);
}

/** What is within reach of the user: the closest agent, the Decisioni desk, the archive. */
function nearby(): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const [id, { actor }] of actors) {
    const d = Math.hypot(actor.x - you.x, actor.y - you.y);
    if (d < TALK_REACH && d < distance) {
      best = id;
      distance = d;
    }
  }
  const toDesk = Math.hypot(DECISIONS[0] - you.x, DECISIONS[1] - you.y);
  if (toDesk < DESK_TALK_REACH && toDesk < distance) {
    best = 'decisions';
    distance = toDesk;
  }
  const toArchive = Math.hypot(ARCHIVE[0] - you.x, ARCHIVE[1] - you.y);
  if (toArchive < TALK_REACH && toArchive < distance) best = 'archive';
  return best;
}

function interact(target: string | null): void {
  if (target === null) return;
  keys.clear();
  if (target === 'decisions') emit('decisions');
  else if (target === 'archive') emit('archive');
  else emit('talk', target);
}

function pointOf(target: string): Point | undefined {
  if (target === 'decisions') return DECISIONS;
  if (target === 'archive') return ARCHIVE;
  const actor = actors.get(target)?.actor;
  return actor === undefined ? undefined : [actor.x, actor.y];
}

function face(target: Point): void {
  const dx = target[0] - you.x;
  const dy = target[1] - you.y;
  you.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

/** Walks next to an agent, the Decisioni desk or the archive; `open` then opens it. */
function goTo(target: string, open = true): void {
  const point = pointOf(target);
  if (point === undefined) return;
  const reach = target === 'decisions' ? DESK_WALK_REACH : WALK_REACH;
  const path = findPath(props.map, tileOf(you.x, you.y), tilesNear(props.map, point[0], point[1], reach));
  if (path === null) return;
  wake();
  const end = path.at(-1);
  if (reduceMotion && end !== undefined) {
    [you.x, you.y] = tileCenter(end);
    you.path = [];
    face(point);
    if (open) interact(target);
    return;
  }
  you.path = path.map((tile) => tileCenter(tile));
  you.then = open ? target : `walk:${target}`;
}

function walkTo(tile: Point): void {
  const path = findPath(props.map, tileOf(you.x, you.y), [tile]);
  if (path === null) return;
  wake();
  you.then = null;
  if (reduceMotion) {
    [you.x, you.y] = tileCenter(tile);
    you.path = [];
    return;
  }
  you.path = path.map((step) => tileCenter(step));
}

/** At the end of a walk: face what the user walked to and, if asked, open it. */
function arrive(): void {
  const then = you.then;
  you.then = null;
  if (then === null) return;
  const target = then.startsWith('walk:') ? then.slice(5) : then;
  const point = pointOf(target);
  if (point !== undefined) face(point);
  if (!then.startsWith('walk:')) interact(target);
}

function updateYou(dt: number): void {
  let vx = 0;
  let vy = 0;
  if (keys.has('left')) vx -= 1;
  if (keys.has('right')) vx += 1;
  if (keys.has('up')) vy -= 1;
  if (keys.has('down')) vy += 1;
  if (vx !== 0 || vy !== 0) {
    you.path = [];
    you.then = null;
    [you.x, you.y] = moveFree(props.map, [you.x, you.y], vx, vy, (56 * dt) / 1000, others());
    you.facing = Math.abs(vx) >= Math.abs(vy) && vx !== 0 ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
    you.moving = true;
    return;
  }
  if (you.path.length > 0) {
    const step = followPath([you.x, you.y], you.path, (56 * dt) / 1000, you.facing);
    [you.x, you.y] = step.at;
    you.path = step.path;
    you.facing = step.facing;
    you.moving = true;
    if (you.path.length === 0) arrive();
    return;
  }
  you.moving = false;
}

/** Sizes of the tags, measured once per text and scale (no layout every frame). */
const measured = new WeakMap<HTMLElement, { key: string; w: number; h: number }>();
function sizeOf(element: HTMLElement): { w: number; h: number } {
  const key = `${element.textContent}|${String(scale.value)}`;
  const known = measured.get(element);
  if (known !== undefined && known.key === key && known.w > 0) return known;
  const size = { key, w: element.offsetWidth, h: element.offsetHeight };
  measured.set(element, size);
  return size;
}

/**
 * Puts a tag at a point of the map, centred: its bottom at `y` ("above") or
 * its top ("below"); always inside the canvas.
 */
function place(element: HTMLElement | null | undefined, x: number, y: number, anchor: 'above' | 'below'): void {
  if (element === null || element === undefined) return;
  const s = scale.value;
  const { w, h } = sizeOf(element);
  const left = Math.max(0, Math.min(W * s - w, Math.round(x * s - w / 2)));
  const top = Math.max(0, Math.min(H * s - h, Math.round(anchor === 'above' ? y * s - h : y * s)));
  element.style.transform = `translate(${String(left)}px, ${String(top)}px)`;
}

function hintText(target: string): string {
  if (target === 'decisions') {
    const total = props.snapshot.decisions.total;
    return total > 0 ? `Decisioni in attesa (${String(total)})` : 'Nessuna decisione in attesa';
  }
  if (target === 'archive') return `Archivio (${String(archiveCount(props.snapshot))})`;
  const name = props.snapshot.agents.find((agent) => agent.id === target)?.name ?? UNKNOWN_AGENT;
  return `Parla con ${name}`;
}

function render(): void {
  const context = canvas.value?.getContext('2d');
  if (context === null || context === undefined || colors === undefined) return;
  context.imageSmoothingEnabled = false;
  const near = nearby();
  const figures: Figure[] = [];
  const screens = new Set<string>();
  for (const agent of props.snapshot.agents) {
    const state = actors.get(agent.id);
    if (state === undefined) continue;
    const { actor } = state;
    const frameOf = actor.walking ? walkFrame(actor.facing, clock, reduceMotion) : seatedFrame(state, agent.id);
    if (!actor.walking && ['working', 'reading', 'thinking', 'waiting'].includes(state.pose)) screens.add(`${String(actor.seat[0])},${String(actor.seat[1])}`);
    figures.push({
      x: actor.x,
      y: actor.y,
      sheet: images.get(agent.id) ?? null,
      ...frameOf,
      bubble: bubbleOf(state.pose, actor.walking),
      near: near === agent.id,
      dim: state.pose === 'paused' && !actor.walking,
    });
    const tag = nameTags.get(agent.id);
    if (tag !== undefined) {
      const text = `${agent.name} · ${actor.walking ? POSE_SHORT.walking : POSE_SHORT[state.pose]}`;
      if (tag.textContent !== text) tag.textContent = text;
      place(tag, actor.x, nameTagTop(props.map, actor), 'below');
    }
  }
  figures.push({ x: you.x, y: you.y, sheet: userSheet, ...(you.moving ? walkFrame(you.facing, clock, reduceMotion) : walkFrame(you.facing, 130, true)), bubble: null, near: false, dim: false });
  drawOffice(context, {
    map: props.map,
    colors,
    now: clock,
    reduceMotion,
    islandRugs: props.map.anchors.islands.map((_, slot) => {
      const island = props.snapshot.islands.find((item) => item.slot === slot);
      return island === undefined ? null : island.label === 'L2' || island.label === 'L3' ? 'l2' : 'l1';
    }),
    screens,
    figures,
    decisionsWaiting: props.snapshot.decisions.total > 0,
  });
  const hintElement = hint.value;
  if (hintElement !== null) {
    if (near !== null && document.activeElement === canvas.value) {
      const text = hintText(near);
      const label = hintElement.querySelector('span');
      if (label !== null && label.textContent !== text) label.textContent = text;
      hintElement.hidden = false;
      place(hintElement, you.x, you.y - 34, 'above');
      if (youTag.value !== null) youTag.value.hidden = true;
    } else {
      hintElement.hidden = true;
      if (youTag.value !== null) youTag.value.hidden = false;
    }
  }
  place(youTag.value, you.x, you.y + 2, 'below');
}

function loop(time: number): void {
  scheduled = false;
  const dt = last === 0 ? 0 : Math.max(0, Math.min(64, time - last));
  last = time;
  clock += dt;
  for (const state of actors.values()) state.actor = advance(state.actor, props.map, (40 * dt) / 1000);
  updateYou(dt);
  render();
  if (!running) return;
  const agentsWalking = [...actors.values()].some(({ actor }) => actor.walking);
  if (keepDrawing(reduceMotion, { keys: keys.size, userPath: you.path.length, agentsWalking })) wake();
  else last = 0;
}

/** Asks for a frame: every frame while running, or one when something changes with reduced motion. */
function wake(): void {
  if (!running || scheduled) return;
  scheduled = true;
  frame = window.requestAnimationFrame(loop);
}

function start(): void {
  if (running) return;
  running = true;
  last = 0;
  wake();
}
function stop(): void {
  running = false;
  scheduled = false;
  window.cancelAnimationFrame(frame);
  keys.clear();
}
function onVisibility(): void {
  if (document.visibilityState === 'hidden') stop();
  else start();
}

function onKeydown(event: KeyboardEvent): void {
  if (isShortcut(event)) return;
  const key = KEYS[event.code] ?? KEYS[event.key];
  if (key !== undefined) {
    keys.add(key);
    event.preventDefault();
    wake();
    return;
  }
  if (event.code === 'KeyE' || event.key === 'Enter') {
    event.preventDefault();
    interact(nearby());
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    keys.clear();
    you.path = [];
    emit('escape');
  }
}
function onKeyup(event: KeyboardEvent): void {
  // A key let go while Cmd was down sends no keyup of its own on macOS.
  if (event.key === 'Meta') {
    keys.clear();
  } else {
    const key = KEYS[event.code] ?? KEYS[event.key];
    if (key !== undefined) keys.delete(key);
  }
  wake();
}
function onWindowBlur(): void {
  keys.clear();
  wake();
}
function onFocusChange(): void {
  keys.clear();
  wake();
}

function inside(room: Room, c: number, r: number): boolean {
  return c >= room[0] && c <= room[2] && r >= room[1] && r <= room[3];
}

function onClick(event: MouseEvent): void {
  const element = canvas.value;
  if (element === null) return;
  element.focus();
  wake();
  const box = element.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * W;
  const y = ((event.clientY - box.top) / box.height) * H;
  for (const [id, { actor }] of actors) {
    if (x >= actor.x - 8 && x <= actor.x + 8 && y >= actor.y - 30 && y <= actor.y) {
      if (Math.hypot(actor.x - you.x, actor.y - you.y) < TALK_REACH) interact(id);
      else goTo(id);
      return;
    }
  }
  const c = Math.floor(x / TILE);
  const r = Math.floor(y / TILE);
  const desk = props.map.anchors.decisions.desk;
  if (r >= desk[1] - 1 && r <= desk[1] && c >= desk[0] && c < desk[0] + desk[2]) {
    goTo('decisions');
    return;
  }
  if (hitsArchive(ARCHIVE_TILES, x, y)) {
    goTo('archive');
    return;
  }
  if (inside([0, 0, props.map.width - 1, props.map.height - 1], c, r)) walkTo([c, r]);
}

function readTheme(): void {
  colors = readColors(getComputedStyle(document.documentElement));
  wake();
}
const themeObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(readTheme);
const schemeQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-color-scheme: light)');

/** Reduced motion turned on: whoever walks is at once where it was going, the user too. */
function onMotion(event: MediaQueryListEvent): void {
  reduceMotion = event.matches;
  if (reduceMotion) {
    for (const agent of props.snapshot.agents) {
      const state = actors.get(agent.id);
      if (state?.actor.walking === true) state.actor = seated(props.map, agent.place);
    }
    const end = you.path.at(-1);
    if (end !== undefined) {
      [you.x, you.y] = end;
      you.path = [];
      you.moving = false;
      arrive();
    }
  }
  wake();
}

let resize: ResizeObserver | undefined;
function fit(): void {
  const width = wrap.value?.clientWidth ?? W * 2;
  const byHeight = Math.floor((window.innerHeight - 140) / H);
  scale.value = Math.max(1, Math.min(4, Math.floor(width / W), Math.max(2, byHeight)));
  wake();
}

/** Area names over the map (lib/office/view.ts): textContent through Vue, positions at the scale. */
const tags = computed(() => areaTags(props.map, props.snapshot));
const labelClass: Record<Label, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };

function setNameTag(id: string, element: unknown): void {
  if (element instanceof HTMLElement) nameTags.set(id, element);
  else nameTags.delete(id);
}

onMounted(() => {
  [you.x, you.y] = tileCenter(props.map.anchors.entrance);
  readTheme();
  buildUserSheet();
  loadSheets();
  syncActors();
  fit();
  if (typeof ResizeObserver !== 'undefined' && wrap.value !== null) {
    resize = new ResizeObserver(fit);
    resize.observe(wrap.value);
  }
  window.addEventListener('resize', fit);
  window.addEventListener('keyup', onKeyup);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibility);
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  schemeQuery?.addEventListener('change', readTheme);
  motionQuery?.addEventListener('change', onMotion);
  if (document.visibilityState !== 'hidden') start();
});
onBeforeUnmount(() => {
  stop();
  resize?.disconnect();
  window.removeEventListener('resize', fit);
  window.removeEventListener('keyup', onKeyup);
  window.removeEventListener('blur', onWindowBlur);
  document.removeEventListener('visibilitychange', onVisibility);
  themeObserver?.disconnect();
  schemeQuery?.removeEventListener('change', readTheme);
  motionQuery?.removeEventListener('change', onMotion);
});

function focus(): void {
  canvas.value?.focus({ preventScroll: false });
}
defineExpose({ goTo, focus });
</script>

<template>
  <div ref="wrap" class="min-w-0">
    <div class="relative mx-auto overflow-hidden rounded-md border border-line-strong" :style="{ width: `${String(W * scale)}px` }">
      <canvas
        ref="canvas"
        :width="W"
        :height="H"
        tabindex="0"
        role="application"
        aria-roledescription="ufficio"
        aria-label="Ufficio: frecce o W A S D per camminare, E o Invio vicino a un agente per parlarci, vicino alla scrivania Decisioni per aprirle, Esc per uscire"
        aria-describedby="office-help"
        class="office-canvas pixelated block cursor-pointer"
        :style="{ width: `${String(W * scale)}px`, height: `${String(H * scale)}px` }"
        @keydown="onKeydown"
        @focus="onFocusChange"
        @blur="onFocusChange"
        @click="onClick"
      />
      <div class="pointer-events-none absolute inset-0" aria-hidden="true">
        <span
          v-for="(tag, index) in tags"
          :key="index"
          class="absolute top-0 left-0 rounded border border-line-strong bg-surface/85 px-1.5 text-[11px] leading-[14px] whitespace-nowrap"
          :class="tag.muted ? 'text-muted' : 'text-ink'"
          :style="{ transform: `translate(${String(tag.x * scale)}px, ${String(tag.y * scale)}px) translateY(-100%)` }"
        >{{ tag.text }}<span v-if="tag.label !== null" class="ml-1 inline-flex items-center gap-1 text-[10px] font-semibold" :class="labelClass[tag.label]"><i class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[tag.label] }}</span></span>
        <span
          v-for="agent in snapshot.agents"
          :key="agent.id"
          :ref="(element) => { setNameTag(agent.id, element); }"
          class="absolute top-0 left-0 rounded border border-line-strong bg-surface/90 px-1.5 text-[11px] leading-[14px] whitespace-nowrap"
        />
        <span ref="youTag" class="absolute top-0 left-0 rounded border border-warn bg-surface/90 px-1.5 text-[11px] leading-[14px] whitespace-nowrap">Tu</span>
        <span ref="hint" hidden class="absolute top-0 left-0 rounded bg-accent px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-accent-ink">
          <kbd class="mr-1 rounded border border-current px-1 font-mono text-[11px]">E</kbd><span />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The ring of :focus-visible inside the canvas: the rounded frame around it would clip it outside. */
.office-canvas:focus-visible {
  outline-offset: -2px;
}
</style>
