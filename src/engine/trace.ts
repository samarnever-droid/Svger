import { gaussBlur } from "./color";

/* ------------------------------------------------------------------ *
 *  1. Sub-pixel iso-contour extraction (marching squares)
 * ------------------------------------------------------------------ */

export interface TraceOptions {
  sigma: number; // blur of the binary mask before contouring (sub-pixel smoothing)
  minArea: number; // loops smaller than this (px²) are dropped as speckles
}

export type Loop = { xs: Float32Array; ys: Float32Array; area: number };

// edge codes
const T = 0, R = 1, B = 2, L = 3;
// [from, to] segment table, inside is always on the RIGHT-hand side
const CASES: Record<number, number[]> = {
  1: [T, L], 2: [R, T], 3: [R, L], 4: [B, R], 6: [B, T], 7: [B, L],
  8: [L, B], 9: [T, B], 11: [R, B], 12: [L, R], 13: [T, R], 14: [L, T],
};

/**
 * Trace the boundary of { rank >= level } and return closed polylines.
 * Thin 1px structures (line-art, lightning, text strokes) survive because the
 * blur is tiny and the contour is interpolated at sub-pixel precision.
 */
export function traceMask(
  rank: Uint8Array,
  W: number,
  H: number,
  level: number,
  opts: TraceOptions
): Loop[] {
  // bounding box of mask
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (rank[row + x] >= level) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return [];

  const radius = Math.max(1, Math.ceil(opts.sigma * 3));
  const P = radius + 3;
  const PW = x1 - x0 + 1 + P * 2;
  const PH = y1 - y0 + 1 + P * 2;

  let f: Float32Array = new Float32Array(PW * PH);
  for (let gy = 0; gy < PH; gy++) {
    let yy = y0 - P + gy;
    yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy; // replicate → contour leaves the canvas
    const row = yy * W;
    for (let gx = 0; gx < PW; gx++) {
      let xx = x0 - P + gx;
      xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
      f[gy * PW + gx] = rank[row + xx] >= level ? 1 : 0;
    }
  }
  if (opts.sigma > 0.05) f = gaussBlur(f, PW, PH, opts.sigma);
  // force closed outline
  for (let gx = 0; gx < PW; gx++) {
    f[gx] = 0;
    f[(PH - 1) * PW + gx] = 0;
  }
  for (let gy = 0; gy < PH; gy++) {
    f[gy * PW] = 0;
    f[gy * PW + PW - 1] = 0;
  }

  const next = new Int32Array(PW * PH * 2).fill(-1);
  const starts: number[] = [];
  const ISO = 0.5;

  for (let j = 0; j < PH - 1; j++) {
    for (let i = 0; i < PW - 1; i++) {
      const idx = j * PW + i;
      const a = f[idx], b = f[idx + 1], c = f[idx + PW + 1], d = f[idx + PW];
      const code =
        (a >= ISO ? 1 : 0) | (b >= ISO ? 2 : 0) | (c >= ISO ? 4 : 0) | (d >= ISO ? 8 : 0);
      if (code === 0 || code === 15) continue;

      // T: h(i,j)  R: v(i+1,j)  B: h(i,j+1)  L: v(i,j)
      const edgeKey = [2 * idx, 2 * (idx + 1) + 1, 2 * (idx + PW), 2 * idx + 1];

      let segs: number[];
      if (code === 5 || code === 10) {
        const centre = (a + b + c + d) / 4 >= ISO;
        if (code === 5) segs = centre ? [T, R, B, L] : [T, L, B, R];
        else segs = centre ? [L, T, R, B] : [R, T, L, B];
      } else segs = CASES[code];

      for (let s = 0; s < segs.length; s += 2) {
        const k0 = edgeKey[segs[s]];
        next[k0] = edgeKey[segs[s + 1]];
        starts.push(k0);
      }
    }
  }

  const px = (key: number): number => {
    const idx = key >> 1;
    const gx = idx % PW;
    if (key & 1) return gx + 0.5 + x0 - P;
    const v0 = f[idx], v1 = f[idx + 1];
    return gx + (ISO - v0) / (v1 - v0) + 0.5 + x0 - P;
  };
  const py = (key: number): number => {
    const idx = key >> 1;
    const gy = (idx / PW) | 0;
    if (!(key & 1)) return gy + 0.5 + y0 - P;
    const v0 = f[idx], v1 = f[idx + PW];
    return gy + (ISO - v0) / (v1 - v0) + 0.5 + y0 - P;
  };

  const loops: Loop[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    if (next[start] < 0) continue;
    const bufX: number[] = [];
    const bufY: number[] = [];
    let k = start;
    let guard = 0;
    do {
      bufX.push(px(k));
      bufY.push(py(k));
      const n = next[k];
      next[k] = -2;
      k = n;
      guard++;
    } while (k >= 0 && k !== start && guard < 5_000_000);
    if (bufX.length < 4) continue;
    // signed area
    let area = 0;
    for (let i = 0, n = bufX.length; i < n; i++) {
      const j = (i + 1) % n;
      area += bufX[i] * bufY[j] - bufX[j] * bufY[i];
    }
    area *= 0.5;
    if (Math.abs(area) < opts.minArea) continue;
    loops.push({ xs: Float32Array.from(bufX), ys: Float32Array.from(bufY), area });
  }
  return loops;
}

