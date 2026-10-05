/**
 * The office map (D-106, stage 1): a closed format of data, read from
 * `src/office/maps/*.json`. A map knows nothing of projects: it says where
 * the walls and the furniture are and names its anchors (entrance, private
 * island, island slots in order, the Decisioni desk, the pause corner, the
 * archive). The validator refuses an unknown key, a free string, a tile not
 * in the legend, a size or a file too big, an anchor out of place, and a
 * seat that cannot be reached from the entrance. It accepts only what the
 * engine draws: the seat of an island just above its desk, the archive seat
 * just below a cabinet.
 */

export const TILE = 16;
export const MAX_WIDTH = 40;
export const MAX_HEIGHT = 30;
export const MAX_BYTES = 16 * 1024;
export const MAX_ISLANDS = 12;
export const MIN_ISLANDS = 2;
export const MAX_PAUSE_SEATS = 6;
/** Solid furniture tiles (walls apart): a map is a room, not a warehouse. */
export const MAX_FURNITURE = 200;

/**
 * Distances of the engine, in pixels (D-106): the user walks to a floor tile
 * within WALK_REACH of an agent or the archive (DESK_WALK_REACH of the
 * Decisioni desk) and talks within TALK_REACH (DESK_TALK_REACH). The
 * validator refuses a map where one of these points has no such tile.
 */
export const WALK_REACH = 22;
export const DESK_WALK_REACH = 26;
export const TALK_REACH = 26;
export const DESK_TALK_REACH = 30;
/** Closer than this a tile is under the thing itself: not a place to stand next to it. */
export const MIN_REACH = 9;

export const TILE_KINDS = ['wall', 'window', 'shelf', 'floor', 'desk', 'counter', 'sofa', 'coffee', 'plant', 'cabinet'] as const;
export type TileKind = (typeof TILE_KINDS)[number];

const WALLS: ReadonlySet<TileKind> = new Set(['wall', 'window', 'shelf']);

export type Point = readonly [number, number];
/** Columns and rows, both inclusive: [c0, r0, c1, r1]. */
export type Room = readonly [number, number, number, number];
/** A desk: first column, row, width in tiles. */
export type Desk = readonly [number, number, number];

export interface Island {
  room: Room;
  desk: Desk;
  /** Where the agent sits: a floor tile next to the desk. */
  seat: Point;
}

export interface OfficeMap {
  format: 1;
  id: string;
  width: number;
  height: number;
  /** Row-major tile kinds. */
  tiles: readonly TileKind[];
  anchors: {
    entrance: Point;
    private: Island;
    islands: readonly Island[];
    decisions: { room: Room; desk: Desk };
    pause: { room: Room; seats: readonly Point[] };
    archive: { room: Room; seat: Point };
  };
}

export type MapResult = { ok: true; map: OfficeMap } | { ok: false; reason: string };

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function tileAt(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, c: number, r: number): TileKind | undefined {
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c >= map.width || r >= map.height) return undefined;
  return map.tiles[r * map.width + c];
}

export function isWalkable(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, c: number, r: number): boolean {
  return tileAt(map, c, r) === 'floor';
}

export function isWall(kind: TileKind | undefined): boolean {
  return kind !== undefined && WALLS.has(kind);
}

const NEIGHBOURS: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Every floor tile reached from `start` by steps of one tile. */
export function reachable(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, start: Point): Set<number> {
  const seen = new Set<number>();
  if (!isWalkable(map, start[0], start[1])) return seen;
  const queue: Point[] = [start];
  seen.add(start[1] * map.width + start[0]);
  for (let index = 0; index < queue.length; index++) {
    const [c, r] = queue[index] ?? [0, 0];
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      const key = nr * map.width + nc;
      if (!isWalkable(map, nc, nr) || seen.has(key)) continue;
      seen.add(key);
      queue.push([nc, nr]);
    }
  }
  return seen;
}

