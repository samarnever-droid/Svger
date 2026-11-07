import { gaussBlur } from "./color";

/* ------------------------------------------------------------------ *
 *  1. Sub-pixel iso-contour extraction (marching squares)
 * ------------------------------------------------------------------ */

export interface TraceOptions {
  sigma: number; // blur of the binary mask before contouring (sub-pixel smoothing)
  minArea: number; // loops smaller than this (px²) are dropped as speckles
  deJitter?: number; // 0..1 Taubin zero-shrinkage staircase smoothing strength
}

export type Loop = {
  xs: Float32Array;
  ys: Float32Array;
  area: number;
  bbox: [number, number, number, number]; // [x0, y0, x1, y1]
};

// edge codes
const T = 0, R = 1, B = 2, L = 3;
// [from, to] segment table, inside is always on the RIGHT-hand side
const CASES: Record<number, number[]> = {
  1: [T, L], 2: [R, T], 3: [R, L], 4: [B, R], 6: [B, T], 7: [B, L],
  8: [L, B], 9: [T, B], 11: [R, B], 12: [L, R], 13: [T, R], 14: [L, T],
};

/**
 * Zero-shrinkage Taubin (lambda/mu) smoothing on a closed contour.
 * Removes +-0.25px Marching Squares diagonal staircase jitter while preserving
 * loop area and sharp corners.
 */
function taubinSmoothLoop(xs: Float32Array, ys: Float32Array, passes: number, cornerCos = 0.35) {
  const n = xs.length;
  if (n < 6 || passes <= 0) return;
  const tx = new Float32Array(n);
  const ty = new Float32Array(n);
  const pinned = new Uint8Array(n);

  // Pin sharp corners so hair tips, text serifs, and corners never round off
  for (let i = 0; i < n; i++) {
    const im = (i - 2 + n) % n;
    const ip = (i + 2) % n;
    const ax = xs[i] - xs[im], ay = ys[i] - ys[im];
    const bx = xs[ip] - xs[i], by = ys[ip] - ys[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 1e-5 && lb > 1e-5) {
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos < cornerCos) pinned[i] = 1;
    }
  }

  const step = (srcX: Float32Array, srcY: Float32Array, dstX: Float32Array, dstY: Float32Array, weight: number) => {
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        dstX[i] = srcX[i];
        dstY[i] = srcY[i];
        continue;
      }
      const im = i === 0 ? n - 1 : i - 1;
      const ip = i === n - 1 ? 0 : i + 1;
      const mx = 0.5 * (srcX[im] + srcX[ip]) - srcX[i];
      const my = 0.5 * (srcY[im] + srcY[ip]) - srcY[i];
      dstX[i] = srcX[i] + weight * mx;
      dstY[i] = srcY[i] + weight * my;
    }
  };

  const lambda = 0.42;
  const mu = -0.44;
  for (let p = 0; p < passes; p++) {
    step(xs, ys, tx, ty, lambda);
    step(tx, ty, xs, ys, mu);
  }
}

/**
 * Trace the ISO=0.5 contour of a continuous field (values 0..1, >=0.5 is inside).
 */
