import { hex } from "./color";
import type { Loop } from "./trace";

export interface GradientStop {
  offset: string; // e.g. "0%", "25%", "50%", "75%", "100%"
  color: string;
  opacity?: number;
}

export interface LinearGradientDef {
  type: "linear";
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
}

export interface RadialGradientDef {
  type: "radial";
  id: string;
  cx: number;
  cy: number;
  r: number;
  fx: number;
  fy: number;
  units?: "userSpaceOnUse" | "objectBoundingBox";
  stops: GradientStop[];
}

export type GradientDef = LinearGradientDef | RadialGradientDef;

export interface RegionFitResult {
  fill: string; // "#rrggbb" or "url(#lg-...)" or "url(#rg-...)"
  colorHex: string; // Representative solid hex
  gradient?: GradientDef;
  boundaryGrad: number; // Average source image gradient along the region boundary
  isSoftSpot: boolean; // True if low boundary gradient + bright/smooth highlight spot
  areaPx: number;
  meanR: number;
  meanG: number;
  meanB: number;
}

/**
 * Fits the optimal color representation for a single connected region of pixels:
 * - Exact local visible pixel mean (eliminates global palette cross-contamination)
 * - 5-stop least-squares <linearGradient> along the principal chromatic/luma axis
 * - 4-stop <radialGradient> centered on the local illumination extremum or centroid
 * - Feathered anti-spot <radialGradient> when the region is a false-contour highlight spot
 */