/** The tiles of a desk. */
export function deskTiles(desk: Desk): Point[] {
  return Array.from({ length: desk[2] }, (_, index): Point => [desk[0] + index, desk[1]]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses a key outside `allowed` and a missing one. */
function closed(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MapError(`«${where}» non è un oggetto`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new MapError(`chiave sconosciuta «${key}» in «${where}»`);
  for (const key of allowed) if (!(key in value)) throw new MapError(`manca «${key}» in «${where}»`);
  return value;
}

class MapError extends Error {}

function ints(value: unknown, length: number, where: string): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => Number.isInteger(item))) {
    throw new MapError(`«${where}» deve essere una lista di ${String(length)} numeri interi`);
  }
  return value as number[];
}

function point(value: unknown, where: string): Point {
  const [c = 0, r = 0] = ints(value, 2, where);
  return [c, r];
}

function room(value: unknown, where: string, width: number, height: number): Room {
  const [c0 = 0, r0 = 0, c1 = 0, r1 = 0] = ints(value, 4, where);
  if (c0 < 0 || r0 < 0 || c1 >= width || r1 >= height || c0 > c1 || r0 > r1) throw new MapError(`«${where}» esce dalla mappa`);
  return [c0, r0, c1, r1];
}

function desk(value: unknown, where: string): Desk {
  const [c = 0, r = 0, w = 0] = ints(value, 3, where);
  if (w < 1 || w > 8) throw new MapError(`«${where}» deve essere larga da 1 a 8 tessere`);
  return [c, r, w];
}

function island(value: unknown, where: string, width: number, height: number): Island {
  const raw = closed(value, ['room', 'desk', 'seat'], where);
  return { room: room(raw.room, `${where}.room`, width, height), desk: desk(raw.desk, `${where}.desk`), seat: point(raw.seat, `${where}.seat`) };
}

