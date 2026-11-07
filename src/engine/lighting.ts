import { hex, gaussBlur } from "./color";
import { fitLoop, loopToPath, traceField, detectPrimitiveShape, type ShapePrimitive } from "./trace";
import {
  fitRegionShading,
  type GradientDef,
  type LinearGradientDef,
  type RadialGradientDef,
} from "./gradients";

export interface FilterDef {
  id: string;
  stdDeviation: number;
  kind: "glow" | "soft";
}

export interface ClipPathDef {
  id: string;
  d: string;
}

export interface VectorElement {
  id: string;
  kind: "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line" | "g";
  fill: string;
  colorHex: string;
  d?: string;
  primitive?: ShapePrimitive;
  opacity?: number;
  filterId?: string;
  clipPathId?: string;
  stroke?: string;
  strokeWidth?: number;
  nodes: number;
  loops: number;
  coverage: number;
  layerGroup: string;
}

/**
 * Computes the per-pixel Sobel/central difference gradient magnitude in sRGB luma + chroma.
 */
export function computeImageGradient(px: Uint8ClampedArray, W: number, H: number): Float32Array {
  const N = W * H;
  const grad = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < H - 1 ? y + 1 : H - 1;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < W - 1 ? x + 1 : W - 1;
      const il = (y * W + xm) * 4, ir = (y * W + xp) * 4;
      const iu = (ym * W + x) * 4, id = (yp * W + x) * 4;
      const gxR = (px[ir] - px[il]) * 0.5;
      const gxG = (px[ir + 1] - px[il + 1]) * 0.5;
      const gxB = (px[ir + 2] - px[il + 2]) * 0.5;
      const gyR = (px[id] - px[iu]) * 0.5;
      const gyG = (px[id + 1] - px[iu + 1]) * 0.5;
      const gyB = (px[id + 2] - px[iu + 2]) * 0.5;
      grad[y * W + x] = Math.sqrt(
        (gxR * gxR + gyR * gyR) * 0.3 +
        (gxG * gxG + gyG * gyG) * 0.59 +
        (gxB * gxB + gyB * gyB) * 0.11
      );
    }
  }
  return grad;
}

/**
 * Iteration 16: Anti-White-Spot Highlight Merger.
 * Detects isolated highlight/lighting islands whose boundary with a surrounding base region
 * has a very low source image gradient (i.e. a false quantization contour on a smooth cheek,
 * shoulder, sky, or cloud highlight rather than a real edge).
 * Merging these false-contour islands into their parent region allows the parent region's
 * <radialGradient> or <linearGradient> to represent the smooth highlight without a hard spot ring!
 */
