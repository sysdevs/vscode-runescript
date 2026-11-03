// `.ob2` model decoding and the client's model operations the preview needs (merge,
// recolour, label groups, lighting), ported from Client-TS dash3d/Model.ts.

import { COS, SIN } from "./anim";

export interface Model {
  numPoints: number;
  numFaces: number;
  numT: number;
  pointX: Int32Array;
  pointY: Int32Array;
  pointZ: Int32Array;
  faceA: Int32Array;
  faceB: Int32Array;
  faceC: Int32Array;
  faceColour: Int32Array;
  /** the face colours before the block's recolours (set by the first recolour; else faceColour) */
  sourceColour?: Int32Array;
  /** null when every face is type 0 (gouraud, untextured) */
  faceRenderType: Int32Array | null;
  /** null when every face is opaque */
  faceAlpha: Int32Array | null;
  vertexLabel: Int32Array | null;
  faceLabel: Int32Array | null;
}

/** A big-endian reader with the client's smart encodings. */
class Reader {
  constructor(private readonly b: Uint8Array, public pos: number) {}
  g1() {
    return this.b[this.pos++];
  }
  g2() {
    this.pos += 2;
    return (this.b[this.pos - 2] << 8) | this.b[this.pos - 1];
  }
  gsmarts() {
    return this.b[this.pos] < 0x80 ? this.g1() - 0x40 : this.g2() - 0xc000;
  }
}

export function decodeOb2(src: Uint8Array): Model {
  if (src.length < 18) throw new Error("not a model (shorter than its trailer)");
  const t = new Reader(src, src.length - 18);
  const numPoints = t.g2();
  const numFaces = t.g2();
  const numT = t.g1();
  const hasRenderType = t.g1();
  const priority = t.g1();
  const hasAlpha = t.g1();
  const hasFaceLabels = t.g1();
  const hasVertexLabels = t.g1();
  const lenX = t.g2();
  const lenY = t.g2();
  const lenZ = t.g2();
  const lenFaceIndex = t.g2();

  let pos = 0;
  const take = (n: number) => ((pos += n), pos - n);
  const vertexOrder = take(numPoints);
  const faceOrder = take(numFaces);
  if (priority === 255) take(numFaces);
  const faceLabelAt = hasFaceLabels === 1 ? take(numFaces) : -1;
  const renderTypeAt = hasRenderType === 1 ? take(numFaces) : -1;
  const vertexLabelAt = hasVertexLabels === 1 ? take(numPoints) : -1;
  const alphaAt = hasAlpha === 1 ? take(numFaces) : -1;
  const faceIndexAt = take(lenFaceIndex);
  const colourAt = take(numFaces * 2);
  take(numT * 6);
  const xAt = take(lenX);
  const yAt = take(lenY);
  const zAt = take(lenZ);
  if (pos > src.length - 18) throw new Error("not a model (sections overrun the trailer)");

  const m: Model = {
    numPoints,
    numFaces,
    numT,
    pointX: new Int32Array(numPoints),
    pointY: new Int32Array(numPoints),
    pointZ: new Int32Array(numPoints),
    faceA: new Int32Array(numFaces),
    faceB: new Int32Array(numFaces),
    faceC: new Int32Array(numFaces),
    faceColour: new Int32Array(numFaces),
    faceRenderType: renderTypeAt >= 0 ? new Int32Array(numFaces) : null,
    faceAlpha: alphaAt >= 0 ? new Int32Array(numFaces) : null,
    vertexLabel: vertexLabelAt >= 0 ? new Int32Array(numPoints) : null,
    faceLabel: faceLabelAt >= 0 ? new Int32Array(numFaces) : null,
  };

  const order = new Reader(src, vertexOrder);
  const xs = new Reader(src, xAt);
  const ys = new Reader(src, yAt);
  const zs = new Reader(src, zAt);
  const labels = new Reader(src, vertexLabelAt);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let v = 0; v < numPoints; v++) {
    const flags = order.g1();
    if (flags & 1) x += xs.gsmarts();
    if (flags & 2) y += ys.gsmarts();
    if (flags & 4) z += zs.gsmarts();
    m.pointX[v] = x;
    m.pointY[v] = y;
    m.pointZ[v] = z;
    if (m.vertexLabel) m.vertexLabel[v] = labels.g1();
  }

  const colours = new Reader(src, colourAt);
  const types = new Reader(src, renderTypeAt);
  const alphas = new Reader(src, alphaAt);
  const faceLabels = new Reader(src, faceLabelAt);
  for (let f = 0; f < numFaces; f++) {
    m.faceColour[f] = colours.g2();
    if (m.faceRenderType) m.faceRenderType[f] = types.g1();
    if (m.faceAlpha) m.faceAlpha[f] = alphas.g1();
    if (m.faceLabel) m.faceLabel[f] = faceLabels.g1();
  }

  const index = new Reader(src, faceIndexAt);
  const kinds = new Reader(src, faceOrder);
  let a = 0;
  let b = 0;
  let c = 0;
  let last = 0;
  for (let f = 0; f < numFaces; f++) {
    const kind = kinds.g1();
    if (kind === 1) {
      a = index.gsmarts() + last;
      b = index.gsmarts() + a;
      c = index.gsmarts() + b;
    } else if (kind === 2) {
      b = c;
      c = index.gsmarts() + last;
    } else if (kind === 3) {
      a = c;
      c = index.gsmarts() + last;
    } else if (kind === 4) {
      [a, b] = [b, a];
      c = index.gsmarts() + last;
    }
    last = c;
    m.faceA[f] = a;
    m.faceB[f] = b;
    m.faceC[f] = c;
  }
  return m;
}

