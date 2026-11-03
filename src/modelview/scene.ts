// What every config type's builder shares: reading model/recolour/seq keys from a block,
// and turning posed, lit parts into the triangle lists the webview draws.
import { AnimFrame } from "./anim";
import { colourTable, rgb15ToHsl16 } from "./colour";
import { Content } from "./content";
import { light, Model, recolour } from "./ob2";

export type Lines = [string, string][];

export interface SeqChoice {
  /** where the block names it: `readyanim`, `walkanim`, `anim` or a param name */
  key: string;
  seq: string;
}

export interface View {
  key: string;
  label: string;
}

export interface Scene {
  /** the seq dropdown's choices; empty hides it */
  seqs: SeqChoice[];
  /** the seq shown, "" for none */
  seq: string;
  /** the view dropdown's choices (obj ground/worn/..., idk body/head); fewer than two hides it */
  views: View[];
  view: string;
  /** per frame: 9 floats per face (three corners, client axes: y down) */
  frames: Float32Array[];
  /** per frame: 4 bytes per corner; faces ordered opaque first */
  colours: Uint8Array[];
  /** per frame, in milliseconds */
  delays: number[];
  opaqueFaces: number;
  faces: number;
  /** [minX, minY, minZ, maxX, maxY, maxZ] over every frame */
  bounds: number[];
  /** labelled parts laid out in a grid (loc shapes), each anchored under its part; empty for a single model */
  parts: { label: string; anchor: number[] }[];
  /** per face (drawing order): its HSL16 colour before the block's recolours, -1 for textured faces (the eyedropper's answer) */
  faceSource: Int32Array;
  /** "icon": points are already in the obj icon's view space; draw with its fixed camera */
  camera?: "icon";
  /** problems worth showing (missing models, frames) */
  warnings: string[];
}

/** One model in one pose, with a colour per face corner (HSL16, or a texture shade). */
export interface Lit {
  model: Model;
  colA: Int32Array;
  colB: Int32Array;
  colC: Int32Array;
}

/** A model drawn in every frame; parts of one scene share the frame count. */
export interface Part {
  label: string;
  frames: Lit[];
}

export function value(lines: Lines, key: string): string | undefined {
  return lines.filter(([k]) => k === key).pop()?.[1];
}

export function num(lines: Lines, key: string, def: number): number {
  const v = Number(value(lines, key));
  return value(lines, key) === undefined || Number.isNaN(v) ? def : v;
}

