// What the model preview reads from a Content checkout, indexed lazily and cached until
// `invalidate`: model name → `.ob2` (name is the file stem, the directory does not matter),
// frame id → its `.anim` file, seq name → frames and delays (from every `.seq` config),
// seq-typed params, and texture ids and average colours.
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { decodePng } from "../ifedit/png";
import { AnimFrame, decodeAnim, frameIds } from "./anim";
import { decodeOb2, Model } from "./ob2";

export interface Seq {
  /** frame names (`anim_1555`) */
  frames: string[];
  /** `delay#` per frame; 0 means the frame's own delay */
  delays: number[];
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (extname(e.name) === ext) out.push(p);
  }
  return out;
}

/** `[name]` blocks of a config file as key/value lines (comments and blank lines dropped). */
export function configBlocks(text: string): Map<string, [string, string][]> {
  const blocks = new Map<string, [string, string][]>();
  let cur: [string, string][] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) blocks.set(header[1], (cur = []));
    else if (cur && line.includes("=")) {
      const at = line.indexOf("=");
      cur.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return blocks;
}

export class Content {
  private models?: Map<string, string>;
  private animFiles?: Map<number, string>;
  private animIds?: Map<string, number>;
  private seqs?: Map<string, Seq>;
  private params?: Set<string>;
  private textureIds?: Map<string, number>;
  private textureColours = new Map<number, [number, number, number] | undefined>();
  private decoded = new Map<string, Map<number, AnimFrame>>();

  constructor(readonly root: string) {}

  invalidate() {
    this.models = this.animFiles = this.animIds = this.seqs = this.params = this.textureIds = undefined;
    this.decoded.clear();
    this.textureColours.clear();
  }

  /** `pack/<name>.pack` as name → id. */
  private pack(name: string): Map<string, number> {
    const ids = new Map<string, number>();
    const pack = join(this.root, "pack", `${name}.pack`);
    if (existsSync(pack)) {
      for (const line of readFileSync(pack, "latin1").split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at > 0) ids.set(line.slice(at + 1).trim(), Number(line.slice(0, at)));
      }
    }
    return ids;
  }

  private modelPaths(): Map<string, string> {
    if (!this.models) {
      this.models = new Map();
      for (const p of walk(join(this.root, "models"), ".ob2")) {
        const stem = basename(p, ".ob2");
        if (!this.models.has(stem)) this.models.set(stem, p);
      }
    }
    return this.models;
  }

  hasModel(name: string): boolean {
    return this.modelPaths().has(name);
  }

  /** The decoded model, or undefined when no `<name>.ob2` exists. */
  model(name: string): Model | undefined {
    const path = this.modelPaths().get(name);
    return path ? decodeOb2(readFileSync(path)) : undefined;
  }

  /** A texture's id in pack/texture.pack (what textured faces store as their colour). */
  textureId(name: string): number | undefined {
    if (!this.textureIds) this.textureIds = this.pack("texture");
    return this.textureIds.get(name);
  }

  /** The average colour of `textures/<name>.png` (opaque pixels) for texture `id`. */
  textureColour(id: number): [number, number, number] | undefined {
    if (!this.textureIds) this.textureIds = this.pack("texture");
    if (this.textureColours.has(id)) return this.textureColours.get(id);
    let colour: [number, number, number] | undefined;
    const name = [...this.textureIds].find(([, i]) => i === id)?.[0];
    const path = name && join(this.root, "textures", `${name}.png`);
    if (path && existsSync(path)) {
      try {
        const { rgba } = decodePng(readFileSync(path));
        const sum = [0, 0, 0];
        let n = 0;
        for (let p = 0; p < rgba.length; p += 4) {
          if (rgba[p + 3] === 0) continue;
          sum[0] += rgba[p];
          sum[1] += rgba[p + 1];
          sum[2] += rgba[p + 2];
          n++;
        }
        if (n) colour = [sum[0] / n, sum[1] / n, sum[2] / n];
      } catch {
        // an unreadable texture keeps the grey fallback
      }
    }
    this.textureColours.set(id, colour);
    return colour;
  }

  seq(name: string): Seq | undefined {
    if (!this.seqs) {
      this.seqs = new Map();
      for (const p of walk(join(this.root, "scripts"), ".seq")) {
        for (const [seq, lines] of configBlocks(readFileSync(p, "latin1"))) {
          const s: Seq = { frames: [], delays: [] };
          for (const [k, v] of lines) {
            const m = /^(frame|delay)(\d+)$/.exec(k);
            if (!m) continue;
            const i = Number(m[2]) - 1;
            if (m[1] === "frame") s.frames[i] = v;
            else s.delays[i] = Number(v) || 0;
          }
          this.seqs.set(seq, s);
        }
      }
    }
    return this.seqs.get(name);
  }

  /** Names of the params declared `type=seq` in every `.param` config. */
  seqParams(): ReadonlySet<string> {
    if (!this.params) {
      this.params = new Set();
      for (const p of walk(join(this.root, "scripts"), ".param")) {
        for (const [param, lines] of configBlocks(readFileSync(p, "latin1"))) {
          if (lines.some(([k, v]) => k === "type" && v === "seq")) this.params.add(param);
        }
      }
    }
    return this.params;
  }

  /** A frame by name (`anim_1555`), through pack/anim.pack. */
  frame(name: string): AnimFrame | undefined {
    if (!this.animIds) this.animIds = this.pack("anim");
    if (!this.animFiles) {
      this.animFiles = new Map();
      for (const p of walk(join(this.root, "models"), ".anim")) {
        for (const id of frameIds(readFileSync(p))) this.animFiles.set(id, p);
      }
    }
    const id = this.animIds.get(name);
    const file = id === undefined ? undefined : this.animFiles.get(id);
    if (id === undefined || !file) return undefined;
    let frames = this.decoded.get(file);
    if (!frames) this.decoded.set(file, (frames = decodeAnim(readFileSync(file))));
    return frames.get(id);
  }
}