/** `Model.combineForAnim`: concatenates faces, sharing points at equal coordinates. */
export function merge(models: Model[]): Model {
  if (models.length === 1) return models[0];
  const numPoints = models.reduce((n, m) => n + m.numPoints, 0);
  const numFaces = models.reduce((n, m) => n + m.numFaces, 0);
  const any = (k: "faceRenderType" | "faceAlpha" | "faceLabel") => models.some((m) => m[k] !== null);
  const out: Model = {
    numPoints: 0,
    numFaces: 0,
    numT: 0,
    pointX: new Int32Array(numPoints),
    pointY: new Int32Array(numPoints),
    pointZ: new Int32Array(numPoints),
    faceA: new Int32Array(numFaces),
    faceB: new Int32Array(numFaces),
    faceC: new Int32Array(numFaces),
    faceColour: new Int32Array(numFaces),
    faceRenderType: any("faceRenderType") ? new Int32Array(numFaces) : null,
    faceAlpha: any("faceAlpha") ? new Int32Array(numFaces) : null,
    vertexLabel: new Int32Array(numPoints),
    faceLabel: any("faceLabel") ? new Int32Array(numFaces) : null,
  };
  const at = new Map<string, number>();
  const addPoint = (src: Model, v: number) => {
    const key = `${src.pointX[v]},${src.pointY[v]},${src.pointZ[v]}`;
    let i = at.get(key);
    if (i === undefined) {
      i = out.numPoints++;
      at.set(key, i);
      out.pointX[i] = src.pointX[v];
      out.pointY[i] = src.pointY[v];
      out.pointZ[i] = src.pointZ[v];
      if (src.vertexLabel) out.vertexLabel![i] = src.vertexLabel[v];
    }
    return i;
  };
  for (const m of models) {
    for (let f = 0; f < m.numFaces; f++) {
      const o = out.numFaces++;
      if (out.faceRenderType) out.faceRenderType[o] = m.faceRenderType?.[f] ?? 0;
      if (out.faceAlpha) out.faceAlpha[o] = m.faceAlpha?.[f] ?? 0;
      if (out.faceLabel && m.faceLabel) out.faceLabel[o] = m.faceLabel[f];
      out.faceColour[o] = m.faceColour[f];
      out.faceA[o] = addPoint(m, m.faceA[f]);
      out.faceB[o] = addPoint(m, m.faceB[f]);
      out.faceC[o] = addPoint(m, m.faceC[f]);
    }
  }
  const n = out.numPoints;
  out.pointX = out.pointX.slice(0, n);
  out.pointY = out.pointY.slice(0, n);
  out.pointZ = out.pointZ.slice(0, n);
  out.vertexLabel = out.vertexLabel!.slice(0, n);
  return out;
}

