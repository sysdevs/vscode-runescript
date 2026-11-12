// Client-TS If3.layout / drawComponent over an `.if3` model: components sized and placed through
// their x/y/width/height modes (Content/docs/if3/layout.md), then drawn. Nothing a script would
// do runs (hooks, cc_* edits, dynamic children); models are left to the webview overlay.
import { Assets, Font, Tile } from "./assets";
import { Com, IfModel, find, get, num, parseNum } from "./parse";
import { Surface, blend } from "./pix";
import { AREAS, Box, PreviewState } from "./render";
import { ENUMS } from "./schema3";

type Get = (key: string) => string | undefined;
const mode = (get: Get, key: string) => Math.max(0, ENUMS[key].indexOf(get(key) ?? ""));

/** If3.size: abs, minus (parent - v), rel (v/16384 of the parent). */
export function size(mode: number, v: number, parent: number): number {
  return mode === 1 ? parent - v : mode === 2 ? Math.floor((parent * v) / 16384) : v;
}

/** If3.pos: abs left/centre/right, rel left/centre/right. */
export function pos(mode: number, v: number, parent: number, size: number): number {
  switch (mode) {
    case 1: return Math.floor((parent - size) / 2) + v;
    case 2: return parent - size - v;
    case 3: return Math.floor((parent * v) / 16384);
    case 4: return Math.floor((parent * v) / 16384) + Math.floor((parent - size) / 2);
    case 5: return parent - size - Math.floor((parent * v) / 16384);
  }
  return v;
}

/** A component's laid-out box inside a parent of `pw` x `ph`. */
export function place(get: Get, pw: number, ph: number) {
  const n = (k: string) => parseNum(get(k));
  const w = size(mode(get, "widthmode"), n("width"), pw);
  const h = size(mode(get, "heightmode"), n("height"), ph);
  return { x: pos(mode(get, "xmode"), n("x"), pw, w), y: pos(mode(get, "ymode"), n("y"), ph, h), w, h };
}

/** The stored x/y/width/height that lay a component out at `box` (inside its parent), keeping its modes. */
export function unplace(get: Get, [x, y, w, h]: [number, number, number, number], [pw, ph]: [number, number]) {
  // the smallest rel value whose floor(parent * v / 16384) reaches the pixel value
  const rel = (px: number, parent: number) => (parent > 0 ? Math.ceil((px * 16384) / parent) : 0);
  const sizeOf = (m: number, px: number, parent: number) => (m === 1 ? parent - px : m === 2 ? rel(px, parent) : px);
  const posOf = (m: number, px: number, parent: number, s: number) => {
    const centre = Math.floor((parent - s) / 2);
    return [px, px - centre, parent - s - px, rel(px, parent), rel(px - centre, parent), rel(parent - s - px, parent)][m];
  };
  return {
    x: posOf(mode(get, "xmode"), x, pw, w),
    y: posOf(mode(get, "ymode"), y, ph, h),
    width: sizeOf(mode(get, "widthmode"), w, pw),
    height: sizeOf(mode(get, "heightmode"), h, ph),
  };
}

/** `graphic=` as a sprite spec: unquoted, a bare group meaning frame 0. */
export function graphicSpec(v: string | undefined): string {
  const g = (v ?? "").replace(/^"|"$/g, "");
  return g === "" || g.includes(",") ? g : `${g},0`;
}

/** The IF3 model keys as the IF1 names ifModelSpec reads. */
export function modelKeys(c: Com): Get {
  const angle = (get(c, "modelangle") ?? "").split(",");
  const map: Record<string, string | undefined> = { model: get(c, "model"), anim: get(c, "modelanim"), zoom: get(c, "modelzoom"), xan: angle[0]?.trim(), yan: angle[1]?.trim() };
  return (k) => map[k];
}

const fontOf = (assets: Assets, c: Com, def = 0) => assets.font(get(c, "textfont") === undefined ? def : mode((k) => get(c, k), "textfont"));

/**
 * Lays out (and with `s` draws) every component: Box per component in tree order, positioned on
 * screen. Hidden components (hide=yes, the eye) and their subtrees are placed but not drawn, and
 * with `s` get no box.
 */
