// What the webview is sent: a rendered frame of the interface and the catalog of
// sprites, fonts and picker lists. Kept free of the vscode API so it runs under node --test.
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Assets, FONT_NAMES } from "./assets";
import { get, parseIf } from "./parse";
import { Surface } from "./pix";
import { decodePng } from "./png";
import { AREAS, PreviewState, layout, render } from "./render";
import { Condition, compare, evalScript, readConditions, schemaData } from "./schema";

const PICKER_PACKS = ["model", "seq", "obj", "varp", "varbit", "interface"];

export function buildFrame(stem: string, text: string, assets: Assets, state: PreviewState) {
  const model = parseIf(stem, text);
  const r = render(model, assets, state);
  const s = new Surface(r.width, r.height);
  s.pixels.set(r.pixels);
  return {
    type: "frame",
    name: stem,
    width: r.width,
    height: r.height,
    rgba: s.toRgba(),
    boxes: r.boxes,
    layout: layout(model, state),
    coms: model.coms.map((c) => ({ name: c.name, keys: c.keys.map((k) => [k.key, k.value]), conds: readConditions((k) => get(c, k)).map((cond) => test(cond, state)) })),
    tree: Object.fromEntries(model.children),
    root: model.root.keys.map((k) => [k.key, k.value]),
    warnings: model.warnings,
    state,
  };
}

/** A condition with what it computes from the state's test values, for the scripts panel. */
function test(cond: Condition, state: PreviewState) {
  const result = evalScript(cond.ops ?? [], (op) => state.tests?.[op.join(",")] ?? 0);
  return { ...cond, result, pass: cond.cmp === null ? null : compare(cond.cmp, result, parseInt(cond.value, 10)) };
}

export function buildCatalog(root: string, assets: Assets, text: string) {
  const sheets = assets.sheetNames().flatMap((name) => {
    const s = assets.sheet(name);
    if (!s) return [];
    const img = decodePng(readFileSync(join(root, "sprites", `${name}.png`)));
    const rgba = img.rgba;
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === 255 && rgba[i + 1] === 0 && rgba[i + 2] === 255) rgba[i + 3] = 0;
    return [{ name, tileW: s.tileW, tileH: s.tileH, cols: s.cols, rows: s.rows, width: img.width, height: img.height, rgba }];
  });
  const fonts = FONT_NAMES.flatMap((name, id) => {
    const f = assets.font(id);
    if (!f) return [];
    const sample = "The quick brown fox";
    const s = new Surface(new Surface(1, 1).stringWid(f, sample) + 2, f.height + 4);
    s.drawStringTag(f, sample, 0, f.height, 0xff981f, true);
    const rgba = s.toRgba();
    for (let i = 0; i < s.pixels.length; i++) if (s.pixels[i] === 0) rgba[i * 4 + 3] = 0;
    return [{ name, width: s.width, height: s.height, rgba }];
  });
  const lists: Record<string, string[]> = {};
  for (const p of PICKER_PACKS) {
    const file = join(root, "pack", `${p}.pack`);
    const names = existsSync(file) ? readFileSync(file, "latin1").split(/\r?\n/).flatMap((l) => (l.includes("=") ? [l.slice(l.indexOf("=") + 1)] : [])) : [];
    lists[p] = p === "interface" ? names.filter((n) => n.includes(":")) : names;
  }
  const colours = [...new Set((text.match(/colour=0x[0-9a-fA-F]{6}/g) ?? []).map((c) => parseInt(c.slice(9), 16)))];
  return { type: "catalog", sheets, fonts, lists, colours, areas: AREAS, schema: schemaData() };
}