export function fitRegionShading(
  pixIndices: Int32Array,
  nPix: number,
  visMask: Uint8Array | null,
  px: Uint8ClampedArray,
  gradMag: Float32Array,
  W: number,
  scale: number,
  gradIdPrefix: string,
  enableGradients = true,
  antiSpotStrength = 1.0
): RegionFitResult {
  // 1. Compute mean RGB, preferring pixels that are visibly exposed (not covered by upper opaque layers)
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  let allR = 0, allG = 0, allB = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  let bGradSum = 0, bGradCnt = 0;

  for (let i = 0; i < nPix; i++) {
    const gi = pixIndices[i];
    const x = gi % W, y = (gi / W) | 0;
    const r = px[gi * 4], g = px[gi * 4 + 1], b = px[gi * 4 + 2];
    allR += r; allG += g; allB += b;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
    if (!visMask || visMask[gi]) {
      sr += r; sg += g; sb += b; cnt++;
    }
    bGradSum += gradMag[gi];
    bGradCnt++;
  }

  const useVis = cnt >= Math.max(4, nPix * 0.12);
  const meanR = useVis ? sr / cnt : allR / Math.max(1, nPix);
  const meanG = useVis ? sg / cnt : allG / Math.max(1, nPix);
  const meanB = useVis ? sb / cnt : allB / Math.max(1, nPix);
  const colorHex = hex(meanR, meanG, meanB);
  const avgGrad = bGradCnt > 0 ? bGradSum / bGradCnt : 20;

  const isSoftSpot = antiSpotStrength > 0 && avgGrad < 12.0 && nPix >= 16 && nPix <= 40000;

  // Allow gradients on smaller smooth lighting spots (>= 18px) so shoulder/cheek spots never stay flat
  const minGradPixels = Math.round((isSoftSpot ? 18 : 64) * scale * scale);
  if (!enableGradients || nPix < minGradPixels || bx1 - bx0 < 3 || by1 - by0 < 3) {
    return {
      fill: colorHex,
      colorHex,
      boundaryGrad: avgGrad,
      isSoftSpot,
      areaPx: nPix / (scale * scale),
      meanR,
      meanG,
      meanB,
    };
  }

  // 2. Measure flat MSE and spatial covariance on visible pixels (or all pixels if mostly covered)
  const stride = nPix > 4000 ? Math.floor(nPix / 2500) : 1;
  let mx = 0, my = 0, mr = 0, mg = 0, mb = 0, scnt = 0;
  for (let i = 0; i < nPix; i += stride) {
    const gi = pixIndices[i];
    if (useVis && visMask && !visMask[gi]) continue;
    mx += gi % W;
    my += (gi / W) | 0;
    mr += px[gi * 4];
    mg += px[gi * 4 + 1];
    mb += px[gi * 4 + 2];
    scnt++;
  }
  if (scnt < 14) {
    return {
      fill: colorHex,
      colorHex,
      boundaryGrad: avgGrad,
      isSoftSpot,
      areaPx: nPix / (scale * scale),
      meanR,
      meanG,
      meanB,
    };
  }
  mx /= scnt; my /= scnt; mr /= scnt; mg /= scnt; mb /= scnt;

  let sxx = 0, sxy = 0, syy = 0;
  let sxr = 0, syr = 0, sxg = 0, syg = 0, sxb = 0, syb = 0;
  let flatSe = 0;
  let peakLuma = -1, peakX = mx, peakY = my;

  for (let i = 0; i < nPix; i += stride) {
    const gi = pixIndices[i];
    if (useVis && visMask && !visMask[gi]) continue;
    const x = gi % W, y = (gi / W) | 0;
    const r = px[gi * 4], g = px[gi * 4 + 1], b = px[gi * 4 + 2];
    const dx = x - mx, dy = y - my;
    const dr = r - mr, dg = g - mg, db = b - mb;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxr += dx * dr; syr += dy * dr;
    sxg += dx * dg; syg += dy * dg;
    sxb += dx * db; syb += dy * db;
    flatSe += dr * dr + dg * dg + db * db;

    const lu = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lu > peakLuma) { peakLuma = lu; peakX = x; peakY = y; }
  }

  const flatMse = flatSe / (scnt * 3);
  // If region is already nearly uniform, keep solid hex
  if (flatMse < (isSoftSpot ? 1.4 : 2.8)) {
    return {
      fill: colorHex,
      colorHex,
      boundaryGrad: avgGrad,
      isSoftSpot: false,
      areaPx: nPix / (scale * scale),
      meanR,
      meanG,
      meanB,
    };
  }

  // 3. Fit 2D Linear Gradient direction via least-squares plane slope
  const det = sxx * syy - sxy * sxy;
  let linDef: LinearGradientDef | undefined;
  let linMse = Infinity;

  if (Math.abs(det) > 1e-6) {
    const invDet = 1 / det;
    const ar = (syy * sxr - sxy * syr) * invDet;
    const br = (sxx * syr - sxy * sxr) * invDet;
    const ag = (syy * sxg - sxy * syg) * invDet;
    const bg = (sxx * syg - sxy * sxg) * invDet;
    const ab = (syy * sxb - sxy * syb) * invDet;
    const bb = (sxx * syb - sxy * sxb) * invDet;

    // Principal gradient vector weighted by channel energy
    const gx = ar * 0.3 + ag * 0.59 + ab * 0.11;
    const gy = br * 0.3 + bg * 0.59 + bb * 0.11;
    let ux = gx, uy = gy;
    let ulen = Math.hypot(ux, uy);
    if (ulen < 1e-5) {
      ux = ar + ag + ab;
      uy = br + bg + bb;
      ulen = Math.hypot(ux, uy);
    }

    if (ulen > 1e-5) {
      ux /= ulen;
      uy /= ulen;
      let tMin = Infinity, tMax = -Infinity;
      for (let i = 0; i < nPix; i += stride) {
        const gi = pixIndices[i];
        if (useVis && visMask && !visMask[gi]) continue;
        const x = gi % W, y = (gi / W) | 0;
        const t = (x - mx) * ux + (y - my) * uy;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
      const span = tMax - tMin;
      if (span >= 4) {
        // Bin into 5 stops: 0%, 25%, 50%, 75%, 100%
        const BINS = 5;
        const brSum = new Float64Array(BINS);
        const bgSum = new Float64Array(BINS);
        const bbSum = new Float64Array(BINS);
        const btSum = new Float64Array(BINS);
        const bW = new Float64Array(BINS);

        for (let i = 0; i < nPix; i += stride) {
          const gi = pixIndices[i];
          if (useVis && visMask && !visMask[gi]) continue;
          const x = gi % W, y = (gi / W) | 0;
          const normT = Math.max(0, Math.min(1, ((x - mx) * ux + (y - my) * uy - tMin) / span));
          const pos = normT * (BINS - 1);
          const b0 = Math.min(BINS - 2, Math.floor(pos));
          const frac = pos - b0;
          const w0 = 1 - frac, w1 = frac;
          const r = px[gi * 4], g = px[gi * 4 + 1], b = px[gi * 4 + 2];
          brSum[b0] += r * w0; bgSum[b0] += g * w0; bbSum[b0] += b * w0; btSum[b0] += normT * w0; bW[b0] += w0;
          brSum[b0 + 1] += r * w1; bgSum[b0 + 1] += g * w1; bbSum[b0 + 1] += b * w1; btSum[b0 + 1] += normT * w1; bW[b0 + 1] += w1;
        }

        const stopR = new Float64Array(BINS);
        const stopG = new Float64Array(BINS);
        const stopB = new Float64Array(BINS);
        const meanT = new Float64Array(BINS);
        for (let b = 0; b < BINS; b++) {
          if (bW[b] > 1e-3) {
            stopR[b] = brSum[b] / bW[b];
            stopG[b] = bgSum[b] / bW[b];
            stopB[b] = bbSum[b] / bW[b];
            meanT[b] = btSum[b] / bW[b];
          } else {
            stopR[b] = mr; stopG[b] = mg; stopB[b] = mb;
            meanT[b] = b / (BINS - 1);
          }
        }
        // Extrapolate one-sided boundary bins b=0 (to t=0) and b=BINS-1 (to t=1) so rim colors match neighboring layers
        if (meanT[1] - meanT[0] > 0.04) {
          const f0 = Math.min(0.6, meanT[0] / (meanT[1] - meanT[0]));
          stopR[0] = Math.max(0, Math.min(255, stopR[0] - (stopR[1] - stopR[0]) * f0));
          stopG[0] = Math.max(0, Math.min(255, stopG[0] - (stopG[1] - stopG[0]) * f0));
          stopB[0] = Math.max(0, Math.min(255, stopB[0] - (stopB[1] - stopB[0]) * f0));
        }
        if (meanT[BINS - 1] - meanT[BINS - 2] > 0.04) {
          const f1 = Math.min(0.6, (1 - meanT[BINS - 1]) / (meanT[BINS - 1] - meanT[BINS - 2]));
          stopR[BINS - 1] = Math.max(0, Math.min(255, stopR[BINS - 1] + (stopR[BINS - 1] - stopR[BINS - 2]) * f1));
          stopG[BINS - 1] = Math.max(0, Math.min(255, stopG[BINS - 1] + (stopG[BINS - 1] - stopG[BINS - 2]) * f1));
          stopB[BINS - 1] = Math.max(0, Math.min(255, stopB[BINS - 1] + (stopB[BINS - 1] - stopB[BINS - 2]) * f1));
        }

        // Evaluate 5-stop linear gradient MSE
        let lSe = 0;
        for (let i = 0; i < nPix; i += stride) {
          const gi = pixIndices[i];
          if (useVis && visMask && !visMask[gi]) continue;
          const x = gi % W, y = (gi / W) | 0;
          const normT = Math.max(0, Math.min(1, ((x - mx) * ux + (y - my) * uy - tMin) / span));
          const pos = normT * (BINS - 1);
          const b0 = Math.min(BINS - 2, Math.floor(pos));
          const f = pos - b0;
          const pr = stopR[b0] * (1 - f) + stopR[b0 + 1] * f;
          const pg = stopG[b0] * (1 - f) + stopG[b0 + 1] * f;
          const pb = stopB[b0] * (1 - f) + stopB[b0 + 1] * f;
          const dr = px[gi * 4] - pr, dg = px[gi * 4 + 1] - pg, db = px[gi * 4 + 2] - pb;
          lSe += dr * dr + dg * dg + db * db;
        }
        linMse = lSe / (scnt * 3);

        const r1 = (v: number) => Math.round((v / scale) * 10) / 10;
        const offsets = ["0%", "25%", "50%", "75%", "100%"];
        // Simplify to 3 stops if intermediate stops are linear
        const stops: GradientStop[] = [];
        for (let b = 0; b < BINS; b++) {
          if (b === 1 || b === 3) {
            const er = 0.5 * (stopR[b - 1] + stopR[b + 1]);
            const eg = 0.5 * (stopG[b - 1] + stopG[b + 1]);
            const eb = 0.5 * (stopB[b - 1] + stopB[b + 1]);
            if (Math.hypot(stopR[b] - er, stopG[b] - eg, stopB[b] - eb) < 1.8) continue;
          }
          stops.push({
            offset: offsets[b],
            color: hex(stopR[b], stopG[b], stopB[b]),
          });
        }
        linDef = {
          type: "linear",
          id: `lg-${gradIdPrefix}`,
          x1: r1(mx + ux * tMin),
          y1: r1(my + uy * tMin),
          x2: r1(mx + ux * tMax),
          y2: r1(my + uy * tMax),
          stops,
        };
      }
    }
  }

  // 4. Fit Radial Gradient (centered at centroid or blended toward illumination peak for soft spots)
  let radDef: RadialGradientDef | undefined;
  let radMse = Infinity;
  {
    // Center for radial gradient: blend between centroid and highlight peak
    const cx = isSoftSpot ? 0.65 * mx + 0.35 * peakX : mx;
    const cy = isSoftSpot ? 0.65 * my + 0.35 * peakY : my;
    let rMax = 0;
    for (let i = 0; i < nPix; i += stride) {
      const gi = pixIndices[i];
      if (useVis && visMask && !visMask[gi]) continue;
      const d = Math.hypot((gi % W) - cx, ((gi / W) | 0) - cy);
      if (d > rMax) rMax = d;
    }
    if (rMax >= 4) {
      const RBINS = 4;
      const rrSum = new Float64Array(RBINS);
      const rgSum = new Float64Array(RBINS);
      const rbSum = new Float64Array(RBINS);
      const rW = new Float64Array(RBINS);

      for (let i = 0; i < nPix; i += stride) {
        const gi = pixIndices[i];
        if (useVis && visMask && !visMask[gi]) continue;
        const d = Math.min(1, Math.hypot((gi % W) - cx, ((gi / W) | 0) - cy) / rMax);
        const pos = d * (RBINS - 1);
        const b0 = Math.min(RBINS - 2, Math.floor(pos));
        const f = pos - b0;
        const w0 = 1 - f, w1 = f;
        const r = px[gi * 4], g = px[gi * 4 + 1], b = px[gi * 4 + 2];
        rrSum[b0] += r * w0; rgSum[b0] += g * w0; rbSum[b0] += b * w0; rW[b0] += w0;
        rrSum[b0 + 1] += r * w1; rgSum[b0 + 1] += g * w1; rbSum[b0 + 1] += b * w1; rW[b0 + 1] += w1;
      }

      const stopR = new Float64Array(RBINS);
      const stopG = new Float64Array(RBINS);
      const stopB = new Float64Array(RBINS);
      for (let b = 0; b < RBINS; b++) {
        if (rW[b] > 1e-3) {
          stopR[b] = rrSum[b] / rW[b];
          stopG[b] = rgSum[b] / rW[b];
          stopB[b] = rbSum[b] / rW[b];
        } else {
          stopR[b] = b > 0 ? stopR[b - 1] : mr;
          stopG[b] = b > 0 ? stopG[b - 1] : mg;
          stopB[b] = b > 0 ? stopB[b - 1] : mb;
        }
      }

      let rSe = 0;
      for (let i = 0; i < nPix; i += stride) {
        const gi = pixIndices[i];
        if (useVis && visMask && !visMask[gi]) continue;
        const d = Math.min(1, Math.hypot((gi % W) - cx, ((gi / W) | 0) - cy) / rMax);
        const pos = d * (RBINS - 1);
        const b0 = Math.min(RBINS - 2, Math.floor(pos));
        const f = pos - b0;
        const pr = stopR[b0] * (1 - f) + stopR[b0 + 1] * f;
        const pg = stopG[b0] * (1 - f) + stopG[b0 + 1] * f;
        const pb = stopB[b0] * (1 - f) + stopB[b0 + 1] * f;
        const dr = px[gi * 4] - pr, dg = px[gi * 4 + 1] - pg, db = px[gi * 4 + 2] - pb;
        rSe += dr * dr + dg * dg + db * db;
      }
      radMse = rSe / (scnt * 3);

      const r1 = (v: number) => Math.round((v / scale) * 10) / 10;
      const fx = r1(0.5 * cx + 0.5 * peakX);
      const fy = r1(0.5 * cy + 0.5 * peakY);
      const offsets = ["0%", "33%", "67%", "100%"];
      radDef = {
        type: "radial",
        id: `rg-${gradIdPrefix}`,
        cx: r1(cx),
        cy: r1(cy),
        r: r1(rMax * 1.04),
        fx,
        fy,
        stops: [0, 1, 2, 3].map((b) => ({
          offset: offsets[b],
          color: hex(stopR[b], stopG[b], stopB[b]),
        })),
      };
    }
  }

  // Choose between solid, linear gradient, and radial gradient
  const bestGradMse = Math.min(linMse, radMse);
  const improvement = flatMse - bestGradMse;
  const relImprovement = improvement / Math.max(1, flatMse);

  // Soft spots prefer radial or linear gradients even at small improvement thresholds to kill flat white spots
  const reqAbs = isSoftSpot ? 0.6 : 2.4;
  const reqRel = isSoftSpot ? 0.06 : 0.14;

  if (improvement >= reqAbs && relImprovement >= reqRel) {
    if (radDef && radMse <= linMse) {
      return {
        fill: `url(#${radDef.id})`,
        colorHex,
        gradient: radDef,
        boundaryGrad: avgGrad,
        isSoftSpot,
        areaPx: nPix / (scale * scale),
        meanR,
        meanG,
        meanB,
      };
    }
    if (linDef) {
      return {
        fill: `url(#${linDef.id})`,
        colorHex,
        gradient: linDef,
        boundaryGrad: avgGrad,
        isSoftSpot,
        areaPx: nPix / (scale * scale),
        meanR,
        meanG,
        meanB,
      };
    }
  }

  return {
    fill: colorHex,
    colorHex,
    boundaryGrad: avgGrad,
    isSoftSpot,
    areaPx: nPix / (scale * scale),
    meanR,
    meanG,
    meanB,
  };
}

