<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { renderSheet } from '../../characters/compose.ts';
import { USER } from '../../characters/art/user.ts';
import { characterNames } from '../lib/character-names.ts';
import { sheetUrl } from '../lib/api.ts';
import { LABEL_TEXT } from '../lib/labels.ts';
import { drawOffice, readColors, type Colors, type Figure } from '../lib/office/draw.ts';
import { skinColors, type OfficeSkin } from '../lib/office/skins.ts';
import { feastDecor, type OfficeFeast } from '../lib/office/feasts.ts';
import {
  archivePoint,
  archiveTiles,
  boardPoint,
  boardTiles,
  decisionsPoint,
  DESK_TALK_REACH,
  DESK_WALK_REACH,
  inRoom,
  TALK_REACH,
  TILE,
  tileCenter,
  tilesNear,
  WALK_REACH,
  type OfficeMap,
  type Point,
} from '../lib/office/map.ts';
import { advance, followPath, retarget, seated, walkFrame, type Actor, type Facing } from '../lib/office/motion.ts';
import { findPath, moveFree, tileOf } from '../lib/office/path.ts';
import { bubbleOf, POSE_SHORT, type OfficeSnapshot } from '../lib/office/snapshot.ts';
import {
  areaTags,
  boardTag,
  cameraOffset,
  closestTarget,
  hintText,
  hitsArchive,
  hitsBoard,
  isShortcut,
  keepDrawing,
  nameTagTop,
  officeScale,
  snapshotKey,
  type Target,
} from '../lib/office/view.ts';
import { agentAt, compactScale, compactView, TOUCH_PAD, WIDE_QUERY } from '../lib/office/phone.ts';
import type { OfficeScene, SpriteState } from '../lib/office/scene3d.ts';
import {
  areaAt,
  buildWorld,
  facingOfYaw,
  inSight,
  SPRITE_HEIGHT,
  standPoint,
  TAG_DISTANCE,
  toWorld,
  viewFacing,
  walkVector,
  yawTowards,
  type OfficeViewMode,
} from '../lib/office/world3d.ts';
import { frameAt, poseFrames, type Pose } from '../lib/sprites.ts';
import type { CharacterChoice, Label } from '../lib/types.ts';

/**
 * The office on a canvas (D-106, stage 1). It receives only the photograph
 * (lib/office/snapshot.ts: who, pose, place, label, counts) and the map,
 * plus which sheet each agent wears (pack, character, rows); never a
 * conversation, a title or a message. Arrows or WASD walk, a click walks
 * along a path of tiles, E or Enter near an agent asks the page to open its
 * conversation, near the Decisioni desk the window of D-091, near the archive
 * its list, near the cardwall on the wall the cardwall (D-165). Esc leaves the canvas. Paused while the tab is hidden; with
 * reduced motion still frames, drawn again only when something changes.
 *
 * The 3D view (D-230) is another drawing of the same engine: the same
 * actors, the same user's point on the map, the same collisions (moveFree),
 * the same E. three.js arrives with a dynamic import only when the view is
 * on, and everything it holds is disposed when it goes off.
 */
const props = defineProps<{
  map: OfficeMap;
  /** The place of the theme (D-216): colours and furniture; the map is `map`. */
  skin?: OfficeSkin | undefined;
  /** The feast of the theme in use (D-252): its decorations; null or absent, none. Read when the canvas starts, as the map. */
  feast?: OfficeFeast | null | undefined;
  snapshot: OfficeSnapshot;
  sheets: Record<string, CharacterChoice | undefined>;
  /** The plan (default) or the walk in 3D (D-230). */
  mode?: OfficeViewMode | undefined;
}>();
const emit = defineEmits<{ talk: [agentId: string]; decisions: []; archive: []; cardwall: []; escape: []; view: [mode: OfficeViewMode] }>();

