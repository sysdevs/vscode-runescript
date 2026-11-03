// `.anim` decoding (one base plus the frames that use it) and the client's frame transform,
// ported from Client-TS dash3d/AnimBase.ts, AnimFrame.ts and Model.animate.

const ORIGIN = 0;
const TRANSLATE = 1;
const ROTATE = 2;
const SCALE = 3;

export interface AnimBase {
  type: Uint8Array;
  labels: Uint8Array[];
}

export interface AnimFrame {
  delay: number;
  base: AnimBase;
  ti: Int32Array;
  tx: Int32Array;
  ty: Int32Array;
  tz: Int32Array;
}

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

/** The frame ids an `.anim` file holds, read from its head section only. */
export function frameIds(data: Uint8Array): number[] {
  const head = new Reader(data, 0);
  const ids: number[] = [];
  for (let i = head.g2(); i > 0; i--) {
    ids.push(head.g2());
    head.g1();
  }
  return ids;
}

/** Every frame in an `.anim` file, by frame id. */
export function decodeAnim(data: Uint8Array): Map<number, AnimFrame> {
  const t = new Reader(data, data.length - 8);
  const headLength = t.g2();
  const tran1Length = t.g2();
  const tran2Length = t.g2();
  const delLength = t.g2();
  const head = new Reader(data, 0);
  const tran1 = new Reader(data, headLength + 2);
  const tran2 = new Reader(data, tran1.pos + tran1Length);
  const del = new Reader(data, tran2.pos + tran2Length);
  const b = new Reader(data, del.pos + delLength);

  const size = b.g1();
  const base: AnimBase = { type: new Uint8Array(size), labels: [] };
  for (let i = 0; i < size; i++) base.type[i] = b.g1();
  for (let i = 0; i < size; i++) {
    const labels = new Uint8Array(b.g1());
    for (let j = 0; j < labels.length; j++) labels[j] = b.g1();
    base.labels.push(labels);
  }

  const frames = new Map<number, AnimFrame>();
  for (let n = head.g2(); n > 0; n--) {
    const id = head.g2();
    const delay = del.g1();
    const ti: number[] = [];
    const tx: number[] = [];
    const ty: number[] = [];
    const tz: number[] = [];
    let lastGroup = -1;
    for (let j = 0, groups = head.g1(); j < groups; j++) {
      const flags = tran1.g1();
      if (flags === 0) continue;
      if (base.type[j] !== ORIGIN) {
        // a transform without its own origin reuses the nearest preceding one
        for (let g = j - 1; g > lastGroup; g--) {
          if (base.type[g] === ORIGIN) {
            ti.push(g);
            tx.push(0);
            ty.push(0);
            tz.push(0);
            break;
          }
        }
      }
      const def = base.type[j] === SCALE ? 128 : 0;
      ti.push(j);
      tx.push(flags & 1 ? tran2.gsmarts() : def);
      ty.push(flags & 2 ? tran2.gsmarts() : def);
      tz.push(flags & 4 ? tran2.gsmarts() : def);
      lastGroup = j;
    }
    frames.set(id, { delay, base, ti: Int32Array.from(ti), tx: Int32Array.from(tx), ty: Int32Array.from(ty), tz: Int32Array.from(tz) });
  }
  return frames;
}

/** The client's fixed-point trig tables (Pix3D.sinTable / cosTable), 2048 steps per turn. */
export const SIN = new Int32Array(2048);
export const COS = new Int32Array(2048);
for (let i = 0; i < 2048; i++) {
  SIN[i] = (Math.sin(i * 0.0030679615757712823) * 65536) | 0;
  COS[i] = (Math.cos(i * 0.0030679615757712823) * 65536) | 0;
}

/** `Model.animate`: applies `frame` in place to the points, grouped by vertex label. */
export function animate(px: Int32Array, py: Int32Array, pz: Int32Array, groups: Int32Array[], frame: AnimFrame) {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let i = 0; i < frame.ti.length; i++) {
    const t = frame.ti[i];
    const type = frame.base.type[t];
    const labels = frame.base.labels[t];
    const x = frame.tx[i];
    const y = frame.ty[i];
    const z = frame.tz[i];
    if (type === ORIGIN) {
      let count = 0;
      ox = oy = oz = 0;
      for (const l of labels) {
        for (const v of groups[l] ?? []) {
          ox += px[v];
          oy += py[v];
          oz += pz[v];
          count++;
        }
      }
      if (count > 0) {
        ox = ((ox / count) | 0) + x;
        oy = ((oy / count) | 0) + y;
        oz = ((oz / count) | 0) + z;
      } else {
        ox = x;
        oy = y;
        oz = z;
      }
    } else if (type === TRANSLATE) {
      for (const l of labels) {
        for (const v of groups[l] ?? []) {
          px[v] += x;
          py[v] += y;
          pz[v] += z;
        }
      }
    } else if (type === ROTATE) {
      const pitch = (x & 0xff) * 8;
      const yaw = (y & 0xff) * 8;
      const roll = (z & 0xff) * 8;
      for (const l of labels) {
        for (const v of groups[l] ?? []) {
          let vx = px[v] - ox;
          let vy = py[v] - oy;
          let vz = pz[v] - oz;
          if (roll !== 0) {
            const s = SIN[roll];
            const c = COS[roll];
            const nx = (vy * s + vx * c) >> 16;
            vy = (vy * c - vx * s) >> 16;
            vx = nx;
          }
          if (pitch !== 0) {
            const s = SIN[pitch];
            const c = COS[pitch];
            const ny = (vy * c - vz * s) >> 16;
            vz = (vy * s + vz * c) >> 16;
            vy = ny;
          }
          if (yaw !== 0) {
            const s = SIN[yaw];
            const c = COS[yaw];
            const nx = (vz * s + vx * c) >> 16;
            vz = (vz * c - vx * s) >> 16;
            vx = nx;
          }
          px[v] = vx + ox;
          py[v] = vy + oy;
          pz[v] = vz + oz;
        }
      }
    } else if (type === SCALE) {
      for (const l of labels) {
        for (const v of groups[l] ?? []) {
          px[v] = ((((px[v] - ox) * x) / 128) | 0) + ox;
          py[v] = ((((py[v] - oy) * y) / 128) | 0) + oy;
          pz[v] = ((((pz[v] - oz) * z) / 128) | 0) + oz;
        }
      }
    }
    // type 5 (transparency) animates face alpha; the preview keeps alpha static
  }
}
