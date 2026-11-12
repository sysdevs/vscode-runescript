// A 2D pixel surface: Client-TS Pix2D (static state made per-instance), Pix32/Pix8
// plotSprite and PixFont string drawing, ported with their clip arithmetic intact.
// The client unrolls some loops four at a time; the plain loops here write the same pixels.
import type { Font, Tile } from "./assets";

/** PixFont.updateState colour tags (Colour.ts). */
const TAGS: Record<string, number> = {
  red: 0xff0000, gre: 0xff00, blu: 0xff, yel: 0xffff00, cya: 0xffff, mag: 0xff00ff, whi: 0xffffff, bla: 0x0,
  lre: 0xff9040, dre: 0x800000, dbl: 0x80, or1: 0xffb000, or2: 0xff7000, or3: 0xff3000, gr1: 0xc0ff00, gr2: 0x80ff00, gr3: 0x40ff00,
};
const DARKRED = 0x800000;

export class Surface {
  readonly pixels: Int32Array;
  clipMinX = 0;
  clipMinY = 0;
  clipMaxX: number;
  clipMaxY: number;

  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Int32Array(width * height);
    this.clipMaxX = width;
    this.clipMaxY = height;
  }

  setClipping(x1: number, y1: number, x2: number, y2: number): void {
    this.clipMinX = Math.max(x1, 0);
    this.clipMinY = Math.max(y1, 0);
    this.clipMaxX = Math.min(x2, this.width);
    this.clipMaxY = Math.min(y2, this.height);
  }

  fillRect(x: number, y: number, width: number, height: number, rgb: number): void {
    if (x < this.clipMinX) {
      width -= this.clipMinX - x;
      x = this.clipMinX;
    }
    if (y < this.clipMinY) {
      height -= this.clipMinY - y;
      y = this.clipMinY;
    }
    if (x + width > this.clipMaxX) width = this.clipMaxX - x;
    if (y + height > this.clipMaxY) height = this.clipMaxY - y;
    const step = this.width - width;
    let offset = x + y * this.width;
    for (let i = -height; i < 0; i++) {
      for (let j = -width; j < 0; j++) this.pixels[offset++] = rgb;
      offset += step;
    }
  }

  fillRectTrans(x: number, y: number, width: number, height: number, rgb: number, alpha: number): void {
    if (x < this.clipMinX) {
      width -= this.clipMinX - x;
      x = this.clipMinX;
    }
    if (y < this.clipMinY) {
      height -= this.clipMinY - y;
      y = this.clipMinY;
    }
    if (x + width > this.clipMaxX) width = this.clipMaxX - x;
    if (y + height > this.clipMaxY) height = this.clipMaxY - y;
    const step = this.width - width;
    let offset = x + y * this.width;
    for (let i = 0; i < height; i++) {
      for (let j = -width; j < 0; j++) {
        this.pixels[offset] = blend(this.pixels[offset], rgb, alpha);
        offset++;
      }
      offset += step;
    }
  }

  drawRect(x: number, y: number, w: number, h: number, rgb: number): void {
    this.hline(x, y, w, rgb);
    this.hline(x, y + h - 1, w, rgb);
    this.vline(x, y, h, rgb);
    this.vline(x + w - 1, y, h, rgb);
  }

  drawRectTrans(x: number, y: number, w: number, h: number, rgb: number, alpha: number): void {
    this.hlineTrans(x, y, w, rgb, alpha);
    this.hlineTrans(x, y + h - 1, w, rgb, alpha);
    if (h >= 3) {
      this.vlineTrans(x, y, h, rgb, alpha);
      this.vlineTrans(x + w - 1, y, h, rgb, alpha);
    }
  }

  hline(x: number, y: number, width: number, rgb: number): void {
    if (y < this.clipMinY || y >= this.clipMaxY) return;
    if (x < this.clipMinX) {
      width -= this.clipMinX - x;
      x = this.clipMinX;
    }
    if (x + width > this.clipMaxX) width = this.clipMaxX - x;
    const off = x + y * this.width;
    for (let i = 0; i < width; i++) this.pixels[off + i] = rgb;
  }

  hlineTrans(x: number, y: number, width: number, rgb: number, alpha: number): void {
    if (y < this.clipMinY || y >= this.clipMaxY) return;
    if (x < this.clipMinX) {
      width -= this.clipMinX - x;
      x = this.clipMinX;
    }
    if (x + width > this.clipMaxX) width = this.clipMaxX - x;
    let offset = x + y * this.width;
    for (let i = 0; i < width; i++, offset++) this.pixels[offset] = blend(this.pixels[offset], rgb, alpha);
  }

  vline(x: number, y: number, height: number, rgb: number): void {
    if (x < this.clipMinX || x >= this.clipMaxX) return;
    if (y < this.clipMinY) {
      height -= this.clipMinY - y;
      y = this.clipMinY;
    }
    if (y + height > this.clipMaxY) height = this.clipMaxY - y;
    const off = x + y * this.width;
    for (let i = 0; i < height; i++) this.pixels[off + i * this.width] = rgb;
  }

  vlineTrans(x: number, y: number, height: number, rgb: number, alpha: number): void {
    if (x < this.clipMinX || x >= this.clipMaxX) return;
    if (y < this.clipMinY) {
      height -= this.clipMinY - y;
      y = this.clipMinY;
    }
    if (y + height > this.clipMaxY) height = this.clipMaxY - y;
    let offset = x + y * this.width;
    for (let i = 0; i < height; i++, offset += this.width) this.pixels[offset] = blend(this.pixels[offset], rgb, alpha);
  }

  /** Pix32.plotSprite; `pix8` writes black as 0 like Pix8 (the scrollbar arrows). */
  plotSprite(t: Tile, x: number, y: number, pix8 = false): void {
    x += t.xof;
    y += t.yof;
    let dstOff = x + y * this.width;
    let srcOff = 0;
    let h = t.hi;
    let w = t.wi;
    let dstStep = this.width - w;
    let srcStep = 0;
    if (y < this.clipMinY) {
      const cutoff = this.clipMinY - y;
      h -= cutoff;
      y = this.clipMinY;
      srcOff += cutoff * w;
      dstOff += cutoff * this.width;
    }
    if (y + h > this.clipMaxY) h -= y + h - this.clipMaxY;
    if (x < this.clipMinX) {
      const cutoff = this.clipMinX - x;
      w -= cutoff;
      x = this.clipMinX;
      srcOff += cutoff;
      dstOff += cutoff;
      srcStep += cutoff;
      dstStep += cutoff;
    }
    if (x + w > this.clipMaxX) {
      const cutoff = x + w - this.clipMaxX;
      w -= cutoff;
      srcStep += cutoff;
      dstStep += cutoff;
    }
    if (w <= 0 || h <= 0) return;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const rgb = t.pixels[srcOff++];
        if (rgb !== 0) this.pixels[dstOff] = pix8 && rgb === 1 ? 0 : rgb;
        dstOff++;
      }
      dstOff += dstStep;
      srcOff += srcStep;
    }
  }

  stringWid(f: Font, str: string): number {
    let w = 0;
    for (let c = 0; c < str.length; c++) {
      if (str.charAt(c) === "@" && c + 4 < str.length && str.charAt(c + 4) === "@") c += 4;
      else w += f.advance[str.charCodeAt(c) & 0xff];
    }
    return w;
  }

  drawStringTag(f: Font, str: string, x: number, y: number, rgb: number, shadowed: boolean): void {
    let strikeout = false;
    const startX = x;
    y -= f.height;
    for (let i = 0; i < str.length; i++) {
      if (str.charAt(i) === "@" && i + 4 < str.length && str.charAt(i + 4) === "@") {
        const tag = str.substring(i + 1, i + 4);
        if (tag in TAGS) rgb = TAGS[tag];
        else if (tag === "str") strikeout = true;
        i += 4;
      } else {
        const c = str.charCodeAt(i) & 0xff;
        if (c !== 32) {
          if (shadowed) this.plotLetter(f.mask[c], x + f.offX[c] + 1, y + f.offY[c] + 1, f.maskW[c], f.maskH[c], 0);
          this.plotLetter(f.mask[c], x + f.offX[c], y + f.offY[c], f.maskW[c], f.maskH[c], rgb);
        }
        x += f.advance[c];
      }
    }
    if (strikeout) this.hline(startX, y + ((f.height * 0.7) | 0), x - startX, DARKRED);
  }

  centreStringTag(f: Font, str: string, x: number, y: number, rgb: number, shadowed: boolean): void {
    this.drawStringTag(f, str, x - ((this.stringWid(f, str) / 2) | 0), y, rgb, shadowed);
  }

  /** PixFont.plotLetter, including its `>= clipMax` edges that drop one extra row/column. */
  private plotLetter(data: Int8Array, x: number, y: number, w: number, h: number, rgb: number): void {
    let dstOff = x + y * this.width;
    let dstStep = this.width - w;
    let srcStep = 0;
    let srcOff = 0;
    if (y < this.clipMinY) {
      const cutoff = this.clipMinY - y;
      h -= cutoff;
      y = this.clipMinY;
      srcOff += cutoff * w;
      dstOff += cutoff * this.width;
    }
    if (y + h >= this.clipMaxY) h -= y + h + 1 - this.clipMaxY;
    if (x < this.clipMinX) {
      const cutoff = this.clipMinX - x;
      w -= cutoff;
      x = this.clipMinX;
      srcOff += cutoff;
      dstOff += cutoff;
      srcStep += cutoff;
      dstStep += cutoff;
    }
    if (x + w >= this.clipMaxX) {
      const cutoff = x + w + 1 - this.clipMaxX;
      w -= cutoff;
      srcStep += cutoff;
      dstStep += cutoff;
    }
    if (w <= 0 || h <= 0) return;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        if (data[srcOff++] !== 0) this.pixels[dstOff] = rgb;
        dstOff++;
      }
      dstOff += dstStep;
      srcOff += srcStep;
    }
  }

  toRgba(): Uint8Array {
    const out = new Uint8Array(this.pixels.length * 4);
    this.pixels.forEach((p, i) => {
      out[i * 4] = (p >> 16) & 0xff;
      out[i * 4 + 1] = (p >> 8) & 0xff;
      out[i * 4 + 2] = p & 0xff;
      out[i * 4 + 3] = 255;
    });
    return out;
  }
}

/** The client's alpha mix: (src*alpha + dst*(256-alpha)) >> 8 per channel. */
export function blend(dst: number, rgb: number, alpha: number): number {
  const inv = 256 - alpha;
  const r = ((((rgb >> 16) & 0xff) * alpha + ((dst >> 16) & 0xff) * inv) >> 8) << 16;
  const g = ((((rgb >> 8) & 0xff) * alpha + ((dst >> 8) & 0xff) * inv) >> 8) << 8;
  const b = ((rgb & 0xff) * alpha + (dst & 0xff) * inv) >> 8;
  return r + g + b;
}
