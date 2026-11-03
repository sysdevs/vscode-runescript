// Builds an `.obj` block's preview, the way the client builds each of its models:
// ground/inventory (ObjType.getModelLit), worn (getWearModelNoCheck) and chathead
// (getHeadModelNoCheck). The inventory view poses the ground model with the obj's 2d* keys
// as ObjType.getSprite does, in the icon's view space.
import { COS, SIN } from "./anim";
import { Content } from "./content";
import { BuildOptions } from "./npc";
import { merge, Model, objRender, resize, translate } from "./ob2";
import { applyRecolours, Lines, lit, loadModels, num, recolours, Scene, toScene, value, View } from "./scene";

/** The views the block defines, ground first. */
export function objViews(lines: Lines): View[] {
  const has = (k: string) => value(lines, k) !== undefined;
  const views: View[] = [];
  if (has("model")) views.push({ key: "ground", label: "Ground" }, { key: "inventory", label: "Inventory icon" });
  if (has("manwear")) views.push({ key: "manwear", label: "Worn (man)" });
  if (has("womanwear")) views.push({ key: "womanwear", label: "Worn (woman)" });
  if (has("manhead")) views.push({ key: "manhead", label: "Chathead (man)" });
  if (has("womanhead")) views.push({ key: "womanhead", label: "Chathead (woman)" });
  return views;
}

/** `ObjType.getSprite` → `Model.objRender`: the lit ground model moved into the icon's view space. */
function iconPose(m: Model, lines: Lines): Model {
  const xan = num(lines, "2dxan", 0) & 2047;
  const yan = num(lines, "2dyan", 0) & 2047;
  const zan = num(lines, "2dzan", 0) & 2047;
  const zoom = num(lines, "2dzoom", 2000);
  const xof = num(lines, "2dxof", 0);
  const yof = num(lines, "2dyof", 0);
  let minY = 0;
  for (const y of m.pointY) minY = Math.max(minY, -y);
  const eyeX = xof;
  const eyeY = ((SIN[xan] * zoom) >> 16) + ((minY / 2) | 0) + yof;
  const eyeZ = ((COS[xan] * zoom) >> 16) + yof;
  return objRender(m, yan, zan, xan, eyeX, eyeY, eyeZ);
}

export function buildObj(content: Content, lines: Lines, opts: BuildOptions = {}): Scene {
  const warnings: string[] = [];
  const views = objViews(lines);
  const view = views.some((v) => v.key === opts.view) ? opts.view! : views[0]?.key ?? "";
  const meta = { seqs: [], seq: "", views, view, warnings };
  const recols = recolours(content, lines);
  const names = (...keys: string[]) => keys.map((k) => value(lines, k)?.split(",")[0].trim()).filter((n): n is string => !!n);

  let model: Model | undefined;
  let lighting: [number, number, number, number, number] = [64, 850, -30, -50, -30];
  if (view === "ground" || view === "inventory") {
    model = loadModels(content, names("model"), warnings)[0];
    if (model) resize(model, num(lines, "resizex", 128), num(lines, "resizey", 128), num(lines, "resizez", 128));
    lighting = [64 + num(lines, "ambient", 0), 768 + num(lines, "contrast", 0) * 5, -50, -10, -50];
  } else if (view === "manwear" || view === "womanwear") {
    const g = view.slice(0, -4);
    // wear3 only counts alongside wear2, as in the client
    const keys = value(lines, `${g}wear2`) ? [`${g}wear`, `${g}wear2`, `${g}wear3`] : [`${g}wear`];
    const models = loadModels(content, names(...keys), warnings);
    if (models.length) {
      model = merge(models);
      translate(model, 0, Number(value(lines, `${g}wear`)?.split(",")[1] ?? 0) || 0, 0);
    }
  } else if (view === "manhead" || view === "womanhead") {
    const models = loadModels(content, names(view, `${view.slice(0, -4)}head2`), warnings);
    if (models.length) model = merge(models);
  }
  if (!model) {
    if (warnings.length === 0) warnings.push("no model to show");
    return toScene(content, [], [], meta);
  }
  applyRecolours(model, recols);
  const shaded = lit(model, ...lighting);
  if (view === "inventory") {
    return toScene(content, [{ label: "", frames: [{ ...shaded, model: iconPose(model, lines) }] }], [1000], { ...meta, camera: "icon" });
  }
  return toScene(content, [{ label: "", frames: [shaded] }], [1000], meta);
}