export function mergeFalseHighlightSpots(
  labels: Uint16Array,
  px: Uint8ClampedArray,
  rgbc: Float64Array,
  gradMag: Float32Array,
  W: number,
  H: number,
  scale: number,
  strength = 1.0
): number {
  if (strength <= 0) return 0;
  const N = W * H;
  const visited = new Uint8Array(N);
  const maxSpotPx = Math.round(12 * scale * scale);
  const queue = new Int32Array(Math.min(N, maxSpotPx + 8));
  const maxBoundaryGrad = 7.5 * strength;
  let mergedCount = 0;

  for (let i = 0; i < N; i++) {
    if (visited[i]) continue;
    const lbl = labels[i];

    let qh = 0, qt = 0;
    queue[qt++] = i;
    visited[i] = 1;
    let tooBig = false;
    let touchesCanvasEdge = false;

    while (qh < qt) {
      const cur = queue[qh++];
      const cx = cur % W, cy = (cur / W) | 0;
      if (cx === 0 || cx === W - 1 || cy === 0 || cy === H - 1) touchesCanvasEdge = true;
      const nb = [
        cx > 0 ? cur - 1 : -1,
        cx < W - 1 ? cur + 1 : -1,
        cy > 0 ? cur - W : -1,
        cy < H - 1 ? cur + W : -1,
      ];
      for (let d = 0; d < 4; d++) {
        const ni = nb[d];
        if (ni < 0) continue;
        if (labels[ni] === lbl && !visited[ni]) {
          visited[ni] = 1;
          if (qt < maxSpotPx) queue[qt++] = ni;
          else tooBig = true;
        }
      }
      if (tooBig) {
        // Mark remainder visited
        const drain = [cur];
        while (drain.length > 0) {
          const c2 = drain.pop()!;
          const x2 = c2 % W, y2 = (c2 / W) | 0;
          if (x2 > 0 && !visited[c2 - 1] && labels[c2 - 1] === lbl) { visited[c2 - 1] = 1; drain.push(c2 - 1); }
          if (x2 < W - 1 && !visited[c2 + 1] && labels[c2 + 1] === lbl) { visited[c2 + 1] = 1; drain.push(c2 + 1); }
          if (y2 > 0 && !visited[c2 - W] && labels[c2 - W] === lbl) { visited[c2 - W] = 1; drain.push(c2 - W); }
          if (y2 < H - 1 && !visited[c2 + W] && labels[c2 + W] === lbl) { visited[c2 + W] = 1; drain.push(c2 + W); }
        }
        break;
      }
    }

    if (tooBig || touchesCanvasEdge || qt < 1) continue;

    // Inspect boundary gradient and dominant surrounding neighbor label
    const nbCounts = new Map<number, number>();
    let bGradSum = 0;
    let bCnt = 0;
    for (let c = 0; c < qt; c++) {
      const idx = queue[c];
      const cx = idx % W, cy = (idx / W) | 0;
      const nb = [
        cx > 0 ? idx - 1 : -1,
        cx < W - 1 ? idx + 1 : -1,
        cy > 0 ? idx - W : -1,
        cy < H - 1 ? idx + W : -1,
      ];
      let isBorder = false;
      for (let d = 0; d < 4; d++) {
        const ni = nb[d];
        if (ni < 0) continue;
        const nl = labels[ni];
        if (nl !== lbl) {
          isBorder = true;
          nbCounts.set(nl, (nbCounts.get(nl) || 0) + 1);
        }
      }
      if (isBorder) {
        bGradSum += gradMag[idx];
        bCnt++;
      }
    }
    if (bCnt === 0 || nbCounts.size === 0) continue;
    const avgBGrad = bGradSum / bCnt;
    if (avgBGrad > maxBoundaryGrad) continue; // Real crisp edge (like white text or eye catchlight) -> NEVER merge!

    // Find dominant surrounding neighbor
    let domLbl = -1, domCnt = 0, totBorder = 0;
    for (const [nl, cnt] of nbCounts.entries()) {
      totBorder += cnt;
      if (cnt > domCnt) { domCnt = cnt; domLbl = nl; }
    }
    if (domLbl < 0 || domCnt < totBorder * 0.65) continue;

    // Check color difference between spot interior pixels and surrounding neighbor
    const spotR = px[i * 4], spotG = px[i * 4 + 1], spotB = px[i * 4 + 2];
    const dr = spotR - rgbc[domLbl * 3];
    const dg = spotG - rgbc[domLbl * 3 + 1];
    const db = spotB - rgbc[domLbl * 3 + 2];
    const colorStep = Math.hypot(dr, dg, db);
    if (colorStep > 38 * strength) continue;

    for (let c = 0; c < qt; c++) {
      labels[queue[c]] = domLbl;
    }
    mergedCount++;
  }
  return mergedCount;
}

/**
 * Evaluates a GradientDef or solid RGB at pixel (x, y) in image coordinates.
 */
export function evalShadingAtPixel(
  x: number,
  y: number,
  scale: number,
  meanR: number,
  meanG: number,
  meanB: number,
  grad: GradientDef | undefined,
  parsedStopsCache: Map<string, [number, number, number, number][]>
): [number, number, number] {
  if (!grad) return [meanR, meanG, meanB];
  let stops = parsedStopsCache.get(grad.id);
  if (!stops) {
    stops = grad.stops.map((s) => {
      const off = parseFloat(s.offset) / 100;
      const r = parseInt(s.color.slice(1, 3), 16) || 0;
      const g = parseInt(s.color.slice(3, 5), 16) || 0;
      const b = parseInt(s.color.slice(5, 7), 16) || 0;
      return [off, r, g, b];
    });
    parsedStopsCache.set(grad.id, stops);
  }
  const sx = x / scale;
  const sy = y / scale;
  let t = 0;
  if (grad.type === "linear") {
    const dx = grad.x2 - grad.x1;
    const dy = grad.y2 - grad.y1;
    const l2 = dx * dx + dy * dy;
    t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((sx - grad.x1) * dx + (sy - grad.y1) * dy) / l2)) : 0;
  } else {
    const r = Math.max(1e-3, grad.r);
    t = Math.min(1, Math.hypot(sx - grad.cx, sy - grad.cy) / r);
  }
  if (t <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
  const last = stops[stops.length - 1];
  if (t >= last[0]) return [last[1], last[2], last[3]];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return [
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
        a[3] + (b[3] - a[3]) * f,
      ];
    }
  }
  return [meanR, meanG, meanB];
}

