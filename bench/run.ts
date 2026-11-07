// Headless benchmark: vectorise -> rasterise with resvg -> compare with source.
//   npx tsx bench/run.ts <image> [key=value ...] [--save=name]
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import fs from "fs";
import { buildSvg, vectorize, type VectorOptions } from "../src/engine/vectorize";
import { rgbToLab } from "../src/engine/color";

export interface Img { data: Uint8ClampedArray; width: number; height: number }

export function loadImg(path: string): Img {
  const buf = fs.readFileSync(path);
  if (path.endsWith(".png")) {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
  }
  const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(d.data), width: d.width, height: d.height };
}

export function crop(img: Img, x0: number, y0: number, w: number, h: number): Img {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.width + x0 + x) * 4, d = (y * w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  return { data: out, width: w, height: h };
}

export function metrics(a: Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, w: number, h: number) {
  const N = w * h;
  let se = 0;
  const la = new Float32Array(3), lb = new Float32Array(3);
  const de: number[] = new Array(N);
  let sumDe = 0;
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) { const d = a[i * 4 + c] - b[i * 4 + c]; se += d * d; }
    rgbToLab(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], la, 0);
    rgbToLab(b[i * 4], b[i * 4 + 1], b[i * 4 + 2], lb, 0);
    const e = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
    de[i] = e; sumDe += e;
  }
  const mse = se / (N * 3);
  const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
  const sorted = Float32Array.from(de).sort();
  // SSIM on luma, 8x8 blocks, stride 4
  const Y = (p: Uint8Array | Uint8ClampedArray, i: number) => 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2];
  const C1 = 6.5025, C2 = 58.5225;
  let ss = 0, sc = 0;
  for (let by = 0; by + 8 <= h; by += 4)
    for (let bx = 0; bx + 8 <= w; bx += 4) {
      let ma = 0, mb = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = (by + y) * w + bx + x; ma += Y(a, i); mb += Y(b, i); }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cv = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = (by + y) * w + bx + x; const da = Y(a, i) - ma, db = Y(b, i) - mb;
        va += da * da; vb += db * db; cv += da * db;
      }
      va /= 63; vb /= 63; cv /= 63;
      ss += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); sc++;
    }
  return { psnr, de: sumDe / N, de95: sorted[Math.floor(N * 0.95)], de99: sorted[Math.floor(N * 0.99)], ssim: ss / sc };
}

export const BASE: VectorOptions = { maxColors: 48, iterations: 30, tolerance: 0.6, sigma: 0.6, cornerAngle: 50, minArea: 3, denoise: 1, detail: 0.7, scale: 1 };

export async function bench(img: Img, opts: VectorOptions, save?: string) {
  const t0 = performance.now();
  // mimic app: upscale by opts.scale with smooth (bilinear) sampling
  let work = img;
  if (opts.scale !== 1) work = resize(img, Math.round(img.width * opts.scale), Math.round(img.height * opts.scale));
  const res = await vectorize(
    { data: work.data, width: work.width, height: work.height, colorSpace: "srgb" } as ImageData,
    img.width, img.height, { ...opts, scale: work.width / img.width }, () => {}
  );
  const t = (performance.now() - t0) / 1000;
  const svg = buildSvg(res.width, res.height, res.background, res.layers);
  const out = new Resvg(svg, { fitTo: { mode: "original" } }).render();
  const m = metrics(img.data, out.pixels, img.width, img.height);
  if (save) {
    fs.mkdirSync("bench/out", { recursive: true });
    fs.writeFileSync(`bench/out/${save}.svg`, svg);
    fs.writeFileSync(`bench/out/${save}.png`, out.asPng());
  }
  return { ...m, kb: svg.length / 1024, nodes: res.nodes, layers: res.layers.length, t };
}

export function resize(img: Img, w: number, h: number): Img {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(img.height - 1.001, (y + 0.5) * (img.height / h) - 0.5));
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(img.width - 1.001, (x + 0.5) * (img.width / w) - 0.5));
      const x0 = Math.floor(sx), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => img.data[(yy * img.width + xx) * 4 + c];
        out[(y * w + x) * 4 + c] =
          p(y0, x0) * (1 - fx) * (1 - fy) + p(y0, x0 + 1) * fx * (1 - fy) + p(y0 + 1, x0) * (1 - fx) * fy + p(y0 + 1, x0 + 1) * fx * fy;
      }
      out[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const isMain = process.argv[1]?.endsWith("run.ts");
if (isMain) {
  (async () => {
    const [file, ...rest] = process.argv.slice(2);
    const opts: any = { ...BASE };
    let save: string | undefined;
    let cropArg: number[] | undefined;
    for (const kv of rest) {
      if (kv.startsWith("--save=")) save = kv.slice(7);
      else if (kv.startsWith("--crop=")) cropArg = kv.slice(7).split(",").map(Number);
      else { const [k, v] = kv.split("="); opts[k] = Number(v); }
    }
    let img = loadImg(file);
    if (cropArg) img = crop(img, cropArg[0], cropArg[1], cropArg[2], cropArg[3]);
    const r = await bench(img, opts, save);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(3)]))));
  })();
}