const W = props.map.width * TILE;
// The decorations of the feast (D-252): where they go is fixed for this map, worked out once.
const decor = props.feast === null || props.feast === undefined ? null : feastDecor(props.map, props.feast);
const H = props.map.height * TILE;
const canvas = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLElement | null>(null);
/** The map with its tags, moved under the window to follow the user (D-229). */
const stage = ref<HTMLElement | null>(null);
const scale = ref(2);
/** The window on the map, in CSS pixels: the whole map when it fits. */
const viewW = ref(W * 2);
const viewH = ref(H * 2);
/** The name tags of the agents, by id: written every frame, outside Vue's reactivity. */
const nameTags = new Map<string, HTMLElement>();
const youTag = ref<HTMLElement | null>(null);
const hint = ref<HTMLElement | null>(null);

const motionQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionQuery?.matches ?? false;

/**
 * The phone (D-293, lib/office/phone.ts): below 48rem the plan keeps whole
 * pixels, its whole height, and scrolls sideways under a finger (the page
 * still scrolls vertically); a finger gets a wider box around an agent. From
 * 48rem the window follows the user as it always has.
 */
const wideQuery = typeof window === 'undefined' ? undefined : window.matchMedia(WIDE_QUERY);
const compact = ref(wideQuery !== undefined && !wideQuery.matches);
const coarseQuery = typeof window === 'undefined' ? undefined : window.matchMedia('(pointer: coarse)');
/** The window on the map: on the phone it is the scroll box. */
const viewport = ref<HTMLElement | null>(null);

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

// The 3D view (D-230): ↑ ↓ (W S) walk, A D step sideways, ← → turn; the mouse or a finger drags to look around.
type Key3 = 'forward' | 'back' | 'left' | 'right' | 'turnLeft' | 'turnRight';
const KEYS3: Record<string, Key3> = {
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'turnLeft', ArrowRight: 'turnRight', KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
};
const keys3 = new Set<Key3>();
const view3d = ref<HTMLElement | null>(null);
const canvas3d = ref<HTMLCanvasElement | null>(null);
const nameTags3 = new Map<string, HTMLElement>();
const hint3 = ref<HTMLElement | null>(null);
const area3 = ref<{ text: string; label: Label | null } | null>(null);
/** off, loading three.js, drawing; or the plan stays: three.js could not be loaded (a newer build: reload), or no WebGL. */
const status3d = ref<'off' | 'loading' | 'ready' | 'load-error' | 'webgl-error'>('off');
let scene3d: OfficeScene | null = null;
let yaw = 0;
let pitch = 0;
/** Where the camera turns by itself while walking a path or on arrival; never with reduced motion. */
let yawGoal: number | null = null;
const TURN_SPEED = 2.4;
const YAW: Record<Facing, number> = { up: 0, left: Math.PI / 2, down: Math.PI, right: -Math.PI / 2 };
const failed3d = computed(() => status3d.value === 'load-error' || status3d.value === 'webgl-error');
const is3d = computed(() => props.mode === '3d' && !failed3d.value);
// The page shows the keys of the view really in use: the plan when the 3D one could not start.
watch(is3d, (on) => {
  emit('view', on ? '3d' : '2d');
}, { immediate: true });

function releaseKeys(): void {
  keys.clear();
  keys3.clear();
}

const DECISIONS = decisionsPoint(props.map);
const ARCHIVE = archivePoint(props.map);
const ARCHIVE_TILES = archiveTiles(props.map);
/** The cardwall on the wall (D-165): none in a map without it. */
const BOARD = boardPoint(props.map);
const BOARD_TILES = boardTiles(props.map);

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
function seatedFrame(state: AgentActor, id: string, facing: Facing = state.actor.facing): { column: number; row: number; mirror: boolean } {
  const { pose } = state;
  if (facing === 'up') {
    const typing = pose === 'working' && !reduceMotion ? Math.floor((clock - state.since) / 180) % 2 : 0;
    return { column: pose === 'working' ? 3 + typing : 1, row: 1, mirror: false };
  }
  if (facing !== 'down') return { column: 1, row: 2, mirror: facing === 'left' };
  const at = frameAt(poseFrames(pose, rowsOf(id)), clock - state.since, reduceMotion);
  return { ...at, mirror: false };
}