function walk(model: IfModel, state: PreviewState, assets: Assets | null, s: Surface | null): Box[] {
  const [width, height] = AREAS[state.area];
  const out: Box[] = [];
  const visit = (name: string, x: number, y: number, w: number, h: number, clip: [number, number, number, number], drawn: boolean) => {
    const c = find(model, name)!;
    const scrollMax = Math.max(0, num(c, "scrollheight") - h);
    const scrollY = Math.max(0, Math.min(state.scroll[name] ?? 0, scrollMax));
    const inner: [number, number, number, number] = [Math.max(x, clip[0]), Math.max(y, clip[1]), Math.min(x + w, clip[2]), Math.min(y + h, clip[3])];
    for (const childName of model.children.get(name) ?? []) {
      const child = find(model, childName);
      if (!child) continue;
      const b = place((k) => get(child, k), w, h);
      const cx = x + b.x;
      const cy = y + b.y - scrollY;
      const type = get(child, "type") ?? "";
      const shown = drawn && !state.hidden.includes(childName) && (get(child, "hide") !== "yes" || state.showHidden);
      // rendering boxes (hit testing) are what is drawn; layout boxes are everything
      if (shown || !s) out.push({ com: childName, type, x: cx, y: cy, w: b.w, h: b.h, clip: inner, parent: name, originX: x, originY: y - scrollY });
      if (shown && s && assets) {
        s.setClipping(...inner);
        draw(s, assets, child, type, cx, cy, b.w, b.h, state.showHidden, width, height);
      }
      if (type === "layer") visit(childName, cx, cy, b.w, b.h, inner, shown);
    }
  };
  visit("", 0, 0, width, height, [0, 0, width, height], true);
  return out;
}

export function layout(model: IfModel, state: PreviewState): Box[] {
  return walk(model, state, null, null);
}

export function render(model: IfModel, assets: Assets, state: PreviewState): { width: number; height: number; pixels: Int32Array; boxes: Box[] } {
  const [width, height] = AREAS[state.area];
  const s = new Surface(width, height);
  const boxes = walk(model, state, assets, s);
  return { width, height, pixels: s.pixels, boxes };
}

function draw(s: Surface, assets: Assets, c: Com, type: string, x: number, y: number, w: number, h: number, showTips: boolean, areaW: number, areaH: number) {
  const n = (k: string, def = 0) => (get(c, k) === undefined ? def : num(c, k));
  const yes = (k: string) => get(c, k) === "yes";
  const colour = n("colour");
  const trans = n("trans") & 0xff;
  const alignH = mode((k) => get(c, k), "textalignh");
  const alignV = mode((k) => get(c, k), "textalignv");
  if (type === "rectangle") {
    if (yes("fill")) {
      if (trans === 0) s.fillRect(x, y, w, h, colour);
      else s.fillRectTrans(x, y, w, h, colour, 256 - trans);
    } else if (trans === 0) s.drawRect(x, y, w, h, colour);
    else s.drawRectTrans(x, y, w, h, colour, 256 - trans);
  } else if (type === "text") {
    const f = fontOf(assets, c);
    const text = get(c, "text") ?? "";
    if (!f || !text) return;
    let rgb = colour;
    for (const line of textLines(s, f, text, w, h, alignH, alignV, n("textlineheight"))) {
      let lx = x + line.x;
      for (const run of colourRuns(line.text, colour, rgb)) {
        s.drawStringTag(f, run.text, lx, y + line.y, run.rgb, yes("textshadow"));
        lx += s.stringWid(f, run.text);
      }
      rgb = colourAfter(line.text, colour, rgb);
    }
  } else if (type === "graphic") {
    let t = assets.sprite(graphicSpec(get(c, "graphic")));
    if (!t) return;
    if (yes("hflip") || yes("vflip")) t = flip(t, yes("hflip"), yes("vflip"));
    const plot = (px: number, py: number) => plotGraphic(s, t!, px, py, n("graphicshadow"), n("outline"), trans);
    if (!yes("tiling")) return plot(x, y);
    const [l, tp, r, b] = [s.clipMinX, s.clipMinY, s.clipMaxX, s.clipMaxY];
    s.setClipping(Math.max(x, l), Math.max(y, tp), Math.min(x + w, r), Math.min(y + h, b));
    for (let ty = 0; ty < h; ty += t.hi) for (let tx = 0; tx < w; tx += t.wi) plot(x + tx, y + ty);
    s.setClipping(l, tp, r, b);
  } else if (type === "circle") {
    drawCircle(s, x, y, w, h, colour, yes("fill"), trans, n("linewid", 1), n("arcstart"), n("arcend", 65536));
  } else if (type === "line") {
    if (yes("linedirection")) line(s, x, y + h, x + w, y, n("linewid", 1), colour);
    else line(s, x, y, x + w, y + h, n("linewid", 1), colour);
  } else if (type === "inputfield") {
    const f = fontOf(assets, c);
    if (!f) return;
    const text = get(c, "text") ?? "";
    const wrap = n("wrapmode") === 1 ? n("linewrappingwidth") || w : 0;
    const [shown, rgb] = text ? [text, colour] : [get(c, "placeholdertext") ?? "", n("placeholdertextcolour")];
    for (const l of textLines(s, f, shown, wrap, h, alignH, alignV, 0)) s.drawStringTag(f, l.text, x + l.x, y + l.y, rgb, yes("textshadow"));
  } else if (type === "tooltip" && showTips) {
    // shown on hover in the client; with "Hidden" on, where it would pop up
    const f = fontOf(assets, c, 1);
    const text = get(c, "text") ?? "";
    if (!f || !text) return;
    const lines = textLines(s, f, text, 250, 0, 0, 0, 0).map((l) => l.text);
    const bw = Math.max(0, ...lines.map((l) => width(s, f, l))) + 6;
    const bh = lines.length * 13 + 5;
    const bx = Math.max(0, Math.min(x, areaW - bw));
    let by = y + h + 2;
    if (by + bh > areaH) by = y - bh - 2;
    s.setClipping(0, 0, areaW, areaH);
    s.fillRect(bx, by, bw, bh, 0xffffa0);
    s.drawRect(bx, by, bw, bh, 0x000000);
    lines.forEach((l, i) => s.drawStringTag(f, l, bx + 3, by + 2 + f.height + i * 13 - 2, 0x000000, false));
  }
}

