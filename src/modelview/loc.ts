// Builds a `.loc` block's preview. Each `model`, `model2..5` stem expands to the models the
// packer finds for it (the bare name is the centrepiece, `<stem>_1` a straight wall, ...;
// ares-gameserver pack/config/client.rs). If every model is a centrepiece the client merges
// them into one; otherwise each shape uses its first model and the preview shows them in a
// row. Per frame (LocType.buildModel): animate, recolour/retexture, resize, offset, light.
import { animate } from "./anim";
import { Content } from "./content";
import { BuildOptions } from "./npc";
import { copyPoints, labelGroups, merge, mirror, Model, resize, translate } from "./ob2";
import { applyRecolours, Lines, lit, loadModels, num, Part, recolours, Scene, seqFrames, toScene, value } from "./scene";

/** `LocShapeSuffix` (index = shape) and the shape names, from the packer. */
const SUFFIX = ["_1", "_2", "_3", "_4", "_q", "_w", "_r", "_e", "_t", "_5", "_8", "_9", "_a", "_s", "_d", "_f", "_g", "_h", "_z", "_x", "_c", "_v", "_0"];
const SHAPE = [
  "wall straight", "wall diagonal corner", "wall L", "wall square corner",
  "wall decor straight", "wall decor straight offset", "wall decor diagonal offset", "wall decor diagonal",
  "wall decor diagonal both", "wall diagonal", "centrepiece", "centrepiece diagonal",
  "roof straight", "roof diagonal with edge", "roof diagonal", "roof L concave", "roof L convex", "roof flat",
  "roof edge straight", "roof edge diagonal corner", "roof edge L", "roof edge square corner", "ground decor",
];
const CENTREPIECE = 10;

/** The (model, shape) pairs the packer writes for the block's stems, centrepieces first, then by shape. */
export function locModels(lines: Lines, exists: (name: string) => boolean): { name: string; shape: number }[] {
  const out: { name: string; shape: number }[] = [];
  for (const [k, stem] of lines) {
    if (!/^model\d*$/.test(k)) continue;
    if (exists(stem)) out.push({ name: stem, shape: CENTREPIECE });
    SUFFIX.forEach((suffix, shape) => {
      if (shape !== CENTREPIECE && exists(stem + suffix)) out.push({ name: stem + suffix, shape });
    });
  }
  const rank = (s: number) => (s === CENTREPIECE ? -1 : s);
  return out.sort((a, b) => rank(a.shape) - rank(b.shape));
}

export function buildLoc(content: Content, lines: Lines, opts: BuildOptions = {}): Scene {
  const warnings: string[] = [];
  const anim = value(lines, "anim");
  const seqs = anim ? [{ key: "anim", seq: anim }] : [];
  const seq = opts.seq ?? anim ?? "";
  const meta = { seqs, seq, views: [], view: "", warnings, footprint: [num(lines, "width", 1), num(lines, "length", 1)] };

  const pairs = locModels(lines, (n) => content.hasModel(n));
  if (pairs.length === 0) {
    const stems = lines.filter(([k]) => /^model\d*$/.test(k)).map(([, v]) => v);
    warnings.push(stems.length ? `no models found for ${stems.join(", ")}` : "no model lines");
    return toScene(content, [], [], meta);
  }
  // one centrepiece made of every model, or one part per shape (its first model)
  const groups: { label: string; names: string[] }[] = [];
  if (pairs.every((p) => p.shape === CENTREPIECE)) groups.push({ label: SHAPE[CENTREPIECE], names: pairs.map((p) => p.name) });
  else {
    const seen = new Set<number>();
    for (const p of pairs) {
      if (seen.has(p.shape)) continue;
      seen.add(p.shape);
      groups.push({ label: p.shape === CENTREPIECE ? SHAPE[p.shape] : `${SUFFIX[p.shape]} ${SHAPE[p.shape]}`, names: [p.name] });
    }
  }

  const recols = recolours(content, lines, true);
  const mirrored = value(lines, "mirror") === "yes";
  const [rx, ry, rz] = ["resizex", "resizey", "resizez"].map((k) => num(lines, k, 128));
  const [ox, oy, oz] = ["offsetx", "offsety", "offsetz"].map((k) => num(lines, k, 0));
  const ambient = (num(lines, "ambient", 0) & 0xff) + 64;
  const contrast = (num(lines, "contrast", 0) & 0xff) * 5 + 768;
  const { frames, delays } = seqFrames(content, seq, warnings);

  const parts: Part[] = [];
  for (const g of groups) {
    const models = loadModels(content, g.names, warnings);
    if (models.length === 0) continue;
    const model: Model = merge(models);
    if (mirrored) mirror(model);
    applyRecolours(model, recols);
    const labels = labelGroups(model.vertexLabel);
    parts.push({
      label: g.label,
      frames: frames.map((frame) => {
        const m = copyPoints(model);
        if (frame) animate(m, labels, frame);
        resize(m, rx, ry, rz);
        translate(m, ox, oy, oz);
        return lit(m, ambient, contrast, -50, -10, -50);
      }),
    });
  }
  return toScene(content, parts, delays, meta);
}
