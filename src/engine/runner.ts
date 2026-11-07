import VectorWorker from "./worker?worker&inline";
import { vectorize, type Progress, type VectorOptions, type VectorResult } from "./vectorize";

/**
 * Runs the vectoriser in a Web Worker so the UI never freezes (and big images get a whole core).
 * Falls back to the main thread if workers are unavailable.
 */
export function runVectorize(
  img: ImageData,
  origW: number,
  origH: number,
  opts: VectorOptions,
  onProgress: (p: Progress) => void,
  sig: { aborted: boolean }
): Promise<VectorResult> {
  let worker: Worker;
  try {
    worker = new VectorWorker();
  } catch {
    return vectorize(img, origW, origH, opts, onProgress, sig);
  }
  return new Promise<VectorResult>((resolve, reject) => {
    const watch = setInterval(() => {
      if (sig.aborted) {
        clearInterval(watch);
        worker.terminate();
        reject(new Error("aborted"));
      }
    }, 80);
    const finish = () => {
      clearInterval(watch);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.p);
      else if (m.type === "done") {
        finish();
        resolve(m.res);
      } else if (m.type === "error") {
        finish();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || "worker crashed"));
    };
    const buffer = img.data.buffer.slice(0) as ArrayBuffer;
    worker.postMessage({ buffer, width: img.width, height: img.height, origW, origH, opts }, [buffer]);
  });
}
