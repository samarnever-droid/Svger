// Colour-space helpers, Oklab/CIELAB perceptual metrics, lighting field estimators,
// and edge-preserving filters used by the vectoriser.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAP = 24389 / 27;

function f(t: number) {
  return t > EPS ? Math.cbrt(t) : (KAP * t + 16) / 116;
}

/** sRGB (0-255) → CIE L*a*b* written into out[o..o+2] */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const lr = LIN[r | 0], lg = LIN[g | 0], lb = LIN[b | 0];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / YN;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

/**
 * sRGB (0-255) → Oklab (scaled to CIELAB-comparable range: L*100, a*250, b*250)
 * Oklab eliminates CIELAB's blue-to-purple hue twist and improves skin/sky highlight uniformity.
 */
export function rgbToOklabScaled(r: number, g: number, b: number, out: Float32Array, o: number) {
  const lr = LIN[r | 0], lg = LIN[g | 0], lb = LIN[b | 0];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[o] = (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100;
  out[o + 1] = (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s) * 240;
  out[o + 2] = (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s) * 240;
}

/** Hybrid perceptual Lab (70% CIELAB + 30% scaled Oklab) for hue-true clustering */
export function rgbToPerceptualLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const lr = LIN[r | 0], lg = LIN[g | 0], lb = LIN[b | 0];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / YN;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  const cL = 116 * fy - 16;
  const cA = 500 * (fx - fy);
  const cB = 200 * (fy - fz);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const oL = (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100;
  const oA = (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s) * 240;
  const oB = (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s) * 240;

  out[o] = 0.7 * cL + 0.3 * oL;
  out[o + 1] = 0.7 * cA + 0.3 * oA;
  out[o + 2] = 0.7 * cB + 0.3 * oB;
}

export function hex(r: number, g: number, b: number) {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

export function parseHex(h: string): [number, number, number] {
  return [
    parseInt(h.slice(1, 3), 16) || 0,
    parseInt(h.slice(3, 5), 16) || 0,
    parseInt(h.slice(5, 7), 16) || 0,
  ];
}

/** Separable gaussian blur on a float field (edge clamped). */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * k[i + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * k[i + radius];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

/** Edge-preserving bilateral filter (kills JPEG noise, keeps line art). */
export function bilateral(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  sigmaS: number,
  sigmaR: number
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(src.length);
  const lut = new Float32Array(766);
  const s = sigmaR * 3;
  for (let i = 0; i < 766; i++) lut[i] = Math.exp(-(i * i) / (2 * s * s));
  const taps: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++)
      taps.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)) });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r0 = src[p], g0 = src[p + 1], b0 = src[p + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let t = 0; t < taps.length; t++) {
        const tp = taps[t];
        let xx = x + tp.dx, yy = y + tp.dy;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        const q = (yy * w + xx) * 4;
        const d = Math.abs(src[q] - r0) + Math.abs(src[q + 1] - g0) + Math.abs(src[q + 2] - b0);
        const wt = tp.w * lut[d];
        sr += src[q] * wt;
        sg += src[q + 1] * wt;
        sb += src[q + 2] * wt;
        sw += wt;
      }
      dst[p] = sr / sw;
      dst[p + 1] = sg / sw;
      dst[p + 2] = sb / sw;
      dst[p + 3] = 255;
    }
  }
  return dst;
}

/**
 * Iteration 10: Edge-Stopping Bilateral Label Regularization.
 * Eliminates isolated cross-region color bleed (such as a 4px background green spot
 * landing on a shaded lip or cheek) while preserving genuine high-contrast details
 * (eye catchlights, eyelashes, text, flower dots).
 */
