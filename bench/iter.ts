import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import fs from "fs";
import { loadImg, metrics, resize, type Img } from "./run";
import { buildSvg, vectorize, type VectorOptions } from "../src/engine/vectorize";
import { rgbToLab, gaussBlur } from "../src/engine/color";

export interface ImageBenchResult {
  name: string;
  psnr: number;
  ssim: number;
  de: number;
  de95: number;
  de99: number;
  spotDe: number; // Error specifically in smooth lighting / highlight zones
  colorAcc: number; // 0..100% perceptual & channel color accuracy
  kb: number;
  nodes: number;
  layers: number;
  tags: Record<string, number>;
  t: number;
}

/**
 * Computes lighting / white-spot specific ΔE in highlight & smooth illumination gradient regions.
 */
export function computeLightingSpotError(src: Uint8ClampedArray, rendered: Uint8Array | Uint8ClampedArray, w: number, h: number): { spotDe: number; colorAcc: number } {
  const N = w * h;
  const luma = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    luma[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
  }
  const smoothLuma = gaussBlur(luma, w, h, 3.0);

  const la = new Float32Array(3);
  const lb = new Float32Array(3);
  let spotErrSum = 0;
  let spotWeightSum = 0;
  let totalChannelDiff = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const dr = Math.abs(src[i * 4] - rendered[i * 4]);
      const dg = Math.abs(src[i * 4 + 1] - rendered[i * 4 + 1]);
      const db = Math.abs(src[i * 4 + 2] - rendered[i * 4 + 2]);
      totalChannelDiff += dr + dg + db;

      // High-luminance or smooth-gradient lighting region detector:
      const gx = Math.abs(luma[i + 1] - luma[i - 1]) * 0.5;
      const gy = Math.abs(luma[i + w] - luma[i - w]) * 0.5;
      const grad = Math.hypot(gx, gy);
      const isSmoothGrad = grad > 0.4 && grad < 14;
      const isHighlight = smoothLuma[i] > 175;
      if (isSmoothGrad || isHighlight) {
        const weight = (isHighlight ? 2.0 : 1.0) * (isSmoothGrad ? 1.5 : 1.0);
        rgbToLab(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], la, 0);
        rgbToLab(rendered[i * 4], rendered[i * 4 + 1], rendered[i * 4 + 2], lb, 0);
        const de = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
        spotErrSum += de * weight;
        spotWeightSum += weight;
      }
    }
  }

  const spotDe = spotWeightSum > 0 ? spotErrSum / spotWeightSum : 0;
  const maeNorm = totalChannelDiff / (N * 3 * 255);
  // Color accuracy percentage combining normalized RGB energy fidelity (1 - MSE/65025) and channel fidelity
  let se = 0;
  for (let i = 0; i < N * 4; i += 4) {
    const dr = src[i] - rendered[i];
    const dg = src[i + 1] - rendered[i + 1];
    const db = src[i + 2] - rendered[i + 2];
    se += dr * dr + dg * dg + db * db;
  }
  const mseNorm = se / (N * 3 * 255 * 255);
  const colorAcc = (1 - mseNorm * 0.5 - maeNorm * 0.1) * 100;
  return { spotDe, colorAcc };
}