export function traceField(
  field: Float32Array,
  FW: number,
  FH: number,
  ox: number,
  oy: number,
  opts: TraceOptions
): Loop[] {
  const W = FW, H = FH;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (field[row + x] >= 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return [];

  const radius = opts.sigma > 0.05 ? Math.max(1, Math.ceil(opts.sigma * 3)) : 0;
  const P = radius + 3;
  const PW = x1 - x0 + 1 + P * 2;
  const PH = y1 - y0 + 1 + P * 2;

  let f: Float32Array = new Float32Array(PW * PH);
  for (let gy = 0; gy < PH; gy++) {
    let yy = y0 - P + gy;
    yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
    const row = yy * W;
    for (let gx = 0; gx < PW; gx++) {
      let xx = x0 - P + gx;
      xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
      f[gy * PW + gx] = field[row + xx];
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
  const OX = ox;
  const OY = oy;

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
    if (key & 1) return gx + 0.5 + x0 - P + OX;
    const v0 = f[idx], v1 = f[idx + 1];
    return gx + (ISO - v0) / (v1 - v0) + 0.5 + x0 - P + OX;
  };
  const py = (key: number): number => {
    const idx = key >> 1;
    const gy = (idx / PW) | 0;
    if (!(key & 1)) return gy + 0.5 + y0 - P + OY;
    const v0 = f[idx], v1 = f[idx + PW];
    return gy + (ISO - v0) / (v1 - v0) + 0.5 + y0 - P + OY;
  };

  const deJitterPasses = opts.deJitter === undefined ? 0 : Math.round(opts.deJitter);
  const loops: Loop[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    if (next[start] < 0) continue;
    const bufX: number[] = [];
    const bufY: number[] = [];
    let k = start;
    let guard = 0;
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    do {
      const vx = px(k), vy = py(k);
      bufX.push(vx);
      bufY.push(vy);
      if (vx < lx0) lx0 = vx;
      if (vx > lx1) lx1 = vx;
      if (vy < ly0) ly0 = vy;
      if (vy > ly1) ly1 = vy;
      const n = next[k];
      next[k] = -2;
      k = n;
      guard++;
    } while (k >= 0 && k !== start && guard < 1_000_000);
    if (bufX.length < 4) continue;
    // signed area
    let area = 0;
    for (let i = 0, n = bufX.length; i < n; i++) {
      const j = (i + 1) % n;
      area += bufX[i] * bufY[j] - bufX[j] * bufY[i];
    }
    area *= 0.5;
    if (Math.abs(area) < opts.minArea) continue;
    const xs = Float32Array.from(bufX);
    const ys = Float32Array.from(bufY);
    if (deJitterPasses > 0 && xs.length >= 8) {
      taubinSmoothLoop(xs, ys, deJitterPasses);
    }
    loops.push({ xs, ys, area, bbox: [lx0, ly0, lx1, ly1] });
  }
  return loops;
}

/* ------------------------------------------------------------------ *
 *  2. Corner detection + Douglas-Peucker + Bounded Schneider Fitting
 * ------------------------------------------------------------------ */

export interface V { x: number; y: number }
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

/**
 * Douglas-Peucker simplification on an open piece pts[0..n-1] to strip redundant
 * collinear/staircase vertices before cubic fitting.
 */
function simplifyPiece(pts: V[], eps: number): V[] {
  const n = pts.length;
  if (n <= 4 || eps <= 0) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = eps * eps;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 <= 1) continue;
    const ax = pts[i0].x, ay = pts[i0].y;
    const dx = pts[i1].x - ax, dy = pts[i1].y - ay;
    const l2 = dx * dx + dy * dy;
    let maxD2 = -1;
    let maxIdx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      let d2: number;
      if (l2 < 1e-10) {
        const ex = pts[i].x - ax, ey = pts[i].y - ay;
        d2 = ex * ex + ey * ey;
      } else {
        const t = Math.max(0, Math.min(1, ((pts[i].x - ax) * dx + (pts[i].y - ay) * dy) / l2));
        const px = ax + t * dx - pts[i].x;
        const py = ay + t * dy - pts[i].y;
        d2 = px * px + py * py;
      }
      if (d2 > maxD2) {
        maxD2 = d2;
        maxIdx = i;
      }
    }
    if (maxD2 > eps2 && maxIdx > i0 && maxIdx < i1) {
      keep[maxIdx] = 1;
      stack.push([i0, maxIdx], [maxIdx, i1]);
    }
  }

  const out: V[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function chordParamsRange(pts: V[], i0: number, i1: number): Float64Array {
  const lenRange = i1 - i0 + 1;
  const u = new Float64Array(lenRange);
  u[0] = 0;
  for (let i = 1; i < lenRange; i++) {
    const a = pts[i0 + i], b = pts[i0 + i - 1];
    u[i] = u[i - 1] + Math.hypot(a.x - b.x, a.y - b.y);
  }
  const total = u[lenRange - 1] || 1;
  for (let i = 1; i < lenRange; i++) u[i] /= total;
  return u;
}

function generateBezierRange(pts: V[], i0: number, i1: number, u: Float64Array, t1: V, t2: V): Seg {
  const p0 = pts[i0], p3 = pts[i1];
  const n = i1 - i0 + 1;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i0 + i];
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1x = t1.x * b1, a1y = t1.y * b1;
    const a2x = t2.x * b2, a2y = t2.y * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const tx = p.x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const ty = p.y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    x0 += a1x * tx + a1y * ty;
    x1 += a2x * tx + a2y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  const dseg = len(sub(p3, p0));
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  let arc = 0;
  for (let i = i0 + 1; i <= i1; i++) arc += len(sub(pts[i], pts[i - 1]));
  const eps = 1e-6 * dseg;
  if (al < eps || ar < eps || !isFinite(al) || !isFinite(ar) || al > arc * 0.8 || ar > arc * 0.8) {
    al = ar = dseg > 1e-6 ? dseg / 3 : arc / 3;
  }
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function maxErrorRange(pts: V[], i0: number, i1: number, c: Seg, u: Float64Array): [number, number] {
  let worst = 0;
  let split = (i0 + i1) >> 1;
  const n = i1 - i0 + 1;
  for (let i = 1; i < n - 1; i++) {
    const bp = bez(c, u[i]);
    const p = pts[i0 + i];
    const dx = bp.x - p.x, dy = bp.y - p.y;
    const e = dx * dx + dy * dy;
    if (e >= worst) {
      worst = e;
      split = i0 + i;
    }
  }
  return [worst, split];
}

function reparamRange(pts: V[], i0: number, i1: number, u: Float64Array, c: Seg) {
  const n = i1 - i0 + 1;
  for (let i = 1; i < n - 1; i++) {
    const t = u[i];
    const d = sub(bez(c, t), pts[i0 + i]);
    const d1 = bez1(c, t), d2 = bez2(c, t);
    const num = dot(d, d1);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) > 1e-12) {
      const nt = t - num / den;
      u[i] = nt < 0 ? 0 : nt > 1 ? 1 : nt;
    }
  }
}

