// Coordinate-descent autotuner. Each evaluation = one "iteration".
//   npx tsx bench/tune.ts <maxEvalsThisRun>
// State lives in bench/tune-state.json so it can be resumed in batches.
import fs from "fs";
import { BASE, bench, crop, loadImg, type Img } from "./run";
import type { VectorOptions } from "../src/engine/vectorize";

const SET: { name: string; img: Img }[] = (() => {
  const photo = loadImg("public/sample.jpg");
  return [
    { name: "text", img: loadImg("bench/img/text.png") },
    { name: "face", img: crop(photo, 180, 130, 360, 360) },
    { name: "stairs", img: crop(photo, 330, 760, 360, 360) },
  ];
})();

const GRID: Record<string, (number | string)[]> = {
  maxColors: [24, 32, 48, 64, 96],
  tolerance: [0.15, 0.25, 0.35, 0.5],
  prune: [0, 4, 7, 11],
  thin: [0, 0.5, 0.8, 1, 1.2],
  minArea: [0, 0.5, 1, 2],
  denoise: [0, 1, 2],
  thinGate: [12, 24, 48],
  detail: [0.4, 0.7, 1],
  underlap: [1, 1.5, 2],
  cornerAngle: [40, 55, 70],
  sigma: [0, 0.25],
  iterations: [30, 60, 100],
  lloyd: [2, 4, 6],
};

const START: any = { ...BASE, maxColors: 32, tolerance: 0.3, sigma: 0, cornerAngle: 65, minArea: 1, denoise: 1, underlap: 1, order: "area", lloyd: 4, prune: 7, thin: 1, thinGate: 24 };
const STATE = "bench/tune-state.json";

async function evaluate(o: VectorOptions) {
  let q = 0, kb = 0, psnr = 0, ssim = 0, de99 = 0, t = 0;
  for (const s of SET) {
    const r = await bench(s.img, o);
    q += 0.5 * r.psnr + 40 * r.ssim - 0.1 * r.de99;
    kb += r.kb; psnr += r.psnr; ssim += r.ssim; de99 += r.de99; t += r.t;
  }
  const n = SET.length;
  // quality first, but doubling the file costs 1.5 points → efficiency matters
  const score = q / n - 1.5 * Math.log2(kb / n / 800);
  return { score, psnr: psnr / n, ssim: ssim / n, de99: de99 / n, kb: kb / n, t };
}

const maxEvals = Number(process.argv[2] ?? 30);
let st: any = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, "utf8"))
  : { best: START, bestScore: null, evals: 0, log: [], round: 0, pi: 0, vi: 0 };

const keys = Object.keys(GRID);
let done = 0;
if (st.bestScore === null) {
  const r = await evaluate(st.best);
  st.bestScore = r.score; st.evals++; done++;
  st.log.push({ n: st.evals, change: "baseline", ...r });
  console.log(`#${st.evals} baseline score=${r.score.toFixed(3)} psnr=${r.psnr.toFixed(2)} ssim=${r.ssim.toFixed(4)} de99=${r.de99.toFixed(1)} kb=${r.kb.toFixed(0)}`);
}
outer: while (st.round < 2) {
  while (st.pi < keys.length) {
    const key = keys[st.pi];
    const vals = GRID[key];
    while (st.vi < vals.length) {
      if (done >= maxEvals) break outer;
      const v = vals[st.vi++];
      if (st.best[key] === v) continue;
      const cand = { ...st.best, [key]: v };
      const r = await evaluate(cand);
      st.evals++; done++;
      const improved = r.score > st.bestScore + 1e-9;
      st.log.push({ n: st.evals, change: `${key}=${v}`, improved, ...r });
      console.log(`#${st.evals} ${key}=${v} score=${r.score.toFixed(3)} psnr=${r.psnr.toFixed(2)} ssim=${r.ssim.toFixed(4)} de99=${r.de99.toFixed(1)} kb=${r.kb.toFixed(0)} t=${r.t.toFixed(1)}s ${improved ? "★ improved" : ""}`);
      if (improved) { st.best = cand; st.bestScore = r.score; }
      fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
    }
    st.pi++; st.vi = 0;
  }
  st.round++; st.pi = 0; st.vi = 0;
}
fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
console.log("BEST", JSON.stringify(st.best), "score", st.bestScore.toFixed(3), "evals", st.evals);
