// Slider controls for the numeric keys that change a preview. `min`/`max` are what the client
// can read for the key (its opcode's width and signedness, or the table it indexes) and clamp
// every value; `lo`/`hi` is the slider's usual span, widened to include the current value.
import { Lines, value } from "./scene";

interface Spec {
  key: string;
  min: number;
  max: number;
  lo: number;
  hi: number;
  step?: number;
  /** used when the block does not set the key */
  def: number;
  /** read as a signed 16-bit value (g2b): 65534 means -2 */
  signed16?: boolean;
  /** only in these preview views */
  views?: string[];
}

export interface Control extends Required<Omit<Spec, "signed16" | "views">> {
  value: number;
  /** whether the block sets the key (else `value` is the default) */
  set: boolean;
}

const U16 = { min: 0, max: 65535 };
const S16 = { min: -32768, max: 32767, signed16: true };
const ANGLE = { min: 0, max: 2047, lo: 0, hi: 2047, def: 0 };
const RESIZE = { ...U16, lo: 0, hi: 512, def: 128 };

const OBJ_ICON = ["inventory"];
const OBJ_GROUND = ["ground", "inventory"];

const SPECS: Record<string, Spec[]> = {
  "runescript-obj": [
    { key: "2dzoom", ...U16, lo: 0, hi: 5000, def: 2000, views: OBJ_ICON },
    { key: "2dxan", ...ANGLE, views: OBJ_ICON },
    { key: "2dyan", ...ANGLE, views: OBJ_ICON },
    { key: "2dzan", ...ANGLE, views: OBJ_ICON },
    { key: "2dxof", ...S16, lo: -1000, hi: 1000, def: 0, views: OBJ_ICON },
    { key: "2dyof", ...S16, lo: -1000, hi: 1000, def: 0, views: OBJ_ICON },
    { key: "resizex", ...RESIZE, views: OBJ_GROUND },
    { key: "resizey", ...RESIZE, views: OBJ_GROUND },
    { key: "resizez", ...RESIZE, views: OBJ_GROUND },
    // g1b; contrast is multiplied by 5 on decode
    { key: "ambient", min: -128, max: 127, lo: -128, hi: 127, def: 0, views: OBJ_GROUND },
    { key: "contrast", min: -128, max: 127, lo: -128, hi: 127, def: 0, views: OBJ_GROUND },
  ],
  "runescript-loc": [
    { key: "resizex", ...RESIZE },
    { key: "resizey", ...RESIZE },
    { key: "resizez", ...RESIZE },
    { key: "offsetx", ...S16, lo: -256, hi: 256, def: 0 },
    { key: "offsety", ...S16, lo: -256, hi: 256, def: 0 },
    { key: "offsetz", ...S16, lo: -256, hi: 256, def: 0 },
    // read as a byte and masked to 0..255
    { key: "ambient", min: 0, max: 255, lo: 0, hi: 255, def: 0 },
    { key: "contrast", min: 0, max: 255, lo: 0, hi: 255, def: 0 },
  ],
  "runescript-npc": [
    { key: "resizeh", ...RESIZE },
    { key: "resizev", ...RESIZE },
  ],
  "runescript-spotanim": [
    { key: "resizeh", ...RESIZE },
    { key: "resizev", ...RESIZE },
    // the client turns by whole quarters
    { key: "angle", ...U16, lo: 0, hi: 270, step: 90, def: 0 },
    { key: "ambient", min: 0, max: 255, lo: 0, hi: 255, def: 0 },
    { key: "contrast", min: 0, max: 255, lo: 0, hi: 255, def: 0 },
  ],
};

/** Clamps `v` to the key's range; signed 16-bit keys read their unsigned spelling as negative. */
export function normalise(spec: { min: number; max: number }, v: number, signed16 = false): number {
  if (signed16 && v > 32767 && v <= 65535) v -= 65536;
  return Math.min(spec.max, Math.max(spec.min, Math.round(v)));
}