function others(): Point[] {
  return [...actors.values()].map(({ actor }): Point => [actor.x, actor.y]);
}

/** What is within reach of the user: the closest agent, the Decisioni desk, the archive, the cardwall. */
function nearby(): string | null {
  const targets: Target[] = [...actors].map(([id, { actor }]) => ({ id, point: [actor.x, actor.y], reach: TALK_REACH }));
  targets.push({ id: 'decisions', point: DECISIONS, reach: DESK_TALK_REACH }, { id: 'archive', point: ARCHIVE, reach: TALK_REACH });
  if (BOARD !== null) targets.push({ id: 'cardwall', point: BOARD, reach: TALK_REACH });
  return closestTarget([you.x, you.y], targets);
}

function interact(target: string | null): void {
  if (target === null) return;
  releaseKeys();
  if (target === 'decisions') emit('decisions');
  else if (target === 'archive') emit('archive');
  else if (target === 'cardwall') emit('cardwall');
  else emit('talk', target);
}

function pointOf(target: string): Point | undefined {
  if (target === 'decisions') return DECISIONS;
  if (target === 'archive') return ARCHIVE;
  if (target === 'cardwall') return BOARD ?? undefined;
  const actor = actors.get(target)?.actor;
  return actor === undefined ? undefined : [actor.x, actor.y];
}

function face(target: Point): void {
  const dx = target[0] - you.x;
  const dy = target[1] - you.y;
  you.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  // In 3D the camera turns to it, slowly; with reduced motion it never turns by itself.
  if (is3d.value && !reduceMotion) yawGoal = yawTowards(toWorld([you.x, you.y]), toWorld(target));
}

/** Walks next to an agent, the Decisioni desk, the archive or the cardwall; `open` then opens it. */
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
  // In 3D an agent is where its sprite stands (in the middle of its seat), not where the plan draws its feet.
  const actor = actors.get(target)?.actor;
  if (actor !== undefined && yawGoal !== null) yawGoal = yawTowards(toWorld([you.x, you.y]), standPoint(actor));
  if (!then.startsWith('walk:')) interact(target);
}