/**
 * Iterations 17, 18, 21: Volumetric Soft Lighting & Anti-Spot Glow Synthesizer.
 * Examines the smooth residual difference between the source image and the current
 * predicted vector shading, and synthesizes native SVG <ellipse>/<circle> primitives
 * filled with feathered <radialGradient> (stop-opacity 0.85 -> 0) and optional
 * <filter><feGaussianBlur/></filter> so smooth cheek highlights, sunbeams, sky glows,
 * and cloud luminance transitions reach near-zero error without hard edges!
 */
export function synthesizeLightingGlowLayers(
  px: Uint8ClampedArray,
  predR: Float32Array,
  predG: Float32Array,
  predB: Float32Array,
  gradMag: Float32Array,
  W: number,
  H: number,
  scale: number,
  maxGlowLobes: number,
  gradientsOut: GradientDef[],
  filtersOut: FilterDef[]
): VectorElement[] {
  if (maxGlowLobes <= 0) return [];
  const N = W * H;

  // Compute smooth signed residual in R, G, B on low-gradient (non-edge) regions
  const resR = new Float32Array(N);
  const resG = new Float32Array(N);
  const resB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Attenuate residual across sharp ink edges so lighting glows don't blur line-art
    const edgeGate = Math.max(0, 1 - gradMag[i] / 22);
    resR[i] = (px[i * 4] - predR[i]) * edgeGate;
    resG[i] = (px[i * 4 + 1] - predG[i]) * edgeGate;
    resB[i] = (px[i * 4 + 2] - predB[i]) * edgeGate;
  }

  const sigma = Math.max(2.0, 3.2 * scale);
  const sR = gaussBlur(resR, W, H, sigma);
  const sG = gaussBlur(resG, W, H, sigma);
  const sB = gaussBlur(resB, W, H, sigma);

  const errEnergy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    errEnergy[i] = Math.hypot(sR[i], sG[i], sB[i]);
  }

  const elements: VectorElement[] = [];
  const suppressed = new Uint8Array(N);
  const minPeakErr = 4.2;
  const r1 = (v: number) => Math.round((v / scale) * 10) / 10;

  // Register a shared soft glow SVG filter if needed
  const glowFilterId = "vf-soft-glow";
  let filterAdded = false;

  for (let lobe = 0; lobe < maxGlowLobes; lobe++) {
    // Find highest smooth residual peak not yet suppressed
    let bestIdx = -1;
    let bestVal = minPeakErr;
    const step = Math.max(1, Math.round(2 * scale));
    for (let y = step; y < H - step; y += step) {
      const row = y * W;
      for (let x = step; x < W - step; x += step) {
        const i = row + x;
        if (suppressed[i]) continue;
        if (errEnergy[i] > bestVal) {
          bestVal = errEnergy[i];
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) break;

    const px0 = bestIdx % W;
    const py0 = (bestIdx / W) | 0;
    const dr0 = sR[bestIdx], dg0 = sG[bestIdx], db0 = sB[bestIdx];
    const norm0 = Math.hypot(dr0, dg0, db0) || 1;
    const ux = dr0 / norm0, uy = dg0 / norm0, uz = db0 / norm0;

    // Grow elliptical support region around (px0, py0) where residual projects positively along (ux, uy, uz)
    const maxR = Math.round(Math.min(W, H) * 0.16);
    const minR = Math.max(3, Math.round(4 * scale));
    const thr = bestVal * 0.32;

    let sumW = 0, mx = 0, my = 0;
    const x0 = Math.max(0, px0 - maxR), x1 = Math.min(W - 1, px0 + maxR);
    const y0 = Math.max(0, py0 - maxR), y1 = Math.min(H - 1, py0 + maxR);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - px0) * (x - px0) + (y - py0) * (y - py0);
        if (d2 > maxR * maxR) continue;
        const idx = y * W + x;
        const proj = sR[idx] * ux + sG[idx] * uy + sB[idx] * uz;
        if (proj > thr) {
          const w = proj - thr;
          sumW += w;
          mx += x * w;
          my += y * w;
        }
      }
    }

    if (sumW <= 0) {
      suppressed[bestIdx] = 1;
      continue;
    }
    mx /= sumW;
    my /= sumW;

    let sxx = 0, syy = 0, pixCount = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - px0) * (x - px0) + (y - py0) * (y - py0);
        if (d2 > maxR * maxR) continue;
        const idx = y * W + x;
        const proj = sR[idx] * ux + sG[idx] * uy + sB[idx] * uz;
        if (proj > thr) {
          const w = proj - thr;
          sxx += w * (x - mx) * (x - mx);
          syy += w * (y - my) * (y - my);
          pixCount++;
        }
      }
    }

    const rx = Math.max(minR, Math.min(maxR, Math.sqrt(sxx / sumW) * 2.15));
    const ry = Math.max(minR, Math.min(maxR, Math.sqrt(syy / sumW) * 2.15));

    // Suppress neighborhood and evaluate whether this feathered radial glow reduces true pixel MSE
    let oldSe = 0, newSe = 0;
    const peakAlpha = Math.min(0.78, Math.max(0.22, bestVal / 42));
    // Target color at peak that pulls predRGB toward true pxRGB by dr0/peakAlpha
    const targR = Math.max(0, Math.min(255, predR[bestIdx] + dr0 / peakAlpha));
    const targG = Math.max(0, Math.min(255, predG[bestIdx] + dg0 / peakAlpha));
    const targB = Math.max(0, Math.min(255, predB[bestIdx] + db0 / peakAlpha));
    const glowHex = hex(targR, targG, targB);

    const bx0 = Math.max(0, Math.floor(mx - rx)), bx1 = Math.min(W - 1, Math.ceil(mx + rx));
    const by0 = Math.max(0, Math.floor(my - ry)), by1 = Math.min(H - 1, Math.ceil(my + ry));

    let edgeCrossPenalty = 0;
    const midAlpha = +(peakAlpha * 0.45).toFixed(2);
    const evalAlpha = (rNorm: number) => {
      if (rNorm >= 1) return 0;
      if (rNorm <= 0.55) {
        const f = rNorm / 0.55;
        return peakAlpha * (1 - f) + midAlpha * f;
      }
      const f = (rNorm - 0.55) / 0.45;
      return midAlpha * (1 - f);
    };

    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const idx = y * W + x;
        const nx = (x - mx) / rx;
        const ny = (y - my) / ry;
        const rNorm = Math.hypot(nx, ny);
        if (rNorm <= 1.15) suppressed[idx] = 1;
        if (rNorm >= 1.0) continue;
        if (gradMag[idx] > 18 && rNorm < 0.85) edgeCrossPenalty++;
        const alpha = evalAlpha(rNorm);
        const nr = predR[idx] * (1 - alpha) + targR * alpha;
        const ng = predG[idx] * (1 - alpha) + targG * alpha;
        const nb = predB[idx] * (1 - alpha) + targB * alpha;

        const tr = px[idx * 4], tg = px[idx * 4 + 1], tb = px[idx * 4 + 2];
        oldSe += (tr - predR[idx]) ** 2 + (tg - predG[idx]) ** 2 + (tb - predB[idx]) ** 2;
        newSe += (tr - nr) ** 2 + (tg - ng) ** 2 + (tb - nb) ** 2;
      }
    }

    const totalArea = Math.PI * rx * ry;
    if (newSe >= oldSe * 0.90 || pixCount < 16 || edgeCrossPenalty > totalArea * 0.06) continue;

    // Commit the lighting glow update to predRGB
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const idx = y * W + x;
        const nx = (x - mx) / rx;
        const ny = (y - my) / ry;
        const rNorm = Math.hypot(nx, ny);
        if (rNorm >= 1.0) continue;
        const alpha = evalAlpha(rNorm);
        predR[idx] = predR[idx] * (1 - alpha) + targR * alpha;
        predG[idx] = predG[idx] * (1 - alpha) + targG * alpha;
        predB[idx] = predB[idx] * (1 - alpha) + targB * alpha;
        errEnergy[idx] *= 0.25;
      }
    }

    const rgId = `rg-glow-${lobe}`;
    const rgDef: RadialGradientDef = {
      type: "radial",
      id: rgId,
      cx: 0.5,
      cy: 0.5,
      r: 0.5,
      fx: 0.5,
      fy: 0.5,
      units: "objectBoundingBox",
      stops: [
        { offset: "0%", color: glowHex, opacity: +peakAlpha.toFixed(2) },
        { offset: "55%", color: glowHex, opacity: midAlpha },
        { offset: "100%", color: glowHex, opacity: 0 },
      ],
    };
    gradientsOut.push(rgDef);

    if (!filterAdded && lobe < 4) {
      filtersOut.push({
        id: glowFilterId,
        stdDeviation: +(0.6 / scale).toFixed(2),
        kind: "soft",
      });
      filterAdded = true;
    }

    const isCircle = Math.abs(rx - ry) <= 0.8 * scale;
    const prim: ShapePrimitive = isCircle
      ? { tag: "circle", attrs: { cx: r1(mx), cy: r1(my), r: r1((rx + ry) * 0.5) }, nodes: 1 }
      : { tag: "ellipse", attrs: { cx: r1(mx), cy: r1(my), rx: r1(rx), ry: r1(ry) }, nodes: 1 };

    elements.push({
      id: `glow-${String(lobe + 1).padStart(2, "0")}`,
      kind: prim.tag,
      fill: `url(#${rgId})`,
      colorHex: glowHex,
      primitive: prim,
      filterId: lobe < 4 ? glowFilterId : undefined,
      nodes: 1,
      loops: 1,
      coverage: (Math.PI * rx * ry) / N,
      layerGroup: "lighting-glow",
    });
  }

  return elements;
}

