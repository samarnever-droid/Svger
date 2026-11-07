import { loadImg, crop, metrics, resize } from "./run";
import { vectorize } from "../src/engine/vectorize";
const photo = loadImg("public/sample.jpg");
const img = crop(photo, 180, 130, 360, 360);
for (const mc of [32, 96, 160]) {
  const o: any = { maxColors: mc, iterations: 30, tolerance: 0.3, sigma: 0, cornerAngle: 65, minArea: 1, denoise: 1, detail: 0.7, scale: 1, underlap: 1, order: "area", lloyd: 4, debug: true };
  const r = await vectorize({ data: img.data, width: img.width, height: img.height } as any, img.width, img.height, o, () => {});
  const d = r.debug!;
  const out = new Uint8ClampedArray(img.data.length);
  const rgb = d.colors.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  for (let i = 0; i < d.W * d.H; i++) { const c = rgb[d.labels[i]]; out[i*4]=c[0]; out[i*4+1]=c[1]; out[i*4+2]=c[2]; out[i*4+3]=255; }
  const m = metrics(img.data, out, d.W, d.H);
  console.log(`maxColors=${mc} actual=${d.colors.length} layers=${r.layers.length} IDEAL-QUANT psnr=${m.psnr.toFixed(2)} de=${m.de.toFixed(2)} ssim=${m.ssim.toFixed(3)} nodes=${r.nodes}`);
}
