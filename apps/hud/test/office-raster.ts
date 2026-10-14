// A canvas of pixels for the tests of the office (D-216): only what drawOffice
// uses (fillStyle and fillRect with #rrggbb(aa) blended, save, restore,
// translate, scale, globalAlpha, drawImage ignored), so a drawing can be
// compared and written as a PNG to look at it.
import { drawOffice, type Colors, type Scene } from '../src/lib/office/draw.ts';
import { TILE } from '../src/lib/office/map.ts';

export interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function parse(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (hex === null) throw new Error(`not a colour of the office: ${color}`);
  const value = Number.parseInt(hex[1] ?? '000000', 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, hex[2] === undefined ? 255 : Number.parseInt(hex[2], 16)];
}

export function rasterize(scene: Scene, draw: typeof drawOffice = drawOffice): Raster {
  const width = scene.map.width * TILE;
  const height = scene.map.height * TILE;
  const rgba = new Uint8Array(width * height * 4);
  let fill = '#000000';
  let alpha = 1;
  let offset: [number, number] = [0, 0];
  const stack: { alpha: number; offset: [number, number] }[] = [];
  const ctx = {
    set fillStyle(value: string) {
      fill = value;
    },
    get fillStyle(): string {
      return fill;
    },
    set globalAlpha(value: number) {
      alpha = value;
    },
    get globalAlpha(): number {
      return alpha;
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      const [r, g, b, a] = parse(fill);
      const opacity = (a / 255) * alpha;
      const x0 = Math.max(0, Math.round(x + offset[0]));
      const y0 = Math.max(0, Math.round(y + offset[1]));
      const x1 = Math.min(width, Math.round(x + offset[0] + w));
      const y1 = Math.min(height, Math.round(y + offset[1] + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const at = (py * width + px) * 4;
          rgba[at] = Math.round(r * opacity + (rgba[at] ?? 0) * (1 - opacity));
          rgba[at + 1] = Math.round(g * opacity + (rgba[at + 1] ?? 0) * (1 - opacity));
          rgba[at + 2] = Math.round(b * opacity + (rgba[at + 2] ?? 0) * (1 - opacity));
          rgba[at + 3] = 255;
        }
      }
    },
    save(): void {
      stack.push({ alpha, offset: [...offset] });
    },
    restore(): void {
      const last = stack.pop();
      if (last !== undefined) ({ alpha, offset } = last);
    },
    translate(x: number, y: number): void {
      offset = [offset[0] + x, offset[1] + y];
    },
    scale(): void {
      // Only mirrored figures scale, and figures have no sheet here.
    },
    drawImage(): void {
      // No sheets in the tests: the figures are their shadows.
    },
  };
  draw(ctx as unknown as CanvasRenderingContext2D, scene);
  return { width, height, rgba };
}

/** The colours of style.css for the office and the theme tokens, from the text of the stylesheet. */
export function colorsOf(css: string, mode: 'dark' | 'light', names: readonly string[], themeNames: readonly string[]): Colors {
  // The dark tokens are the first block of :root; the light ones the block under [data-theme="light"].
  const light = css.slice(css.indexOf(':root[data-theme="light"]'));
  const source = mode === 'dark' ? css : light;
  const colors: Record<string, string> = {};
  for (const name of names) colors[name] = new RegExp(`--office-${name}:\\s*(#[0-9a-fA-F]{6,8})`).exec(source)?.[1] ?? '#808080';
  for (const name of themeNames) colors[name] = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6,8})`).exec(source)?.[1] ?? '#808080';
  return colors as Colors;
}