/**
 * Iterations 19, 20, 22, 25: Residual Error-Driven Crisp Micro-Detail & Catchlight Loop.
 * Finds any remaining high-error pixels (like pure white "15th MAPPA" text, eye catchlights,
 * eyelashes, red rooftops, flower petals, or uncaptured gradient sub-steps), clusters their
 * residual colors, and traces crisp precision vector primitives on top!
 */
export function synthesizeResidualDetailLayers(
  px: Uint8ClampedArray,
  predR: Float32Array,
  predG: Float32Array,
  predB: Float32Array,
  W: number,
  H: number,
  scale: number,
  tolerance: number,
  cornerAngle: number,
  minArea: number,
  maxResidualClusters = 8
): VectorElement[] {
  if (maxResidualClusters <= 0) return [];
  const N = W * H;
  const errMag = new Float32Array(N);
  const hotIndices: number[] = [];
  const errThr = 15.0; // Significant visible color discrepancy

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const dr = px[i * 4] - predR[i];
      const dg = px[i * 4 + 1] - predG[i];
      const db = px[i * 4 + 2] - predB[i];
      const e = Math.hypot(dr, dg, db);
      // Only trigger crisp residual paths on high-contrast features (text, catchlights, edges),
      // never on smooth lighting gradients where hard contours would create speckles
      const gx = Math.abs(px[(i + 1) * 4] - px[(i - 1) * 4]) + Math.abs(px[(i + 1) * 4 + 1] - px[(i - 1) * 4 + 1]);
      const gy = Math.abs(px[(i + W) * 4] - px[(i - W) * 4]) + Math.abs(px[(i + W) * 4 + 1] - px[(i - W) * 4 + 1]);
      const isSharpFeature = gx + gy >= 28 || e >= 28;
      errMag[i] = isSharpFeature ? e : e * 0.35;
      if (errMag[i] >= errThr) {
        hotIndices.push(i);
      }
    }
  }

  if (hotIndices.length < Math.max(8, N * 0.00015)) return [];

  // Cluster the true RGB colors of hot residual pixels into K_res micro-palettes
  const K = Math.min(maxResidualClusters, Math.max(2, Math.floor(hotIndices.length / 80)));
  const centers = new Float64Array(K * 3);
  const step = Math.max(1, Math.floor(hotIndices.length / K));
  for (let k = 0; k < K; k++) {
    const idx = hotIndices[Math.min(hotIndices.length - 1, k * step)];
    centers[k * 3] = px[idx * 4];
    centers[k * 3 + 1] = px[idx * 4 + 1];
    centers[k * 3 + 2] = px[idx * 4 + 2];
  }

  const hotAssign = new Uint8Array(hotIndices.length);
  for (let it = 0; it < 6; it++) {
    const sums = new Float64Array(K * 3);
    const cnts = new Float64Array(K);
    for (let j = 0; j < hotIndices.length; j++) {
      const i = hotIndices[j];
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (r - centers[k * 3]) ** 2 + (g - centers[k * 3 + 1]) ** 2 + (b - centers[k * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      hotAssign[j] = best;
      const w = errMag[i];
      sums[best * 3] += r * w;
      sums[best * 3 + 1] += g * w;
      sums[best * 3 + 2] += b * w;
      cnts[best] += w;
    }
    for (let k = 0; k < K; k++) {
      if (cnts[k] > 0) {
        centers[k * 3] = sums[k * 3] / cnts[k];
        centers[k * 3 + 1] = sums[k * 3 + 1] / cnts[k];
        centers[k * 3 + 2] = sums[k * 3 + 2] / cnts[k];
      }
    }
  }

  const elements: VectorElement[] = [];
  const minLoopArea = Math.max(1.2, minArea * 1.5) * scale * scale;

  for (let k = 0; k < K; k++) {
    const cr = centers[k * 3], cg = centers[k * 3 + 1], cb = centers[k * 3 + 2];
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    let count = 0;

    for (let j = 0; j < hotIndices.length; j++) {
      if (hotAssign[j] !== k) continue;
      const i = hotIndices[j];
      // Verify that replacing predRGB[i] with (cr, cg, cb) strictly improves error at pixel i
      const newDist = Math.hypot(px[i * 4] - cr, px[i * 4 + 1] - cg, px[i * 4 + 2] - cb);
      if (newDist < errMag[i] * 0.65 && newDist < 18) {
        const x = i % W, y = (i / W) | 0;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        count++;
      }
    }

    if (count < 6 || bx1 < 0) continue;

    const pad = 2;
    const wx0 = Math.max(0, bx0 - pad), wy0 = Math.max(0, by0 - pad);
    const wx1 = Math.min(W - 1, bx1 + pad), wy1 = Math.min(H - 1, by1 + pad);
    const FW = wx1 - wx0 + 1, FH = wy1 - wy0 + 1;
    const F = new Float32Array(FW * FH);

    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let y = 0; y < FH; y++) {
      const gy = wy0 + y;
      for (let x = 0; x < FW; x++) {
        const gx = wx0 + x;
        const gi = gy * W + gx;
        const dNew = Math.hypot(px[gi * 4] - cr, px[gi * 4 + 1] - cg, px[gi * 4 + 2] - cb);
        const dOld = errMag[gi];
        if (dOld >= errThr * 0.85 && dNew < dOld * 0.72 && dNew < 20) {
          const sum = dOld + dNew;
          F[y * FW + x] = sum > 1e-5 ? dOld / sum : 1;
          if (F[y * FW + x] >= 0.5) {
            sr += px[gi * 4];
            sg += px[gi * 4 + 1];
            sb += px[gi * 4 + 2];
            sc++;
          }
        } else {
          F[y * FW + x] = 0.15;
        }
      }
    }

    if (sc < 5) continue;
    const exactHex = hex(sr / sc, sg / sc, sb / sc);
    const loops = traceField(F, FW, FH, wx0, wy0, { sigma: 0, minArea: minLoopArea });
    if (loops.length === 0) continue;

    // Update predRGB for covered pixels
    const er = sr / sc, eg = sg / sc, eb = sb / sc;
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        if (F[y * FW + x] >= 0.5) {
          const gi = (wy0 + y) * W + wx0 + x;
          predR[gi] = er;
          predG[gi] = eg;
          predB[gi] = eb;
        }
      }
    }

    if (loops.length === 1) {
      const lp = loops[0];
      const fit = fitLoop(lp, { tolerance: tolerance * scale, cornerAngle });
      const prim = detectPrimitiveShape(lp, fit.segs, scale, tolerance);
      if (prim) {
        elements.push({
          id: `detail-${String(k + 1).padStart(2, "0")}`,
          kind: prim.tag,
          fill: exactHex,
          colorHex: exactHex,
          primitive: prim,
          nodes: prim.nodes,
          loops: 1,
          coverage: sc / N,
          layerGroup: "residual-detail",
        });
        continue;
      }
    }

    let d = "";
    let nodes = 0;
    for (const lp of loops) {
      const fit = fitLoop(lp, { tolerance: tolerance * scale, cornerAngle });
      const p = loopToPath(lp, fit.segs, fit.polygon, scale, tolerance);
      d += p.d;
      nodes += p.nodes;
    }

    elements.push({
      id: `detail-${String(k + 1).padStart(2, "0")}`,
      kind: "path",
      fill: exactHex,
      colorHex: exactHex,
      d,
      nodes,
      loops: loops.length,
      coverage: sc / N,
      layerGroup: "residual-detail",
    });
  }

  return elements;
}

export { fitRegionShading, type GradientDef, type LinearGradientDef };
