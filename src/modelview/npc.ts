// Builds what the preview draws for one `.npc` block, the way the client builds an NPC
// (NpcType.getSequencedModel): models merged, recoloured and lit once, then each seq frame
// animated and resized by resizeh/resizev. Also the block parsing every type shares.
import { animate } from "./anim";
import { Content } from "./content";
import { copyPoints, labelGroups, merge, resize } from "./ob2";
import { applyRecolours, indexed, Lines, lit, loadModels, num, recolours, Scene, SeqChoice, seqFrames, toScene } from "./scene";

export type { Scene, SeqChoice } from "./scene";

/** What a builder may be asked to show: a seq ("" none, undefined the default) and a view. */
export interface BuildOptions {
  seq?: string;
  view?: string;
}

/**
 * The `[block]` containing `line` (0-based), as key/value lines, with its header line `start`
 * and `end` (the next header or the end of the text, exclusive); undefined above the first block.
 */
export function blockAt(text: string, line: number): { name: string; lines: Lines; text: string; start: number; end: number } | undefined {
  const all = text.split(/\r?\n/);
  let start = Math.min(line, all.length - 1);
  while (start >= 0 && !/^\s*\[[^\]]+\]/.test(all[start])) start--;
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < all.length && !/^\s*\[[^\]]+\]/.test(all[end])) end++;
  const name = /\[([^\]]+)\]/.exec(all[start])![1];
  const lines: Lines = [];
  for (const raw of all.slice(start + 1, end)) {
    const l = raw.replace(/\/\/.*$/, "").trim();
    const at = l.indexOf("=");
    if (at > 0) lines.push([l.slice(0, at).trim(), l.slice(at + 1).trim()]);
  }
  return { name, lines, text: all.slice(start, end).join("\n"), start, end };
}

/**
 * Seq choices for an npc block: readyanim, then each walkanim entry, then each
 * `param=<name>,<seq>` whose param is `type=seq` (attack_anim, defend_anim, ...).
 */
export function npcSeqs(lines: Lines, seqParams: ReadonlySet<string> = new Set()): SeqChoice[] {
  const out: SeqChoice[] = [];
  for (const [k, v] of lines) {
    if (k === "readyanim") out.unshift({ key: k, seq: v });
    else if (k === "walkanim") out.push(...v.split(",").map((s) => ({ key: k, seq: s.trim() })));
    else if (k === "param") {
      const at = v.indexOf(",");
      const name = v.slice(0, at).trim();
      if (at > 0 && seqParams.has(name)) out.push({ key: name, seq: v.slice(at + 1).trim() });
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => c.seq && !seen.has(c.seq) && seen.add(c.seq));
}

export function buildNpc(content: Content, lines: Lines, opts: BuildOptions = {}): Scene {
  const warnings: string[] = [];
  const seqs = npcSeqs(lines, content.seqParams());
  const seq = opts.seq ?? seqs[0]?.seq ?? "";
  const meta = { seqs, seq, views: [], view: "", warnings };
  const models = loadModels(content, indexed(lines, "model").map(([, v]) => v), warnings);
  if (models.length === 0) {
    if (warnings.length === 0) warnings.push("no model# lines");
    return toScene(content, [], [], meta);
  }

  const model = merge(models);
  applyRecolours(model, recolours(content, lines));
  const groups = labelGroups(model.vertexLabel);
  const base = lit(model, 64, 850, -30, -50, -30);
  const resizeh = num(lines, "resizeh", 128);
  const resizev = num(lines, "resizev", 128);
  const { frames, delays } = seqFrames(content, seq, warnings);
  const posed = frames.map((frame) => {
    const m = copyPoints(model);
    if (frame) animate(m.pointX, m.pointY, m.pointZ, groups, frame);
    resize(m, resizeh, resizev, resizeh);
    // lit once before animating, as the client does
    return { ...base, model: m };
  });
  return toScene(content, [{ label: "", frames: posed }], delays, meta);
}
