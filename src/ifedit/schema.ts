// What the packer (ares-gameserver src/pack/interface.rs) accepts, as data for the editor.
import type { Intent } from "./edits";

/** Layout keys in the order the editor writes them; other keys go after them. */
export const KEY_ORDER = ["type", "layer", "x", "y", "width", "height"];

/** Keys a new component starts with (x and y are added where it is dropped). */
export const NEW_COM: Record<"rect" | "text" | "graphic" | "layer" | "inv" | "invtext" | "model", [string, string][]> = {
  rect: [["type", "rect"], ["width", "32"], ["height", "32"], ["colour", "0xff981f"], ["fill", "yes"]],
  text: [["type", "text"], ["width", "100"], ["height", "12"], ["font", "p12_full"], ["colour", "0xff981f"], ["shadowed", "yes"], ["text", "Text"]],
  graphic: [["type", "graphic"], ["width", "32"], ["height", "32"]],
  layer: [["type", "layer"], ["width", "100"], ["height", "100"]],
  inv: [["type", "inv"], ["width", "4"], ["height", "7"], ["margin", "10,4"]],
  invtext: [["type", "invtext"], ["width", "2"], ["height", "10"], ["font", "p11_full"], ["colour", "0xffffff"]],
  model: [["type", "model"], ["width", "32"], ["height", "32"], ["zoom", "1000"]],
};

export const TYPES = ["layer", "overlay", "inv", "rect", "text", "graphic", "model", "invtext"];
export const BUTTON_TYPES = ["normal", "target", "close", "toggle", "select", "pause"];
/** What the client shows for an empty `option` (IfType.ts). */
export const BUTTON_DEFAULT_OPTION: Record<string, string> = { normal: "Ok", toggle: "Select", select: "Select", pause: "Continue" };
export const TARGET_FLAGS = ["obj", "npc", "loc", "player", "heldobj"];
export const FONTS = ["p11_full", "p12_full", "b12_full", "q8_full"];

const COLOURS = ["colour", "activecolour", "overcolour", "activeovercolour"];
const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const PER_TYPE: Record<string, string[]> = {
  layer: ["scroll", "hide"],
  overlay: ["scroll", "hide"],
  inv: ["draggable", "interactable", "usable", "swappable", "margin", ...range("option", 5), ...range("slot", 20)],
  rect: ["fill", "trans", ...COLOURS],
  text: ["font", "text", "activetext", "center", "shadowed", ...COLOURS],
  graphic: ["graphic", "activegraphic"],
  model: ["model", "activemodel", "anim", "activeanim", "zoom", "xan", "yan"],
  invtext: ["font", "center", "shadowed", "colour", "margin", "interactable", ...range("option", 5)],
};

/** The keys ares-gameserver interface.rs packs for this type and button type. */
export function fieldsFor(type: string, buttontype: string | undefined): string[] {
  const out = ["x", "y", "width", "height", "layer", "buttontype", "clientcode", "overlayer"];
  if (buttontype !== undefined && buttontype in BUTTON_DEFAULT_OPTION) out.push("option");
  if (buttontype === "target" || type === "inv") out.push("actionverb", "action", "actiontarget");
  return [...out, ...(PER_TYPE[type] ?? [])];
}

export const COMPARATORS = ["eq", "lt", "gt", "neq"];
/** Script ops and the kind of each operand (interface.rs SCRIPT_OPS / script_operands). */
export const SCRIPT_OPS: Record<string, ("stat" | "invcom" | "obj" | "varp" | "varbit" | "int")[]> = {
  stat_level: ["stat"], stat_base_level: ["stat"], stat_xp: ["stat"], stat_xp_remaining: ["stat"],
  inv_count: ["invcom", "obj"], inv_contains: ["invcom", "obj"], pushvar: ["varp"], testbit: ["varp", "int"],
  push_varbit: ["varbit"], push_constant: ["int"], runenergy: [], runweight: [], subtract: [], divide: [],
  multiply: [], coordx: [], coordz: [], op7: [], op8: [], op9: [],
};
/** Editor labels for script ops; maths ops set how the next value combines (default add). */
export const SCRIPT_OP_INFO: Record<string, { label: string; group: string }> = {
  inv_count: { label: "Count of item", group: "Inventory" },
  inv_contains: { label: "Holds item (non-zero if so)", group: "Inventory" },
  pushvar: { label: "Varp value", group: "Variables" },
  testbit: { label: "Varp bit (0/1)", group: "Variables" },
  push_varbit: { label: "Varbit value", group: "Variables" },
  push_constant: { label: "Number", group: "Variables" },
  stat_level: { label: "Skill level", group: "Skills" },
  stat_base_level: { label: "Skill base level", group: "Skills" },
  stat_xp: { label: "Skill xp", group: "Skills" },
  stat_xp_remaining: { label: "Xp to next level", group: "Skills" },
  op8: { label: "Combat level", group: "Player" },
  op9: { label: "Total level", group: "Player" },
  runenergy: { label: "Run energy", group: "Player" },
  runweight: { label: "Weight", group: "Player" },
  coordx: { label: "Tile x", group: "Player" },
  coordz: { label: "Tile z", group: "Player" },
  subtract: { label: "−", group: "Maths" },
  divide: { label: "÷", group: "Maths" },
  multiply: { label: "×", group: "Maths" },
  op7: { label: "op7 (unknown)", group: "Unknown" },
};
export const MATHS_OPS = ["subtract", "divide", "multiply"];
export const COMPARATOR_LABELS: Record<string, string> = { eq: "=", neq: "≠", lt: "<", gt: ">" };

