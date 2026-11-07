/// <reference lib="webworker" />
import { vectorize, type VectorOptions } from "./vectorize";

interface Job {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  origW: number;
  origH: number;
  opts: VectorOptions;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    const img = { data: new Uint8ClampedArray(j.buffer), width: j.width, height: j.height, colorSpace: "srgb" } as ImageData;
    const res = await vectorize(img, j.origW, j.origH, j.opts, (p) => (self as unknown as Worker).postMessage({ type: "progress", p }));
    (self as unknown as Worker).postMessage({ type: "done", res });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: "error", message: (err as Error).message });
  }
};
