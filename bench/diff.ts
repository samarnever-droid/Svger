import { loadImg } from "./run";
import { PNG } from "pngjs";
import fs from "fs";
const [a, b, out] = process.argv.slice(2);
const A = loadImg(a), B = loadImg(b);
const p = new PNG({ width: A.width, height: A.height });
for (let i = 0; i < A.width * A.height; i++) {
  const e = Math.max(Math.abs(A.data[i*4]-B.data[i*4]), Math.abs(A.data[i*4+1]-B.data[i*4+1]), Math.abs(A.data[i*4+2]-B.data[i*4+2]));
  const v = Math.min(255, e * 3);
  p.data[i*4] = v; p.data[i*4+1] = v; p.data[i*4+2] = v; p.data[i*4+3] = 255;
}
fs.writeFileSync(out, PNG.sync.write(p));
