import { bilateral, gaussBlur, hex, regularizeLabels, rgbToPerceptualLab } from "./color";
import { detectPrimitiveShape, fitLoop, loopToPath, traceField, type ShapePrimitive } from "./trace";
import {
  fitRegionShading,
  segmentLayerRegions,
  type GradientDef,
} from "./gradients";
import {
  computeImageGradient,
  evalShadingAtPixel,
  mergeFalseHighlightSpots,
  synthesizeLightingGlowLayers,
  synthesizeResidualDetailLayers,
  type FilterDef,
  type ClipPathDef,
} from "./lighting";

export interface VectorOptions {
  maxColors: number; // palette ceiling
  iterations: number; // refinement passes (default 30-100)
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
  gradients?: boolean; // Enable per-region <linearGradient> & <radialGradient> fitting
  antiSpot?: number; // 0-1.5 Anti-white-spot & lighting glow synthesis strength
  primitives?: boolean; // Enable <rect>, <circle>, <ellipse>, <polygon> primitive emission
  residualPass?: boolean; // Enable residual error-driven micro-detail & catchlight pass
}

export interface SubShape {
  kind: "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line";
  fill: string;
  colorHex: string;
  d?: string;
  primitive?: ShapePrimitive;
  opacity?: number;
  filterId?: string;
  clipPathId?: string;
  nodes: number;
  loops: number;
}

export interface Layer {
  id: string;
  color: string;
  fill?: string;
  d: string;
  subShapes?: SubShape[];
  filterId?: string;
  clipPathId?: string;
  opacity?: number;
  nodes: number;
  loops: number;
  coverage: number;
  kind?: "base" | "gradient" | "lighting" | "residual";
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
  backgroundFill?: string;
  layers: Layer[];
  gradients?: GradientDef[];
  filters?: FilterDef[];
  clipPaths?: ClipPathDef[];
  errors: number[];
  colorHistory: number[];
  nodes: number;
  loops: number;
  tagCounts?: Record<string, number>;
  regionalColorAccuracy?: number;
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

function renderSubShapeTag(sh: SubShape): string {
  const opAttr = sh.opacity !== undefined && sh.opacity < 0.995 ? ` fill-opacity="${sh.opacity}"` : "";
  const fltAttr = sh.filterId ? ` filter="url(#${sh.filterId})"` : "";
  const clipAttr = sh.clipPathId ? ` clip-path="url(#${sh.clipPathId})"` : "";
  if (sh.kind !== "path" && sh.primitive) {
    const p = sh.primitive;
    const attrStr = Object.entries(p.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    return `<${p.tag} fill="${sh.fill}"${opAttr}${fltAttr}${clipAttr} ${attrStr}/>`;
  }
  return `<path fill="${sh.fill}" fill-rule="evenodd"${opAttr}${fltAttr}${clipAttr} d="${sh.d || ""}"/>`;
}

export function countSvgTagsFast(svg: string): Record<string, number> {
  const tags = [
    "svg", "defs", "linearGradient", "radialGradient", "stop",
    "filter", "feGaussianBlur", "feMerge", "clipPath",
    "g", "rect", "circle", "ellipse", "polygon", "path"
  ];
  const counts: Record<string, number> = {};
  for (const t of tags) {
    const pat = `<${t}`;
    let pos = 0, c = 0;
    while ((pos = svg.indexOf(pat, pos)) !== -1) {
      const nextChar = svg.charCodeAt(pos + pat.length);
      if (nextChar === 32 || nextChar === 62 || nextChar === 47 || nextChar === 10) c++;
      pos += pat.length;
    }
    if (c > 0) counts[t] = c;
  }
  return counts;
}

export function buildSvg(
  w: number,
  h: number,
  bg: string,
  layers: Layer[],
  hidden?: Set<string>,
  resultMeta?: Pick<VectorResult, "backgroundFill" | "gradients" | "filters" | "clipPaths">
): string {
  const grads = resultMeta?.gradients ?? [];
  const filters = resultMeta?.filters ?? [];
  const clips = resultMeta?.clipPaths ?? [];
  const bgFill = resultMeta?.backgroundFill ?? bg;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="geometricPrecision">`;
  s += `<title>SVGer Hybrid Vector Artwork</title>`;
  s += `<desc>Pure vector geometry with adaptive regional gradients, anti-spot lighting filters, and sub-pixel Bézier contours</desc>`;

  if (grads.length > 0 || filters.length > 0 || clips.length > 0) {
    s += `<defs>`;
    for (const f of filters) {
      s += `<filter id="${f.id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`;
      s += `<feGaussianBlur in="SourceGraphic" stdDeviation="${f.stdDeviation}" result="blur"/>`;
      s += `<feMerge><feMergeNode in="blur"/></feMerge>`;
      s += `</filter>`;
    }
    for (const cp of clips) {
      s += `<clipPath id="${cp.id}"><path d="${cp.d}" fill-rule="evenodd"/></clipPath>`;
    }
    for (const g of grads) {
      if (g.type === "linear") {
        s += `<linearGradient id="${g.id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" gradientUnits="userSpaceOnUse">`;
        for (const st of g.stops) {
          const op = st.opacity !== undefined && st.opacity < 1 ? ` stop-opacity="${st.opacity}"` : "";
          s += `<stop offset="${st.offset}" stop-color="${st.color}"${op}/>`;
        }
        s += `</linearGradient>`;
      } else {
        const units = g.units ?? "userSpaceOnUse";
        const fxAttr = g.fx !== g.cx || g.fy !== g.cy ? ` fx="${g.fx}" fy="${g.fy}"` : "";
        s += `<radialGradient id="${g.id}" cx="${g.cx}" cy="${g.cy}" r="${g.r}"${fxAttr} gradientUnits="${units}">`;
        for (const st of g.stops) {
          const op = st.opacity !== undefined ? ` stop-opacity="${st.opacity}"` : "";
          s += `<stop offset="${st.offset}" stop-color="${st.color}"${op}/>`;
        }
        s += `</radialGradient>`;
      }
    }
    s += `</defs>`;
  }