/** The shortest turn from one yaw to another, in (-π, π]. */
function turnBetween(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function updateYou(dt: number): void {
  let vx = 0;
  let vy = 0;
  if (is3d.value) {
    const turn = (keys3.has('turnLeft') ? 1 : 0) - (keys3.has('turnRight') ? 1 : 0);
    if (turn !== 0) {
      yaw += (turn * TURN_SPEED * dt) / 1000;
      yawGoal = null;
    }
    [vx, vy] = walkVector({ forward: keys3.has('forward'), back: keys3.has('back'), left: keys3.has('left'), right: keys3.has('right') }, yaw);
    if (vx !== 0 || vy !== 0) yawGoal = null;
    if (yawGoal !== null) {
      const left = turnBetween(yaw, yawGoal);
      const step = (TURN_SPEED * dt) / 1000;
      if (Math.abs(left) <= step) {
        yaw = yawGoal;
        yawGoal = null;
      } else {
        yaw += Math.sign(left) * step;
      }
    }
  } else {
    if (keys.has('left')) vx -= 1;
    if (keys.has('right')) vx += 1;
    if (keys.has('up')) vy -= 1;
    if (keys.has('down')) vy += 1;
  }
  if (vx !== 0 || vy !== 0) {
    you.path = [];
    you.then = null;
    [you.x, you.y] = moveFree(props.map, [you.x, you.y], vx, vy, (56 * dt) / 1000, others());
    you.facing = is3d.value ? facingOfYaw(yaw) : Math.abs(vx) >= Math.abs(vy) && vx !== 0 ? (vx > 0 ? 'right' : 'left') : vy > 0 ? 'down' : 'up';
    you.moving = true;
    return;
  }
  if (you.path.length > 0) {
    const step = followPath([you.x, you.y], you.path, (56 * dt) / 1000, you.facing);
    const next = step.path[0];
    // Walking a path in 3D the camera looks where the user goes (never with reduced motion: there the walk is a jump).
    if (is3d.value && !reduceMotion && next !== undefined && Math.hypot(next[0] - step.at[0], next[1] - step.at[1]) > 0.5) yawGoal = yawTowards(toWorld(step.at), toWorld(next));
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

/** The desks whose screen is on: someone seated there reads, writes, thinks or waits (the same in 2D and 3D). */
function screensOn(): Set<string> {
  const screens = new Set<string>();
  for (const state of actors.values()) {
    const { actor } = state;
    if (!actor.walking && ['working', 'reading', 'thinking', 'waiting'].includes(state.pose)) screens.add(`${String(actor.seat[0])},${String(actor.seat[1])}`);
  }
  return screens;
}

/** The text of an agent's tag: its name (D-214: the person of the series it wears) and what it does. */
function tagText(id: string, name: string, state: AgentActor): string {
  return `${characterNames.value[id] ?? name} · ${state.actor.walking ? POSE_SHORT.walking : POSE_SHORT[state.pose]}`;
}

/** The same state drawn in 3D (D-230): the sprites turned as the camera sees them, tags only for who is in sight. */
function render3d(): void {
  const scene = scene3d;
  const box = view3d.value;
  if (scene === null || box === null) return;
  const eye = toWorld([you.x, you.y]);
  const near = nearby();
  const sprites: SpriteState[] = [];
  const width = box.clientWidth;
  const height = box.clientHeight;
  for (const agent of props.snapshot.agents) {
    const state = actors.get(agent.id);
    if (state === undefined) continue;
    const { actor } = state;
    const at = standPoint(actor);
    const seen = viewFacing(actor.facing, at, eye);
    const frameOf = actor.walking ? walkFrame(seen, clock, reduceMotion) : seatedFrame(state, agent.id, seen);
    const sheet = images.get(agent.id) ?? null;
    sprites.push({ id: agent.id, x: at.x, z: at.z, sheet, ...frameOf, dim: state.pose === 'paused' && !actor.walking });
    const tag = nameTags3.get(agent.id);
    if (tag === undefined) continue;
    const text = tagText(agent.id, agent.name, state);
    if (tag.textContent !== text) tag.textContent = text;
    tag.classList.toggle('near', near === agent.id);
    const close = Math.hypot(at.x - eye.x, at.z - eye.z) < TAG_DISTANCE && inSight(props.map, eye, at);
    const point = close && sheet !== null ? scene.project(at.x, SPRITE_HEIGHT + 0.08, at.z) : null;
    const shown = point !== null && point.left >= 0 && point.left <= width && point.top >= 0 && point.top <= height;
    tag.hidden = !shown;
    if (shown) tag.style.transform = `translate(${String(Math.round(point.left))}px, ${String(Math.round(point.top))}px) translate(-50%, -100%)`;
  }
  scene.frame({ eye, yaw, pitch, sprites, screens: screensOn(), decisionsWaiting: props.snapshot.decisions.total > 0, now: clock, reduceMotion });
  const hintElement = hint3.value;
  if (hintElement !== null) {
    const show = near !== null && document.activeElement === canvas3d.value;
    hintElement.hidden = !show;
    const label = hintElement.querySelector('span');
    if (show && label !== null) {
      const text = hintText(near, props.snapshot);
      if (label.textContent !== text) label.textContent = text;
    }
  }
  const area = areaAt(props.map, props.snapshot, tileOf(you.x, you.y));
  if (area?.text !== area3.value?.text || area?.label !== area3.value?.label) area3.value = area;
}

function render(): void {
  if (is3d.value) {
    render3d();
    return;
  }
  const context = canvas.value?.getContext('2d');
  if (context === null || context === undefined || colors === undefined) return;
  context.imageSmoothingEnabled = false;
  const near = nearby();
  const figures: Figure[] = [];
  const screens = screensOn();
  for (const agent of props.snapshot.agents) {
    const state = actors.get(agent.id);
    if (state === undefined) continue;
    const { actor } = state;
    const frameOf = actor.walking ? walkFrame(actor.facing, clock, reduceMotion) : seatedFrame(state, agent.id);
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
      // D-214: the name of the person of the series, when the agent wears one.
      const text = tagText(agent.id, agent.name, state);
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
    boardNear: near === 'cardwall',
    skin: props.skin ?? 'base',
    decor,
  });
  const hintElement = hint.value;
  if (hintElement !== null) {
    if (near !== null && document.activeElement === canvas.value) {
      const text = hintText(near, props.snapshot);
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
  follow();
}

/** Pixels from the feet to the middle of a character: the window centres on the body, not the feet. */
const BODY_MIDDLE = 12;
/** The window is never lower than this (CSS pixels), nor taller than the page minus its header and the line under the map. */
const MIN_VIEW_HEIGHT = 192;
const PAGE_CHROME = 160;

/** The window follows the user (D-229): the stage moves, the canvas never scrolls. */
function follow(): void {
  const element = stage.value;
  if (element === null) return;
  const s = scale.value;
  if (compact.value) {
    // On the phone the finger scrolls the window; it follows the user only while a walk is under way.
    if (element.style.transform !== '') element.style.transform = '';
    const box = viewport.value;
    if (box !== null && you.path.length > 0) {
      const left = cameraOffset(box.clientWidth, W * s, you.x * s);
      if (Math.abs(box.scrollLeft - left) > 1) box.scrollLeft = left;
    }
    return;
  }
  const x = cameraOffset(viewW.value, W * s, you.x * s);
  const y = cameraOffset(viewH.value, H * s, (you.y - BODY_MIDDLE) * s);
  const transform = `translate(${String(-x)}px, ${String(-y)}px)`;
  if (element.style.transform !== transform) element.style.transform = transform;
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
  const turning = yawGoal !== null || drag !== null ? 1 : 0;
  if (keepDrawing(reduceMotion, { keys: keys.size + keys3.size + turning, userPath: you.path.length, agentsWalking })) wake();
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
  releaseKeys();
}
function onVisibility(): void {
  if (document.visibilityState === 'hidden') stop();
  else start();
}

function onKeydown(event: KeyboardEvent): void {
  if (isShortcut(event)) return;
  if (is3d.value) {
    const key3 = KEYS3[event.code] ?? KEYS3[event.key];
    if (key3 !== undefined) {
      keys3.add(key3);
      event.preventDefault();
      wake();
      return;
    }
  } else {
    const key = KEYS[event.code] ?? KEYS[event.key];
    if (key !== undefined) {
      keys.add(key);
      event.preventDefault();
      wake();
      return;
    }
  }
  if (event.code === 'KeyE' || event.key === 'Enter') {
    event.preventDefault();
    interact(nearby());
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    releaseKeys();
    you.path = [];
    emit('escape');
  }
}
function onKeyup(event: KeyboardEvent): void {
  // A key let go while Cmd was down sends no keyup of its own on macOS.
  if (event.key === 'Meta') {
    releaseKeys();
  } else {
    const key = KEYS[event.code] ?? KEYS[event.key];
    if (key !== undefined) keys.delete(key);
    const key3 = KEYS3[event.code] ?? KEYS3[event.key];
    if (key3 !== undefined) keys3.delete(key3);
  }
  wake();
}
function onWindowBlur(): void {
  releaseKeys();
  wake();
}
function onFocusChange(): void {
  releaseKeys();
  wake();
}

function onClick(event: MouseEvent): void {
  const element = canvas.value;
  if (element === null) return;
  // On the phone a tap must not move the scroll the finger chose.
  if (compact.value) element.focus({ preventScroll: true });
  else element.focus();
  wake();
  const box = element.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * W;
  const y = ((event.clientY - box.top) / box.height) * H;
  const feet = [...actors].map(([id, { actor }]) => ({ id, x: actor.x, y: actor.y }));
  const hit = agentAt(feet, x, y, coarseQuery?.matches === true ? TOUCH_PAD : 0);
  if (hit !== null) {
    clickAgent(hit);
    return;
  }
  clickMap(x, y);
}

/** A click on an agent: talks within reach, otherwise walks to it. */
function clickAgent(id: string): void {
  const actor = actors.get(id)?.actor;
  if (actor === undefined) return;
  if (Math.hypot(actor.x - you.x, actor.y - you.y) < TALK_REACH) interact(id);
  else goTo(id);
}

/** A click on a point of the map (pixels), from the plan or from the 3D view: the desk, the archive, the cardwall, or a walk. */
function clickMap(x: number, y: number): void {
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
  if (hitsBoard(BOARD_TILES, x, y)) {
    goTo('cardwall');
    return;
  }
  if (inRoom([0, 0, props.map.width - 1, props.map.height - 1], c, r)) walkTo([c, r]);
}

function readTheme(): void {
  colors = skinColors(readColors(getComputedStyle(document.documentElement)), props.skin ?? 'base');
  scene3d?.setColors(colors);
  wake();
}

// Dragging in the 3D view turns the camera; a press that does not move is a click (a tap on the phone).
let drag: { id: number; x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
const DRAG_TURN = 0.006;
const MAX_PITCH = 0.6;
function onPointerDown(event: PointerEvent): void {
  const element = canvas3d.value;
  if (element === null || (event.pointerType === 'mouse' && event.button !== 0)) return;
  element.focus({ preventScroll: true });
  element.setPointerCapture(event.pointerId);
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw, pitch, moved: false };
  wake();
}
function onPointerMove(event: PointerEvent): void {
  if (drag?.id !== event.pointerId) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  yawGoal = null;
  yaw = drag.yaw - dx * DRAG_TURN;
  pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, drag.pitch - dy * DRAG_TURN));
  wake();
}
function onPointerUp(event: PointerEvent): void {
  if (drag?.id !== event.pointerId) return;
  const clicked = !drag.moved;
  drag = null;
  const element = canvas3d.value;
  if (!clicked || element === null || scene3d === null) return;
  const box = element.getBoundingClientRect();
  const hit = scene3d.pick(event.clientX - box.left, event.clientY - box.top);
  if (hit === null) return;
  if (hit.kind === 'agent') clickAgent(hit.id);
  else clickMap(hit.x * TILE, hit.z * TILE);
  wake();
}
function onPointerCancel(): void {
  drag = null;
}

function sizeScene(): void {
  const box = view3d.value;
  if (scene3d !== null && box !== null) scene3d.resize(box.clientWidth, box.clientHeight);
}

/** Turns the 3D view on: three.js arrives now, with a dynamic import; looking where the user faced in the plan. */
let entering = 0;
async function enter3d(): Promise<void> {
  const attempt = ++entering;
  status3d.value = 'loading';
  releaseKeys();
  let module: typeof import('../lib/office/scene3d.ts');
  try {
    module = await import('../lib/office/scene3d.ts');
  } catch {
    if (attempt === entering) status3d.value = 'load-error';
    return;
  }
  await nextTick();
  const element = canvas3d.value;
  if (attempt !== entering || props.mode !== '3d' || element === null) return;
  try {
    scene3d = module.createOfficeScene(element, buildWorld(props.map, props.skin ?? 'base', decor));
  } catch {
    status3d.value = 'webgl-error';
    return;
  }
  // A context taken away by the browser: the plan again, with the reason, and every resource freed.
  scene3d.onLost(() => {
    leave3d();
    status3d.value = 'webgl-error';
  });
  yaw = YAW[you.facing];
  pitch = 0;
  yawGoal = null;
  status3d.value = 'ready';
  readTheme();
  sizeScene();
  wake();
}

/** Back to the plan: everything three.js holds is freed, the loop draws the 2D canvas again. */
function leave3d(): void {
  entering++;
  // The plan shows the user turned where the camera looked, even after turning on the spot.
  if (scene3d !== null) you.facing = facingOfYaw(yaw);
  scene3d?.dispose();
  scene3d = null;
  drag = null;
  yawGoal = null;
  releaseKeys();
  status3d.value = 'off';
  wake();
}
watch(
  () => props.mode,
  (mode) => {
    if (mode === '3d') void enter3d();
    else leave3d();
  },
);

function setNameTag3(id: string, element: unknown): void {
  if (element instanceof HTMLElement) nameTags3.set(id, element);
  else nameTags3.delete(id);
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
  if (compact.value) {
    scale.value = compactScale(width, W);
    const sized = compactView(width, W, H, scale.value);
    viewW.value = sized.viewW;
    viewH.value = sized.viewH;
    void nextTick(sizeScene);
    wake();
    return;
  }
  scale.value = officeScale(width, props.map.width);
  viewW.value = Math.min(W * scale.value, width);
  viewH.value = Math.min(H * scale.value, Math.max(MIN_VIEW_HEIGHT, window.innerHeight - PAGE_CHROME));
  void nextTick(sizeScene);
  wake();
}

/** Area names over the map (lib/office/view.ts): textContent through Vue, positions at the scale. */
const tags = computed(() => {
  const board = boardTag(props.map);
  return board === null ? areaTags(props.map, props.snapshot) : [...areaTags(props.map, props.snapshot), board];
});
const labelClass: Record<Label, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };

/** Crossing 48rem: the window changes kind; on the phone it starts with the user in the middle. */
function onWide(): void {
  compact.value = wideQuery !== undefined && !wideQuery.matches;
  fit();
  void nextTick(() => {
    const box = viewport.value;
    if (box === null) return;
    box.scrollLeft = compact.value ? cameraOffset(box.clientWidth, W * scale.value, you.x * scale.value) : 0;
    wake();
  });
}

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
  onWide();
  wideQuery?.addEventListener('change', onWide);
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
  if (props.mode === '3d') void enter3d();
});
onBeforeUnmount(() => {
  stop();
  leave3d();
  resize?.disconnect();
  window.removeEventListener('resize', fit);
  window.removeEventListener('keyup', onKeyup);
  window.removeEventListener('blur', onWindowBlur);
  document.removeEventListener('visibilitychange', onVisibility);
  themeObserver?.disconnect();
  schemeQuery?.removeEventListener('change', readTheme);
  motionQuery?.removeEventListener('change', onMotion);
  wideQuery?.removeEventListener('change', onWide);
});

