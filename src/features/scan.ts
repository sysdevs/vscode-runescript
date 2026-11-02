// Pure text scanners shared by the providers. No vscode import so they can be unit tested.
// ponytail: regex over whole files, no parser; replaced by the ares-compiler language server in phase 2.

export interface Header { trigger: string; subject: string; line: number; }
export interface Section { name: string; line: number; }
export interface Colour { line: number; start: number; end: number; hex: string; }
export interface Word { sigil: "" | "$" | "%" | "^" | "~" | "@"; name: string; start: number; end: number; }

const IDENT = "[A-Za-z0-9_+.:]+";
const HEADER = /^\s*\[([A-Za-z0-9_]+),\s*([^\]]*)\]/;
const SECTION = /^\[([^\]]+)\]\s*$/;
const CONSTANT = /^\^([A-Za-z0-9_+.:]+)\s*=/;
const COLOUR = /\b0x([0-9a-fA-F]{6})\b/g;

export function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** `[trigger,subject]` script headers in a .rs2 file. */
export function scriptHeaders(text: string): Header[] {
  const out: Header[] = [];
  lines(text).forEach((l, line) => {
    const m = HEADER.exec(l);
    if (m) out.push({ trigger: m[1], subject: m[2].trim(), line });
  });
  return out;
}

/** `[name]` sections in a config file, or `^name` definitions in a .constant file. */
export function sections(text: string): Section[] {
  const out: Section[] = [];
  lines(text).forEach((l, line) => {
    const m = SECTION.exec(l) ?? CONSTANT.exec(l);
    if (m) out.push({ name: l.startsWith("^") ? "^" + m[1] : m[1], line });
  });
  return out;
}

/** Every `0xRRGGBB` in a config file. */
export function colours(text: string): Colour[] {
  const out: Colour[] = [];
  lines(text).forEach((l, line) => {
    for (const m of l.matchAll(COLOUR)) {
      out.push({ line, start: m.index, end: m.index + m[0].length, hex: m[1] });
    }
  });
  return out;
}

/** The identifier under `col` in `line`, with its sigil (`~proc`, `@label`, `^const`, `%var`, `$local`). */
export function wordAt(line: string, col: number): Word | undefined {
  const re = new RegExp(IDENT, "g");
  for (const m of line.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    const before = line[start - 1];
    const sigil = before === "$" || before === "%" || before === "^" || before === "~" || before === "@" ? before : "";
    return { sigil, name: m[0], start, end };
  }
  return undefined;
}
