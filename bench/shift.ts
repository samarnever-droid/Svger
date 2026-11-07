import { Resvg } from "@resvg/resvg-js";
import fs from "fs";
import { loadImg, metrics } from "./run";
const img = loadImg("bench/img/text.png");
const svg = fs.readFileSync("bench/out/png_x.svg", "utf8");
for (const dx of [-0.5, -0.25, 0, 0.25, 0.5]) for (const dy of [-0.5, 0, 0.5]) {
  const s = svg.replace(/(<rect id="background")/, `<g transform="translate(${dx} ${dy})">$1`).replace("</svg>", "</g></svg>");
  const o = new Resvg(s, { fitTo: { mode: "original" } }).render();
  const m = metrics(img.data, o.pixels, img.width, img.height);
  console.log(dx, dy, m.psnr.toFixed(2), m.de.toFixed(3));
}
