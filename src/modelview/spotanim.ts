// Builds a `.spotanim` block's preview as MapSpotAnim draws one: per frame the recoloured model
// is animated, resized (resizeh, resizev, resizeh), turned by `angle` and lit.
import { animate } from "./anim";
import { Content } from "./content";
import { BuildOptions } from "./npc";
import { copyPoints, labelGroups, resize, rotate90 } from "./ob2";
import { applyRecolours, Lines, lit, loadModels, num, recolours, Scene, seqFrames, toScene, value } from "./scene";

export function buildSpotanim(content: Content, lines: Lines, opts: BuildOptions = {}): Scene {
  const warnings: string[] = [];
  const anim = value(lines, "anim");
  const seqs = anim ? [{ key: "anim", seq: anim }] : [];
  const seq = opts.seq ?? anim ?? "";
  const meta = { seqs, seq, views: [], view: "", warnings };
  const name = value(lines, "model");
  const model = name ? loadModels(content, [name], warnings)[0] : undefined;
  if (!model) {
    if (warnings.length === 0) warnings.push("no model line");
    return toScene(content, [], [], meta);
  }
  applyRecolours(model, recolours(content, lines));
  const groups = labelGroups(model.vertexLabel);
  const resizeh = num(lines, "resizeh", 128);
  const resizev = num(lines, "resizev", 128);
  const turns = (num(lines, "angle", 0) / 90) | 0;
  const ambient = 64 + num(lines, "ambient", 0);
  const contrast = 850 + num(lines, "contrast", 0);
  const { frames, delays } = seqFrames(content, seq, warnings);
  const posed = frames.map((frame) => {
    const m = copyPoints(model);
    if (frame) animate(m.pointX, m.pointY, m.pointZ, groups, frame);
    resize(m, resizeh, resizev, resizeh);
    for (let i = 0; i < turns; i++) rotate90(m);
    return lit(m, ambient, contrast, -30, -50, -30);
  });
  return toScene(content, [{ label: "", frames: posed }], delays, meta);
}