const width = (s: Surface, f: Font, text: string) => s.stringWid(f, text.replace(/<col=[0-9a-fA-F]+>|<\/col>/g, ""));

/** If3.textLines: split at <br> and \n, word-wrapped to `w` (0: no wrap), aligned; y is each baseline. */
function textLines(s: Surface, f: Font, text: string, w: number, h: number, alignH: number, alignV: number, lineHeight: number) {
  const lines: string[] = [];
  for (const part of text.split("<br>").flatMap((p) => p.split("\\n"))) {
    if (w <= 0 || width(s, f, part) <= w) {
      lines.push(part);
      continue;
    }
    let cur = "";
    for (const word of part.split(" ")) {
      const next = cur.length === 0 ? word : `${cur} ${word}`;
      if (cur.length > 0 && width(s, f, next) > w) {
        lines.push(cur);
        cur = word;
      } else cur = next;
    }
    lines.push(cur);
  }
  const lh = lineHeight > 0 ? lineHeight : f.height;
  const total = lines.length * lh;
  const top = alignV === 1 ? Math.floor((h - total) / 2) : alignV === 2 ? h - total : 0;
  return lines.map((text, i) => {
    const wid = width(s, f, text);
    const x = alignH === 1 ? Math.floor((w - wid) / 2) : alignH === 2 ? w - wid : 0;
    return { text, x, y: top + i * lh + f.height };
  });
}

function colourRuns(text: string, rgb: number, start: number) {
  const runs: { text: string; rgb: number }[] = [];
  let colour = start;
  for (const part of text.split(/(<col=[0-9a-fA-F]+>|<\/col>)/)) {
    if (part.startsWith("<col=")) colour = parseInt(part.slice(5, -1), 16);
    else if (part === "</col>") colour = rgb;
    else if (part.length > 0) runs.push({ text: part, rgb: colour });
  }
  return runs;
}

function colourAfter(text: string, rgb: number, start: number) {
  let colour = start;
  for (const m of text.matchAll(/<col=([0-9a-fA-F]+)>|<\/col>/g)) colour = m[1] ? parseInt(m[1], 16) : rgb;
  return colour;
}

