// What an interface model component (`.if` type=model) draws, as Client.drawInterface and
// IfType.getTempModel build it: `model` (or `activemodel` while active; an active component
// without one draws nothing), animated by `anim` / `activeanim`, lit per frame with
// (64, 768, -50, -10, -50), then posed by `Model.objRender` from `zoom`, `xan`, `yan`.
// The points come out in view space; the caller projects them about the component's centre.
import { animate, COS, SIN } from "./anim";
import { Content } from "./content";
import { copyPoints, labelGroups, objRender } from "./ob2";
import { lit, loadModels, Scene, seqFrames, toScene } from "./scene";

/** The keys of one model component that decide its drawing (also its cache key). */
export interface IfModelSpec {
  model?: string;
  anim?: string;
  zoom: number;
  xan: number;
  yan: number;
}

export function ifModelSpec(get: (key: string) => string | undefined, active: boolean): IfModelSpec {
  const n = (k: string) => Number(get(k) ?? 0) || 0;
  return {
    model: active ? get("activemodel") : get("model"),
    anim: active ? get("activeanim") : get("anim"),
    zoom: n("zoom"),
    xan: n("xan") & 2047,
    yan: n("yan") & 2047,
  };
}

export function buildIfModel(content: Content, spec: IfModelSpec): Scene | undefined {
  if (!spec.model) return undefined;
  const warnings: string[] = [];
  const model = loadModels(content, [spec.model], warnings)[0];
  if (!model) return undefined;
  const groups = labelGroups(model.vertexLabel);
  const eyeY = (SIN[spec.xan] * spec.zoom) >> 16;
  const eyeZ = (COS[spec.xan] * spec.zoom) >> 16;
  const { frames, delays } = seqFrames(content, spec.anim ?? "", warnings);
  const posed = frames.map((frame) => {
    const m = copyPoints(model);
    if (frame) animate(m, groups, frame);
    const shaded = lit(m, 64, 768, -50, -10, -50);
    return { ...shaded, model: objRender(m, spec.yan, 0, spec.xan, 0, eyeY, eyeZ) };
  });
  return toScene(content, [{ label: "", frames: posed }], delays, { seqs: [], seq: spec.anim ?? "", views: [], view: "", warnings, camera: "icon" });
}
