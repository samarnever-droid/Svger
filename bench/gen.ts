// Generates synthetic test images (text stress test) into bench/img/
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import fs from "fs";

fs.mkdirSync("bench/img", { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4efe6"/><stop offset="1" stop-color="#d9cdb8"/></linearGradient></defs>
<rect width="720" height="480" fill="url(#g)"/>
<text x="24" y="70" font-family="DejaVu Serif" font-weight="bold" font-size="56" fill="#1b1b1b">Pixel Perfect</text>
<text x="24" y="120" font-family="DejaVu Sans" font-size="30" fill="#2b2b2b">The quick brown fox jumps over</text>
<text x="24" y="156" font-family="DejaVu Sans" font-size="20" fill="#333">The quick brown fox jumps over the lazy dog 0123456789</text>
<text x="24" y="184" font-family="DejaVu Sans" font-size="14" fill="#333">The quick brown fox jumps over the lazy dog 0123456789</text>
<text x="24" y="206" font-family="DejaVu Sans" font-size="11" fill="#333">The quick brown fox jumps over the lazy dog 0123456789 — tiny text</text>
<text x="24" y="226" font-family="DejaVu Sans Mono" font-size="12" fill="#222">const svg = vectorize(img, {iterations: 100}); // mono</text>
<rect x="0" y="250" width="720" height="110" fill="#14213d"/>
<text x="24" y="305" font-family="DejaVu Sans" font-weight="bold" font-size="44" fill="#fca311">WHITE &amp; GOLD on NAVY</text>
<text x="24" y="340" font-family="DejaVu Serif" font-size="18" fill="#e5e5e5">Reversed text: sharp serifs &amp; thin hairlines must stay crisp.</text>
<text x="24" y="410" font-family="DejaVu Serif" font-style="italic" font-size="36" fill="#9d0208">Red italic Qgjpy &amp;@#%</text>
<circle cx="610" cy="420" r="40" fill="none" stroke="#111" stroke-width="1.5"/>
<path d="M540 380 L680 460" stroke="#111" stroke-width="1"/>
<path d="M560 460 Q620 380 690 400" stroke="#0a7" stroke-width="2" fill="none"/>
</svg>`;

const r = new Resvg(svg, { font: { loadSystemFonts: true }, fitTo: { mode: "original" } });
const png = r.render();
fs.writeFileSync("bench/img/text.png", png.asPng());
const enc = jpeg.encode({ data: Buffer.from(png.pixels), width: png.width, height: png.height }, 88);
fs.writeFileSync("bench/img/text.jpg", enc.data);
console.log("generated", png.width, png.height);
