// Client-TS Client.drawInterface / drawScrollbar over an `.if` model. Values are read the
// way ares-gameserver packs them; runtime state the client would supply (active scripts, the mouse,
// %1..%5, scroll positions) comes from PreviewState. Inventories are empty, models are
// left to the webview overlay.
import { Assets, FONT_NAMES, Tile } from "./assets";
import { Com, IfModel, boxOf, find, get, num, parseNum } from "./parse";
import { Surface } from "./pix";

export type Area = "main" | "side" | "chat";
export const AREAS: Record<Area, [number, number]> = { main: [512, 334], side: [190, 261], chat: [479, 96] };

export interface PreviewState {
  area: Area;
  active: boolean;
  /** Mouse position in area pixels; hover follows the client's addComponentOptions rule. */
  mouse: [number, number] | null;
  showHidden: boolean;
  scroll: Record<string, number>;
  vars: string[];
  /** Test values for script ops (keyed by the op line, e.g. `pushvar,bank_x`); missing ones are 0. */
  tests?: Record<string, number>;
  /** Components hidden in the editor only (the eye in the layers panel); their subtrees are skipped. */
  hidden: string[];
}

export interface Box {
  com: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  clip: [number, number, number, number];
  parent: string;
  originX: number;
  originY: number;
}

const TYPES: Record<string, number> = { layer: 0, overlay: 0, inv: 2, rect: 3, text: 4, graphic: 5, model: 6, invtext: 7 };
const SCROLLBAR_TRACK = 0x23201b;
const SCROLLBAR_GRIP_FOREGROUND = 0x4d4233;
const SCROLLBAR_GRIP_HIGHLIGHT = 0x766654;
const SCROLLBAR_GRIP_LOWLIGHT = 0x332d25;

/**
 * Where every component sits on screen, whether or not it is drawn (inside a hide=yes layer,
 * eye-hidden or clipped): the same placement as render, for marking the selection.
 */
export function layout(model: IfModel, state: PreviewState): Box[] {
  const [width, height] = AREAS[state.area];
  const out: Box[] = [];
  const walk = (name: string, x: number, y: number, scrollY: number) => {
    for (const childName of model.children.get(name) ?? []) {
      const child = find(model, childName);
      if (!child) continue;
      const childX = x + num(child, "x");
      const childY = y + num(child, "y") - scrollY;
      const { w, h } = boxOf(child);
      out.push({ com: childName, type: get(child, "type") ?? "", x: childX, y: childY, w, h, clip: [0, 0, width, height], parent: name, originX: x, originY: y - scrollY });
      if (["layer", "overlay"].includes(get(child, "type") ?? "")) {
        const max = num(child, "scroll") - num(child, "height");
        walk(childName, childX, childY, Math.max(0, Math.min(state.scroll[childName] ?? 0, max)));
      }
    }
  };
  walk("", 0, 0, 0);
  return out;
}

