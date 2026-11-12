// Editor intents as pure text -> text functions over `.if` files, plus the
// interface.pack / interface.order id bookkeeping. Untouched lines stay byte-identical.
import { Hook, formatHook } from "./hook";
import { Com, Format, IfModel, boxOf, find, get, num, parentOf, parseIf } from "./parse";
import { unplace } from "./render3";
import { Condition, KEY_ORDER, writeConditions } from "./schema";
import { KEY_ORDER as KEY_ORDER3 } from "./schema3";

export type Intent =
  /** `.if3`: puts a component at a pixel box inside its parent, written through its x/y/size modes. */
  | { kind: "place"; com: string; box: [number, number, number, number]; parent: [number, number] }
  /** `.if3`: replaces every `param=` line. */
  | { kind: "params"; com: string; values: string[] }
  /** `.if3`: sets (or with null removes) one hook. */
  | { kind: "hook"; com: string; key: string; hook: Hook | null }
  | { kind: "set"; com: string; key: string; value: string | null }
  | { kind: "add"; com: string; parent: string; keys: [string, string][] }
  | { kind: "delete"; com: string }
  | { kind: "reorder"; com: string; parent: string; before: string | null }
  | { kind: "conditions"; com: string; conds: Condition[] }
  | { kind: "duplicate"; coms: string[] }
  | { kind: "group"; coms: string[]; name: string }
  | { kind: "ungroup"; com: string }
  | { kind: "paste"; text: string; parent: string }
  | { kind: "batch"; intents: Intent[] };

export function applyIntent(ifName: string, text: string, intent: Intent, fmt: Format = "if"): string {
  if (intent.kind === "batch") return intent.intents.reduce((t, i) => applyIntent(ifName, t, i, fmt), text);
  const m = parseIf(ifName, text, fmt);
  if (intent.kind === "conditions") {
    const existing = (find(m, intent.com)?.keys ?? []).map((k) => k.key).filter((k) => /^script\d(op\d+)?$/.test(k));
    return applyIntent(ifName, text, { kind: "batch", intents: writeConditions(intent.com, intent.conds, existing) }, fmt);
  }
  if (intent.kind === "place") {
    const c = find(m, intent.com);
    if (!c) throw new Error(`no component ${intent.com}`);
    const want = unplace((k) => get(c, k), intent.box, intent.parent);
    const intents: Intent[] = (["x", "y", "width", "height"] as const)
      .filter((k) => want[k] !== num(c, k))
      .map((k) => ({ kind: "set", com: intent.com, key: k, value: String(want[k]) }));
    return applyIntent(ifName, text, { kind: "batch", intents }, fmt);
  }
  if (intent.kind === "hook") {
    return applyIntent(ifName, text, { kind: "set", com: intent.com, key: intent.key, value: intent.hook && intent.hook.script ? formatHook(intent.hook) : null }, fmt);
  }
  const lines = m.lines.slice();
  const order = fmt === "if3" ? KEY_ORDER3 : KEY_ORDER;
  switch (intent.kind) {
    case "set":
      setKey(m, lines, intent.com, intent.key, intent.value, order);
      break;
    case "params": {
      const c = find(m, intent.com);
      if (!c) throw new Error(`no component ${intent.com}`);
      const old = c.keys.filter((k) => k.key === "param").map((k) => k.line);
      const at = old.length ? old[0] : insertAt(c, "param", order);
      for (const l of [...old].reverse()) lines.splice(l, 1);
      lines.splice(at, 0, ...intent.values.map((v) => `param=${v}`));
      break;
    }
    case "add":
      addBlock(lines, intent.com, intent.parent, intent.keys);
      break;
    case "delete":
      for (const c of [...subtree(m, intent.com)].map((n) => find(m, n)!).sort((a, b) => b.header - a.header)) removeBlock(lines, c);
      break;
    case "reorder":
      return reorder(ifName, text, intent.com, intent.parent, intent.before, fmt);
    case "duplicate":
      return intent.coms.reduce((t, c) => duplicate(ifName, t, c, fmt), text);
    case "group":
      return group(ifName, text, intent.coms, intent.name, fmt);
    case "ungroup":
      return ungroup(ifName, text, intent.com, fmt);
    case "paste":
      return paste(ifName, text, intent.text, intent.parent, fmt);
  }
  return lines.join(m.eol);
}