/** Quick-add scripts: the patterns Content uses most. */
export const SCRIPT_PRESETS: { label: string; cond: Condition }[] = [
  { label: "Has item in inventory", cond: { cmp: "gt", value: "0", ops: [["inv_count", "inventory:inv", ""]] } },
  { label: "Varp equals", cond: { cmp: "eq", value: "1", ops: [["pushvar", ""]] } },
  { label: "Varp bit is set", cond: { cmp: "eq", value: "1", ops: [["testbit", "", "0"]] } },
  { label: "Skill level at least", cond: { cmp: "gt", value: "0", ops: [["stat_level", "attack"]] } },
  { label: "Show a varp (%N only)", cond: { cmp: null, value: "", ops: [["pushvar", ""]] } },
];

/**
 * The client's script fold: values add into the result unless a maths op set another operator
 * for the next one. `value(op)` supplies everything but push_constant. Int32 maths; a 0 divisor
 * leaves the result as it is (ponytail: from memory of the 274 client, unchecked).
 */
export function evalScript(ops: string[][], value: (op: string[]) => number): number {
  let result = 0;
  let operator = "";
  for (const op of ops) {
    if (MATHS_OPS.includes(op[0])) {
      operator = op[0];
      continue;
    }
    const v = op[0] === "push_constant" ? parseInt(op[1], 10) | 0 : value(op) | 0;
    if (operator === "subtract") result = (result - v) | 0;
    else if (operator === "divide") result = v === 0 ? result : (result / v) | 0;
    else if (operator === "multiply") result = Math.imul(result, v);
    else result = (result + v) | 0;
    operator = "";
  }
  return result;
}

/** getIfActive for one comparison. */
export function compare(cmp: string, v: number, against: number): boolean {
  return cmp === "eq" ? v === against : cmp === "neq" ? v !== against : cmp === "lt" ? v < against : cmp === "gt" ? v > against : false;
}

export const STATS = ["attack", "defence", "strength", "hitpoints", "ranged", "prayer", "magic", "cooking", "woodcutting", "fletching", "fishing", "firemaking", "crafting", "smithing", "mining", "herblore", "agility", "thieving", "runecraft"];

/**
 * Script N: its `scriptNopK` steps (the value the client computes, shown as %N in text) and an
 * optional `scriptN=cmp,value` comparison (all of them true = the component is active).
 * cmp null means no `scriptN` key; ops [] is the empty `scriptNop1=` form; ops null means no op keys.
 */
export interface Condition {
  cmp: string | null;
  value: string;
  ops: string[][] | null;
}

/** Conditions as the packer counts them: up to the larger of the scriptN and scriptNop1 counts. */
export function readConditions(get: (key: string) => string | undefined): Condition[] {
  const count = (suffix: string) => [1, 2, 3, 4, 5].filter((j) => get(`script${j}${suffix}`) !== undefined).length;
  const out: Condition[] = [];
  for (let j = 1; j <= Math.max(count(""), count("op1")); j++) {
    const raw = get(`script${j}`);
    const [cmp, value = ""]: [string | null, string?] = raw === undefined ? [null] : (raw.split(",") as [string, string?]);
    let ops: string[][] | null = null;
    if (get(`script${j}op1`) === "") ops = [];
    else {
      for (let k = 1; k <= 20; k++) {
        const op = get(`script${j}op${k}`);
        if (op !== undefined && op !== "") (ops ??= []).push(op.split(","));
      }
    }
    out.push({ cmp, value, ops });
  }
  return out;
}

/** Set intents writing `conds` contiguously from script1, deleting every other existing script key. */
export function writeConditions(com: string, conds: Condition[], existing: string[]): Intent[] {
  // the packer reads script1..count and the client pairs comparison i with script i
  const open = conds.findIndex((c) => c.cmp === null);
  if (open !== -1 && conds.slice(open).some((c) => c.cmp !== null)) {
    throw new Error(`script ${open + 1} has no comparison, so no later script can have one (move value-only scripts last)`);
  }
  const lines: [string, string][] = [];
  conds.forEach((c, i) => {
    const j = i + 1;
    if (c.cmp !== null) lines.push([`script${j}`, `${c.cmp},${c.value}`]);
    if (c.ops && c.ops.length === 0) lines.push([`script${j}op1`, ""]);
    c.ops?.forEach((op, k) => lines.push([`script${j}op${k + 1}`, op.join(",")]));
  });
  const written = new Set(lines.map(([k]) => k));
  return [
    ...lines.map(([key, value]): Intent => ({ kind: "set", com, key, value })),
    ...[...new Set(existing)].filter((k) => !written.has(k)).map((key): Intent => ({ kind: "set", com, key, value: null })),
  ];
}

/** The schema as plain data for the webview. */
export function schemaData() {
  const FIELDS: Record<string, Record<string, string[]>> = {};
  for (const t of TYPES) {
    FIELDS[t] = { "": fieldsFor(t, undefined) };
    for (const b of BUTTON_TYPES) FIELDS[t][b] = fieldsFor(t, b);
  }
  return { NEW_COM, KEY_ORDER, TYPES, BUTTON_TYPES, BUTTON_DEFAULT_OPTION, TARGET_FLAGS, FONTS, FIELDS, COMPARATORS, SCRIPT_OPS, STATS, SCRIPT_OP_INFO, MATHS_OPS, COMPARATOR_LABELS, SCRIPT_PRESETS };
}