function fitCubicRange(pts: V[], i0: number, i1: number, t1: V, t2: V, err: number, out: Seg[], depth = 0) {
  const n = i1 - i0 + 1;
  if (n <= 2) {
    const d = len(sub(pts[i1], pts[i0])) / 3;
    out.push([pts[i0], add(pts[i0], mul(t1, d)), add(pts[i1], mul(t2, d)), pts[i1]]);
    return;
  }


  const u = chordParamsRange(pts, i0, i1);
  let c = generateBezierRange(pts, i0, i1, u, t1, t2);
  let [e, split] = maxErrorRange(pts, i0, i1, c, u);
  if (e < err) {
    out.push(c);
    return;
  }
  if (e < err * 12) {
    for (let i = 0; i < 5; i++) {
      reparamRange(pts, i0, i1, u, c);
      c = generateBezierRange(pts, i0, i1, u, t1, t2);
      [e, split] = maxErrorRange(pts, i0, i1, c, u);
      if (e < err) {
        out.push(c);
        return;
      }
    }
  }
  if (depth >= 12 || n < 4) {
    out.push(c);
    return;
  }
  split = Math.max(i0 + 1, Math.min(i1 - 1, split));
  const tc = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubicRange(pts, i0, split, t1, tc, err, out, depth + 1);
  fitCubicRange(pts, split, i1, mul(tc, -1), t2, err, out, depth + 1);
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



  const cuts: { i: number; corner: boolean }[] = corners.map((i) => ({ i, corner: true }));
  if (cuts.length === 0) {
    cuts.push({ i: 0, corner: false });
    cuts.push({ i: Math.floor(n / 2), corner: false });
  } else if (cuts.length === 1) {
    cuts.push({ i: (cuts[0].i + Math.floor(n / 2)) % n, corner: false });
    cuts.sort((a, b) => a.i - b.i);
  }

  const kk = k + 1;
  const tanOrig = (i: number, dir: 1 | -1, corner: boolean): V => {
    if (corner) {
      const j = (i + dir * kk + n * 4) % n;
      return norm(sub(pts[j], pts[i]));
    }
    const a = pts[(i - kk + n * 4) % n], b = pts[(i + kk) % n];
    return norm(mul(sub(b, a), dir));
  };

  const err = o.tolerance * o.tolerance;
  const dpEps = o.tolerance > 0.35 ? o.tolerance * 0.2 : 0;
  const out: Seg[] = [];

  for (let c = 0; c < cuts.length; c++) {
    const a = cuts[c], b = cuts[(c + 1) % cuts.length];
    let piece: V[] = [];
    let i = a.i;
    piece.push(pts[i]);
    while (i !== b.i) {
      i = (i + 1) % n;
      piece.push(pts[i]);
    }
    if (piece.length < 2) continue;
    if (piece.length > 8 && dpEps > 0.02) {
      piece = simplifyPiece(piece, dpEps);
    }
    if (piece.length === 2) {
      const d = len(sub(piece[1], piece[0])) / 3;
      const t1 = norm(sub(piece[1], piece[0]));
      out.push([piece[0], add(piece[0], mul(t1, d)), sub(piece[1], mul(t1, d)), piece[1]]);
      continue;
    }
    const t1 = tanOrig(a.i, 1, a.corner);
    const t2 = tanOrig(b.i, -1, b.corner);
    fitCubicRange(piece, 0, piece.length - 1, t1, t2, err, out, 0);
  }
  return { segs: out, polygon: false };
}