/** The smallest single replacement (character offsets into oldText) turning oldText into newText. */
export function minimalEdit(oldText: string, newText: string): { start: number; end: number; text: string } | null {
  if (oldText === newText) return null;
  const segs = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = segs(oldText);
  const b = segs(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const len = (xs: string[]) => xs.reduce((n, x) => n + x.length, 0);
  const start = len(a.slice(0, p));
  return { start, end: oldText.length - len(a.slice(a.length - s)), text: b.slice(p, b.length - s).join("") };
}

export function nextComName(model: IfModel): string {
  return freshName(new Set(model.coms.map((c) => c.name)));
}

/** `com_N` one past the highest taken `com_N`. */
function freshName(taken: Set<string>): string {
  let max = -1;
  for (const name of taken) {
    const n = /^com_(\d+)$/.exec(name);
    if (n) max = Math.max(max, +n[1]);
  }
  return `com_${max + 1}`;
}

/** The exact block text of the given components' subtrees (a component under another given one is not repeated). */
export function copyText(ifName: string, text: string, coms: string[], fmt: Format = "if"): string {
  const m = parseIf(ifName, text, fmt);
  const underOther = (n: string) => {
    for (let p = parentOf(m, n); p !== undefined && p !== ""; p = parentOf(m, p)) if (coms.includes(p)) return true;
    return false;
  };
  const names = new Set(coms.filter((c) => find(m, c) && !underOther(c)).flatMap((c) => subtree(m, c)));
  const blocks = m.coms.filter((c) => names.has(c.name)).map((c) => m.lines.slice(c.header, c.end).join("\n"));
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

/**
 * Block lines for `coms` (file order) with names and overlayer= rewritten through `rename`; `layerOf`
 * gives each block's layer= value from its current one (null: no layer= line).
 */
function renamedBlocks(m: IfModel, coms: Com[], rename: Map<string, string>, layerOf: (layer: string | undefined) => string | null): string[][] {
  return coms.map((c) => {
    const body: string[] = [];
    let sawLayer = false;
    for (const line of m.lines.slice(c.header + 1, c.end)) {
      const eq = line.indexOf("=");
      const key = eq === -1 ? "" : line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === "layer") {
        const to = layerOf(value);
        if (to !== null && !sawLayer) body.push(`layer=${to}`);
        sawLayer = true;
      } else if (key === "overlayer" && rename.has(value)) {
        body.push(`overlayer=${rename.get(value)}`);
      } else {
        body.push(line);
      }
    }
    if (!sawLayer) {
      const to = layerOf(undefined);
      if (to !== null) body.splice(body[0]?.startsWith("type=") ? 1 : 0, 0, `layer=${to}`);
    }
    return [`[${rename.get(c.name) ?? c.name}]`, ...body];
  });
}

/** A copy of the subtree of `name` with fresh names, placed right after the subtree so it draws just above. */
function duplicate(ifName: string, text: string, name: string, fmt: Format): string {
  const m = parseIf(ifName, text, fmt);
  if (!find(m, name)) return text;
  const names = subtree(m, name);
  const taken = new Set(m.coms.map((c) => c.name));
  const rename = new Map<string, string>();
  for (const n of names) {
    const fresh = freshName(taken);
    taken.add(fresh);
    rename.set(n, fresh);
  }
  const coms = m.coms.filter((c) => names.includes(c.name));
  const blocks = renamedBlocks(m, coms, rename, (layer) => (layer === undefined ? null : rename.get(layer) ?? layer));
  const lines = m.lines.slice();
  lines.splice(Math.max(...coms.map((c) => c.end)), 0, ...blocks.flatMap((b) => ["", ...b]));
  return lines.join(m.eol);
}

/** Wraps sibling components in a new layer at their bounding box; positions on screen do not change. */
function group(ifName: string, text: string, coms: string[], name: string, fmt: Format): string {
  const m = parseIf(ifName, text, fmt);
  if (find(m, name)) throw new Error(`${name} already exists`);
  const parents = new Set(coms.map((c) => parentOf(m, c)));
  if (!coms.length || parents.size !== 1 || parents.has(undefined)) throw new Error("select components in the same layer to group them");
  const parent = [...parents][0]!;
  const sibs = m.children.get(parent) ?? [];
  const ordered = sibs.filter((c) => coms.includes(c));
  const boxes = ordered.map((c) => {
    const com = find(m, c)!;
    const { w, h } = boxOf(com);
    return [num(com, "x"), num(com, "y"), w, h];
  });
  const x = Math.min(...boxes.map((b) => b[0]));
  const y = Math.min(...boxes.map((b) => b[1]));
  const w = Math.max(...boxes.map((b) => b[0] + b[2])) - x;
  const h = Math.max(...boxes.map((b) => b[1] + b[3])) - y;
  // the group takes the place of the topmost selected component
  const top = sibs.indexOf(ordered[ordered.length - 1]);
  const before = sibs.slice(top + 1).find((c) => !coms.includes(c)) ?? null;
  const keys: [string, string][] = [["type", "layer"], ["x", String(x)], ["y", String(y)], ["width", String(w)], ["height", String(h)]];
  text = applyIntent(ifName, text, { kind: "add", com: name, parent, keys }, fmt);
  text = reorder(ifName, text, name, parent, before, fmt);
  ordered.forEach((c, i) => {
    text = reorder(ifName, text, c, name, null, fmt);
    text = applyIntent(ifName, text, { kind: "batch", intents: [
      { kind: "set", com: c, key: "x", value: String(boxes[i][0] - x) },
      { kind: "set", com: c, key: "y", value: String(boxes[i][1] - y) },
    ] }, fmt);
  });
  return text;
}

/** Moves the children of a layer into its parent where the layer was, then deletes the layer. */
function ungroup(ifName: string, text: string, name: string, fmt: Format): string {
  const m = parseIf(ifName, text, fmt);
  const layer = find(m, name);
  const parent = parentOf(m, name);
  if (!layer || parent === undefined) return text;
  const [lx, ly] = [num(layer, "x"), num(layer, "y")];
  for (const c of m.children.get(name) ?? []) {
    const com = find(m, c)!;
    text = applyIntent(ifName, text, { kind: "batch", intents: [
      { kind: "set", com: c, key: "x", value: String(num(com, "x") + lx) },
      { kind: "set", com: c, key: "y", value: String(num(com, "y") + ly) },
    ] }, fmt);
    text = reorder(ifName, text, c, parent, name, fmt);
  }
  return applyIntent(ifName, text, { kind: "delete", com: name }, fmt);
}

/** Appends `.if` blocks from the clipboard into `parent`, renaming names this file already has. */
function paste(ifName: string, text: string, clip: string, parent: string, fmt: Format): string {
  const src = parseIf("clipboard", clip.replace(/\r\n/g, "\n"), fmt);
  if (!src.coms.length) return text;
  const m = parseIf(ifName, text, fmt);
  const taken = new Set(m.coms.map((c) => c.name));
  const rename = new Map<string, string>();
  for (const c of src.coms) {
    const to = taken.has(c.name) ? freshName(new Set([...taken, ...src.coms.map((x) => x.name)])) : c.name;
    taken.add(to);
    rename.set(c.name, to);
  }
  const pasted = new Set(src.coms.map((c) => c.name));
  const blocks = renamedBlocks(src, src.coms, rename, (layer) =>
    layer !== undefined && pasted.has(layer) ? rename.get(layer)! : parent === "" ? null : parent);
  const lines = m.lines.slice();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const b of blocks) {
    if (lines.length) lines.push("");
    lines.push(...b);
  }
  lines.push("");
  return lines.join(m.eol);
}