/** `<prefix>N` keys as [N, value], ascending. */
export function indexed(lines: Lines, prefix: string): [number, string][] {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  const out: [number, string][] = [];
  for (const [k, v] of lines) {
    const m = re.exec(k);
    if (m) out.push([Number(m[1]), v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Decodes each named model; a missing or broken one becomes a warning. */
export function loadModels(content: Content, names: string[], warnings: string[]): Model[] {
  const out: Model[] = [];
  for (const name of names) {
    try {
      const m = content.model(name);
      if (m) out.push(m);
      else warnings.push(`unknown model ${name}`);
    } catch (e) {
      warnings.push(`model ${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * The block's recolours in slot order, as values to match face colours: `recol#s/d` are
 * RGB15 (converted to HSL16); with `textures`, `retex#s/d` texture names share the same slots
 * (as the packer stores them until rev 465).
 */
export function recolours(content: Content, lines: Lines, textures = false): [number, number][] {
  const slots = new Map<number, { s?: number; d?: number }>();
  for (const [k, v] of lines) {
    const m = /^(recol|retex)(\d+)([sd])$/.exec(k);
    if (!m || (m[1] === "retex" && !textures)) continue;
    const n = m[1] === "recol" ? rgb15ToHsl16(Number(v)) : content.textureId(v);
    if (n === undefined) continue;
    const slot = slots.get(Number(m[2])) ?? {};
    slot[m[3] as "s" | "d"] = n;
    slots.set(Number(m[2]), slot);
  }
  return [...slots]
    .sort((a, b) => a[0] - b[0])
    .filter(([, p]) => p.s !== undefined && p.d !== undefined)
    .map(([, p]) => [p.s!, p.d!]);
}

export function applyRecolours(model: Model, pairs: [number, number][]) {
  model.sourceColour ??= model.faceColour.slice();
  for (const [s, d] of pairs) recolour(model, s, d);
}

export function lit(model: Model, ambient: number, contrast: number, x: number, y: number, z: number): Lit {
  return { model, ...light(model, ambient, contrast, x, y, z) };
}

/** A seq's frames and delays (ms); none (one still frame) for "" or an unknown seq. */
export function seqFrames(content: Content, seq: string, warnings: string[]): { frames: (AnimFrame | undefined)[]; delays: number[] } {
  const frames: (AnimFrame | undefined)[] = [];
  const delays: number[] = [];
  const s = seq ? content.seq(seq) : undefined;
  if (seq && !s) warnings.push(`unknown seq ${seq}`);
  for (let i = 0; s && i < s.frames.length; i++) {
    const name = s.frames[i];
    const frame = name ? content.frame(name) : undefined;
    if (!frame) {
      warnings.push(`seq ${seq}: no frame ${name ?? i + 1}`);
      continue;
    }
    frames.push(frame);
    // client cycles are 20 ms; a 0 delay falls back to the frame's, then to 1
    delays.push((s.delays[i] || frame.delay || 1) * 20);
  }
  if (frames.length === 0) return { frames: [undefined], delays: [1000] };
  return { frames, delays };
}

type Meta = Pick<Scene, "seqs" | "seq" | "views" | "view" | "warnings" | "camera">;

/** Expands parts into per-frame triangle lists; several parts are laid out in a grid. */
export function toScene(content: Content, parts: Part[], delays: number[], meta: Meta): Scene {
  const empty: Scene = { ...meta, frames: [], colours: [], delays: [], opaqueFaces: 0, faces: 0, bounds: [0, 0, 0, 0, 0, 0], parts: [], faceSource: new Int32Array(0) };
  if (parts.length === 0) return empty;

  // several parts sit in a grid of about sqrt(n) columns (x) and rows (y), each centred in its
  // cell and standing on the cell's floor, so each stays large in the view
  const offsets = parts.map(() => [0, 0]);
  if (parts.length > 1) {
    const extents = parts.map((p) => {
      const e = [Infinity, Infinity, -Infinity, -Infinity];
      for (const { model } of p.frames) {
        for (let v = 0; v < model.numPoints; v++) {
          e[0] = Math.min(e[0], model.pointX[v]);
          e[1] = Math.min(e[1], model.pointY[v]);
          e[2] = Math.max(e[2], model.pointX[v]);
          e[3] = Math.max(e[3], model.pointY[v]);
        }
      }
      return e[0] <= e[2] ? e : [0, 0, 0, 0];
    });
    const cellW = Math.max(...extents.map((e) => e[2] - e[0])) * 1.5;
    const cellH = Math.max(...extents.map((e) => e[3] - e[1])) * 1.6;
    const cols = Math.ceil(Math.sqrt(parts.length));
    extents.forEach((e, i) => {
      offsets[i] = [(i % cols) * cellW - (e[0] + e[2]) / 2, Math.floor(i / cols) * cellH - e[3]];
    });
  }

  // opaque faces first so the webview can draw them before the blended ones
  const faces: [number, number][] = [];
  parts.forEach((p, i) => {
    for (let f = 0; f < p.frames[0].model.numFaces; f++) faces.push([i, f]);
  });
  const alpha = ([p, f]: [number, number]) => parts[p].frames[0].model.faceAlpha?.[f] ?? 0;
  faces.sort((a, b) => Number(alpha(a) !== 0) - Number(alpha(b) !== 0));
  const opaqueFaces = faces.filter((f) => alpha(f) === 0).length;

  const table = colourTable();
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const partBounds = parts.map(() => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const frames: Float32Array[] = [];
  const colours: Uint8Array[] = [];
  for (let n = 0; n < delays.length; n++) {
    const pos = new Float32Array(faces.length * 9);
    const col = new Uint8Array(faces.length * 12);
    faces.forEach(([p, f], i) => {
      const { model: m, colA, colB, colC } = parts[p].frames[n];
      const type = m.faceRenderType?.[f] ?? 0;
      const texture = (type & 2) !== 0 ? content.textureColour(m.faceColour[f]) : undefined;
      const corners = [m.faceA[f], m.faceB[f], m.faceC[f]];
      const shades = [colA[f], colB[f], colC[f]];
      for (let j = 0; j < 3; j++) {
        const v = corners[j];
        const o = i * 9 + j * 3;
        pos[o] = m.pointX[v] + offsets[p][0];
        pos[o + 1] = m.pointY[v] + offsets[p][1];
        pos[o + 2] = m.pointZ[v];
        for (let k = 0; k < 3; k++) {
          bounds[k] = Math.min(bounds[k], pos[o + k]);
          bounds[k + 3] = Math.max(bounds[k + 3], pos[o + k]);
          partBounds[p][k] = Math.min(partBounds[p][k], pos[o + k]);
          partBounds[p][k + 3] = Math.max(partBounds[p][k + 3], pos[o + k]);
        }
        const c = (i * 3 + j) * 4;
        if ((type & 2) !== 0) {
          // textures are not mapped: the texture's average colour at the face's light level
          const [r, g, b] = texture ?? [128, 128, 128];
          const k = (127 - shades[j]) / 96;
          col[c] = Math.min(255, r * k);
          col[c + 1] = Math.min(255, g * k);
          col[c + 2] = Math.min(255, b * k);
        } else {
          const rgb = table[shades[j] & 0xffff];
          col[c] = (rgb >> 16) & 0xff;
          col[c + 1] = (rgb >> 8) & 0xff;
          col[c + 2] = rgb & 0xff;
        }
        col[c + 3] = 255 - alpha([p, f]);
      }
    });
    frames.push(pos);
    colours.push(col);
  }
  if (faces.length === 0) return { ...empty, delays };
  const faceSource = Int32Array.from(faces, ([p, f]) => {
    const m = parts[p].frames[0].model;
    return ((m.faceRenderType?.[f] ?? 0) & 2) !== 0 ? -1 : (m.sourceColour ?? m.faceColour)[f];
  });
  // labels hang under each part: centre in x and z, its floor (max y, client y is down)
  const b = partBounds;
  const labelled = parts.length > 1 ? parts.map((p, i) => ({ label: p.label, anchor: [(b[i][0] + b[i][3]) / 2, b[i][4], (b[i][2] + b[i][5]) / 2] })) : [];
  return { ...meta, frames, colours, delays, opaqueFaces, faces: faces.length, bounds, parts: labelled, faceSource };
}
