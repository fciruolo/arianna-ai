import {
  BoxGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { ColorName, Colors } from './draw.ts';
import { EYE_HEIGHT, pickedTile, SPRITE_HEIGHT, SPRITE_WIDTH, type Ink, type World } from './world3d.ts';

/**
 * The 3D view of the office with three.js (D-230), loaded only by the page
 * Ufficio with a dynamic import, so the rest of the chat never downloads it.
 * Nothing here reaches the network: the boxes come from lib/office/world3d.ts,
 * the colours from the theme's tokens, the characters from the sheets the 2D
 * view already loaded. No module of three's `examples` (loaders, controls,
 * environments): only the core classes. The page calls `frame` with the state
 * of the 2D engine and `dispose` when it leaves the 3D view.
 */

/** A character to draw: where its feet are, the frame of its sheet, greyed when paused. */
export interface SpriteState {
  id: string;
  x: number;
  z: number;
  sheet: HTMLImageElement | HTMLCanvasElement | null;
  column: number;
  row: number;
  mirror: boolean;
  dim: boolean;
}

export interface FrameState {
  /** The user: eyes at EYE_HEIGHT over this point of the floor. */
  eye: { x: number; z: number };
  yaw: number;
  pitch: number;
  sprites: readonly SpriteState[];
  /** Seats whose screen is on ("c,r"). */
  screens: ReadonlySet<string>;
  decisionsWaiting: boolean;
  now: number;
  reduceMotion: boolean;
}

/** What a click or a tap hit: an agent by id, or a point of the world's floor (x, z) under a thing or the floor. */
export type Pick3 = { kind: 'agent'; id: string } | { kind: 'point'; x: number; z: number } | null;

export interface OfficeScene {
  /** Called once if the browser takes the WebGL context away (a GPU reset, too many contexts). */
  onLost(callback: () => void): void;
  setColors(colors: Colors): void;
  resize(width: number, height: number): void;
  frame(state: FrameState): void;
  /** Projects a point of the world to CSS pixels of the canvas; null behind the camera. */
  project(x: number, y: number, z: number): { left: number; top: number } | null;
  pick(left: number, top: number): Pick3;
  dispose(): void;
}

const FRAME_W = 16;
const FRAME_H = 32;

/** A colour of the theme for three.js: a CSS colour, its alpha dropped (`#rrggbbaa` included). */
function colorOf(value: string): Color {
  const hex = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(value.trim());
  const color = new Color();
  try {
    color.setStyle(hex === null ? value : `#${hex[1] ?? '808080'}`);
  } catch {
    color.set(0x808080);
  }
  return color;
}

/** Throws when the browser has no WebGL: the page then stays on the 2D view and says why. */
export function createOfficeScene(canvas: HTMLCanvasElement, world: World): OfficeScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 1, 0.05, 80);
  camera.rotation.order = 'YXZ';

  /*
   * A simple light, the same in light and dark: the colours of the theme as
   * they are (as the 2D view draws them), each face of a box a little darker
   * by the way it turns (tops full, faces north and south a little less, east
   * and west less again). With real lights the dark theme's walls vanished
   * into its background.
   */
  // The last colours of the theme: a material made later (a screen turned on) starts with them, never white.
  let palette: Colors | null = null;
  const materials = new Map<ColorName, MeshBasicMaterial>();
  const material = (name: ColorName): MeshBasicMaterial => {
    let known = materials.get(name);
    if (known === undefined) {
      known = new MeshBasicMaterial({ vertexColors: true });
      if (palette !== null) known.color.copy(colorOf(palette[name]));
      materials.set(name, known);
    }
    return known;
  };
  // The fixed colours of the decorations of a feast (D-252): set once, the theme never changes them.
  const inks = new Map<Ink, MeshBasicMaterial>();
  const inkMaterial = (value: Ink): MeshBasicMaterial => {
    let known = inks.get(value);
    if (known === undefined) {
      known = new MeshBasicMaterial({ vertexColors: true, color: colorOf(value) });
      inks.set(value, known);
    }
    return known;
  };
  const isInk = (value: ColorName | Ink): value is Ink => value.startsWith('#');
  const floorMaterials = new Map<ColorName, MeshBasicMaterial>();
  const floorMaterial = (name: ColorName): MeshBasicMaterial => {
    let known = floorMaterials.get(name);
    if (known === undefined) {
      known = new MeshBasicMaterial();
      floorMaterials.set(name, known);
    }
    return known;
  };
  const cube = new BoxGeometry(1, 1, 1);
  // BoxGeometry's faces in order +x, -x, +y, -y, +z, -z, four corners each.
  const SHADE = [0.78, 0.78, 1, 0.6, 0.9, 0.9];
  cube.setAttribute('color', new Float32BufferAttribute(SHADE.flatMap((shade) => Array.from({ length: 12 }, () => shade)), 3));
  const plane = new PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2);
  const solid = new Group();
  scene.add(solid);
  const matrix = new Matrix4();
  const at = new Object3D();

  // The floor: one instanced mesh per colour (Base is checked, as in 2D).
  for (const alt of [false, true]) {
    const tiles = world.floors.filter((tile) => tile.alt === alt);
    if (tiles.length === 0) continue;
    const mesh = new InstancedMesh(plane, floorMaterial(alt ? 'floor-alt' : 'floor'), tiles.length);
    tiles.forEach((tile, index) => {
      at.position.set(tile.c + 0.5, 0, tile.r + 0.5);
      at.scale.set(1, 1, 1);
      at.updateMatrix();
      mesh.setMatrixAt(index, at.matrix);
    });
    mesh.userData.floor = true;
    solid.add(mesh);
  }
  // Walls, lintels and furniture: one instanced mesh of unit boxes per colour.
  const byColor = new Map<ColorName | Ink, World['blocks']>();
  for (const block of world.blocks) byColor.set(block.color, [...(byColor.get(block.color) ?? []), block]);
  for (const [name, blocks] of byColor) {
    const mesh = new InstancedMesh(cube, isInk(name) ? inkMaterial(name) : material(name), blocks.length);
    blocks.forEach((block, index) => {
      matrix.makeScale(block.w, block.h, block.d).setPosition(block.x, block.y + block.h / 2, block.z);
      mesh.setMatrixAt(index, matrix);
    });
    solid.add(mesh);
  }
  // The screens of the desks: on while someone works there, as in 2D.
  const screens = world.monitors.map((monitor) => {
    const body = new Mesh(cube, material('monitor'));
    body.scale.set(0.36, 0.24, 0.05);
    body.position.set(monitor.x, 0.48 + 0.16, monitor.z);
    const face = new Mesh(cube, material('screen-off'));
    face.scale.set(0.3, 0.18, 0.02);
    face.position.set(monitor.x, 0.48 + 0.16, monitor.z + monitor.facing * 0.03);
    solid.add(body, face);
    return { key: monitor.key, face };
  });
  // The «!» over the Decisioni desk while something waits for the user.
  const bang = new Group();
  const bangBar = new Mesh(cube, material('warn'));
  bangBar.scale.set(0.08, 0.26, 0.08);
  bangBar.position.y = 0.2;
  const bangDot = new Mesh(cube, material('warn'));
  bangDot.scale.set(0.08, 0.08, 0.08);
  bang.add(bangBar, bangDot);
  bang.position.set(world.bell.x, world.bell.y, world.bell.z);
  scene.add(bang);

  // The characters: one sprite each, its frame copied from the sheet the 2D view loaded onto a small canvas of its own.
  interface Figure3 {
    sprite: Sprite;
    canvas: HTMLCanvasElement;
    texture: CanvasTexture;
    /** The frame on the canvas: sheet, column, row, mirror; redrawn only when it changes. */
    drawn: string;
    source: HTMLImageElement | HTMLCanvasElement | null;
  }
  const figures = new Map<string, Figure3>();
  const figure = (state: SpriteState): Figure3 => {
    let known = figures.get(state.id);
    if (known === undefined) {
      const canvas2 = document.createElement('canvas');
      canvas2.width = FRAME_W;
      canvas2.height = FRAME_H;
      const texture = new CanvasTexture(canvas2);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = SRGBColorSpace;
      const sprite = new Sprite(new SpriteMaterial({ map: texture, alphaTest: 0.5 }));
      sprite.center.set(0.5, 0);
      sprite.scale.set(SPRITE_WIDTH, SPRITE_HEIGHT, 1);
      sprite.userData.agent = state.id;
      scene.add(sprite);
      known = { sprite, canvas: canvas2, texture, drawn: '', source: null };
      figures.set(state.id, known);
    }
    const key = `${String(state.column)},${String(state.row)},${String(state.mirror)}`;
    if (state.sheet !== null && (known.source !== state.sheet || known.drawn !== key)) {
      const context = known.canvas.getContext('2d');
      if (context !== null) {
        context.clearRect(0, 0, FRAME_W, FRAME_H);
        context.imageSmoothingEnabled = false;
        context.save();
        if (state.mirror) {
          context.translate(FRAME_W, 0);
          context.scale(-1, 1);
        }
        context.drawImage(state.sheet, state.column * FRAME_W, state.row * FRAME_H, FRAME_W, FRAME_H, 0, 0, FRAME_W, FRAME_H);
        context.restore();
        known.texture.needsUpdate = true;
      }
      known.source = state.sheet;
      known.drawn = key;
    }
    return known;
  };
  const dimColor = new Color(0.55, 0.55, 0.55);
  const fullColor = new Color(1, 1, 1);

  let width = 1;
  let height = 1;

  let lost: (() => void) | null = null;
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    lost?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  return {
    onLost(callback) {
      lost = callback;
    },
    setColors(colors) {
      palette = colors;
      for (const [name, item] of materials) item.color.copy(colorOf(colors[name]));
      for (const [name, item] of floorMaterials) item.color.copy(colorOf(colors[name]));
      // Above the walls the colour of their tops, as the 2D view draws them: a ceiling in shadow, never the page itself.
      scene.background = colorOf(colors['wall-top']);
    },
    resize(w, h) {
      width = Math.max(1, Math.round(w));
      height = Math.max(1, Math.round(h));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    frame(state) {
      camera.position.set(state.eye.x, EYE_HEIGHT, state.eye.z);
      camera.rotation.set(state.pitch, state.yaw, 0);
      camera.updateMatrixWorld();
      for (const screen of screens) screen.face.material = material(state.screens.has(screen.key) ? 'screen' : 'screen-off');
      bang.visible = state.decisionsWaiting;
      bang.position.y = world.bell.y + (state.reduceMotion ? 0 : Math.sin(state.now / 300) * 0.04);
      const present = new Set<string>();
      for (const item of state.sprites) {
        present.add(item.id);
        const { sprite, source } = figure(item);
        sprite.position.set(item.x, 0, item.z);
        sprite.visible = source !== null;
        sprite.material.color.copy(item.dim ? dimColor : fullColor);
      }
      for (const [id, item] of figures) {
        if (present.has(id)) continue;
        scene.remove(item.sprite);
        item.texture.dispose();
        item.sprite.material.dispose();
        figures.delete(id);
      }
      renderer.render(scene, camera);
    },
    project(x, y, z) {
      const point = new Vector3(x, y, z).project(camera);
      if (point.z > 1 || point.z < -1) return null;
      return { left: ((point.x + 1) / 2) * width, top: ((1 - point.y) / 2) * height };
    },
    pick(left, top) {
      const ray = new Raycaster();
      ray.setFromCamera(new Vector2((left / width) * 2 - 1, 1 - (top / height) * 2), camera);
      const hits = ray.intersectObjects([solid, ...[...figures.values()].filter((item) => item.sprite.visible).map((item) => item.sprite)], true);
      for (const hit of hits) {
        const agent: unknown = hit.object.userData.agent;
        if (typeof agent === 'string') {
          // A sprite is a rectangle: only its middle half counts, the empty sides around the figure let the click through.
          if (Math.hypot(hit.point.x - hit.object.position.x, hit.point.z - hit.object.position.z) <= SPRITE_WIDTH / 4) return { kind: 'agent', id: agent };
          continue;
        }
        const normal = hit.face?.normal;
        return { kind: 'point', ...pickedTile(hit.point, normal === undefined ? null : { x: normal.x, z: normal.z }) };
      }
      return null;
    },
    dispose() {
      for (const item of figures.values()) {
        item.texture.dispose();
        item.sprite.material.dispose();
      }
      figures.clear();
      for (const item of [...materials.values(), ...floorMaterials.values(), ...inks.values()]) item.dispose();
      for (const child of solid.children) if (child instanceof InstancedMesh) child.dispose();
      cube.dispose();
      plane.dispose();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      lost = null;
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