function subtree(m: IfModel, name: string): string[] {
  const out = [name];
  for (const c of m.children.get(name) ?? []) out.push(...subtree(m, c));
  return out;
}

function setKey(m: IfModel, lines: string[], name: string, key: string, value: string | null, order: string[]) {
  const com = find(m, name);
  if (!com) throw new Error(`no component ${name}`);
  const hits = com.keys.filter((k) => k.key === key);
  const line = `${key}=${value}`;
  if (hits.length) {
    if (value !== null) lines[hits[hits.length - 1].line] = line;
    const drop = value === null ? hits : hits.slice(0, -1);
    for (const h of drop.reverse()) lines.splice(h.line, 1);
    return;
  }
  if (value === null) return;
  lines.splice(insertAt(com, key, order), 0, line);
}

/** Where a new `key` line goes: after the last earlier `order` key, else after the header (layout keys) or at the block end. */
function insertAt(com: Com, key: string, order: string[]): number {
  const rank = order.indexOf(key);
  if (rank === -1) return com.keys.length ? com.keys[com.keys.length - 1].line + 1 : com.header + 1;
  let at = com.header + 1;
  for (const k of com.keys) {
    const r = order.indexOf(k.key);
    if (r !== -1 && r < rank) at = Math.max(at, k.line + 1);
  }
  return at;
}

function addBlock(lines: string[], name: string, parent: string, keys: [string, string][]) {
  const body = keys.map(([k, v]) => `${k}=${v}`);
  if (parent !== "") body.splice(keys.length && keys[0][0] === "type" ? 1 : 0, 0, `layer=${parent}`);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length) lines.push("");
  lines.push(`[${name}]`, ...body, "");
}

/** Removes a block and one separating blank line (the one after it, else the one before). */
function removeBlock(lines: string[], c: Com) {
  let start = c.header;
  let end = c.end;
  if (end < lines.length - 1 && lines[end] === "") end++;
  else if (start > 0 && lines[start - 1] === "") start--;
  lines.splice(start, end - start);
}