/* ------------------------------------------------------------------ *
 *  2. Corner detection + Schneider cubic Bézier fitting
 * ------------------------------------------------------------------ */

interface V { x: number; y: number }
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const norm = (a: V): V => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};

export type Seg = [V, V, V, V];

function bez(c: Seg, t: number): V {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + cc * c[2].x + d * c[3].x,
    y: a * c[0].y + b * c[1].y + cc * c[2].y + d * c[3].y,
  };
}
function bez1(c: Seg, t: number): V {
  const mt = 1 - t;
  const a = 3 * mt * mt, b = 6 * mt * t, d = 3 * t * t;
  return {
    x: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
    y: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
  };
}
function bez2(c: Seg, t: number): V {
  const mt = 1 - t;
  return {
    x: 6 * mt * (c[2].x - 2 * c[1].x + c[0].x) + 6 * t * (c[3].x - 2 * c[2].x + c[1].x),
    y: 6 * mt * (c[2].y - 2 * c[1].y + c[0].y) + 6 * t * (c[3].y - 2 * c[2].y + c[1].y),
  };
}

function chordParams(pts: V[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(pts: V[], u: number[], t1: V, t2: V): Seg {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const dseg = len(sub(p3, p0));
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  let arc = 0;
  for (let i = 1; i < pts.length; i++) arc += len(sub(pts[i], pts[i - 1]));
  const eps = 1e-6 * dseg;
  if (al < eps || ar < eps || !isFinite(al) || !isFinite(ar) || al > arc * 0.8 || ar > arc * 0.8) {
    al = ar = dseg > 1e-6 ? dseg / 3 : arc / 3;
  }
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function maxError(pts: V[], c: Seg, u: number[]): [number, number] {
  let worst = 0, split = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = sub(bez(c, u[i]), pts[i]);
    const e = d.x * d.x + d.y * d.y;
    if (e >= worst) {
      worst = e;
      split = i;
    }
  }
  return [worst, split];
}

function reparam(pts: V[], u: number[], c: Seg): number[] {
  return u.map((t, i) => {
    const d = sub(bez(c, t), pts[i]);
    const d1 = bez1(c, t), d2 = bez2(c, t);
    const num = dot(d, d1);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    const nt = t - num / den;
    return nt < 0 ? 0 : nt > 1 ? 1 : nt;
  });
}

function fitCubic(pts: V[], t1: V, t2: V, err: number, out: Seg[], depth = 0) {
  const n = pts.length;
  if (n === 2) {
    const d = len(sub(pts[1], pts[0])) / 3;
    out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let c = generateBezier(pts, u, t1, t2);
  let [e, split] = maxError(pts, c, u);
  if (e < err) {
    out.push(c);
    return;
  }
  if (e < err * 16) {
    for (let i = 0; i < 6; i++) {
      u = reparam(pts, u, c);
      c = generateBezier(pts, u, t1, t2);
      [e, split] = maxError(pts, c, u);
      if (e < err) {
        out.push(c);
        return;
      }
    }
  }
  if (depth > 40 || n < 4) {
    out.push(c);
    return;
  }
  split = Math.max(1, Math.min(n - 2, split));
  const tc = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts.slice(0, split + 1), t1, tc, err, out, depth + 1);
  fitCubic(pts.slice(split), mul(tc, -1), t2, err, out, depth + 1);
}

export interface FitOptions {
  tolerance: number; // px
  cornerAngle: number; // degrees
}

/** Fit one closed polyline with a sequence of cubic Béziers, preserving corners. */
export function fitLoop(loop: Loop, o: FitOptions): { segs: Seg[]; polygon: boolean } {
  const n = loop.xs.length;
  const pts: V[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: loop.xs[i], y: loop.ys[i] };

  if (n < 8) return { segs: [], polygon: true };

  // --- corner detection (turning angle over a window, then non-max suppression)
  const k = Math.max(2, Math.min(5, Math.floor(n / 8)));
  const angle = new Float32Array(n);
  const thr = (o.cornerAngle * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = sub(pts[i], pts[(i - k + n) % n]);
    const b = sub(pts[(i + k) % n], pts[i]);
    const la = len(a), lb = len(b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
    angle[i] = Math.acos(c);
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (angle[i] < thr) continue;
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) {
      if (j === 0) continue;
      const q = angle[(i + j + n) % n];
      if (q > angle[i] || (q === angle[i] && j < 0)) isMax = false;
    }
    if (isMax) corners.push(i);
  }

  const tanAt = (i: number, dir: 1 | -1, corner: boolean): V => {
    // dir=1: tangent pointing forward, dir=-1: pointing backward
    const kk = k + 1;
    if (corner) {
      const j = (i + dir * kk + n * 4) % n;
      return norm(sub(pts[j], pts[i]));
    }
    const a = pts[(i - kk + n * 4) % n], b = pts[(i + kk) % n];
    return norm(mul(sub(b, a), dir));
  };

  const cuts: { i: number; corner: boolean }[] = corners.map((i) => ({ i, corner: true }));
  if (cuts.length === 0) {
    cuts.push({ i: 0, corner: false });
    cuts.push({ i: Math.floor(n / 2), corner: false });
  } else if (cuts.length === 1) {
    cuts.push({ i: (cuts[0].i + Math.floor(n / 2)) % n, corner: false });
    cuts.sort((a, b) => a.i - b.i);
  }

  const err = o.tolerance * o.tolerance;
  const out: Seg[] = [];
  for (let c = 0; c < cuts.length; c++) {
    const a = cuts[c], b = cuts[(c + 1) % cuts.length];
    const piece: V[] = [];
    let i = a.i;
    piece.push(pts[i]);
    while (i !== b.i) {
      i = (i + 1) % n;
      piece.push(pts[i]);
    }
    if (piece.length < 2) continue;
    if (piece.length === 2) {
      const d = len(sub(piece[1], piece[0])) / 3;
      const t1 = norm(sub(piece[1], piece[0]));
      out.push([piece[0], add(piece[0], mul(t1, d)), sub(piece[1], mul(t1, d)), piece[1]]);
      continue;
    }
    const t1 = tanAt(a.i, 1, a.corner);
    const t2 = tanAt(b.i, -1, b.corner);
    fitCubic(piece, t1, t2, err, out);
  }
  return { segs: out, polygon: false };
}

export function loopToPath(loop: Loop, segs: Seg[], polygon: boolean, scale: number): { d: string; nodes: number } {
  const fmt = (v: number) => {
    const s = (v / scale).toFixed(2);
    return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  if (polygon || segs.length === 0) {
    let d = "";
    for (let i = 0; i < loop.xs.length; i++) d += (i ? "L" : "M") + fmt(loop.xs[i]) + " " + fmt(loop.ys[i]);
    return { d: d + "Z", nodes: loop.xs.length };
  }
  let d = "M" + fmt(segs[0][0].x) + " " + fmt(segs[0][0].y);
  for (const s of segs) {
    d += "C" + fmt(s[1].x) + " " + fmt(s[1].y) + " " + fmt(s[2].x) + " " + fmt(s[2].y) + " " + fmt(s[3].x) + " " + fmt(s[3].y);
  }
  return { d: d + "Z", nodes: segs.length };
}
