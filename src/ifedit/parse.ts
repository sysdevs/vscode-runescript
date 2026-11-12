// `.if` interface text -> model. Mirrors ares-gameserver src/pack/interface.rs: one file per
// interface, `[com]` headers, `key=value` lines (no trimming, last duplicate wins),
// `layer=` moving a component from the root's child list to the layer's.
import { NUMBERS as NUMBERS3 } from "./schema3";

export interface KeyLine {
  key: string;
  value: string;
  line: number;
}

export interface Com {
  name: string;
  header: number;
  /** Exclusive: the line after the component's last non-empty line. */
  end: number;
  keys: KeyLine[];
}

export interface Warning {
  line: number;
  message: string;
}

export interface IfModel {
  name: string;
  eol: "\n" | "\r\n";
  lines: string[];
  root: Com;
  coms: Com[];
  /** Parent name ("" = root) -> child names in draw order. */
  children: Map<string, string[]>;
  warnings: Warning[];
}

const NUM_KEYS = new Set(["x", "y", "width", "height", "scroll", "trans", "zoom", "xan", "yan", "clientcode"]);
const NUM_KEYS3 = new Set(NUMBERS3);
const INT = /^-?(0x[0-9a-fA-F]+|\d+)$/;

/** `.if` (IF1) or `.if3`: the file's extension, which picks the packer. */
export type Format = "if" | "if3";

/**
 * `.if3` (interface3.rs load_if3) differs: `//` lines are skipped, `param` repeats, a line without
 * `=` or a key before the first header fails the build, and the root is an implicit full-size layer.
 */
export function parseIf(name: string, text: string, format: Format = "if"): IfModel {
  const if3 = format === "if3";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const root: Com = { name: "", header: -1, end: 0, keys: if3 ? [{ key: "type", value: "layer", line: -1 }, { key: "widthmode", value: "minus", line: -1 }, { key: "heightmode", value: "minus", line: -1 }] : [] };
  const coms: Com[] = [];
  const warnings: Warning[] = [];
  const rootKids: string[] = [];
  const children = new Map<string, string[]>([["", rootKids]]);
  const layerLines: KeyLine[] = [];
  let cur = root;

  lines.forEach((line, n) => {
    if (line === "" || (if3 && line.startsWith("//"))) return;
    if (line.startsWith("[")) {
      const com = line.slice(1, -1);
      if (coms.some((c) => c.name === com)) warnings.push({ line: n, message: `duplicate component [${com}]` });
      cur = { name: com, header: n, end: n + 1, keys: [] };
      coms.push(cur);
      rootKids.push(com);
      return;
    }
    cur.end = n + 1;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq);
    const value = eq === -1 ? line : line.slice(eq + 1);
    if (eq === -1) warnings.push({ line: n, message: if3 ? "line has no '=': the packer fails" : "line has no '=': the packer stores it under an empty key" });
    // only the key: trailing spaces in text= / option= values are real content
    else if (key !== key.trim()) warnings.push({ line: n, message: "spaces around '=' are kept by the packer" });
    if (if3 && cur === root) warnings.push({ line: n, message: "key before the first [component]: the packer fails" });
    if (!if3 && value.includes("//")) warnings.push({ line: n, message: "'//' comments are not stripped by the packer" });
    if (!(if3 && key === "param") && cur.keys.some((k) => k.key === key && k.line !== -1)) warnings.push({ line: n, message: `duplicate key ${key}: the last one wins` });
    if ((if3 ? NUM_KEYS3 : NUM_KEYS).has(key) && !INT.test(value)) warnings.push({ line: n, message: `${key} is not a number: the packer fails` });
    const kl = { key, value, line: n };
    cur.keys.push(kl);
    if (key === "layer") {
      layerLines.push(kl);
      if (cur !== root) {
        // a second layer= on the same component appends again, like the packer (which then errors)
        const kids = children.get(value) ?? [];
        kids.push(cur.name);
        children.set(value, kids);
        const i = rootKids.lastIndexOf(cur.name);
        if (i !== -1) rootKids.splice(i, 1);
      }
    }
  });
  for (const kl of layerLines) {
    const target = coms.find((c) => c.name === kl.value);
    if (!target) warnings.push({ line: kl.line, message: `layer ${kl.value} does not exist` });
    else if (if3 && get(target, "type") !== "layer") warnings.push({ line: kl.line, message: `layer ${kl.value} is not a type=layer component: the packer fails` });
  }
  warnings.sort((a, b) => a.line - b.line);
  return { name, eol, lines, root, coms, children, warnings };
}

/** The packer's value for `key`: the last occurrence. */
export function get(com: Com, key: string): string | undefined {
  for (let i = com.keys.length - 1; i >= 0; i--) if (com.keys[i].key === key) return com.keys[i].value;
  return undefined;
}

/** The packer's int(): decimal or 0x hex with optional '-'; anything else is 0 here (a build error there). */
export function num(com: Com, key: string): number {
  return parseNum(get(com, key));
}

export function parseNum(v: string | undefined): number {
  if (v === undefined || !INT.test(v)) return 0;
  const neg = v.startsWith("-");
  const s = neg ? v.slice(1) : v;
  const n = s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 10);
  return neg ? -n : n;
}

/** A component's size in pixels: inv and invtext width/height count cells (Client.drawInterface). */
export function boxOf(com: Com): { w: number; h: number } {
  const w = num(com, "width");
  const h = num(com, "height");
  const [mx, my] = (get(com, "margin") ?? "").split(",").map((v) => parseNum(v));
  const type = get(com, "type");
  if (type === "inv") return { w: w * (32 + (mx ?? 0)) - (mx ?? 0), h: h * (32 + (my ?? 0)) - (my ?? 0) };
  if (type === "invtext") return { w: w * (115 + (mx ?? 0)), h: h * (12 + (my ?? 0)) };
  return { w, h };
}

/** The name of the layer `name` is drawn in ("" for the root), or undefined if it is not in the tree. */
export function parentOf(model: IfModel, name: string): string | undefined {
  for (const [parent, kids] of model.children) if (kids.includes(name)) return parent;
  return undefined;
}

export function find(model: IfModel, name: string): Com | undefined {
  return name === "" ? model.root : model.coms.find((c) => c.name === name);
}