/** The sliders for a block of `language` in `view`, with the block's current values. */
export function controlsFor(language: string, lines: Lines, view: string): Control[] {
  return (SPECS[language] ?? [])
    .filter((s) => !s.views || s.views.includes(view))
    .map((s) => {
      const raw = value(lines, s.key);
      const parsed = raw === undefined ? NaN : Number(raw);
      const set = !Number.isNaN(parsed);
      const v = set ? normalise(s, parsed, s.signed16) : s.def;
      return { key: s.key, min: s.min, max: s.max, lo: Math.min(s.lo, v), hi: Math.max(s.hi, v), step: s.step ?? 1, def: s.def, value: v, set };
    });
}

/** Clamps a value for `key` of `language` (unknown keys pass through rounded). */
export function clampFor(language: string, key: string, v: number): number {
  const s = SPECS[language]?.find((c) => c.key === key);
  return s ? normalise(s, v, s.signed16) : Math.round(v);
}

/** A text replacement: from [line, character] to [line, character]. */
export interface TextEdit {
  from: [number, number];
  to: [number, number];
  text: string;
}

/**
 * The edit that sets `key` to `v` in the block whose header is line `start` (body up to `end`,
 * exclusive): rewrites the value of the key's last line (keeping a trailing comment), or adds
 * `key=v` after the block's last non-blank line. `v` undefined removes the key's last line.
 */
export function keyEdit(text: string[], start: number, end: number, key: string, v: number | undefined, eol = "\n"): TextEdit | undefined {
  const re = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)(.*?)(\\s*//.*)?$`);
  for (let i = end - 1; i > start; i--) {
    const m = re.exec(text[i]);
    if (!m) continue;
    if (v === undefined) return i + 1 < text.length ? { from: [i, 0], to: [i + 1, 0], text: "" } : { from: [i - 1, text[i - 1].length], to: [i, text[i].length], text: "" };
    return { from: [i, m[1].length], to: [i, m[1].length + m[2].length], text: String(v) };
  }
  if (v === undefined) return undefined;
  let last = end - 1;
  while (last > start && text[last].trim() === "") last--;
  return { from: [last, text[last].length], to: [last, text[last].length], text: `${eol}${key}=${v}` };
}

/**
 * The edits for several key changes in one block, all computed against `text` (so they can go
 * in one WorkspaceEdit). Keys added at the same place are joined into one insertion.
 */
export function keyEdits(text: string[], start: number, end: number, changes: [string, number | undefined][], eol = "\n"): TextEdit[] {
  const out: TextEdit[] = [];
  for (const [k, v] of changes) {
    const e = keyEdit(text, start, end, k, v, eol);
    if (!e) continue;
    const same = out.find((o) => o.from[0] === e.from[0] && o.from[1] === e.from[1] && o.to[0] === e.to[0] && o.to[1] === e.to[1] && e.from[0] === e.to[0] && e.from[1] === e.to[1]);
    if (same) same.text += e.text;
    else out.push(e);
  }
  return out;
}

export interface RecolSlot {
  slot: number;
  /** RGB15 values; undefined when the block lacks that half */
  s?: number;
  d?: number;
}

/** The block's `recol#s/d` slots (RGB15), ascending. */
export function recolSlots(lines: Lines): RecolSlot[] {
  const slots = new Map<number, RecolSlot>();
  for (const [k, v] of lines) {
    const m = /^recol(\d+)([sd])$/.exec(k);
    const n = Number(v);
    if (!m || v === "" || Number.isNaN(n)) continue;
    const slot = slots.get(Number(m[1])) ?? { slot: Number(m[1]) };
    slot[m[2] as "s" | "d"] = n;
    slots.set(slot.slot, slot);
  }
  return [...slots.values()].sort((a, b) => a.slot - b.slot);
}

/** The first slot 1-9 that neither a recol nor a retex key uses (the packer reads one digit). */
export function freeRecolSlot(lines: Lines): number | undefined {
  const used = new Set(lines.map(([k]) => /^(?:recol|retex)(\d+)[sd]$/.exec(k)?.[1]).filter((n) => n !== undefined).map(Number));
  for (let n = 1; n <= 9; n++) if (!used.has(n)) return n;
  return undefined;
}

/** `lines` with `key` set to `v` (last occurrence replaced, else appended) or removed (v undefined). */
export function withValue(lines: Lines, key: string, v: number | undefined): Lines {
  const out = lines.filter(([k]) => k !== key);
  if (v !== undefined) out.push([key, String(v)]);
  return out;
}