export function recolour(m: Model, src: number, dst: number) {
  for (let f = 0; f < m.numFaces; f++) if (m.faceColour[f] === src) m.faceColour[f] = dst;
}

/** A copy sharing faces and colours, with its own points and alphas (what animation and posing change). */
export function copyPoints(m: Model): Model {
  return { ...m, pointX: m.pointX.slice(), pointY: m.pointY.slice(), pointZ: m.pointZ.slice(), faceAlpha: m.faceAlpha?.slice() ?? null };
}

export function translate(m: Model, x: number, y: number, z: number) {
  for (let v = 0; v < m.numPoints; v++) {
    m.pointX[v] += x;
    m.pointY[v] += y;
    m.pointZ[v] += z;
  }
}

/** `Model.mirror`: negates z and swaps face corners A and C (changes the faces: use on a fresh model). */
export function mirror(m: Model) {
  for (let v = 0; v < m.numPoints; v++) m.pointZ[v] = -m.pointZ[v];
  for (let f = 0; f < m.numFaces; f++) [m.faceA[f], m.faceC[f]] = [m.faceC[f], m.faceA[f]];
}

export function rotate90(m: Model) {
  for (let v = 0; v < m.numPoints; v++) {
    const x = m.pointX[v];
    m.pointX[v] = m.pointZ[v];
    m.pointZ[v] = -x;
  }
}

/**
 * `Model.objRender`'s view transform (obj icons, interface models): a copy turned by `roll`
 * then `yaw`, moved by the eye offset and pitched by `eyePitch`, in view space (x right, y
 * down, z away). The client then projects `origin + (x << 9) / z`.
 */
export function objRender(m: Model, yaw: number, roll: number, eyePitch: number, eyeX: number, eyeY: number, eyeZ: number): Model {
  const out: Model = { ...m, pointX: new Int32Array(m.numPoints), pointY: new Int32Array(m.numPoints), pointZ: new Int32Array(m.numPoints) };
  for (let v = 0; v < m.numPoints; v++) {
    let x = m.pointX[v];
    let y = m.pointY[v];
    let z = m.pointZ[v];
    let t: number;
    if (roll !== 0) {
      t = (y * SIN[roll] + x * COS[roll]) >> 16;
      y = (y * COS[roll] - x * SIN[roll]) >> 16;
      x = t;
    }
    if (yaw !== 0) {
      t = (z * SIN[yaw] + x * COS[yaw]) >> 16;
      z = (z * COS[yaw] - x * SIN[yaw]) >> 16;
      x = t;
    }
    x += eyeX;
    y += eyeY;
    z += eyeZ;
    t = (y * COS[eyePitch] - z * SIN[eyePitch]) >> 16;
    z = (y * SIN[eyePitch] + z * COS[eyePitch]) >> 16;
    y = t;
    out.pointX[v] = x;
    out.pointY[v] = y;
    out.pointZ[v] = z;
  }
  return out;
}

export function resize(m: Model, x: number, y: number, z: number) {
  for (let v = 0; v < m.numPoints; v++) {
    m.pointX[v] = ((m.pointX[v] * x) / 128) | 0;
    m.pointY[v] = ((m.pointY[v] * y) / 128) | 0;
    m.pointZ[v] = ((m.pointZ[v] * z) / 128) | 0;
  }
}

