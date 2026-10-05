import type { Label } from '../types.ts';
import { TILE, tileAt, type OfficeMap, type Point, type Room } from './map.ts';
import type { Actor } from './motion.ts';
import type { OfficeSnapshot } from './snapshot.ts';

/**
 * The rules of the office canvas (D-106) that need no canvas: when the loop
 * stops, which keys are steps, where the tags go, what a click on the
 * archive hits, when the photograph really changed. OfficeCanvas.vue calls
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
      return project === undefined ? tag(island.room, 'libera', null, true) : tag(island.room, project.project, project.label);
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

/** The photograph as a key: the page makes a new one every second, the canvas wakes only when it differs. */
export function snapshotKey(snapshot: OfficeSnapshot): string {
  return JSON.stringify(snapshot);
}
