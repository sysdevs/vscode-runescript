// Sprites and fonts straight from Content PNGs, cut and cropped the way the packer does it
// (ares-gameserver src/pack/pix.rs) and measured the way the client does it (Client-TS PixFont.depack).
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { decodePng } from "./png";

export interface Tile {
  wi: number;
  hi: number;
  xof: number;
  yof: number;
  owi: number;
  ohi: number;
  /** wi*hi pixels, 0 = transparent (Pix32: magenta -> 0, black -> 1). */
  pixels: Int32Array;
}

export interface Sheet {
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  tiles: Tile[];
}

export interface Font {
  height: number;
  mask: Int8Array[];
  maskW: Int32Array;
  maskH: Int32Array;
  offX: Int32Array;
  offY: Int32Array;
  advance: Int32Array;
}

export const FONT_NAMES = ["p11_full", "p12_full", "b12_full", "q8_full"] as const;

const MAGENTA = 0xff00ff;

interface Image {
  width: number;
  height: number;
  rgb: Int32Array;
}

export class Assets {
  private sheets = new Map<string, Sheet | undefined>();
  private fonts = new Map<number, Font | undefined>();

  constructor(readonly contentRoot: string) {}

  sheetNames(): string[] {
    const dir = join(this.contentRoot, "sprites");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.slice(0, -4))
      .sort();
  }

  sheet(name: string): Sheet | undefined {
    if (!this.sheets.has(name)) this.sheets.set(name, this.loadSheet(name));
    return this.sheets.get(name);
  }

  /** `name,index`, split on the last comma like IfType.getSprite. */
  sprite(spec: string): Tile | undefined {
    const comma = spec.lastIndexOf(",");
    if (comma === -1) return undefined;
    const index = parseInt(spec.slice(comma + 1), 10);
    if (Number.isNaN(index)) return undefined;
    return this.sheet(spec.slice(0, comma))?.tiles[index];
  }

  font(id: number): Font | undefined {
    if (!this.fonts.has(id)) this.fonts.set(id, this.loadFont(id));
    return this.fonts.get(id);
  }

  invalidate(): void {
    this.sheets.clear();
    this.fonts.clear();
  }

  private loadSheet(name: string): Sheet | undefined {
    const img = this.image("sprites", name);
    const size = img && this.tileSize("sprites", name, img);
    if (!img || !size) return undefined;
    const [tileW, tileH] = size;
    const cols = img.width / tileW;
    const rows = img.height / tileH;
    const tiles: Tile[] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) tiles.push(tile(img, x * tileW, y * tileH, tileW, tileH));
    return { tileW, tileH, cols, rows, tiles };
  }

  private loadFont(id: number): Font | undefined {
    const name = FONT_NAMES[id];
    const img = name && this.image("fonts", name);
    const size = img && this.tileSize("fonts", name, img);
    if (!img || !size) return undefined;
    const [tw, th] = size;
    // pix.rs palette(): magenta first, then colours first-seen over the whole sheet
    const palette = new Map<number, number>([[MAGENTA, 0]]);
    for (const rgb of img.rgb) if (!palette.has(rgb)) palette.set(rgb, palette.size);
    const f: Font = {
      height: 0,
      mask: new Array(256),
      maskW: new Int32Array(256),
      maskH: new Int32Array(256),
      offX: new Int32Array(256),
      offY: new Int32Array(256),
      advance: new Int32Array(256),
    };
    const cols = img.width / tw;
    for (let c = 0; c < 256; c++) {
      const cx = (c % cols) * tw;
      const cy = Math.floor(c / cols) * th;
      if (cy >= img.height) {
        f.mask[c] = new Int8Array(0);
        continue;
      }
      const [left, top, wi, hi] = bounds(img, cx, cy, tw, th);
      const mask = new Int8Array(wi * hi);
      for (let y = 0; y < hi; y++) for (let x = 0; x < wi; x++) mask[x + y * wi] = (palette.get(img.rgb[left + x + (top + y) * img.width])! << 24) >> 24;
      f.mask[c] = mask;
      f.maskW[c] = wi;
      f.maskH[c] = hi;
      f.offY[c] = top - cy;
      // PixFont.depack from here on
      if (hi > f.height && c < 128) f.height = hi;
      f.offX[c] = 1;
      f.advance[c] = wi + 2;
      const from = (hi / 7) | 0;
      let space = 0;
      for (let y = from; y < hi; y++) space += mask[y * wi];
      if (space <= from) {
        f.advance[c]--;
        f.offX[c] = 0;
      }
      space = 0;
      for (let y = from; y < hi; y++) space += mask[wi + y * wi - 1];
      if (space <= from) f.advance[c]--;
    }
    f.advance[32] = name === "q8_full" ? f.advance[73] : f.advance[105];
    return f;
  }

  private image(dir: string, name: string): Image | undefined {
    try {
      const { width, height, rgba } = decodePng(readFileSync(join(this.contentRoot, dir, `${name}.png`)));
      const rgb = new Int32Array(width * height);
      for (let i = 0; i < rgb.length; i++) rgb[i] = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      return { width, height, rgb };
    } catch {
      return undefined;
    }
  }

  /** `meta/<name>.opt` first line `WxH`, else the whole image; undefined when it does not divide the image. */
  private tileSize(dir: string, name: string, img: Image): [number, number] | undefined {
    let size: [number, number] = [img.width, img.height];
    const opt = join(this.contentRoot, dir, "meta", `${name}.opt`);
    if (existsSync(opt)) {
      const m = /^(\d+)x(\d+)$/.exec(readFileSync(opt, "latin1").split("\n")[0].replace(/\r$/, "").trim());
      if (!m) return undefined;
      size = [+m[1], +m[2]];
    }
    const [w, h] = size;
    return w > 0 && h > 0 && img.width % w === 0 && img.height % h === 0 ? size : undefined;
  }
}

/** pix.rs bounds(): the box of non-magenta pixels, or the whole tile when there are none. */
function bounds(img: Image, x0: number, y0: number, w: number, h: number): [number, number, number, number] {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (img.rgb[x + y * img.width] === MAGENTA) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right === -1 ? [x0, y0, w, h] : [left, top, right - left + 1, bottom - top + 1];
}

function tile(img: Image, x0: number, y0: number, w: number, h: number): Tile {
  const [left, top, wi, hi] = bounds(img, x0, y0, w, h);
  const pixels = new Int32Array(wi * hi);
  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < wi; x++) {
      const rgb = img.rgb[left + x + (top + y) * img.width];
      pixels[x + y * wi] = rgb === MAGENTA ? 0 : rgb === 0 ? 1 : rgb;
    }
  }
  return { wi, hi, xof: left - x0, yof: top - y0, owi: w, ohi: h, pixels };
}
