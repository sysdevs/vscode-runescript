// Builds an `.idk` block's preview: the kit part alone, its body models (IdkType.getModelNoCheck)
// or its chathead models (getHeadNoCheck), recoloured and lit as the client lights a player.
import { Content } from "./content";
import { BuildOptions } from "./npc";
import { merge } from "./ob2";
import { applyRecolours, indexed, Lines, lit, loadModels, recolours, Scene, toScene, View } from "./scene";

export function idkViews(lines: Lines): View[] {
  const views: View[] = [];
  if (indexed(lines, "model").length) views.push({ key: "body", label: "Body" });
  if (indexed(lines, "head").length) views.push({ key: "head", label: "Chathead" });
  return views;
}

export function buildIdk(content: Content, lines: Lines, opts: BuildOptions = {}): Scene {
  const warnings: string[] = [];
  const views = idkViews(lines);
  const view = views.some((v) => v.key === opts.view) ? opts.view! : views[0]?.key ?? "";
  const meta = { seqs: [], seq: "", views, view, warnings };
  const models = loadModels(content, indexed(lines, view === "head" ? "head" : "model").map(([, v]) => v), warnings);
  if (models.length === 0) {
    if (warnings.length === 0) warnings.push("no model# or head# lines");
    return toScene(content, [], [], meta);
  }
  const model = merge(models);
  applyRecolours(model, recolours(content, lines));
  return toScene(content, [{ label: "", frames: [lit(model, 64, 850, -30, -50, -30)] }], [1000], meta);
}