/** Parses a map file and checks every rule; never throws. */
export function parseMapText(text: string): MapResult {
  if (new TextEncoder().encode(text).length > MAX_BYTES) return { ok: false, reason: `il file supera ${String(MAX_BYTES / 1024)} KB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'il file non è JSON valido' };
  }
  return parseMap(raw);
}

export function parseMap(raw: unknown): MapResult {
  try {
    return { ok: true, map: check(raw) };
  } catch (error) {
    if (error instanceof MapError) return { ok: false, reason: error.message };
    throw error;
  }
}

function check(raw: unknown): OfficeMap {
  const top = closed(raw, ['format', 'id', 'size', 'rows', 'legend', 'anchors'], 'mappa');
  if (top.format !== 1) throw new MapError('formato sconosciuto: serve «format»: 1');
  if (typeof top.id !== 'string' || !ID.test(top.id)) throw new MapError('«id» deve avere solo minuscole, cifre e trattini');
  const [width = 0, height = 0] = ints(top.size, 2, 'size');
  if (width < 4 || height < 4 || width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new MapError(`dimensioni fuori dai limiti (da 4×4 a ${String(MAX_WIDTH)}×${String(MAX_HEIGHT)} tessere)`);
  }

  if (!isRecord(top.legend)) throw new MapError('«legend» non è un oggetto');
  const legend = new Map<string, TileKind>();
  for (const [letter, kind] of Object.entries(top.legend)) {
    if (Array.from(letter).length !== 1) throw new MapError(`la chiave «${letter}» di «legend» deve essere un solo carattere`);
    const known = TILE_KINDS.find((item) => item === kind);
    if (known === undefined) throw new MapError(`tessera sconosciuta per «${letter}»`);
    legend.set(letter, known);
  }

  if (!Array.isArray(top.rows) || top.rows.length !== height) throw new MapError(`«rows» deve avere ${String(height)} righe`);
  const tiles: TileKind[] = [];
  top.rows.forEach((line: unknown, r) => {
    if (typeof line !== 'string' || Array.from(line).length !== width) throw new MapError(`la riga ${String(r)} deve avere ${String(width)} caratteri`);
    for (const letter of line) {
      const kind = legend.get(letter);
      if (kind === undefined) throw new MapError(`il carattere «${letter}» della riga ${String(r)} non è in «legend»`);
      tiles.push(kind);
    }
  });
  const furniture = tiles.filter((kind) => kind !== 'floor' && !isWall(kind)).length;
  if (furniture > MAX_FURNITURE) throw new MapError(`troppi arredi (${String(furniture)}, al massimo ${String(MAX_FURNITURE)})`);

  const a = closed(top.anchors, ['entrance', 'private', 'islands', 'decisions', 'pause', 'archive'], 'anchors');
  if (!Array.isArray(a.islands)) throw new MapError('«islands» deve essere una lista');
  if (a.islands.length < MIN_ISLANDS || a.islands.length > MAX_ISLANDS) {
    throw new MapError(`servono da ${String(MIN_ISLANDS)} a ${String(MAX_ISLANDS)} isole`);
  }
  const decisionsRaw = closed(a.decisions, ['room', 'desk'], 'decisions');
  const pauseRaw = closed(a.pause, ['room', 'seats'], 'pause');
  const archiveRaw = closed(a.archive, ['room', 'seat'], 'archive');
  if (!Array.isArray(pauseRaw.seats) || pauseRaw.seats.length < 1 || pauseRaw.seats.length > MAX_PAUSE_SEATS) {
    throw new MapError(`«pause.seats» deve avere da 1 a ${String(MAX_PAUSE_SEATS)} posti`);
  }
  const map: OfficeMap = {
    format: 1,
    id: top.id,
    width,
    height,
    tiles,
    anchors: {
      entrance: point(a.entrance, 'entrance'),
      private: island(a.private, 'private', width, height),
      islands: a.islands.map((item: unknown, index) => island(item, `islands[${String(index)}]`, width, height)),
      decisions: { room: room(decisionsRaw.room, 'decisions.room', width, height), desk: desk(decisionsRaw.desk, 'decisions.desk') },
      pause: { room: room(pauseRaw.room, 'pause.room', width, height), seats: pauseRaw.seats.map((item: unknown, index) => point(item, `pause.seats[${String(index)}]`)) },
      archive: { room: room(archiveRaw.room, 'archive.room', width, height), seat: point(archiveRaw.seat, 'archive.seat') },
    },
  };
  checkPlaces(map);
  return map;
}

/** Desks on furniture, seats on the floor next to their furniture, each seat reached from the entrance, no seat shared. */
function checkPlaces(map: OfficeMap): void {
  const { anchors } = map;
  if (!isWalkable(map, ...anchors.entrance)) throw new MapError('l\'ingresso deve essere su una tessera calpestabile');
  const from = reachable(map, anchors.entrance);
  const taken = new Set<number>();
  const seat = (where: string, at: Point, next: (c: number, r: number) => boolean): void => {
    if (!isWalkable(map, ...at)) throw new MapError(`il posto «${where}» deve essere su una tessera calpestabile`);
    if (!NEIGHBOURS.some(([dc, dr]) => next(at[0] + dc, at[1] + dr))) throw new MapError(`il posto «${where}» non è accanto al suo arredo`);
    const key = at[1] * map.width + at[0];
    if (taken.has(key)) throw new MapError(`il posto «${where}» è già di un altro`);
    taken.add(key);
    if (!from.has(key)) throw new MapError(`il posto «${where}» non si raggiunge dall'ingresso`);
  };
  const furnished = (where: string, d: Desk, kind: TileKind): void => {
    for (const [c, r] of deskTiles(d)) if (tileAt(map, c, r) !== kind) throw new MapError(`«${where}» non è su tessere «${kind}»`);
  };
  const islandSeat = (where: string, item: Island): void => {
    furnished(`${where}.desk`, item.desk, 'desk');
    seat(where, item.seat, (c, r) => deskTiles(item.desk).some((tile) => tile[0] === c && tile[1] === r));
    // The engine draws the chair above the desk and the agent behind it.
    const [sc, sr] = item.seat;
    if (!deskTiles(item.desk).some(([c, r]) => c === sc && r === sr + 1)) throw new MapError(`il posto «${where}» deve stare subito sopra la sua scrivania`);
  };
  islandSeat('private', anchors.private);
  anchors.islands.forEach((item, index) => {
    islandSeat(`islands[${String(index)}]`, item);
  });
  furnished('decisions.desk', anchors.decisions.desk, 'counter');
  anchors.pause.seats.forEach((at, index) => {
    seat(`pause.seats[${String(index)}]`, at, (c, r) => tileAt(map, c, r) === 'sofa' || tileAt(map, c, r) === 'coffee');
  });
  seat('archive', anchors.archive.seat, (c, r) => tileAt(map, c, r) === 'cabinet');
  // The engine walks the user to the cabinet above the archive seat.
  if (tileAt(map, anchors.archive.seat[0], anchors.archive.seat[1] - 1) !== 'cabinet') throw new MapError('il posto «archive» deve stare subito sotto un armadio');

  // What the engine walks to: some tile within its reach, reached from the entrance.
  const withinReach = (where: string, at: Point, reach: number): void => {
    if (!tilesNear(map, at[0], at[1], reach).some(([c, r]) => from.has(r * map.width + c))) throw new MapError(`${where} non si raggiunge dall'ingresso`);
  };
  withinReach('la scrivania Decisioni', decisionsPoint(map), DESK_WALK_REACH);
  withinReach('l\'agente della Privata', seatPoint(map, anchors.private.seat), WALK_REACH);
  anchors.islands.forEach((item, index) => {
    withinReach(`l'agente di «islands[${String(index)}]»`, seatPoint(map, item.seat), WALK_REACH);
  });
  withinReach('l\'armadio dell\'Archivio', archivePoint(map), WALK_REACH);
}