/* ------------------------------------------------------------------ *
 *  3. Geometric Primitive Recognition (<rect>, <circle>, <ellipse>, <polygon>)
 * ------------------------------------------------------------------ */

export interface ShapePrimitive {
  tag: "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line";
  attrs: Record<string, string | number>;
  nodes: number;
}

/**
 * Inspects a single loop (no holes) and determines if it can be represented
 * more accurately and compactly as a native SVG <rect>, <circle>, <ellipse>, or <polygon>.
 */
export function detectPrimitiveShape(loop: Loop, segs: Seg[], scale: number, tolerance: number): ShapePrimitive | null {
  const n = loop.xs.length;
  const absArea = Math.abs(loop.area) / (scale * scale);
  const [bx0, by0, bx1, by1] = loop.bbox.map((v) => v / scale);
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 0.4 || bh < 0.4) return null;

  const r1 = (v: number) => Math.round(v * 10) / 10;

  // 1. Check for <circle> or axis-aligned <ellipse> on compact glints, droplets, dots, catchlights
  if (absArea >= 2.0 && absArea <= 1800 && n >= 8) {
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      cx += loop.xs[i] / scale;
      cy += loop.ys[i] / scale;
    }
    cx /= n;
    cy /= n;
    const rx = bw * 0.5;
    const ry = bh * 0.5;
    const expectedArea = Math.PI * rx * ry;
    if (rx > 0.6 && ry > 0.6 && Math.abs(absArea - expectedArea) / expectedArea < 0.11) {
      let maxRadErr = 0;
      for (let i = 0; i < n; i++) {
        const dx = (loop.xs[i] / scale - cx) / rx;
        const dy = (loop.ys[i] / scale - cy) / ry;
        const r = Math.hypot(dx, dy);
        const err = Math.abs(r - 1) * Math.min(rx, ry);
        if (err > maxRadErr) maxRadErr = err;
      }
      if (maxRadErr <= Math.max(0.32, tolerance * 1.1)) {
        if (Math.abs(rx - ry) <= 0.25) {
          return {
            tag: "circle",
            attrs: { cx: r1(cx), cy: r1(cy), r: r1((rx + ry) * 0.5) },
            nodes: 1,
          };
        }
        return {
          tag: "ellipse",
          attrs: { cx: r1(cx), cy: r1(cy), rx: r1(rx), ry: r1(ry) },
          nodes: 1,
        };
      }
    }
  }

  // 2. Check for axis-aligned <rect>
  const rectArea = bw * bh;
  if (rectArea >= 6 && Math.abs(absArea - rectArea) / rectArea < 0.045) {
    let maxEdgeDist = 0;
    for (let i = 0; i < n; i++) {
      const x = loop.xs[i] / scale;
      const y = loop.ys[i] / scale;
      const d = Math.min(Math.abs(x - bx0), Math.abs(x - bx1), Math.abs(y - by0), Math.abs(y - by1));
      if (d > maxEdgeDist) maxEdgeDist = d;
    }
    if (maxEdgeDist <= Math.max(0.28, tolerance * 0.9)) {
      return {
        tag: "rect",
        attrs: { x: r1(bx0), y: r1(by0), width: r1(bw), height: r1(bh) },
        nodes: 4,
      };
    }
  }

  // 3. Check if all fitted segments are straight lines (and loop is small/medium angular shape) -> <polygon>
  if (segs.length >= 3 && segs.length <= 14) {
    let allLinear = true;
    const lineTol = Math.max(0.12, tolerance * 0.45) * scale;
    for (const s of segs) {
      if (!isSegLinear(s, lineTol)) {
        allLinear = false;
        break;
      }
    }
    if (allLinear) {
      const ptsStr = segs.map((s) => `${r1(s[0].x / scale)},${r1(s[0].y / scale)}`).join(" ");
      return {
        tag: "polygon",
        attrs: { points: ptsStr },
        nodes: segs.length,
      };
    }
  }

  return null;
}

