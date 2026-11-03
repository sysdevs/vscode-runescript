// Colour conversions for the model preview: config recolours are RGB15 and become the
// client's HSL16 like the packer does (ares-gameserver util/color.rs); HSL16 face colours
// become RGB through the client's colour table (Pix3D.initColourTable at brightness 0.8).

function hsl24to16(hue: number, saturation: number, lightness: number): number {
  if (lightness > 243) saturation >>= 4;
  else if (lightness > 217) saturation >>= 3;
  else if (lightness > 192) saturation >>= 2;
  else if (lightness > 179) saturation >>= 1;
  return (((hue & 0xff) >> 2) << 10) + ((saturation >> 5) << 7) + (lightness >> 1);
}

const clamp255 = (v: number) => Math.min(255, Math.max(0, v));

function rgbToHsl(red: number, green: number, blue: number): number {
  const min = Math.min(red, green, blue);
  const max = Math.max(red, green, blue);
  let h = 0;
  let s = 0;
  const l = (min + max) / 2;
  if (min !== max) {
    s = l < 0.5 ? (max - min) / (max + min) : (max - min) / (2 - max - min);
    if (red === max) h = (green - blue) / (max - min);
    else if (green === max) h = (blue - red) / (max - min) + 2;
    else h = (red - green) / (max - min) + 4;
  }
  h /= 6;
  return hsl24to16((h * 256) | 0, clamp255((s * 256) | 0), clamp255((l * 256) | 0));
}

/** A config `recol#s/d` value (RGB15) as the HSL16 the client matches face colours against. */
export function rgb15ToHsl16(rgb: number): number {
  return rgbToHsl(((rgb >> 10) & 0x1f) / 31, ((rgb >> 5) & 0x1f) / 31, (rgb & 0x1f) / 31);
}

/** An RGB15 value as RGB24 (each 5-bit channel shifted up, as the packer's rgb15to24). */
export function rgb15ToRgb24(rgb: number): number {
  return ((((rgb >> 10) & 0x1f) << 3) << 16) | ((((rgb >> 5) & 0x1f) << 3) << 8) | ((rgb & 0x1f) << 3);
}

/** RGB24 as the nearest RGB15 (drops each channel's low 3 bits). */
export function rgb24ToRgb15(rgb: number): number {
  return (((rgb >> 19) & 0x1f) << 10) | (((rgb >> 11) & 0x1f) << 5) | ((rgb >> 3) & 0x1f);
}

let preimages: Map<number, number[]> | undefined;

/**
 * An RGB15 value that converts to `hsl` (so a `recol#s` written with it matches faces of that
 * colour), the one nearest the colour the client shows for it; undefined when none does.
 */
export function rgb15ForHsl16(hsl: number): number | undefined {
  if (!preimages) {
    preimages = new Map();
    for (let rgb = 0; rgb < 32768; rgb++) {
      const h = rgb15ToHsl16(rgb);
      const list = preimages.get(h);
      if (list) list.push(rgb);
      else preimages.set(h, [rgb]);
    }
  }
  const shown = colourTable()[hsl & 0xffff];
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const rgb of preimages.get(hsl) ?? []) {
    const c = rgb15ToRgb24(rgb);
    const d = Math.abs((c >> 16) - (shown >> 16)) + Math.abs(((c >> 8) & 0xff) - ((shown >> 8) & 0xff)) + Math.abs((c & 0xff) - (shown & 0xff));
    if (d < bestDistance) [best, bestDistance] = [rgb, d];
  }
  return best;
}

function gammaCorrect(rgb: number, gamma: number): number {
  const ch = (v: number) => (Math.pow(v / 256, gamma) * 256) | 0;
  return (ch(rgb >> 16) << 16) + (ch((rgb >> 8) & 0xff) << 8) + ch(rgb & 0xff);
}

function hueChannel(p: number, q: number, t: number): number {
  if (t * 6 < 1) return p + (q - p) * 6 * t;
  if (t * 2 < 1) return q;
  if (t * 3 < 2) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

let table: Int32Array | undefined;

/** HSL16 → RGB24, the client's colour table. */
export function colourTable(): Int32Array {
  if (table) return table;
  table = new Int32Array(65536);
  let offset = 0;
  for (let y = 0; y < 512; y++) {
    const hue = ((y / 8) | 0) / 64 + 0.0078125;
    const saturation = (y & 0x7) / 8 + 0.0625;
    for (let x = 0; x < 128; x++) {
      const lightness = x / 128;
      const q = lightness < 0.5 ? lightness * (saturation + 1) : lightness + saturation - lightness * saturation;
      const p = lightness * 2 - q;
      let tr = hue + 1 / 3;
      if (tr > 1) tr--;
      let tb = hue - 1 / 3;
      if (tb < 0) tb++;
      const r = (hueChannel(p, q, tr) * 256) | 0;
      const g = (hueChannel(p, q, hue) * 256) | 0;
      const b = (hueChannel(p, q, tb) * 256) | 0;
      table[offset++] = gammaCorrect((r << 16) + (g << 8) + b, 0.8);
    }
  }
  return table;
}