export function regularizeLabels(
  labels: Uint16Array,
  px: Uint8ClampedArray,
  rgbc: Float64Array,
  w: number,
  h: number,
  maxIslandArea = 14,
  maxColorPenalty = 18
) {
  const N = w * h;
  const visited = new Uint8Array(N);
  const comp = new Int32Array(maxIslandArea + 2);
  const borderLabels = new Int32Array(64);
  const borderCounts = new Int32Array(64);

  for (let i = 0; i < N; i++) {
    if (visited[i]) continue;
    const lbl = labels[i];
    let head = 0, tail = 0;
    comp[tail++] = i;
    visited[i] = 1;
    let tooBig = false;

    while (head < tail) {
      const cur = comp[head++];
      const cx = cur % w, cy = (cur / w) | 0;
      const nb = [
        cx > 0 ? cur - 1 : -1,
        cx < w - 1 ? cur + 1 : -1,
        cy > 0 ? cur - w : -1,
        cy < h - 1 ? cur + w : -1,
      ];
      for (let d = 0; d < 4; d++) {
        const ni = nb[d];
        if (ni < 0) continue;
        if (labels[ni] === lbl) {
          if (!visited[ni]) {
            visited[ni] = 1;
            if (tail <= maxIslandArea) {
              comp[tail++] = ni;
            } else {
              tooBig = true;
            }
          }
        }
      }
      if (tooBig) {
        // Drain rest of component to mark visited
        const q = [cur];
        while (q.length > 0) {
          const c2 = q.pop()!;
          const x2 = c2 % w, y2 = (c2 / w) | 0;
          if (x2 > 0 && !visited[c2 - 1] && labels[c2 - 1] === lbl) { visited[c2 - 1] = 1; q.push(c2 - 1); }
          if (x2 < w - 1 && !visited[c2 + 1] && labels[c2 + 1] === lbl) { visited[c2 + 1] = 1; q.push(c2 + 1); }
          if (y2 > 0 && !visited[c2 - w] && labels[c2 - w] === lbl) { visited[c2 - w] = 1; q.push(c2 - w); }
          if (y2 < h - 1 && !visited[c2 + w] && labels[c2 + w] === lbl) { visited[c2 + w] = 1; q.push(c2 + w); }
        }
        break;
      }
    }

    if (tooBig || tail === 0 || tail > maxIslandArea) continue;

    // Collect surrounding neighbor labels and average pixel RGB of the island
    let nUnique = 0;
    let mr = 0, mg = 0, mb = 0;
    for (let c = 0; c < tail; c++) {
      const idx = comp[c];
      mr += px[idx * 4];
      mg += px[idx * 4 + 1];
      mb += px[idx * 4 + 2];
      const cx = idx % w, cy = (idx / w) | 0;
      const nb = [
        cx > 0 ? idx - 1 : -1,
        cx < w - 1 ? idx + 1 : -1,
        cy > 0 ? idx - w : -1,
        cy < h - 1 ? idx + w : -1,
      ];
      for (let d = 0; d < 4; d++) {
        const ni = nb[d];
        if (ni < 0) continue;
        const nl = labels[ni];
        if (nl !== lbl) {
          let found = -1;
          for (let u = 0; u < nUnique; u++) {
            if (borderLabels[u] === nl) { found = u; break; }
          }
          if (found >= 0) borderCounts[found]++;
          else if (nUnique < 64) {
            borderLabels[nUnique] = nl;
            borderCounts[nUnique] = 1;
            nUnique++;
          }
        }
      }
    }
    if (nUnique === 0) continue;
    mr /= tail;
    mg /= tail;
    mb /= tail;

    const curDist = Math.hypot(
      mr - rgbc[lbl * 3],
      mg - rgbc[lbl * 3 + 1],
      mb - rgbc[lbl * 3 + 2]
    );

    // Find best surrounding label
    let bestLbl = -1;
    let bestScore = Infinity;
    for (let u = 0; u < nUnique; u++) {
      const nl = borderLabels[u];
      const ndist = Math.hypot(
        mr - rgbc[nl * 3],
        mg - rgbc[nl * 3 + 1],
        mb - rgbc[nl * 3 + 2]
      );
      // Only absorb if the island's pixels are reasonably close to the neighbor color
      if (ndist - curDist <= maxColorPenalty && ndist <= 26) {
        const score = ndist - borderCounts[u] * 0.4;
        if (score < bestScore) {
          bestScore = score;
          bestLbl = nl;
        }
      }
    }

    if (bestLbl >= 0) {
      for (let c = 0; c < tail; c++) {
        labels[comp[c]] = bestLbl;
      }
    }
  }
}