function isSegLinear(s: Seg, tol: number): boolean {
  const dx = s[3].x - s[0].x, dy = s[3].y - s[0].y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-6) return true;
  const tol2 = tol * tol;
  for (let k = 1; k <= 2; k++) {
    const px = s[k].x - s[0].x, py = s[k].y - s[0].y;
    const t = (px * dx + py * dy) / l2;
    if (t < -0.05 || t > 1.05) return false;
    const ex = px - t * dx, ey = py - t * dy;
    if (ex * ex + ey * ey > tol2) return false;
  }
  return true;
}

function trySegQuadratic(s: Seg, tol: number): V | null {
  // Cubic is quadratic with control point Q if Q1a = (3*p1 - p0)/2 == Q1b = (3*p2 - p3)/2
  const qax = 1.5 * s[1].x - 0.5 * s[0].x;
  const qay = 1.5 * s[1].y - 0.5 * s[0].y;
  const qbx = 1.5 * s[2].x - 0.5 * s[3].x;
  const qby = 1.5 * s[2].y - 0.5 * s[3].y;
  // Error bound between cubic and quadratic approximation is sqrt(3)/36 * |Q1a - Q1b| * 2
  const diff = Math.hypot(qax - qbx, qay - qby) * 0.1;
  if (diff <= tol) {
    return { x: 0.5 * (qax + qbx), y: 0.5 * (qay + qby) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  4. Ultra-compact SVG Path Serializer (M, L, H, V, Q, S, C, Z + relative)
 * ------------------------------------------------------------------ */

export function loopToPath(
  loop: Loop,
  segs: Seg[],
  polygon: boolean,
  scale: number,
  tolerance = 0.2
): { d: string; nodes: number } {
  const dec = tolerance <= 0.4 ? 2 : 1;
  const mult = dec === 2 ? 100 : 10;
  const qNum = (v: number) => Math.round((v / scale) * mult) / mult;

  const fmtNum = (n: number): string => {
    const v = Math.abs(n) < 1e-4 ? 0 : n;
    let s = v.toFixed(dec);
    if (dec > 0 && s.indexOf(".") >= 0) {
      s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
    if (s.startsWith("0.")) s = s.slice(1);
    else if (s.startsWith("-0.")) s = "-" + s.slice(2);
    return s;
  };

  const joinCoords = (nums: number[]): string => {
    let out = "";
    for (let i = 0; i < nums.length; i++) {
      const s = fmtNum(nums[i]);
      if (i === 0) {
        out += s;
      } else if (s.startsWith("-")) {
        out += s;
      } else {
        out += " " + s;
      }
    }
    return out;
  };

  if (polygon || segs.length === 0) {
    let cx = qNum(loop.xs[0]);
    let cy = qNum(loop.ys[0]);
    let d = "M" + joinCoords([cx, cy]);
    let nodes = 1;
    for (let i = 1; i < loop.xs.length; i++) {
      const nx = qNum(loop.xs[i]);
      const ny = qNum(loop.ys[i]);
      const dx = +(nx - cx).toFixed(dec);
      const dy = +(ny - cy).toFixed(dec);
      if (dx === 0 && dy === 0) continue;
      if (dy === 0) d += "h" + fmtNum(dx);
      else if (dx === 0) d += "v" + fmtNum(dy);
      else d += "l" + joinCoords([dx, dy]);
      cx = nx;
      cy = ny;
      nodes++;
    }
    return { d: d + "Z", nodes };
  }

  const lineTol = Math.max(0.035, tolerance * 0.18) * scale;
  const quadTol = Math.max(0.035, tolerance * 0.16) * scale;
  const smoothTol = Math.max(0.04, tolerance * 0.18);

  let cx = qNum(segs[0][0].x);
  let cy = qNum(segs[0][0].y);
  let d = "M" + joinCoords([cx, cy]);
  let prevCubicC2: V | null = null;
  let nodes = 0;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const x3 = qNum(s[3].x);
    const y3 = qNum(s[3].y);
    const dx3 = +(x3 - cx).toFixed(dec);
    const dy3 = +(y3 - cy).toFixed(dec);

    if (isSegLinear(s, lineTol)) {
      if (dx3 === 0 && dy3 === 0) continue;
      if (dy3 === 0) {
        const rel = "h" + fmtNum(dx3);
        const abs = "H" + fmtNum(x3);
        d += rel.length <= abs.length ? rel : abs;
      } else if (dx3 === 0) {
        const rel = "v" + fmtNum(dy3);
        const abs = "V" + fmtNum(y3);
        d += rel.length <= abs.length ? rel : abs;
      } else {
        const rel = "l" + joinCoords([dx3, dy3]);
        const abs = "L" + joinCoords([x3, y3]);
        d += rel.length <= abs.length ? rel : abs;
      }
      cx = x3;
      cy = y3;
      prevCubicC2 = null;
      nodes++;
      continue;
    }

    const qCtrl = trySegQuadratic(s, quadTol);
    if (qCtrl) {
      const qx = qNum(qCtrl.x);
      const qy = qNum(qCtrl.y);
      const dqx = +(qx - cx).toFixed(dec);
      const dqy = +(qy - cy).toFixed(dec);
      const rel = "q" + joinCoords([dqx, dqy, dx3, dy3]);
      const abs = "Q" + joinCoords([qx, qy, x3, y3]);
      d += rel.length <= abs.length ? rel : abs;
      cx = x3;
      cy = y3;
      prevCubicC2 = null;
      nodes++;
      continue;
    }

    const x1 = qNum(s[1].x), y1 = qNum(s[1].y);
    const x2 = qNum(s[2].x), y2 = qNum(s[2].y);
    const dx1 = +(x1 - cx).toFixed(dec), dy1 = +(y1 - cy).toFixed(dec);
    const dx2 = +(x2 - cx).toFixed(dec), dy2 = +(y2 - cy).toFixed(dec);

    if (prevCubicC2) {
      const rx1 = 2 * cx - prevCubicC2.x;
      const ry1 = 2 * cy - prevCubicC2.y;
      if (Math.hypot(rx1 - x1, ry1 - y1) <= smoothTol) {
        const rel = "s" + joinCoords([dx2, dy2, dx3, dy3]);
        const abs = "S" + joinCoords([x2, y2, x3, y3]);
        d += rel.length <= abs.length ? rel : abs;
        prevCubicC2 = { x: x2, y: y2 };
        cx = x3;
        cy = y3;
        nodes++;
        continue;
      }
    }

    const rel = "c" + joinCoords([dx1, dy1, dx2, dy2, dx3, dy3]);
    const abs = "C" + joinCoords([x1, y1, x2, y2, x3, y3]);
    d += rel.length <= abs.length ? rel : abs;
    prevCubicC2 = { x: x2, y: y2 };
    cx = x3;
    cy = y3;
    nodes++;
  }

  return { d: d + "Z", nodes: Math.max(1, nodes) };
}
