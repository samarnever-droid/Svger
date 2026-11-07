import { bilateral, gaussBlur, hex, rgbToLab } from "./color";
import { fitLoop, loopToPath, traceField } from "./trace";

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
  underlap?: number; // px each layer slips under the layers above it (seam-free stacking)
  order?: "area" | "light"; // paint order of the layers
  lloyd?: number; // full-resolution palette polish passes
  thinGate?: number; // luma contrast (0-255) below which the thin correction fades out
  thin?: number; // 0-1 strength of the thin-stroke (mass-preserving) iso-level correction
  prune?: number; // ΔE: drop anti-alias ramp colours that are blends of two palette colours (0 = off)
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
  debug?: { labels: Uint16Array; colors: string[]; W: number; H: number };
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

  /* ---------- 4. full-resolution classification (hard label + soft distances) ---------- */
  onProgress({ phase: "Classifying every pixel", pct: 41 });
  await tick();
  let K = centers.length / 3;
  let labels = new Uint16Array(N);
  const d1 = new Float32Array(N); // distance to nearest centre
  const d2 = new Float32Array(N); // distance to second-nearest centre
  const classify = () => {
    K = centers.length / 3;
    const cnt = new Float64Array(K);
    const sm = new Float64Array(K * 3);
    for (let i = 0; i < N; i++) {
      const l = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
      let best = 0, bd = Infinity, sd = Infinity;
      for (let k = 0; k < K; k++) {
        const dl = l - centers[k * 3], da = a - centers[k * 3 + 1], db = b - centers[k * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { sd = bd; bd = d; best = k; }
        else if (d < sd) sd = d;
      }
      labels[i] = best;
      d1[i] = Math.sqrt(bd);
      d2[i] = sd === Infinity ? 1e4 : Math.sqrt(sd);
      cnt[best]++;
      sm[best * 3] += l; sm[best * 3 + 1] += a; sm[best * 3 + 2] += b;
    }
    return { cnt, sm };
  };
  let st4 = classify();

  // "core" pixel = all four neighbours share its label → untouched by anti-aliasing / edges
  const core = new Uint8Array(N);
  const computeCore = () => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, l = labels[i];
        core[i] =
          (x === 0 || labels[i - 1] === l) && (x === W - 1 || labels[i + 1] === l) &&
          (y === 0 || labels[i - W] === l) && (y === H - 1 || labels[i + W] === l)
            ? 1 : 0;
      }
    }
  };
  // move every centre to the mean of its *core* pixels (fallback: all pixels)
  const recenter = () => {
    computeCore();
    const kk = centers.length / 3;
    const cs = new Float64Array(kk * 3), cc = new Float64Array(kk);
    for (let i = 0; i < N; i++) {
      if (!core[i]) continue;
      const k = labels[i];
      cs[k * 3] += lab[i * 3]; cs[k * 3 + 1] += lab[i * 3 + 1]; cs[k * 3 + 2] += lab[i * 3 + 2]; cc[k]++;
    }
    for (let k = 0; k < kk; k++) {
      if (cc[k] > 0) {
        centers[k * 3] = cs[k * 3] / cc[k]; centers[k * 3 + 1] = cs[k * 3 + 1] / cc[k]; centers[k * 3 + 2] = cs[k * 3 + 2] / cc[k];
      } else if (st4.cnt[k] > 0) {
        centers[k * 3] = st4.sm[k * 3] / st4.cnt[k]; centers[k * 3 + 1] = st4.sm[k * 3 + 1] / st4.cnt[k]; centers[k * 3 + 2] = st4.sm[k * 3 + 2] / st4.cnt[k];
      }
    }
  };
  const polish = opts.lloyd ?? 2;
  for (let p = 0; p < polish; p++) {
    recenter();
    st4 = classify();
    await tick();
    check();
  }

  /* ramp pruning: anti-alias pixels are blends of two real colours → let the renderer's
     own anti-aliasing recreate them from a sub-pixel-accurate contour instead */
  const pruneTol = opts.prune ?? 7;
  if (pruneTol > 0) {
    for (let round = 0; round < 2; round++) {
      const kk = centers.length / 3;
      if (kk <= 3) break;
      const area = new Float64Array(kk), ramp = new Float64Array(kk);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x, l = labels[i];
          area[l]++;
          if (core[i]) continue;
          let r = false;
          if (x > 0 && x < W - 1) { const a = labels[i - 1], b = labels[i + 1]; if (a !== l && b !== l && a !== b) r = true; }
          if (!r && y > 0 && y < H - 1) { const a = labels[i - W], b = labels[i + W]; if (a !== l && b !== l && a !== b) r = true; }
          if (r) ramp[l]++;
        }
      }
      const cand = Array.from({ length: kk }, (_, k) => k)
        .filter((k) => area[k] > 0 && ramp[k] / area[k] > 0.4)
        .sort((a, b) => ramp[b] / area[b] - ramp[a] / area[a]);
      const gone = new Uint8Array(kk);
      let alive = kk, dropped = 0;
      for (const c of cand) {
        if (alive <= 3) break;
        const pl = centers[c * 3], pa = centers[c * 3 + 1], pb = centers[c * 3 + 2];
        let ok = false;
        for (let i = 0; i < kk && !ok; i++) {
          if (i === c || gone[i]) continue;
          for (let j = i + 1; j < kk; j++) {
            if (j === c || gone[j]) continue;
            const ex = centers[j * 3] - centers[i * 3], ey = centers[j * 3 + 1] - centers[i * 3 + 1], ez = centers[j * 3 + 2] - centers[i * 3 + 2];
            const L2 = ex * ex + ey * ey + ez * ez;
            if (L2 < 1) continue;
            const t = ((pl - centers[i * 3]) * ex + (pa - centers[i * 3 + 1]) * ey + (pb - centers[i * 3 + 2]) * ez) / L2;
            if (t < 0.04 || t > 0.96) continue;
            const dl = pl - (centers[i * 3] + t * ex), da = pa - (centers[i * 3 + 1] + t * ey), db = pb - (centers[i * 3 + 2] + t * ez);
            const dist = Math.sqrt(dl * dl + da * da + db * db);
            if (dist <= pruneTol && dist <= 0.2 * Math.sqrt(L2)) { ok = true; break; }
          }
        }
        if (ok) { gone[c] = 1; alive--; dropped++; }
      }
      if (!dropped) break;
      const nc: number[] = [];
      for (let k = 0; k < kk; k++) if (!gone[k]) nc.push(centers[k * 3], centers[k * 3 + 1], centers[k * 3 + 2]);
      centers.length = 0;
      centers.push(...nc);
      st4 = classify();
      for (let p = 0; p < 2; p++) { recenter(); st4 = classify(); }
      await tick();
      check();
    }
  }
  computeCore();
  let counts = st4.cnt;
  const minCount = Math.max(3, N * 0.000004);
  const keep: number[] = [];
  for (let k = 0; k < K; k++) if (counts[k] >= minCount) keep.push(k);
  if (keep.length < K && keep.length > 0) {
    const nc: number[] = [];
    for (const k of keep) nc.push(centers[k * 3], centers[k * 3 + 1], centers[k * 3 + 2]);
    centers.length = 0;
    centers.push(...nc);
    st4 = classify();
    counts = st4.cnt;
    computeCore();
  }
  K = centers.length / 3;

  /* ---------- sRGB stage: the renderer blends anti-aliased edges linearly in sRGB, so the
     final labels and the soft coverage fields are computed in sRGB (exact for 2-colour edges) ---------- */
  const rgbc = new Float64Array(K * 3);
  {
    const cs = new Float64Array(K * 3), cc = new Float64Array(K), ca = new Float64Array(K * 3), cA = new Float64Array(K);
    for (let i = 0; i < N; i++) {
      const k = labels[i];
      for (let c = 0; c < 3; c++) ca[k * 3 + c] += px[i * 4 + c];
      cA[k]++;
      if (core[i]) { for (let c = 0; c < 3; c++) cs[k * 3 + c] += px[i * 4 + c]; cc[k]++; }
    }
    for (let k = 0; k < K; k++)
      for (let c = 0; c < 3; c++) rgbc[k * 3 + c] = cc[k] > 0 ? cs[k * 3 + c] / cc[k] : ca[k * 3 + c] / (cA[k] || 1);
  }
  const classifyRGB = () => {
    const cnt = new Float64Array(K);
    for (let i = 0; i < N; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      let best = 0, bd = Infinity, sd = Infinity;
      for (let k = 0; k < K; k++) {
        const dr = r - rgbc[k * 3], dg = g - rgbc[k * 3 + 1], db = b - rgbc[k * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { sd = bd; bd = d; best = k; }
        else if (d < sd) sd = d;
      }
      labels[i] = best;
      d1[i] = Math.sqrt(bd);
      d2[i] = sd === Infinity ? 1e4 : Math.sqrt(sd);
      cnt[best]++;
    }
    return cnt;
  };
  counts = classifyRGB();
  for (let p = 0; p < 2; p++) {
    computeCore();
    const cs = new Float64Array(K * 3), cc = new Float64Array(K);
    for (let i = 0; i < N; i++) {
      if (!core[i]) continue;
      const k = labels[i];
      for (let c = 0; c < 3; c++) cs[k * 3 + c] += px[i * 4 + c];
      cc[k]++;
    }
    for (let k = 0; k < K; k++) if (cc[k] > 0) for (let c = 0; c < 3; c++) rgbc[k * 3 + c] = cs[k * 3 + c] / cc[k];
    counts = classifyRGB();
  }
  const bx0 = new Int32Array(K).fill(W), by0 = new Int32Array(K).fill(H);
  const bx1 = new Int32Array(K).fill(-1), by1 = new Int32Array(K).fill(-1);
  for (let i = 0; i < N; i++) {
    const k = labels[i];
    const x = i % W, y = (i / W) | 0;
    if (x < bx0[k]) bx0[k] = x;
    if (x > bx1[k]) bx1[k] = x;
    if (y < by0[k]) by0[k] = y;
    if (y > by1[k]) by1[k] = y;
  }
  const colors: string[] = [];
  for (let k = 0; k < K; k++) colors.push(hex(rgbc[k * 3], rgbc[k * 3 + 1], rgbc[k * 3 + 2]));

  // paint order: biggest (background) first so small detail ends up on top
  const mode = opts.order ?? "area";
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) =>
    mode === "light" ? rgbc[b * 3] * 0.3 + rgbc[b * 3 + 1] * 0.59 + rgbc[b * 3 + 2] * 0.11 - (rgbc[a * 3] * 0.3 + rgbc[a * 3 + 1] * 0.59 + rgbc[a * 3 + 2] * 0.11) : counts[b] - counts[a]
  );
  const rankOf = new Uint8Array(K);
  order.forEach((k, r) => (rankOf[k] = r));
  const rank = new Uint8Array(N);
  for (let i = 0; i < N; i++) rank[i] = rankOf[labels[i]];

  /* ---------- 5. trace every layer on its own soft membership field ---------- */
  const layers: Layer[] = [];
  let totalNodes = 0, totalLoops = 0;
  const minArea = Math.max(0, opts.minArea * scale * scale);
  const U = Math.max(0, Math.ceil((opts.underlap ?? 2) * scale));
  const UVAL = opts.sigma > 0.05 ? 0.8 : 0.5001;
  const M = U + 2;
  for (let r = 1; r < K; r++) {
    check();
    const k = order[r];
    onProgress({ phase: `Tracing layer ${r}/${K - 1} · ${colors[k]}`, pct: 42 + (r / K) * 56 });
    await tick();
    if (bx1[k] < 0) continue;
    const wx0 = Math.max(0, bx0[k] - M), wy0 = Math.max(0, by0[k] - M);
    const wx1 = Math.min(W - 1, bx1[k] + M), wy1 = Math.min(H - 1, by1[k] + M);
    const FW = wx1 - wx0 + 1, FH = wy1 - wy0 + 1;
    const F = new Float32Array(FW * FH);
    const mask = new Uint8Array(FW * FH); // 1 own · 2 underlap · 3 filled hole
    const c0 = rgbc[k * 3], c1 = rgbc[k * 3 + 1], c2 = rgbc[k * 3 + 2];
    for (let y = 0; y < FH; y++) {
      let gi = (wy0 + y) * W + wx0;
      let fi = y * FW;
      for (let x = 0; x < FW; x++, gi++, fi++) {
        const dl = px[gi * 4] - c0, da = px[gi * 4 + 1] - c1, db = px[gi * 4 + 2] - c2;
        const dk = Math.sqrt(dl * dl + da * da + db * db);
        const own = rank[gi] === r;
        const dO = own ? d2[gi] : d1[gi];
        const sum = dO + dk;
        F[fi] = sum < 1e-6 ? (own ? 1 : 0) : dO / sum;
        if (own) mask[fi] = 1;
      }
    }
    // thin-feature correction: a stroke narrower than a pixel never reaches coverage 1, so the
    // 0.5 iso-line would under-fill it. Lower/raise the level so the enclosed area matches the
    // coverage mass (thin line: P/(1+P), thin gap: 1/(2-Q)); identical to 0.5 on step edges.
    const thinK = opts.thin ?? 1;
    if (thinK > 0) {
      const mx = new Float32Array(FW * FH), mn = new Float32Array(FW * FH);
      const tmx = new Float32Array(FW * FH), tmn = new Float32Array(FW * FH);
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          const a = F[x > 0 ? i - 1 : i], b = F[i], c = F[x < FW - 1 ? i + 1 : i];
          tmx[i] = Math.max(a, b, c); tmn[i] = Math.min(a, b, c);
        }
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          const a = y > 0 ? i - FW : i, c = y < FH - 1 ? i + FW : i;
          mx[i] = Math.max(tmx[a], tmx[i], tmx[c]); mn[i] = Math.min(tmn[a], tmn[i], tmn[c]);
        }
      // local contrast (3×3 luma range) – gradients / noise must not trigger the correction
      const lu = new Float32Array(FW * FH);
      for (let y = 0; y < FH; y++) {
        let gi = (wy0 + y) * W + wx0;
        for (let x = 0; x < FW; x++, gi++) lu[y * FW + x] = px[gi * 4] * 0.3 + px[gi * 4 + 1] * 0.59 + px[gi * 4 + 2] * 0.11;
      }
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          const a = lu[x > 0 ? i - 1 : i], b = lu[i], c = lu[x < FW - 1 ? i + 1 : i];
          tmx[i] = Math.max(a, b, c); tmn[i] = Math.min(a, b, c);
        }
      const rng = new Float32Array(FW * FH);
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          const a = y > 0 ? i - FW : i, c = y < FH - 1 ? i + FW : i;
          rng[i] = Math.max(tmx[a], tmx[i], tmx[c]) - Math.min(tmn[a], tmn[i], tmn[c]);
        }
      const gLo = opts.thinGate ?? 24;
      for (let i = 0; i < F.length; i++) {
        const P = Math.max(0.3, mx[i]), Q = Math.min(0.7, mn[i]);
        let L = P / (1 + P) + 1 / (2 - Q) - 0.5;
        const gate = Math.max(0, Math.min(1, (rng[i] - gLo) / gLo));
        L = 0.5 + (L - 0.5) * thinK * gate;
        const m = F[i];
        F[i] = m <= L ? (m * 0.5) / L : 0.5 + ((m - L) * 0.5) / (1 - L);
      }
    }
    // underlap: grow under the layers painted later (breadth-first, U steps)
    if (U > 0) {
      let front: number[] = [];
      for (let i = 0; i < mask.length; i++) if (mask[i] === 1) front.push(i);
      for (let s = 0; s < U && front.length; s++) {
        const nxt: number[] = [];
        for (const i of front) {
          const x = i % FW, y = (i / FW) | 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= FH) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= FW) continue;
              const j = yy * FW + xx;
              if (mask[j] === 0 && rank[(wy0 + yy) * W + wx0 + xx] > r) {
                mask[j] = 2;
                nxt.push(j);
              }
            }
          }
        }
        front = nxt;
      }
    }
    // fill holes made only of later-painted pixels (they are covered anyway) → far fewer nodes
    {
      const reach = new Uint8Array(FW * FH);
      const q = new Int32Array(FW * FH);
      let qh = 0, qt = 0;
      const seed = (j: number) => {
        if (mask[j] === 0 && !reach[j]) { reach[j] = 1; q[qt++] = j; }
      };
      for (let x = 0; x < FW; x++) { seed(x); seed((FH - 1) * FW + x); }
      for (let y = 0; y < FH; y++) { seed(y * FW); seed(y * FW + FW - 1); }
      for (let y = 0; y < FH; y++) {
        const g = (wy0 + y) * W + wx0;
        for (let x = 0; x < FW; x++) if (rank[g + x] < r) seed(y * FW + x);
      }
      while (qh < qt) {
        const i = q[qh++];
        const x = i % FW;
        if (x > 0) seed(i - 1);
        if (x < FW - 1) seed(i + 1);
        if (i >= FW) seed(i - FW);
        if (i < FW * (FH - 1)) seed(i + FW);
      }
      for (let i = 0; i < mask.length; i++) if (mask[i] === 0 && !reach[i]) mask[i] = 3;
    }
    for (let i = 0; i < mask.length; i++) if (mask[i] >= 2 && F[i] < UVAL) F[i] = UVAL;

    const loops = traceField(F, FW, FH, wx0, wy0, { sigma: opts.sigma > 0.05 ? opts.sigma * scale : 0, minArea });
    if (!loops.length) continue;
    let d = "";
    let nodes = 0;
    for (const lp of loops) {
      const fit = fitLoop(lp, { tolerance: opts.tolerance * scale, cornerAngle: opts.cornerAngle });
      const p = loopToPath(lp, fit.segs, fit.polygon, scale);
      d += p.d;
      nodes += p.nodes;
    }
    layers.push({
      id: `layer-${String(r).padStart(2, "0")}`,
      color: colors[k],
      d,
      nodes,
      loops: loops.length,
      coverage: counts[k] / N,
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
    debug: (opts as any).debug ? { labels, colors, W, H } : undefined,
  };
}
