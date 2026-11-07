import { bilateral, gaussBlur, hex, rgbToLab } from "./color";
import { fitLoop, loopToPath, traceMask } from "./trace";

export interface VectorOptions {
  maxColors: number; // palette ceiling
  iterations: number; // refinement passes (default 30)
  tolerance: number; // Bézier fit tolerance in source px
  sigma: number; // contour smoothing (source px)
  cornerAngle: number; // degrees
  minArea: number; // despeckle (source px²)
  denoise: number; // 0-3 bilateral passes
  detail: number; // 0-1 — how hard the palette fights for thin lines / edges
  scale: number; // internal super-sampling (1 or 2)
}

export interface Layer {
  id: string;
  color: string;
  d: string;
  nodes: number;
  loops: number;
  coverage: number;
}

export interface Progress {
  phase: string;
  pct: number;
  iteration?: number;
  error?: number;
  colors?: number;
}

export interface VectorResult {
  width: number;
  height: number;
  background: string;
  layers: Layer[];
  errors: number[];
  colorHistory: number[];
  nodes: number;
  loops: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSvg(w: number, h: number, bg: string, layers: Layer[], hidden?: Set<string>): string {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="geometricPrecision">`;
  s += `<title>Vectorised artwork</title>`;
  s += `<rect id="background" width="${w}" height="${h}" fill="${bg}"/>`;
  for (const l of layers) {
    if (hidden && hidden.has(l.id)) continue;
    s += `<path id="${l.id}" fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`;
  }
  return s + "</svg>";
}

export async function vectorize(
  img: ImageData,
  origW: number,
  origH: number,
  opts: VectorOptions,
  onProgress: (p: Progress) => void,
  signal?: { aborted: boolean }
): Promise<VectorResult> {
  const check = () => {
    if (signal?.aborted) throw new Error("aborted");
  };
  const W = img.width, H = img.height, N = W * H;
  const scale = opts.scale;

  /* ---------- 1. denoise ---------- */
  onProgress({ phase: "Denoising (edge-preserving)", pct: 1 });
  await tick();
  let px: Uint8ClampedArray = img.data;
  const radius = scale >= 2 ? 3 : 2;
  for (let p = 0; p < opts.denoise; p++) {
    px = bilateral(px, W, H, radius, radius * 0.7, 16);
    onProgress({ phase: `Denoising pass ${p + 1}/${opts.denoise}`, pct: 1 + ((p + 1) / opts.denoise) * 5 });
    await tick();
    check();
  }

  /* ---------- 2. Lab + detail weights ---------- */
  onProgress({ phase: "Converting to CIELAB, mapping line-art & edges", pct: 7 });
  await tick();
  const lab = new Float32Array(N * 3);
  const Lc = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rgbToLab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], lab, i * 3);
    Lc[i] = lab[i * 3];
  }
  const blurred = gaussBlur(Lc, W, H, 2.2 * scale);

  const S = Math.min(N, 90000);
  const sLab = new Float32Array(S * 3);
  const sW = new Float32Array(S);
  const sIdx = new Int32Array(S);
  const rand = rng(1337);
  const step = N / S;
  for (let j = 0; j < S; j++) {
    const i = Math.min(N - 1, Math.floor(j * step + rand() * step));
    sIdx[j] = i;
    sLab[j * 3] = lab[i * 3];
    sLab[j * 3 + 1] = lab[i * 3 + 1];
    sLab[j * 3 + 2] = lab[i * 3 + 2];
    const x = i % W, y = (i / W) | 0;
    const xm = x > 0 ? i - 1 : i, xp = x < W - 1 ? i + 1 : i;
    const ym = y > 0 ? i - W : i, yp = y < H - 1 ? i + W : i;
    const g = Math.abs(Lc[xp] - Lc[xm]) + Math.abs(Lc[yp] - Lc[ym]);
    const line = Math.max(0, blurred[i] - Lc[i]); // dark thin structure
    const edge = Math.min(1, g / 18);
    const ln = Math.min(1, line / 9);
    sW[j] = 1 + opts.detail * (5 * ln + 2 * edge);
  }

  /* ---------- 3. 30-pass error-driven palette refinement ---------- */
  const centers: number[] = [];
  {
    let m0 = 0, m1 = 0, m2 = 0, ws = 0;
    for (let j = 0; j < S; j++) {
      m0 += sLab[j * 3] * sW[j];
      m1 += sLab[j * 3 + 1] * sW[j];
      m2 += sLab[j * 3 + 2] * sW[j];
      ws += sW[j];
    }
    centers.push(m0 / ws, m1 / ws, m2 / ws);
  }
  const sLabelArr = new Uint16Array(S);
  const sDist = new Float32Array(S);

  const assign = () => {
    const K = centers.length / 3;
    const sse = new Float64Array(K);
    const sums = new Float64Array(K * 3);
    const wsum = new Float64Array(K);
    let errW = 0, errU = 0, wTot = 0;
    for (let j = 0; j < S; j++) {
      const l = sLab[j * 3], a = sLab[j * 3 + 1], b = sLab[j * 3 + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dl = l - centers[k * 3], da = a - centers[k * 3 + 1], db = b - centers[k * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      sLabelArr[j] = best;
      sDist[j] = bd;
      const w = sW[j];
      sse[best] += bd * w;
      wsum[best] += w;
      sums[best * 3] += l * w;
      sums[best * 3 + 1] += a * w;
      sums[best * 3 + 2] += b * w;
      const e = Math.sqrt(bd);
      errW += e * w;
      errU += e;
      wTot += w;
    }
    return { sse, sums, wsum, errW: errW / wTot, errU: errU / S };
  };

  const lloyd = () => {
    const st = assign();
    const K = centers.length / 3;
    for (let k = 0; k < K; k++) {
      if (st.wsum[k] > 0) {
        centers[k * 3] = st.sums[k * 3] / st.wsum[k];
        centers[k * 3 + 1] = st.sums[k * 3 + 1] / st.wsum[k];
        centers[k * 3 + 2] = st.sums[k * 3 + 2] / st.wsum[k];
      }
    }
    return st;
  };

  const splitCluster = (c: number) => {
    let m0 = 0, m1 = 0, m2 = 0, ws = 0;
    for (let j = 0; j < S; j++) {
      if (sLabelArr[j] !== c) continue;
      const w = sW[j];
      m0 += sLab[j * 3] * w;
      m1 += sLab[j * 3 + 1] * w;
      m2 += sLab[j * 3 + 2] * w;
      ws += w;
    }
    if (ws <= 0) return false;
    m0 /= ws; m1 /= ws; m2 /= ws;
    let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
    for (let j = 0; j < S; j++) {
      if (sLabelArr[j] !== c) continue;
      const w = sW[j];
      const d0 = sLab[j * 3] - m0, d1 = sLab[j * 3 + 1] - m1, d2 = sLab[j * 3 + 2] - m2;
      c00 += w * d0 * d0; c01 += w * d0 * d1; c02 += w * d0 * d2;
      c11 += w * d1 * d1; c12 += w * d1 * d2; c22 += w * d2 * d2;
    }
    c00 /= ws; c01 /= ws; c02 /= ws; c11 /= ws; c12 /= ws; c22 /= ws;
    let v0 = 1, v1 = 0.3, v2 = 0.1, lam = 0;
    for (let it = 0; it < 12; it++) {
      const n0 = c00 * v0 + c01 * v1 + c02 * v2;
      const n1 = c01 * v0 + c11 * v1 + c12 * v2;
      const n2 = c02 * v0 + c12 * v1 + c22 * v2;
      const l = Math.hypot(n0, n1, n2);
      if (l < 1e-9) return false;
      v0 = n0 / l; v1 = n1 / l; v2 = n2 / l;
      lam = l;
    }
    const sd = Math.sqrt(lam);
    if (sd < 0.6) return false;
    centers.push(m0 + 0.6 * sd * v0, m1 + 0.6 * sd * v1, m2 + 0.6 * sd * v2);
    centers[c * 3] = m0 - 0.6 * sd * v0;
    centers[c * 3 + 1] = m1 - 0.6 * sd * v1;
    centers[c * 3 + 2] = m2 - 0.6 * sd * v2;
    return true;
  };

  const errors: number[] = [];
  const colorHistory: number[] = [];
  const iters = Math.max(4, opts.iterations);
  const growth = Math.max(2, Math.round(iters * 0.72));
  let lastErr = 99;

  for (let it = 0; it < iters; it++) {
    check();
    let K = centers.length / 3;
    if (it < growth && K < opts.maxColors && lastErr > 0.9) {
      const target = Math.min(opts.maxColors, Math.round(1 + (opts.maxColors - 1) * ((it + 1) / growth)));
      let guard = 0;
      while (K < target && guard++ < 8) {
        const st = assign();
        const order = Array.from({ length: K }, (_, k) => k).sort((a, b) => st.sse[b] - st.sse[a]);
        let m = Math.min(target - K, K);
        for (const c of order) {
          if (m <= 0) break;
          if (splitCluster(c)) m--;
        }
        // error-driven: inject the colour that is worst represented (rare highlights, tiny details)
        if (it % 3 === 2 && centers.length / 3 < target) {
          let bj = -1, bv = 0;
          for (let j = 0; j < S; j++) {
            const v = sDist[j] * sW[j];
            if (v > bv) { bv = v; bj = j; }
          }
          if (bj >= 0 && sDist[bj] > 16) centers.push(sLab[bj * 3], sLab[bj * 3 + 1], sLab[bj * 3 + 2]);
        }
        const nk = centers.length / 3;
        if (nk === K) break;
        K = nk;
      }
    }
    lloyd();
    const st = lloyd();
    lastErr = st.errU;
    errors.push(st.errU);
    colorHistory.push(centers.length / 3);
    onProgress({
      phase: `Refinement pass ${it + 1}/${iters}`,
      pct: 8 + ((it + 1) / iters) * 32,
      iteration: it + 1,
      error: st.errU,
      colors: centers.length / 3,
    });
    await tick();
  }

  /* ---------- 4. label the whole image ---------- */
  onProgress({ phase: "Classifying every pixel", pct: 41 });
  await tick();
  let K = centers.length / 3;
  let labels = new Uint16Array(N);
  const classify = () => {
    K = centers.length / 3;
    const counts = new Float64Array(K);
    for (let i = 0; i < N; i++) {
      const l = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const dl = l - centers[k * 3], da = a - centers[k * 3 + 1], db = b - centers[k * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      labels[i] = best;
      counts[best]++;
    }
    return counts;
  };
  let counts = classify();
  const minCount = Math.max(3, N * 0.000004);
  const keep: number[] = [];
  for (let k = 0; k < K; k++) if (counts[k] >= minCount) keep.push(k);
  if (keep.length < K && keep.length > 0) {
    const nc: number[] = [];
    for (const k of keep) nc.push(centers[k * 3], centers[k * 3 + 1], centers[k * 3 + 2]);
    centers.length = 0;
    centers.push(...nc);
    labels = new Uint16Array(N);
    counts = classify();
  }
  K = centers.length / 3;

  // real fill colours = mean sRGB of members
  const sr = new Float64Array(K), sg = new Float64Array(K), sb = new Float64Array(K), cn = new Float64Array(K);
  for (let i = 0; i < N; i++) {
    const k = labels[i];
    sr[k] += px[i * 4]; sg[k] += px[i * 4 + 1]; sb[k] += px[i * 4 + 2]; cn[k]++;
  }
  const colors: string[] = [];
  for (let k = 0; k < K; k++) colors.push(hex(sr[k] / (cn[k] || 1), sg[k] / (cn[k] || 1), sb[k] / (cn[k] || 1)));

  // stack order: lightest at the bottom → darkest (line-art) on top. Seamless, gap-free.
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) => centers[b * 3] - centers[a * 3]);
  const rankOf = new Uint8Array(K);
  order.forEach((k, r) => (rankOf[k] = r));
  const rank = new Uint8Array(N);
  for (let i = 0; i < N; i++) rank[i] = rankOf[labels[i]];

  /* ---------- 5. trace + fit every layer ---------- */
  const layers: Layer[] = [];
  let totalNodes = 0, totalLoops = 0;
  const minArea = Math.max(0, opts.minArea * scale * scale);
  for (let r = 1; r < K; r++) {
    check();
    const k = order[r];
    onProgress({
      phase: `Tracing layer ${r}/${K - 1} · ${colors[k]}`,
      pct: 42 + (r / K) * 56,
    });
    await tick();
    const loops = traceMask(rank, W, H, r, { sigma: Math.max(0.35, opts.sigma * scale), minArea });
    if (!loops.length) continue;
    let d = "";
    let nodes = 0;
    for (const lp of loops) {
      const fit = fitLoop(lp, { tolerance: opts.tolerance * scale, cornerAngle: opts.cornerAngle });
      const p = loopToPath(lp, fit.segs, fit.polygon, scale);
      d += p.d;
      nodes += p.nodes;
    }
    const cov = counts[k] / N;
    layers.push({
      id: `layer-${String(r).padStart(2, "0")}`,
      color: colors[k],
      d,
      nodes,
      loops: loops.length,
      coverage: cov,
    });
    totalNodes += nodes;
    totalLoops += loops.length;
  }

  onProgress({ phase: "Assembling SVG", pct: 99 });
  await tick();
  return {
    width: origW,
    height: origH,
    background: colors[order[0]],
    layers,
    errors,
    colorHistory,
    nodes: totalNodes,
    loops: totalLoops,
  };
}