function flip(t: Tile, h: boolean, v: boolean): Tile {
  const pixels = new Int32Array(t.pixels.length);
  for (let y = 0; y < t.hi; y++) for (let x = 0; x < t.wi; x++) pixels[(v ? t.hi - 1 - y : y) * t.wi + (h ? t.wi - 1 - x : x)] = t.pixels[y * t.wi + x];
  return { ...t, pixels };
}

/** If3.plot: shadow, outline, then the sprite (blended when trans). */
function plotGraphic(s: Surface, t: Tile, x: number, y: number, shadow: number, outline: number, trans: number) {
  if (shadow !== 0) silhouette(s, t, x + 1, y + 1, shadow);
  if (outline > 0) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) silhouette(s, t, x + dx, y + dy, outline === 1 ? 0x000001 : 0xffffff);
  if (trans === 0) return s.plotSprite(t, x, y);
  eachPixel(s, t, x, y, (i, rgb) => (s.pixels[i] = blend(s.pixels[i], rgb, 256 - trans)));
}

function silhouette(s: Surface, t: Tile, x: number, y: number, rgb: number) {
  eachPixel(s, t, x, y, (i) => (s.pixels[i] = rgb));
}

/** Calls `f` for each opaque sprite pixel inside the clip, with its surface index. */
function eachPixel(s: Surface, t: Tile, x: number, y: number, f: (i: number, rgb: number) => void) {
  x += t.xof;
  y += t.yof;
  for (let sy = 0; sy < t.hi; sy++) {
    const py = y + sy;
    if (py < s.clipMinY || py >= s.clipMaxY) continue;
    for (let sx = 0; sx < t.wi; sx++) {
      const px = x + sx;
      const rgb = t.pixels[sx + sy * t.wi];
      if (px >= s.clipMinX && px < s.clipMaxX && rgb !== 0) f(px + py * s.width, rgb);
    }
  }
}

/** If3.drawCircle: an ellipse in the box, filled or `lw` thick, cut to the arc (clockwise from 12 o'clock). */
function drawCircle(s: Surface, x: number, y: number, w: number, h: number, colour: number, fill: boolean, trans: number, lw: number, arcStart: number, arcEnd: number) {
  if (w <= 0 || h <= 0) return;
  const span = arcEnd - arcStart;
  if (span === 0) return;
  const full = span >= 65536 || span <= -65536;
  const start = ((arcStart % 65536) + 65536) % 65536;
  const end = ((arcEnd % 65536) + 65536) % 65536;
  const [rx, ry] = [w / 2, h / 2];
  const [ix, iy] = [rx - lw, ry - lw];
  for (let py = Math.max(y, s.clipMinY); py < Math.min(y + h, s.clipMaxY); py++) {
    for (let px = Math.max(x, s.clipMinX); px < Math.min(x + w, s.clipMaxX); px++) {
      const dx = px + 0.5 - (x + rx);
      const dy = py + 0.5 - (y + ry);
      if ((dx / rx) ** 2 + (dy / ry) ** 2 > 1) continue;
      if (!fill && ix > 0 && iy > 0 && (dx / ix) ** 2 + (dy / iy) ** 2 <= 1) continue;
      if (!full) {
        let a = Math.atan2(dx, -dy);
        if (a < 0) a += Math.PI * 2;
        const u = (a / (Math.PI * 2)) * 65536;
        if (start < end ? u < start || u >= end : u < start && u >= end) continue;
      }
      const i = px + py * s.width;
      s.pixels[i] = trans === 0 ? colour : blend(s.pixels[i], colour, 256 - trans);
    }
  }
}

/** Pix2D.line: Bresenham, a `lw` x `lw` square per step when thicker than 1. */
function line(s: Surface, x1: number, y1: number, x2: number, y2: number, lw: number, rgb: number) {
  const dx = Math.abs(x2 - x1);
  const dy = -Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (lw <= 1) {
      if (x1 >= s.clipMinX && x1 < s.clipMaxX && y1 >= s.clipMinY && y1 < s.clipMaxY) s.pixels[x1 + y1 * s.width] = rgb;
    } else s.fillRect(x1, y1, lw, lw, rgb);
    if (x1 === x2 && y1 === y2) return;
    const e2 = 2 * err;
    if (e2 >= dy) ((err += dy), (x1 += sx));
    if (e2 <= dx) ((err += dx), (y1 += sy));
  }
}
