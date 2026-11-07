import { loadImg } from "./run";
import { PNG } from "pngjs";
import fs from "fs";
const [a, b, out, x0, y0, w, h, z] = process.argv.slice(2);
const A = loadImg(a), B = loadImg(b);
const X0 = +x0, Y0 = +y0, Wd = +w, Hd = +h, Z = +z;
const p = new PNG({ width: Wd * Z * 3 + 8, height: Hd * Z });
p.data.fill(255);
for (let y = 0; y < Hd * Z; y++) for (let x = 0; x < Wd * Z; x++) {
  const sx = X0 + ((x / Z) | 0), sy = Y0 + ((y / Z) | 0);
  const i = (sy * A.width + sx) * 4;
  for (let c = 0; c < 3; c++) {
    const set = (col: number, v: number) => { p.data[(y * p.width + x + col * (Wd * Z + 4)) * 4 + c] = v; };
    set(0, A.data[i + c]); set(1, B.data[i + c]); set(2, Math.min(255, Math.abs(A.data[i + c] - B.data[i + c]) * 3));
  }
}
fs.writeFileSync(out, PNG.sync.write(p));
