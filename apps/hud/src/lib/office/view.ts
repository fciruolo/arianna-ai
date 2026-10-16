import type { Label } from '../types.ts';
import { boardTiles, TILE, tileAt, type OfficeMap, type Point, type Room } from './map.ts';
import type { Actor } from './motion.ts';
import { UNKNOWN_AGENT, type OfficeSnapshot } from './snapshot.ts';

/**
 * The rules of the office canvas (D-106) that need no canvas: when the loop
 * stops, which keys are steps, where the tags go, what a click on the
 * archive or the cardwall hits, what is within reach and its hint, when the
 * photograph really changed. OfficeCanvas.vue calls
 * them; the tests check them without a browser.
 */

/** What still moves on the map. */
export interface Movement {
  /** Arrow or WASD keys held. */
  keys: number;
  /** Points left on the user's walk. */
  userPath: number;
  agentsWalking: boolean;
}

/** Every frame without reduced motion; with it, only while something moves (still frames otherwise). */
export function keepDrawing(reduceMotion: boolean, movement: Movement): boolean {
  return !reduceMotion || movement.keys > 0 || movement.userPath > 0 || movement.agentsWalking;
}

/** A key with Cmd, Ctrl or Alt is a shortcut of the browser or the system (Cmd+R, Alt+←), never a step. */
export function isShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * Where the top of an agent's name tag goes, in pixels of the map: never
 * over furniture or a face. Seated behind a desk, on the floor in front of
 * the desk; otherwise under the feet.
 */
export function nameTagTop(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, actor: Pick<Actor, 'seat' | 'walking' | 'y'>): number {
  const [c, r] = actor.seat;
  if (!actor.walking && tileAt(map, c, r + 1) === 'desk') return (r + 2) * TILE + 1;
  return actor.y + 2;
}

export interface AreaTag {
  /** Left edge, in pixels of the map. */
  x: number;
  /** Bottom edge, in pixels of the map: the tag sits above it. */
  y: number;
  text: string;
  label: Label | null;
  muted: boolean;
}

/** Projects behind the archive: the named ones and those only counted. */
/** The name on an island: the project's, or «GOD» for the clones of Arianna's own code (D-127). */
export function islandName(project: string): string {
  return project === 'arianna' ? 'GOD' : project;
}

export function archiveCount(snapshot: Pick<OfficeSnapshot, 'archived' | 'unnamed'>): number {
  return snapshot.archived.length + snapshot.unnamed;
}

/**
 * The names of the areas, in the bottom-left corner of each: on the floor,
 * never on the furniture along the top or on who sits there.
 */
export function areaTags(map: Pick<OfficeMap, 'anchors'>, snapshot: Pick<OfficeSnapshot, 'islands' | 'archived' | 'unnamed'>): AreaTag[] {
  const { anchors } = map;
  const tag = (room: Room, text: string, label: Label | null, muted = false): AreaTag => ({ x: room[0] * TILE + 3, y: (room[3] + 1) * TILE - 1, text, label, muted });
  const archived = archiveCount(snapshot);
  return [
    tag(anchors.private.room, 'Privata', 'L2'),
    ...anchors.islands.map((island, slot) => {
      const project = snapshot.islands.find((item) => item.slot === slot);
      return project === undefined ? tag(island.room, 'libera', null, true) : tag(island.room, islandName(project.project), project.label);
    }),
    tag(anchors.pause.room, 'Pausa', null),
    tag(anchors.decisions.room, 'Decisioni', null),
    tag(anchors.archive.room, archived > 0 ? `Archivio · ${String(archived)}` : 'Archivio', null),
  ];
}

/** Pixels a cabinet is drawn above its tile. */
const CABINET_TOP = 10;

/** A point of the map on the archive's cabinet: any of its tiles, or the part drawn above them. */
export function hitsArchive(tiles: readonly Point[], x: number, y: number): boolean {
  return tiles.some(([c, r]) => x >= c * TILE && x < (c + 1) * TILE && y >= r * TILE - CABINET_TOP && y < (r + 1) * TILE);
}

/** The cardwall's name (D-165): on the wall above it, never on the floor where the user stands; null without a cardwall. */
export function boardTag(map: Pick<OfficeMap, 'width' | 'tiles'>): AreaTag | null {
  const first = boardTiles(map)[0];
  if (first === undefined) return null;
  return { x: first[0] * TILE + 1, y: first[1] * TILE, text: 'Cardwall', label: null, muted: false };
}

/** A point of the map on the cardwall: any of its tiles on the wall. */
export function hitsBoard(tiles: readonly Point[], x: number, y: number): boolean {
  return tiles.some(([c, r]) => x >= c * TILE && x < (c + 1) * TILE && y >= r * TILE && y < (r + 1) * TILE);
}

/** Something the user can open: an agent, the Decisioni desk, the archive, the cardwall (D-165). */
export interface Target {
  id: string;
  point: Point;
  /** Closer than this (pixels) it is within reach. */
  reach: number;
}

/** The target within reach of the user, the closest one; null with none. On a tie the first in the list wins. */
export function closestTarget(at: Point, targets: readonly Target[]): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const d = Math.hypot(target.point[0] - at[0], target.point[1] - at[1]);
    if (d < target.reach && d < distance) {
      best = target.id;
      distance = d;
    }
  }
  return best;
}

/** The hint over the user near a target: counts and fixed names, never a title. */
export function hintText(target: string, snapshot: Pick<OfficeSnapshot, 'agents' | 'decisions' | 'archived' | 'unnamed'>): string {
  if (target === 'decisions') {
    const total = snapshot.decisions.total;
    return total > 0 ? `Decisioni in attesa (${String(total)})` : 'Nessuna decisione in attesa';
  }
  if (target === 'archive') return `Archivio (${String(archiveCount(snapshot))})`;
  if (target === 'cardwall') return 'Apri il cardwall';
  const name = snapshot.agents.find((agent) => agent.id === target)?.name ?? UNKNOWN_AGENT;
  return `Parla con ${name}`;
}

/**
 * The plan follows the user (D-229): the scale shows about VIEW_TILES tiles
 * across the room the page gives (between 2 and 4, a whole number for crisp
 * pixels); the window on the map is centred on the user and stops at its edges.
 */
export const VIEW_TILES = 22;

export function officeScale(width: number, mapTiles: number): number {
  const tiles = Math.max(1, Math.min(mapTiles, VIEW_TILES));
  return Math.max(2, Math.min(4, Math.floor(width / (tiles * TILE))));
}

/** The offset of the window on one axis: 0 when the map fits, else centred on `at` and kept inside the map. */
export function cameraOffset(view: number, world: number, at: number): number {
  if (world <= view) return 0;
  return Math.round(Math.max(0, Math.min(world - view, at - view / 2)));
}

/** The photograph as a key: the page makes a new one every second, the canvas wakes only when it differs. */
export function snapshotKey(snapshot: OfficeSnapshot): string {
  return JSON.stringify(snapshot);
}