export function countSvgTags(svg: string): Record<string, number> {
  const tags = [
    "svg", "defs", "linearGradient", "radialGradient", "stop",
    "filter", "feGaussianBlur", "feColorMatrix", "feComponentTransfer", "feComposite", "feBlend", "feMerge",
    "clipPath", "mask", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path"
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

export async function runIterationBench(iterId: string, opts: VectorOptions, subset?: string[]) {
  const names = subset ?? ["mikasa", "poster", "gta_map", "photo"];
  const results: ImageBenchResult[] = [];
  fs.mkdirSync(`bench/out/${iterId}`, { recursive: true });

  for (const name of names) {
    const img = loadImg(`bench/img/${name}.png`);

    const t0 = performance.now();
    let work = img;
    if (opts.scale !== 1) {
      work = resize(img, Math.round(img.width * opts.scale), Math.round(img.height * opts.scale));
    }
    const res = await vectorize(
      { data: work.data, width: work.width, height: work.height, colorSpace: "srgb" } as ImageData,
      img.width,
      img.height,
      { ...opts, scale: work.width / img.width },
      () => {}
    );
    const t = (performance.now() - t0) / 1000;
    const svg = buildSvg(res.width, res.height, res.background, res.layers, undefined, res);
    const out = new Resvg(svg, { fitTo: { mode: "original" } }).render();
    const pix = out.pixels;
    const m = metrics(img.data, pix, img.width, img.height);
    const { spotDe, colorAcc } = computeLightingSpotError(img.data, pix, img.width, img.height);
    const tags = countSvgTags(svg);

    fs.writeFileSync(`bench/out/${iterId}/${name}.svg`, svg);
    fs.writeFileSync(`bench/out/${iterId}/${name}.png`, out.asPng());

    // Save 4x amplified diff heatmap
    const diff = new PNG({ width: img.width, height: img.height });
    for (let i = 0; i < img.width * img.height; i++) {
      const dr = Math.abs(img.data[i * 4] - pix[i * 4]);
      const dg = Math.abs(img.data[i * 4 + 1] - pix[i * 4 + 1]);
      const db = Math.abs(img.data[i * 4 + 2] - pix[i * 4 + 2]);
      diff.data[i * 4] = Math.min(255, dr * 4);
      diff.data[i * 4 + 1] = Math.min(255, dg * 4);
      diff.data[i * 4 + 2] = Math.min(255, db * 4);
      diff.data[i * 4 + 3] = 255;
    }
    fs.writeFileSync(`bench/out/${iterId}/${name}_diff.png`, PNG.sync.write(diff));

    const item: ImageBenchResult = {
      name,
      psnr: +m.psnr.toFixed(3),
      ssim: +m.ssim.toFixed(4),
      de: +m.de.toFixed(3),
      de95: +m.de95.toFixed(3),
      de99: +m.de99.toFixed(3),
      spotDe: +spotDe.toFixed(3),
      colorAcc: +colorAcc.toFixed(4),
      kb: +(svg.length / 1024).toFixed(1),
      nodes: res.nodes,
      layers: res.layers.length,
      tags,
      t: +t.toFixed(2),
    };
    results.push(item);
  }

  const avg = {
    iterId,
    psnr: +(results.reduce((s, r) => s + r.psnr, 0) / results.length).toFixed(3),
    ssim: +(results.reduce((s, r) => s + r.ssim, 0) / results.length).toFixed(4),
    de: +(results.reduce((s, r) => s + r.de, 0) / results.length).toFixed(3),
    spotDe: +(results.reduce((s, r) => s + r.spotDe, 0) / results.length).toFixed(3),
    colorAcc: +(results.reduce((s, r) => s + r.colorAcc, 0) / results.length).toFixed(4),
    kb: +(results.reduce((s, r) => s + r.kb, 0) / results.length).toFixed(1),
    nodes: Math.round(results.reduce((s, r) => s + r.nodes, 0) / results.length),
  };
  console.log(`[${iterId}] AVG:`, JSON.stringify(avg));
  for (const r of results) {
    console.log(`  - ${r.name.padEnd(8)} psnr=${r.psnr}dB ssim=${r.ssim} de=${r.de} spotDe=${r.spotDe} acc=${r.colorAcc}% kb=${r.kb}KB nodes=${r.nodes} tags=${JSON.stringify(r.tags)}`);
  }
  return { avg, results };
}

const isMain = process.argv[1]?.endsWith("iter.ts");
if (isMain) {
  (async () => {
    const iterId = process.argv[2] || "iter00_baseline";
    const baseOpts: any = {
      maxColors: 32,
      iterations: 60,
      tolerance: 0.2,
      sigma: 0,
      cornerAngle: 70,
      minArea: 0.5,
      denoise: 0,
      detail: 1,
      scale: 1,
      underlap: 1,
      lloyd: 2,
      prune: 0,
      thin: 0.8,
      thinGate: 12,
    };
    await runIterationBench(iterId, baseOpts);
  })();
}
