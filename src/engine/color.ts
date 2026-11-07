// Colour-space helpers + image filters used by the vectoriser.

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
  const lr = LIN[r], lg = LIN[g], lb = LIN[b];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / YN;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN;
  const fx = f(x), fy = f(y), fz = f(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

export function hex(r: number, g: number, b: number) {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
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