/**
 * Connected-component segmentation of a layer's traced loops and pixels.
 * Maps every traced outer loop + its interior hole loops to the exact set of
 * source pixels inside that connected component in O(FW * FH) time.
 */
export interface ConnectedRegion {
  id: number;
  loops: Loop[];
  pixels: Int32Array;
}

function pointInLoop(px: number, py: number, lp: Loop): boolean {
  const [x0, y0, x1, y1] = lp.bbox;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const xs = lp.xs, ys = lp.ys, n = xs.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xs[i], yi = ys[i];
    const xj = xs[j], yj = ys[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function segmentLayerRegions(
  F: Float32Array,
  loops: Loop[],
  FW: number,
  FH: number,
  wx0: number,
  wy0: number,
  W: number,
  rank: Uint8Array,
  r: number
): ConnectedRegion[] {
  if (loops.length === 0) return [];

  // Separate outer boundary contours (area > 0) from inner hole contours (area < 0)
  const outers: Loop[] = [];
  const holes: Loop[] = [];
  for (const lp of loops) {
    if (lp.area >= 0) outers.push(lp);
    else holes.push(lp);
  }

  if (outers.length === 0) {
    const allPix: number[] = [];
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const gi = (wy0 + y) * W + wx0 + x;
        if (rank[gi] === r) allPix.push(gi);
      }
    }
    return [{ id: 1, loops, pixels: Int32Array.from(allPix) }];
  }

  // Sort outers by area descending (largest first so outer shapes paint before inner islands)
  outers.sort((a, b) => b.area - a.area);
  const regionLoops: Loop[][] = outers.map((o) => [o]);

  for (const h of holes) {
    const hx = h.xs[0], hy = h.ys[0];
    const absHoleArea = Math.abs(h.area);
    let assigned = -1;
    // Search from smallest outer to largest outer that is strictly larger than the hole
    for (let i = outers.length - 1; i >= 0; i--) {
      if (outers[i].area > absHoleArea && pointInLoop(hx, hy, outers[i])) {
        assigned = i;
        break;
      }
    }
    if (assigned < 0) {
      let bestD = Infinity;
      for (let i = 0; i < outers.length; i++) {
        if (outers[i].area <= absHoleArea) continue;
        const [bx0, by0, bx1, by1] = outers[i].bbox;
        const cx = 0.5 * (bx0 + bx1), cy = 0.5 * (by0 + by1);
        const d = Math.hypot(hx - cx, hy - cy);
        if (d < bestD) { bestD = d; assigned = i; }
      }
    }
    regionLoops[Math.max(0, assigned)].push(h);
  }

  // Fast case: single outer loop
  if (outers.length === 1) {
    const allPix: number[] = [];
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const gi = (wy0 + y) * W + wx0 + x;
        if (rank[gi] === r) allPix.push(gi);
      }
    }
    return [{ id: 1, loops: regionLoops[0], pixels: Int32Array.from(allPix) }];
  }

  // Multiple outer loops: 4-connected component labeling on F >= 0.5
  const M = FW * FH;
  const compMap = new Int32Array(M);
  const queue = new Int32Array(M);
  const compPixels: number[][] = [];
  let nComp = 0;

  for (let i = 0; i < M; i++) {
    if (compMap[i] !== 0 || F[i] < 0.5) continue;
    nComp++;
    const cid = nComp;
    let qh = 0, qt = 0;
    queue[qt++] = i;
    compMap[i] = cid;
    const pixList: number[] = [];
    const fallbackPix: number[] = [];

    while (qh < qt) {
      const cur = queue[qh++];
      const cx = cur % FW, cy = (cur / FW) | 0;
      const gi = (wy0 + cy) * W + wx0 + cx;
      if (rank[gi] === r) {
        pixList.push(gi);
      } else if (fallbackPix.length < 24) {
        fallbackPix.push(gi);
      }
      if (cx > 0 && compMap[cur - 1] === 0 && F[cur - 1] >= 0.5) { compMap[cur - 1] = cid; queue[qt++] = cur - 1; }
      if (cx < FW - 1 && compMap[cur + 1] === 0 && F[cur + 1] >= 0.5) { compMap[cur + 1] = cid; queue[qt++] = cur + 1; }
      if (cy > 0 && compMap[cur - FW] === 0 && F[cur - FW] >= 0.5) { compMap[cur - FW] = cid; queue[qt++] = cur - FW; }
      if (cy < FH - 1 && compMap[cur + FW] === 0 && F[cur + FW] >= 0.5) { compMap[cur + FW] = cid; queue[qt++] = cur + FW; }
    }
    compPixels.push(pixList.length > 0 ? pixList : fallbackPix);
  }

  const regions: ConnectedRegion[] = [];
  for (let i = 0; i < outers.length; i++) {
    const o = outers[i];
    // Probe interior point using right-hand normal of first segment
    const x0 = o.xs[0] - wx0 - 0.5, y0 = o.ys[0] - wy0 - 0.5;
    const x1 = o.xs[1] - wx0 - 0.5, y1 = o.ys[1] - wy0 - 0.5;
    const dx = x1 - x0, dy = y1 - y0, dl = Math.hypot(dx, dy) || 1;
    // Right-hand side in screen coords (x right, y down) of (dx, dy) is (-dy, dx)
    const ix = Math.max(0, Math.min(FW - 1, Math.round(0.5 * (x0 + x1) - (dy / dl) * 0.45)));
    const iy = Math.max(0, Math.min(FH - 1, Math.round(0.5 * (y0 + y1) + (dx / dl) * 0.45)));
    let cid = compMap[iy * FW + ix];
    if (cid <= 0) {
      for (let dy2 = -1; dy2 <= 1 && cid <= 0; dy2++) {
        const yy = iy + dy2;
        if (yy < 0 || yy >= FH) continue;
        for (let dx2 = -1; dx2 <= 1 && cid <= 0; dx2++) {
          const xx = ix + dx2;
          if (xx < 0 || xx >= FW) continue;
          cid = compMap[yy * FW + xx];
        }
      }
    }
    const pix = cid > 0 ? compPixels[cid - 1] : [];
    if (pix.length === 0) {
      // Fallback: bbox scan for rank === r
      const [bx0, by0, bx1, by1] = o.bbox;
      const sx0 = Math.max(0, Math.floor(bx0)), sx1 = Math.min(W - 1, Math.ceil(bx1));
      const sy0 = Math.max(0, Math.floor(by0)), sy1 = Math.min(HFallback(W, rank.length) - 1, Math.ceil(by1));
      for (let y = sy0; y <= sy1; y++) {
        for (let x = sx0; x <= sx1; x++) {
          const gi = y * W + x;
          if (rank[gi] === r) pix.push(gi);
        }
      }
    }
    if (pix.length > 0) {
      regions.push({
        id: i + 1,
        loops: regionLoops[i],
        pixels: Int32Array.from(pix),
      });
    }
  }
  return regions;
}

function HFallback(W: number, N: number): number {
  return (N / W) | 0;
}