/** The floor tiles from which something at pixel (x, y) is within `reach` pixels (and not on top of it). */
export function tilesNear(grid: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, x: number, y: number, reach: number): Point[] {
  const found: Point[] = [];
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      if (!isWalkable(grid, c, r)) continue;
      const d = Math.hypot(c * TILE + 8 - x, r * TILE + 11 - y);
      if (d <= reach && d >= MIN_REACH) found.push([c, r]);
    }
  }
  return found;
}

/** The point of the Decisioni desk the user walks to and the bell is on. */
export function decisionsPoint(map: Pick<OfficeMap, 'anchors'>): Point {
  const counter = map.anchors.decisions.desk;
  return [((counter[0] * 2 + counter[2]) / 2) * TILE, counter[1] * TILE + 8];
}

/** The archive's point: the cabinet above its seat. */
export function archivePoint(map: Pick<OfficeMap, 'anchors'>): Point {
  const [c, r] = map.anchors.archive.seat;
  return [c * TILE + 8, (r - 1) * TILE + 8];
}

/** The archive's cabinet: the cabinet tiles joined to the one above its seat (in `base` two wide). */
export function archiveTiles(map: OfficeMap): Point[] {
  const [sc, sr] = map.anchors.archive.seat;
  if (tileAt(map, sc, sr - 1) !== 'cabinet') return [];
  const seen = new Set<number>([(sr - 1) * map.width + sc]);
  const queue: Point[] = [[sc, sr - 1]];
  for (let index = 0; index < queue.length; index++) {
    const [c, r] = queue[index] ?? [0, 0];
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      const key = nr * map.width + nc;
      if (tileAt(map, nc, nr) !== 'cabinet' || seen.has(key)) continue;
      seen.add(key);
      queue.push([nc, nr]);
    }
  }
  return queue;
}

/** Where a seated agent is drawn, in pixels: feet behind a desk below the seat, on a sofa above it, or in the middle of the tile. */
export function seatPoint(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, at: Point): Point {
  const [c, r] = at;
  if (tileAt(map, c, r + 1) === 'desk') return [c * TILE + 8, (r + 1) * TILE + 2];
  if (tileAt(map, c, r - 1) === 'sofa') return [c * TILE + 8, (r - 1) * TILE + 14];
  return tileCenter(at);
}

/** The point of a tile where a walker stands. */
export function tileCenter(at: Point): Point {
  return [at[0] * TILE + 8, at[1] * TILE + 11];
}

/** The direction a seated agent faces: down behind a desk or on a sofa, up towards furniture above. */
export function seatFace(map: Pick<OfficeMap, 'width' | 'height' | 'tiles'>, at: Point): 'down' | 'up' {
  const above = tileAt(map, at[0], at[1] - 1);
  if (tileAt(map, at[0], at[1] + 1) === 'desk' || above === 'sofa') return 'down';
  return above !== undefined && above !== 'floor' && !isWall(above) ? 'up' : 'down';
}
