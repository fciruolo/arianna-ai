import { zoomAt, type GraphNodeData, type View } from './graph.ts';

/**
 * "Conoscenza" on the phone (D-293): the arithmetic of the gestures and the
 * list that stands in for the graph under 768 px, kept apart from the page so
 * it can be tested without a canvas.
 */

/** A point on the screen, in CSS pixels of the canvas. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * The view while two fingers pinch: the world point that was under the middle
 * of the fingers when they touched stays under their middle now, zoomed by how
 * much the fingers moved apart (clamped like the wheel's zoom).
 */
export function pinchView(start: View, startMid: ScreenPoint, startDistance: number, mid: ScreenPoint, distance: number): View {
  const factor = startDistance > 0 && distance > 0 ? distance / startDistance : 1;
  const zoomed = zoomAt(start, startMid.x, startMid.y, factor);
  return { ...zoomed, x: zoomed.x + mid.x - startMid.x, y: zoomed.y + mid.y - startMid.y };
}

/** How far from a node a press still hits it, in screen pixels: a finger is wider than a mouse. */
export function hitRadius(touch: boolean): number {
  return touch ? 22 : 4;
}

/**
 * The view that brings a world point to the middle of a horizontal band of
 * the canvas (between `top` and `bottom`), at zoom `k`: on the phone the
 * header covers the top and the note's sheet the bottom.
 */
export function centerInBand(width: number, top: number, bottom: number, wx: number, wy: number, k: number): View {
  const low = Math.min(top, bottom);
  const high = Math.max(top, bottom);
  return { k, x: width / 2 - wx * k, y: (low + high) / 2 - wy * k };
}

/** The phone's two ways to see the knowledge: the graph or a list of its nodes. */
export type PhoneView = 'graph' | 'list';

/** The stored choice of this browser; the graph for anything else. */
export function readPhoneView(stored: string | null): PhoneView {
  return stored === 'list' ? 'list' : 'graph';
}

type ListNode = Pick<GraphNodeData, 'title' | 'kind' | 'degree'>;

/** Pages before tags, the most linked first, then by title as Italian sorts it. */
function compareNodes(a: ListNode, b: ListNode): number {
  const tagA = a.kind === 'tag' ? 1 : 0;
  const tagB = b.kind === 'tag' ? 1 : 0;
  if (tagA !== tagB) return tagA - tagB;
  if (a.degree !== b.degree) return b.degree - a.degree;
  return a.title.localeCompare(b.title, 'it', { sensitivity: 'base' });
}

/** One row of the list: the node and its index in the graph. */
export interface ListRow<T> {
  index: number;
  node: T;
}

/**
 * The rows of the list view: the nodes that pass the filter (`matches`, one
 * flag per node as the graph computes it), sorted, at most `limit`, and how
 * many more matched beyond it.
 */
export function listRows<T extends ListNode>(nodes: readonly T[], matches: readonly boolean[], limit: number): { rows: ListRow<T>[]; more: number } {
  const rows: ListRow<T>[] = [];
  nodes.forEach((node, index) => {
    if (matches[index] === true) rows.push({ index, node });
  });
  rows.sort((a, b) => compareNodes(a.node, b.node) || a.index - b.index);
  const cap = Math.max(0, Math.floor(limit));
  return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) };
}

/** The neighbours of a node as rows, in the list's order; indices out of the graph are dropped. */
export function neighbourRows<T extends ListNode>(nodes: readonly T[], indices: Iterable<number>): ListRow<T>[] {
  const rows: ListRow<T>[] = [];
  for (const index of new Set(indices)) {
    const node = nodes[index];
    if (node !== undefined) rows.push({ index, node });
  }
  return rows.sort((a, b) => compareNodes(a.node, b.node) || a.index - b.index);
}