/** `Model.prepareAnim`: the vertices of each vertex label, in vertex order. */
export function labelGroups(labels: Int32Array | null): Int32Array[] {
  if (!labels) return [];
  let max = 0;
  const count = new Int32Array(256);
  for (const l of labels) {
    count[l]++;
    if (l > max) max = l;
  }
  const groups: Int32Array[] = [];
  for (let l = 0; l <= max; l++) groups.push(new Int32Array(count[l]));
  count.fill(0);
  labels.forEach((l, v) => (groups[l][count[l]++] = v));
  return groups;
}

/** `Model.getColour`: an HSL16 colour shaded by `scalar`, or a texture shade for textured faces. */
function shade(hsl: number, scalar: number, type: number): number {
  if ((type & 2) === 2) return 127 - Math.min(127, Math.max(0, scalar));
  scalar = (scalar * (hsl & 0x7f)) >> 7;
  return (hsl & 0xff80) + Math.min(126, Math.max(2, scalar));
}

/**
 * `Model.calculateNormals(ambient, contrast, x, y, z, true)` + `light`: one HSL16 (or texture
 * shade) per face corner. Flat faces (render type bit 1) use corner A for all three.
 */
export function light(m: Model, ambient: number, contrast: number, x: number, y: number, z: number) {
  const scale = (contrast * (Math.sqrt(x * x + y * y + z * z) | 0)) >> 8;
  const nx = new Int32Array(m.numPoints);
  const ny = new Int32Array(m.numPoints);
  const nz = new Int32Array(m.numPoints);
  const nw = new Int32Array(m.numPoints);
  const colA = new Int32Array(m.numFaces);
  const colB = new Int32Array(m.numFaces);
  const colC = new Int32Array(m.numFaces);
  for (let f = 0; f < m.numFaces; f++) {
    const a = m.faceA[f];
    const b = m.faceB[f];
    const c = m.faceC[f];
    const dxAB = m.pointX[b] - m.pointX[a];
    const dyAB = m.pointY[b] - m.pointY[a];
    const dzAB = m.pointZ[b] - m.pointZ[a];
    const dxAC = m.pointX[c] - m.pointX[a];
    const dyAC = m.pointY[c] - m.pointY[a];
    const dzAC = m.pointZ[c] - m.pointZ[a];
    let x1 = dyAB * dzAC - dyAC * dzAB;
    let y1 = dzAB * dxAC - dzAC * dxAB;
    let z1 = dxAB * dyAC - dxAC * dyAB;
    while (x1 > 8192 || y1 > 8192 || z1 > 8192 || x1 < -8192 || y1 < -8192 || z1 < -8192) {
      x1 >>= 1;
      y1 >>= 1;
      z1 >>= 1;
    }
    let length = Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1) | 0;
    if (length <= 0) length = 1;
    x1 = ((x1 * 256) / length) | 0;
    y1 = ((y1 * 256) / length) | 0;
    z1 = ((z1 * 256) / length) | 0;
    const type = m.faceRenderType?.[f] ?? 0;
    if ((type & 1) === 0) {
      for (const v of [a, b, c]) {
        nx[v] += x1;
        ny[v] += y1;
        nz[v] += z1;
        nw[v]++;
      }
    } else {
      const lightness = ambient + (((x * x1 + y * y1 + z * z1) / (scale + ((scale / 2) | 0))) | 0);
      colA[f] = colB[f] = colC[f] = shade(m.faceColour[f], lightness, type);
    }
  }
  const corner = (v: number, colour: number, type: number) =>
    shade(colour, ambient + (((x * nx[v] + y * ny[v] + z * nz[v]) / (scale * nw[v])) | 0), type);
  for (let f = 0; f < m.numFaces; f++) {
    const type = m.faceRenderType?.[f] ?? 0;
    if ((type & 1) !== 0) continue;
    colA[f] = corner(m.faceA[f], m.faceColour[f], type);
    colB[f] = corner(m.faceB[f], m.faceColour[f], type);
    colC[f] = corner(m.faceC[f], m.faceColour[f], type);
  }
  return { colA, colB, colC };
}