function focus(): void {
  (is3d.value ? canvas3d.value : canvas.value)?.focus({ preventScroll: false });
}
defineExpose({ goTo, focus });
</script>

<template>
  <div ref="wrap" class="min-w-0">
    <!-- overflow-clip, not hidden: focusing the canvas must never scroll the window on the map (D-229). -->
    <!-- On the phone (D-293) the window scrolls sideways under a finger instead: the page keeps its vertical scroll. -->
    <div
      v-show="!is3d"
      ref="viewport"
      class="relative mx-auto rounded-md border border-line-strong"
      :class="compact ? 'overflow-x-auto overflow-y-hidden overscroll-x-contain' : 'overflow-clip'"
      :style="{ width: `${String(viewW)}px`, height: `${String(viewH)}px` }"
    >
      <div ref="stage" class="absolute top-0 left-0" :style="{ width: `${String(W * scale)}px`, height: `${String(H * scale)}px` }">
        <canvas
          ref="canvas"
          :width="W"
          :height="H"
          tabindex="0"
          role="application"
          aria-roledescription="ufficio"
          aria-label="Ufficio: frecce o W A S D per camminare, E o Invio vicino a un agente per parlarci, vicino alla scrivania Decisioni per aprirle, vicino al cardwall per aprirlo, Esc per uscire"
          aria-describedby="office-help office-keys"
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
            class="absolute top-0 left-0 rounded border border-line-strong bg-surface/85 px-1.5 text-[12.5px] leading-[14px] whitespace-nowrap phone:px-1 phone:text-[11px] phone:leading-[13px]"
            :class="tag.muted ? 'text-muted' : 'text-ink'"
            :style="{ transform: `translate(${String(tag.x * scale)}px, ${String(tag.y * scale)}px) translateY(-100%)` }"
          >{{ tag.text }}<span v-if="tag.label !== null" class="ml-1 inline-flex items-center gap-1 text-[12px] font-semibold" :class="labelClass[tag.label]"><i class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[tag.label] }}</span></span>
          <span
            v-for="agent in snapshot.agents"
            :key="agent.id"
            :ref="(element) => { setNameTag(agent.id, element); }"
            class="absolute top-0 left-0 rounded border border-line-strong bg-surface/90 px-1.5 text-[12.5px] leading-[14px] whitespace-nowrap phone:px-1 phone:text-[11px] phone:leading-[13px]"
          />
          <span ref="youTag" class="absolute top-0 left-0 rounded border border-warn bg-surface/90 px-1.5 text-[12.5px] leading-[14px] whitespace-nowrap phone:px-1 phone:text-[11px] phone:leading-[13px]">Tu</span>
          <span ref="hint" hidden class="absolute top-0 left-0 rounded bg-accent px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-accent-ink">
            <kbd class="mr-1 rounded border border-current px-1 font-mono text-[12.5px]">E</kbd><span />
          </span>
        </div>
      </div>
    </div>
    <!-- The 3D view (D-230): the same office walked in first person; three.js only while it is on. -->
    <div v-if="is3d" ref="view3d" class="relative overflow-clip rounded-md border border-line-strong" :style="{ height: `${String(viewH)}px` }">
      <canvas
        ref="canvas3d"
        tabindex="0"
        role="application"
        aria-roledescription="ufficio in 3D"
        aria-label="Ufficio in 3D: freccia su e giù o W e S per camminare, A e D per un passo di lato, frecce sinistra e destra per girarti, trascina per guardarti intorno, E o Invio vicino a un agente per parlarci, Esc per uscire"
        aria-describedby="office-help office-keys"
        class="office-canvas block size-full cursor-grab touch-none select-none active:cursor-grabbing"
        @keydown="onKeydown"
        @focus="onFocusChange"
        @blur="onFocusChange"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
      />
      <div class="pointer-events-none absolute inset-0" aria-hidden="true">
        <span
          v-for="agent in snapshot.agents"
          :key="agent.id"
          :ref="(element) => { setNameTag3(agent.id, element); }"
          hidden
          class="tag3 absolute top-0 left-0 rounded border border-line-strong bg-surface/90 px-1.5 text-[12.5px] leading-[14px] whitespace-nowrap"
        />
        <span v-if="area3 !== null" class="absolute top-2 left-2 rounded border border-line-strong bg-surface/90 px-2 py-0.5 text-[13px] whitespace-nowrap text-ink">{{ area3.text }}<span v-if="area3.label !== null" class="ml-1.5 inline-flex items-center gap-1 text-[12px] font-semibold" :class="labelClass[area3.label]"><i class="size-1.5 rounded-full bg-current" aria-hidden="true" />{{ LABEL_TEXT[area3.label] }}</span></span>
        <span ref="hint3" hidden class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-accent px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-accent-ink">
          <kbd class="mr-1 rounded border border-current px-1 font-mono text-[12.5px]">E</kbd><span />
        </span>
        <span class="absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-ink/50" />
        <p v-if="status3d === 'loading'" class="absolute inset-0 grid place-items-center text-sm text-muted">Preparo la vista 3D…</p>
      </div>
    </div>
    <p v-if="mode === '3d' && status3d === 'webgl-error'" role="status" class="mt-2 text-[13px] text-muted">La vista 3D non è disponibile in questo browser (WebGL manca o si è fermato): resta la pianta.</p>
    <p v-if="mode === '3d' && status3d === 'load-error'" role="status" class="mt-2 text-[13px] text-muted">Non riesco a caricare la vista 3D: ricarica la pagina. Intanto resta la pianta.</p>
  </div>
</template>

<style scoped>
/* The ring of :focus-visible inside the canvas: the rounded frame around it would clip it outside. */
.office-canvas:focus-visible {
  outline-offset: -2px;
}
/* The agent within reach of E, in 3D: its tag underlined, as the 2D view underlines the figure. */
.tag3.near {
  border-color: var(--accent);
  text-decoration: underline;
}
</style>