export function render(model: IfModel, assets: Assets, state: PreviewState): { width: number; height: number; pixels: Int32Array; boxes: Box[] } {
  const [width, height] = AREAS[state.area];
  const s = new Surface(width, height);
  const boxes: Box[] = [];
  // the packer gives the root type=layer, width=512, height=334 before reading the file
  const typeOf = (c: Com) => TYPES[get(c, "type") ?? (c === model.root ? "layer" : "")] ?? -1;
  const yes = (c: Com, k: string) => get(c, k) === "yes";
  const size = (c: Com, k: "width" | "height", def: number) => (get(c, k) === undefined ? def : num(c, k));
  const pair = (v: string | undefined): [number, number] => {
    const [a, b] = (v ?? "").split(",");
    return [parseNum(a), parseNum(b)];
  };
  // getIfActive: only components with comparisons (scriptN) can be active
  const active = (c: Com) => state.active && [1, 2, 3, 4, 5].some((j) => get(c, `script${j}`) !== undefined);
  const scrollOf = (c: Com) => {
    const max = num(c, "scroll") - num(c, "height");
    return Math.max(0, Math.min(state.scroll[c.name] ?? 0, max));
  };

  // Client.addComponentOptions: the last component under the mouse with an overlayer or an
  // overcolour is hovered (its overlayer if it has one). Hidden layers are not entered.
  let hover: string | null = null;
  const findHover = (com: Com, mx: number, my: number, x: number, y: number, scrollY: number) => {
    const w = size(com, "width", com === model.root ? 512 : 0);
    const h = size(com, "height", com === model.root ? 334 : 0);
    if (typeOf(com) !== 0 || yes(com, "hide") || mx < x || my < y || mx > x + w || my > y + h) return;
    for (const childName of model.children.get(com.name) ?? []) {
      const child = find(model, childName);
      if (!child || state.hidden.includes(childName)) continue;
      const childX = x + num(child, "x");
      const childY = y + num(child, "y") - scrollY;
      const over = get(child, "overlayer");
      const overLayer = over !== undefined && find(model, over) ? over : null;
      if ((overLayer !== null || num(child, "overcolour") !== 0) && mx >= childX && my >= childY && mx < childX + num(child, "width") && my < childY + num(child, "height")) {
        hover = overLayer ?? childName;
      }
      if (typeOf(child) === 0) findHover(child, mx, my, childX, childY, scrollOf(child));
    }
  };
  if (state.mouse) findHover(model.root, state.mouse[0], state.mouse[1], 0, 0, 0);
  const font = (c: Com) => {
    const id = FONT_NAMES.indexOf(get(c, "font") as (typeof FONT_NAMES)[number]);
    return id === -1 ? undefined : assets.font(id);
  };

  const drawInterface = (com: Com, x: number, y: number, scrollY: number) => {
    const name = com.name;
    if (typeOf(com) !== 0 || (yes(com, "hide") && !state.showHidden && hover !== name)) return;
    const [left, top, right, bottom] = [s.clipMinX, s.clipMinY, s.clipMaxX, s.clipMaxY];
    const w = size(com, "width", com === model.root ? 512 : 0);
    const h = size(com, "height", com === model.root ? 334 : 0);
    s.setClipping(x, y, x + w, y + h);

    for (const childName of model.children.get(name) ?? []) {
      const child = find(model, childName);
      if (!child || state.hidden.includes(childName)) continue;
      const childX = x + num(child, "x");
      const childY = y + num(child, "y") - scrollY;
      const type = typeOf(child);
      const cw = num(child, "width");
      const ch = num(child, "height");
      const [mx, my] = pair(get(child, "margin"));
      const { w: bw, h: bh } = boxOf(child);
      boxes.push({
        com: childName, type: get(child, "type") ?? "", x: childX, y: childY, w: bw, h: bh,
        clip: [s.clipMinX, s.clipMinY, s.clipMaxX, s.clipMaxY], parent: name, originX: x, originY: y - scrollY,
      });
      const hovered = hover === childName;
      const isActive = active(child);
      let colour = isActive ? num(child, "activecolour") : num(child, "colour");
      const over = isActive ? num(child, "activeovercolour") : num(child, "overcolour");
      if (hovered && over !== 0) colour = over;

      if (type === 0) {
        const scrollHeight = num(child, "scroll");
        const scrollPos = scrollOf(child);
        drawInterface(child, childX, childY, scrollPos);
        if (scrollHeight > ch) drawScrollbar(childX + cw, childY, scrollPos, scrollHeight, ch);
      } else if (type === 2) {
        let slot = 0;
        for (let row = 0; row < ch; row++) {
          for (let col = 0; col < cw; col++) {
            let slotX = childX + col * (mx + 32);
            let slotY = childY + row * (my + 32);
            const bg = slot < 20 ? get(child, `slot${slot + 1}`) : undefined;
            if (bg !== undefined) {
              const [sprite, offset] = bg.split(":");
              const [dx, dy] = pair(offset || "0,0");
              slotX += dx;
              slotY += dy;
              const image = sprite.length > 0 ? assets.sprite(sprite) : undefined;
              if (image) s.plotSprite(image, slotX, slotY);
            }
            slot++;
          }
        }
      } else if (type === 3) {
        const trans = num(child, "trans") & 0xff;
        if (trans === 0) {
          if (yes(child, "fill")) s.fillRect(childX, childY, cw, ch, colour);
          else s.drawRect(childX, childY, cw, ch, colour);
        } else if (yes(child, "fill")) {
          s.fillRectTrans(childX, childY, cw, ch, colour, 256 - trans);
        } else {
          s.drawRect(childX, childY, cw, ch, colour);
          s.drawRectTrans(childX, childY, cw, ch, colour, 256 - trans);
        }
      } else if (type === 4) {
        const f = font(child);
        let text = get(child, "text") ?? "";
        const activeText = get(child, "activetext");
        if (isActive && activeText) text = activeText;
        if (width === 479) {
          if (colour === 0xffff00) colour = 0x0000ff;
          if (colour === 0x00c000) colour = 0xffffff;
        }
        if (!f || !text) continue;
        for (let i = 0; i < 5; i++) text = text.split(`%${i + 1}`).join(state.vars[i] ?? "");
        const shadowed = yes(child, "shadowed");
        for (let lineY = childY + f.height; text.length > 0; lineY += f.height) {
          const newline = text.indexOf("\\n");
          const line = newline === -1 ? text : text.substring(0, newline);
          text = newline === -1 ? "" : text.substring(newline + 2);
          if (yes(child, "center")) s.centreStringTag(f, line, childX + ((cw / 2) | 0), lineY, colour, shadowed);
          else s.drawStringTag(f, line, childX, lineY, colour, shadowed);
        }
      } else if (type === 5) {
        const spec = isActive ? get(child, "activegraphic") : get(child, "graphic");
        const image = spec ? assets.sprite(spec) : undefined;
        if (image) s.plotSprite(image, childX, childY);
      }
      // type 6 (model) and 7 (invtext, empty inventory) draw nothing in the preview
    }
    s.setClipping(left, top, right, bottom);
  };

  const drawScrollbar = (x: number, y: number, scrollY: number, scrollHeight: number, h: number) => {
    const plot = (t: Tile | undefined, px: number, py: number) => t && s.plotSprite(t, px, py, true);
    plot(assets.sprite("scrollbar,0"), x, y);
    plot(assets.sprite("scrollbar,1"), x, y + h - 16);
    s.fillRect(x, y + 16, 16, h - 32, SCROLLBAR_TRACK);
    let gripSize = (((h - 32) * h) / scrollHeight) | 0;
    if (gripSize < 8) gripSize = 8;
    const gripY = (((h - gripSize - 32) * scrollY) / (scrollHeight - h)) | 0;
    s.fillRect(x, y + gripY + 16, 16, gripSize, SCROLLBAR_GRIP_FOREGROUND);
    s.vline(x, y + gripY + 16, gripSize, SCROLLBAR_GRIP_HIGHLIGHT);
    s.vline(x + 1, y + gripY + 16, gripSize, SCROLLBAR_GRIP_HIGHLIGHT);
    s.hline(x, y + gripY + 16, 16, SCROLLBAR_GRIP_HIGHLIGHT);
    s.hline(x, y + gripY + 17, 16, SCROLLBAR_GRIP_HIGHLIGHT);
    s.vline(x + 15, y + gripY + 16, gripSize, SCROLLBAR_GRIP_LOWLIGHT);
    s.vline(x + 14, y + gripY + 17, gripSize - 1, SCROLLBAR_GRIP_LOWLIGHT);
    s.hline(x, y + gripY + gripSize + 15, 16, SCROLLBAR_GRIP_LOWLIGHT);
    s.hline(x + 1, y + gripY + gripSize + 14, 15, SCROLLBAR_GRIP_LOWLIGHT);
  };

  drawInterface(model.root, 0, 0, 0);
  return { width, height, pixels: s.pixels, boxes };
}