function reorder(ifName: string, text: string, name: string, parent: string, before: string | null, fmt: Format): string {
  text = applyIntent(ifName, text, { kind: "set", com: name, key: "layer", value: parent === "" ? null : parent }, fmt);
  let m = parseIf(ifName, text, fmt);
  const com = find(m, name)!;
  const block = m.lines.slice(com.header, com.end);
  const lines = m.lines.slice();
  removeBlock(lines, com);
  m = parseIf(ifName, lines.join(m.eol), fmt);
  if (before !== null) {
    lines.splice(find(m, before)!.header, 0, ...block, "");
  } else {
    const sibs = m.children.get(parent) ?? [];
    const after = sibs.length ? find(m, sibs[sibs.length - 1]) : parent === "" ? undefined : find(m, parent);
    if (after) {
      lines.splice(after.end, 0, "", ...block);
    } else {
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (lines.length) lines.push("");
      lines.push(...block, "");
    }
  }
  return lines.join(m.eol);
}


/**
 * Gives each new `ifName:com` the next free id: appended to the pack, inserted after the interface's group in
 * the order. A new interface (no `id=ifName` line yet) first gets its own id, with its group at the end of the order.
 */
export function addIds(packText: string, orderText: string, ifName: string, coms: string[]): { pack: string; order: string } {
  const pack = splitLines(packText);
  const order = splitLines(orderText);
  const names = new Map<number, string>();
  let max = -1;
  let rootId: number | undefined;
  for (const l of pack.lines) {
    const eq = l.indexOf("=");
    if (eq === -1) continue;
    const id = +l.slice(0, eq);
    const name = l.slice(eq + 1);
    names.set(id, name);
    max = Math.max(max, id);
    if (name === ifName) rootId = id;
  }
  if (rootId === undefined) {
    rootId = ++max;
    pack.lines.push(`${rootId}=${ifName}`);
    order.lines.push(String(rootId));
  }
  const taken = new Set(names.values());
  for (const c of coms) if (taken.has(`${ifName}:${c}`)) throw new Error(`interface.pack already has ${ifName}:${c}`);
  const ids = coms.map((_, i) => max + 1 + i);
  pack.lines.push(...coms.map((c, i) => `${ids[i]}=${ifName}:${c}`));
  let at = order.lines.findIndex((l) => l !== "" && +l === rootId);
  if (at === -1) throw new Error(`interface.order has no id ${rootId} for ${ifName}`);
  while (at + 1 < order.lines.length && names.get(+order.lines[at + 1])?.startsWith(`${ifName}:`)) at++;
  order.lines.splice(at + 1, 0, ...ids.map(String));
  return { pack: pack.join(), order: order.join() };
}

/** The pack and order changed so `ifName`'s components are exactly `coms` (run when the .if is saved). */
export function reconcileIds(packText: string, orderText: string, ifName: string, coms: string[]): { pack: string; order: string } {
  const prefix = `${ifName}:`;
  const inPack = packText.split(/\r?\n/).flatMap((l) => {
    const name = l.slice(l.indexOf("=") + 1);
    return l.includes("=") && name.startsWith(prefix) ? [name.slice(prefix.length)] : [];
  });
  const want = new Set(coms);
  const have = new Set(inPack);
  const extra = inPack.filter((c) => !want.has(c));
  const missing = [...want].filter((c) => !have.has(c));
  let ids = { pack: packText, order: orderText };
  if (extra.length) ids = removeIds(ids.pack, ids.order, ifName, extra);
  // a new interface needs its own id even before it has components
  const hasRoot = packText.split(/\r?\n/).some((l) => l.slice(l.indexOf("=") + 1) === ifName && l.includes("="));
  if (missing.length || !hasRoot) ids = addIds(ids.pack, ids.order, ifName, missing);
  return ids;
}

export function removeIds(packText: string, orderText: string, ifName: string, coms: string[]): { pack: string; order: string } {
  const pack = splitLines(packText);
  const order = splitLines(orderText);
  const gone = new Set(coms.map((c) => `${ifName}:${c}`));
  const ids = new Set<string>();
  pack.lines = pack.lines.filter((l) => {
    const eq = l.indexOf("=");
    if (eq !== -1 && gone.has(l.slice(eq + 1))) return ids.add(l.slice(0, eq)), false;
    return true;
  });
  order.lines = order.lines.filter((l) => !ids.has(l));
  return { pack: pack.join(), order: order.join() };
}

/** Lines without the final newline, rejoined with the file's own eol. */
function splitLines(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailing = text.endsWith(eol);
  const lines = (trailing ? text.slice(0, -eol.length) : text).split(eol);
  if (lines.length === 1 && lines[0] === "") lines.pop();
  const file = { lines, join: () => file.lines.join(eol) + (trailing ? eol : "") };
  return file;
}