  s += `<rect id="background" width="${w}" height="${h}" fill="${bgFill}"/>`;

  for (const l of layers) {
    if (hidden && hidden.has(l.id)) continue;
    if (l.subShapes && l.subShapes.length > 0) {
      if (l.subShapes.length === 1) {
        const sh = l.subShapes[0];
        const opAttr = sh.opacity !== undefined && sh.opacity < 0.995 ? ` fill-opacity="${sh.opacity}"` : "";
        const fltAttr = sh.filterId ? ` filter="url(#${sh.filterId})"` : "";
        const clipAttr = sh.clipPathId ? ` clip-path="url(#${sh.clipPathId})"` : "";
        if (sh.kind !== "path" && sh.primitive) {
          const p = sh.primitive;
          const attrStr = Object.entries(p.attrs)
            .map(([k, v]) => `${k}="${v}"`)
            .join(" ");
          s += `<${p.tag} id="${l.id}" fill="${sh.fill}"${opAttr}${fltAttr}${clipAttr} ${attrStr}/>`;
        } else {
          s += `<path id="${l.id}" fill="${sh.fill}" fill-rule="evenodd"${opAttr}${fltAttr}${clipAttr} d="${sh.d || l.d}"/>`;
        }
      } else {
        const fltAttr = l.filterId ? ` filter="url(#${l.filterId})"` : "";
        s += `<g id="${l.id}"${fltAttr}>`;
        for (const sh of l.subShapes) {
          s += renderSubShapeTag(sh);
        }
        s += `</g>`;
      }
    } else if (l.d) {
      const fill = l.fill ?? l.color;
      const fltAttr = l.filterId ? ` filter="url(#${l.filterId})"` : "";
      const opAttr = l.opacity !== undefined && l.opacity < 0.995 ? ` fill-opacity="${l.opacity}"` : "";
      s += `<path id="${l.id}" fill="${fill}" fill-rule="evenodd"${opAttr}${fltAttr} d="${l.d}"/>`;
    }
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
  const enableGradients = opts.gradients ?? true;
  const antiSpotStrength = opts.antiSpot ?? 1.0;
  const enablePrimitives = opts.primitives ?? true;
  const enableResidual = opts.residualPass ?? true;

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

  /* ---------- 2. Perceptual Oklab+CIELAB + detail & lighting ramp weights ---------- */
  onProgress({ phase: "Converting to Oklab+CIELAB & mapping lighting ramps", pct: 7 });
  await tick();
  const lab = new Float32Array(N * 3);
  const Lc = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    rgbToPerceptualLab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], lab, i * 3);
    Lc[i] = lab[i * 3];
  }
  const blurred = gaussBlur(Lc, W, H, 2.2 * scale);
  const gradMag = computeImageGradient(px, W, H);

  const S = Math.min(N, 95000);
  const sLab = new Float32Array(S * 3);
  const sW = new Float32Array(S);
  const sIdx = new Int32Array(S);
  const rand = rng(1337);
  const step = N / S;
  for (let j = 0; j < S; j++) {
    const i = Math.min(N - 1, Math.floor(j * step + rand() * step));
    sIdx[j] = i;
    const l = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
    sLab[j * 3] = l;
    sLab[j * 3 + 1] = a;
    sLab[j * 3 + 2] = b;
    const x = i % W, y = (i / W) | 0;
    const xm = x > 0 ? i - 1 : i, xp = x < W - 1 ? i + 1 : i;
    const ym = y > 0 ? i - W : i, yp = y < H - 1 ? i + W : i;
    const g = Math.abs(Lc[xp] - Lc[xm]) + Math.abs(Lc[yp] - Lc[ym]);
    const line = Math.max(0, blurred[i] - l); // dark thin structure
    const highlightPeak = Math.max(0, l - blurred[i]); // bright glint / text / catchlight
    const edge = Math.min(1, g / 18);
    const ln = Math.min(1, (line + highlightPeak * 0.85) / 9);
    const chroma = Math.hypot(a, b);
    const chromaBoost = chroma > 26 ? Math.min(1.4, (chroma - 26) / 30) : 0;
    // Smooth highlight lighting ramp weight (prevents coarse banding on cheeks/clouds/sky)
    const smoothHighlight = l > 68 && g > 0.3 && g < 7.5 ? 0.65 * antiSpotStrength : 0;
    sW[j] = 1 + opts.detail * (4.8 * ln + 2.0 * edge + 1.5 * chromaBoost) + smoothHighlight;
  }

  /* ---------- 3. Error-driven palette refinement + Anchor Pinning ---------- */
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
    if (it < growth && K < opts.maxColors && lastErr > 0.85) {
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
        // Iteration 08 & 09: Density-smoothed error injection (avoids single-pixel outlier white spots)
        if (it % 3 === 2 && centers.length / 3 < target) {
          let bj = -1, bv = 0;
          for (let j = 0; j < S; j++) {
            // Avoid injecting an isolated smooth-glow pixel as a lone point center
            const gi = sIdx[j];
            const isSmoothSpot = sLab[j * 3] > 78 && gradMag[gi] < 5.5;
            const v = sDist[j] * sW[j] * (isSmoothSpot ? 0.45 : 1.0);
            if (v > bv) { bv = v; bj = j; }
          }
          if (bj >= 0 && sDist[bj] > 16) {
            // Average all high-error samples near sLab[bj] so the new center is a true local mode
            const bl = sLab[bj * 3], ba = sLab[bj * 3 + 1], bb = sLab[bj * 3 + 2];
            let sl = 0, sa = 0, sb = 0, sw = 0;
            for (let j = 0; j < S; j++) {
              const dl = sLab[j * 3] - bl, da = sLab[j * 3 + 1] - ba, db = sLab[j * 3 + 2] - bb;
              if (dl * dl + da * da + db * db <= 36) {
                const w = sW[j];
                sl += sLab[j * 3] * w; sa += sLab[j * 3 + 1] * w; sb += sLab[j * 3 + 2] * w; sw += w;
              }
            }
            if (sw > 0) centers.push(sl / sw, sa / sw, sb / sw);
            else centers.push(bl, ba, bb);
          }
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

  /* ---------- Iteration 08: Pure White / Black & High-Chroma Anchor Pinning ---------- */
  {
    assign();
    let whiteL = 0, whiteA = 0, whiteB = 0, whiteCnt = 0, whiteErr = 0;
    for (let j = 0; j < S; j++) {
      const l = sLab[j * 3], a = sLab[j * 3 + 1], b = sLab[j * 3 + 2];
      if (l > 95.5 && Math.hypot(a, b) < 8) {
        whiteL += l; whiteA += a; whiteB += b; whiteCnt++;
        whiteErr += Math.sqrt(sDist[j]);
      }
    }
    // If crisp white pixels exist (e.g. "15th MAPPA" text) and are poorly represented, pin a white anchor
    if (whiteCnt >= Math.max(8, S * 0.0003) && whiteErr / whiteCnt > 3.2) {
      centers.push(whiteL / whiteCnt, whiteA / whiteCnt, whiteB / whiteCnt);
      lloyd();
    }
  }

  /* ---------- 4. Full-resolution classification ---------- */
  onProgress({ phase: "Classifying every pixel", pct: 41 });
  await tick();
  let K = centers.length / 3;
  let labels = new Uint16Array(N);
  const d1 = new Float32Array(N);
  const d2 = new Float32Array(N);
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

  /* ramp pruning */
  const pruneTol = opts.prune ?? 0;
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

  /* ---------- sRGB stage + Bilateral Label Regularization + Anti-Spot Merger ---------- */
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

  // Iteration 10: Bilateral Label Regularization (removes cross-region color bleed on lips/skin)
  regularizeLabels(labels, px, rgbc, W, H, Math.round(12 * scale * scale), 14);

  // Iteration 16: Merge false-contour highlight spots into parent smooth lighting region when gradients are enabled
  if (enableGradients && antiSpotStrength > 0) {
    mergeFalseHighlightSpots(labels, px, rgbc, gradMag, W, H, scale, antiSpotStrength);
  }

  // Recompute counts & bounding boxes after label regularization and spot merging
  counts.fill(0);
  const bx0 = new Int32Array(K).fill(W), by0 = new Int32Array(K).fill(H);
  const bx1 = new Int32Array(K).fill(-1), by1 = new Int32Array(K).fill(-1);
  for (let i = 0; i < N; i++) {
    const k = labels[i];
    counts[k]++;
    const x = i % W, y = (i / W) | 0;
    if (x < bx0[k]) bx0[k] = x;
    if (x > bx1[k]) bx1[k] = x;
    if (y < by0[k]) by0[k] = y;
    if (y > by1[k]) by1[k] = y;
  }
  const colors: string[] = [];
  for (let k = 0; k < K; k++) colors.push(hex(rgbc[k * 3], rgbc[k * 3 + 1], rgbc[k * 3 + 2]));

  // Paint order: biggest (background) first so small detail ends up on top
  const mode = opts.order ?? "area";
  const order = Array.from({ length: K }, (_, k) => k).sort((a, b) =>
    mode === "light"
      ? rgbc[b * 3] * 0.3 + rgbc[b * 3 + 1] * 0.59 + rgbc[b * 3 + 2] * 0.11 -
        (rgbc[a * 3] * 0.3 + rgbc[a * 3 + 1] * 0.59 + rgbc[a * 3 + 2] * 0.11)
      : counts[b] - counts[a]
  );
  const rankOf = new Uint8Array(K);
  order.forEach((k, r) => (rankOf[k] = r));
  const rank = new Uint8Array(N);
  for (let i = 0; i < N; i++) rank[i] = rankOf[labels[i]];

  /* ---------- Fit Background Layer (rank 0) Shading & Initialize Predicted RGB Buffer ---------- */
  const gradients: GradientDef[] = [];
  const filters: FilterDef[] = [];
  const clipPaths: ClipPathDef[] = [];
  const parsedStopsCache = new Map<string, [number, number, number, number][]>();

  const predR = new Float32Array(N);
  const predG = new Float32Array(N);
  const predB = new Float32Array(N);

  const bgK = order[0];
  let backgroundHex = colors[bgK];
  let backgroundFill = backgroundHex;
  {
    const bgPix: number[] = [];
    for (let i = 0; i < N; i++) if (rank[i] === 0) bgPix.push(i);
    if (bgPix.length > 0) {
      const bgFit = fitRegionShading(
        Int32Array.from(bgPix),
        bgPix.length,
        null,
        px,
        gradMag,
        W,
        scale,
        "bg",
        enableGradients,
        antiSpotStrength
      );
      backgroundHex = bgFit.colorHex;
      backgroundFill = bgFit.fill;
      if (bgFit.gradient) gradients.push(bgFit.gradient);
      for (let i = 0; i < N; i++) {
        const [pr, pg, pb] = evalShadingAtPixel(
          i % W,
          (i / W) | 0,
          scale,
          bgFit.meanR,
          bgFit.meanG,
          bgFit.meanB,
          bgFit.gradient,
          parsedStopsCache
        );
        predR[i] = pr;
        predG[i] = pg;
        predB[i] = pb;
      }
    } else {
      for (let i = 0; i < N; i++) {
        predR[i] = rgbc[bgK * 3];
        predG[i] = rgbc[bgK * 3 + 1];
        predB[i] = rgbc[bgK * 3 + 2];
      }
    }
  }

  /* ---------- 5. Trace every layer & fit per-region colors, gradients & primitives ---------- */
  const layers: Layer[] = [];
  let totalNodes = 0, totalLoops = 0;
  const minArea = Math.max(0, opts.minArea * scale * scale);
  const U = Math.max(0, Math.ceil((opts.underlap ?? 2) * scale));
  const UVAL = opts.sigma > 0.05 ? 0.8 : 0.5001;
  const M = U + 2;

  for (let r = 1; r < K; r++) {
    check();
    const k = order[r];
    onProgress({ phase: `Tracing & shading layer ${r}/${K - 1} · ${colors[k]}`, pct: 42 + (r / K) * 48 });
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
        let fVal = sum < 1e-6 ? (own ? 1 : 0) : dO / sum;
        // Ensure pixels reassigned by regularizeLabels / mergeFalseHighlightSpots respect own membership
        if (own && fVal < 0.502) fVal = 0.55;
        else if (!own && fVal >= 0.5) fVal = 0.45;
        F[fi] = fVal;
        if (own) mask[fi] = 1;
      }
    }

    // Thin-feature mass-preserving iso-level correction
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
      const rngArr = new Float32Array(FW * FH);
      for (let y = 0; y < FH; y++)
        for (let x = 0; x < FW; x++) {
          const i = y * FW + x;
          const a = y > 0 ? i - FW : i, c = y < FH - 1 ? i + FW : i;
          rngArr[i] = Math.max(tmx[a], tmx[i], tmx[c]) - Math.min(tmn[a], tmn[i], tmn[c]);
        }
      const gLo = opts.thinGate ?? 24;
      for (let i = 0; i < F.length; i++) {
        const P = Math.max(0.3, mx[i]), Q = Math.min(0.7, mn[i]);
        let L = P / (1 + P) + 1 / (2 - Q) - 0.5;
        const gate = Math.max(0, Math.min(1, (rngArr[i] - gLo) / gLo));
        L = 0.5 + (L - 0.5) * thinK * gate;
        const m = F[i];
        F[i] = m <= L ? (m * 0.5) / L : 0.5 + ((m - L) * 0.5) / (1 - L);
      }
    }

    // Underlap: grow under the layers painted later
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

    // Fill holes made only of later-painted pixels
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

    const loops = traceField(F, FW, FH, wx0, wy0, {
      sigma: opts.sigma > 0.05 ? opts.sigma * scale : 0,
      minArea,
    });
    if (!loops.length) continue;

    // Segment layer into connected regions so each region gets its own exact visible color or gradient
    const regions = segmentLayerRegions(F, loops, FW, FH, wx0, wy0, W, rank, r);
    const subShapes: SubShape[] = [];
    // Group solid-color paths that share the exact same hex string within this layer to keep SVG compact
    const solidPathBuckets = new Map<string, { d: string; nodes: number; loops: number }>();
    let layerNodes = 0;
    let layerLoops = 0;
    let hasGradientInLayer = false;

    for (let regIdx = 0; regIdx < regions.length; regIdx++) {
      const reg = regions[regIdx];
      const regFit = fitRegionShading(
        reg.pixels,
        reg.pixels.length,
        null,
        px,
        gradMag,
        W,
        scale,
        `r${r}-c${reg.id}`,
        enableGradients,
        antiSpotStrength
      );

      if (regFit.gradient) {
        gradients.push(regFit.gradient);
        hasGradientInLayer = true;
      }

      // Update predicted RGB buffer for all truly owned pixels in this region
      for (let pi = 0; pi < reg.pixels.length; pi++) {
        const gi = reg.pixels[pi];
        if (rank[gi] !== r) continue;
        const [pr, pg, pb] = evalShadingAtPixel(
          gi % W,
          (gi / W) | 0,
          scale,
          regFit.meanR,
          regFit.meanG,
          regFit.meanB,
          regFit.gradient,
          parsedStopsCache
        );
        predR[gi] = pr;
        predG[gi] = pg;
        predB[gi] = pb;
      }

      // Check for single-loop geometric primitive (<rect>, <circle>, <ellipse>, <polygon>)
      if (enablePrimitives && reg.loops.length === 1 && !regFit.gradient) {
        const lp = reg.loops[0];
        const fit = fitLoop(lp, { tolerance: opts.tolerance * scale, cornerAngle: opts.cornerAngle });
        const prim = detectPrimitiveShape(lp, fit.segs, scale, opts.tolerance);
        if (prim) {
          subShapes.push({
            kind: prim.tag,
            fill: regFit.fill,
            colorHex: regFit.colorHex,
            primitive: prim,
            nodes: prim.nodes,
            loops: 1,
          });
          layerNodes += prim.nodes;
          layerLoops += 1;
          continue;
        }
      }

      let regD = "";
      let regNodes = 0;
      for (const lp of reg.loops) {
        const fit = fitLoop(lp, { tolerance: opts.tolerance * scale, cornerAngle: opts.cornerAngle });
        const p = loopToPath(lp, fit.segs, fit.polygon, scale, opts.tolerance);
        regD += p.d;
        regNodes += p.nodes;
      }

      layerNodes += regNodes;
      layerLoops += reg.loops.length;

      if (regFit.gradient) {
        subShapes.push({
          kind: "path",
          fill: regFit.fill,
          colorHex: regFit.colorHex,
          d: regD,
          nodes: regNodes,
          loops: reg.loops.length,
        });
      } else {
        // Quantize tiny speckles (< 16px) to 2-unit RGB buckets so tiny speckles merge into shared <path>
        const fillKey =
          reg.pixels.length < 16 * scale * scale
            ? hex(
                Math.round(regFit.meanR / 2) * 2,
                Math.round(regFit.meanG / 2) * 2,
                Math.round(regFit.meanB / 2) * 2
              )
            : regFit.colorHex;
        const existing = solidPathBuckets.get(fillKey);
        if (existing) {
          existing.d += regD;
          existing.nodes += regNodes;
          existing.loops += reg.loops.length;
        } else {
          solidPathBuckets.set(fillKey, { d: regD, nodes: regNodes, loops: reg.loops.length });
        }
      }
    }

    for (const [fillHex, bucket] of solidPathBuckets.entries()) {
      subShapes.push({
        kind: "path",
        fill: fillHex,
        colorHex: fillHex,
        d: bucket.d,
        nodes: bucket.nodes,
        loops: bucket.loops,
      });
    }

    if (subShapes.length === 0) continue;

    // Combined fallback d for compatibility
    const combinedD = subShapes.map((s) => s.d || "").join("");
    layers.push({
      id: `layer-${String(r).padStart(2, "0")}`,
      color: colors[k],
      fill: subShapes.length === 1 ? subShapes[0].fill : colors[k],
      d: combinedD,
      subShapes,
      nodes: layerNodes,
      loops: layerLoops,
      coverage: counts[k] / N,
      kind: hasGradientInLayer ? "gradient" : "base",
    });
    totalNodes += layerNodes;
    totalLoops += layerLoops;
  }

  /* ---------- 6. Volumetric Lighting Glow & Anti-White-Spot Pass ---------- */
  if (antiSpotStrength > 0) {
    onProgress({ phase: "Synthesizing volumetric lighting & anti-spot glows", pct: 92 });
    await tick();
    const maxGlows = Math.round(14 * antiSpotStrength);
    const glowEls = synthesizeLightingGlowLayers(
      px,
      predR,
      predG,
      predB,
      gradMag,
      W,
      H,
      scale,
      maxGlows,
      gradients,
      filters
    );
    for (const el of glowEls) {
      layers.push({
        id: el.id,
        color: el.colorHex,
        fill: el.fill,
        d: el.d || "",
        subShapes: [
          {
            kind: el.kind === "g" ? "path" : el.kind,
            fill: el.fill,
            colorHex: el.colorHex,
            d: el.d,
            primitive: el.primitive,
            opacity: el.opacity,
            filterId: el.filterId,
            clipPathId: el.clipPathId,
            nodes: el.nodes,
            loops: el.loops,
          },
        ],
        filterId: el.filterId,
        nodes: el.nodes,
        loops: el.loops,
        coverage: el.coverage,
        kind: "lighting",
      });
      totalNodes += el.nodes;
      totalLoops += el.loops;
    }
  }

  /* ---------- 7. Residual Error-Driven Crisp Micro-Detail & Catchlight Pass ---------- */
  if (enableResidual) {
    onProgress({ phase: "Refining residual crisp details & catchlights", pct: 96 });
    await tick();
    const resEls = synthesizeResidualDetailLayers(
      px,
      predR,
      predG,
      predB,
      W,
      H,
      scale,
      opts.tolerance,
      opts.cornerAngle,
      opts.minArea,
      8
    );
    for (const el of resEls) {
      layers.push({
        id: el.id,
        color: el.colorHex,
        fill: el.fill,
        d: el.d || "",
        subShapes: [
          {
            kind: el.kind === "g" ? "path" : el.kind,
            fill: el.fill,
            colorHex: el.colorHex,
            d: el.d,
            primitive: el.primitive,
            nodes: el.nodes,
            loops: el.loops,
          },
        ],
        nodes: el.nodes,
        loops: el.loops,
        coverage: el.coverage,
        kind: "residual",
      });
      totalNodes += el.nodes;
      totalLoops += el.loops;
    }
  }

  // Compute regional color accuracy across the image
  let sePred = 0;
  for (let i = 0; i < N; i++) {
    const dr = px[i * 4] - predR[i];
    const dg = px[i * 4 + 1] - predG[i];
    const db = px[i * 4 + 2] - predB[i];
    sePred += dr * dr + dg * dg + db * db;
  }
  const regionalColorAccuracy = 100 * (1 - sePred / (N * 3 * 255 * 255));

  onProgress({ phase: "Assembling SVG", pct: 99 });
  await tick();
  return {
    width: origW,
    height: origH,
    background: backgroundHex,
    backgroundFill,
    layers,
    gradients,
    filters,
    clipPaths,
    errors,
    colorHistory,
    nodes: totalNodes,
    loops: totalLoops,
    regionalColorAccuracy,
    debug: (opts as any).debug ? { labels, colors, W, H } : undefined,
  };
}
