import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import sampleUrl from "./assets/sample.jpg";
import { buildSvg, type Progress, type VectorOptions, type VectorResult } from "./engine/vectorize";
import { runVectorize } from "./engine/runner";

/* ------------------------------------------------------------------ */
/*  presets                                                            */
/* ------------------------------------------------------------------ */
const PRESETS: Record<string, { label: string; hint: string; o: VectorOptions }> = {
  anime: {
    label: "Pixel-perfect",
    hint: "Highest fidelity · 100 passes · exact contours",
    o: { maxColors: 32, iterations: 100, tolerance: 0.15, sigma: 0, cornerAngle: 70, minArea: 0.5, denoise: 0, detail: 1, scale: 1, underlap: 1, lloyd: 2, prune: 0, thin: 0.8, thinGate: 12 },
  },
  lineart: {
    label: "Ink & text",
    hint: "Lettering, hairlines, small type",
    o: { maxColors: 16, iterations: 100, tolerance: 0.12, sigma: 0, cornerAngle: 70, minArea: 0.25, denoise: 0, detail: 1, scale: 1, underlap: 1, lloyd: 2, prune: 0, thin: 1, thinGate: 12 },
  },
  max: {
    label: "Balanced",
    hint: "~60% smaller files, still crisp edges",
    o: { maxColors: 32, iterations: 60, tolerance: 0.3, sigma: 0, cornerAngle: 70, minArea: 1, denoise: 1, detail: 1, scale: 1, underlap: 1, lloyd: 2, prune: 4, thin: 0.8, thinGate: 12 },
  },
  fast: {
    label: "Quick draft",
    hint: "Tiny file, ~1-2 s",
    o: { maxColors: 16, iterations: 30, tolerance: 0.6, sigma: 0, cornerAngle: 70, minArea: 3, denoise: 1, detail: 1, scale: 1, underlap: 1, lloyd: 2, prune: 7, thin: 0.6, thinGate: 12 },
  },
};

const MAX_WORK_PIXELS = 2_000_000;

interface Source {
  url: string;
  name: string;
  w: number;
  h: number;
  img: HTMLImageElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("Could not decode image"));
    im.src = url;
  });
}

function fmtBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/* ------------------------------------------------------------------ */
/*  small UI atoms                                                     */
/* ------------------------------------------------------------------ */
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
  fmt?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-zinc-200">{props.label}</span>
        <span className="tabular-nums text-fuchsia-300">{props.fmt ? props.fmt(props.value) : props.value}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-fuchsia-500"
      />
      {props.hint && <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">{props.hint}</div>}
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-base font-semibold tabular-nums text-zinc-100">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function ConvergenceChart({ errors, colors, live }: { errors: number[]; colors: number[]; live?: boolean }) {
  const W = 300, H = 70;
  const n = 30;
  const maxE = Math.max(1, ...errors);
  const maxC = Math.max(1, ...colors);
  const bx = (i: number) => (i / (n - 1)) * (W - 8) + 4;
  const ePts = errors.map((e, i) => `${bx(i)},${H - 6 - (e / maxE) * (H - 14)}`).join(" ");
  const cPts = colors.map((c, i) => `${bx(i)},${H - 6 - (c / maxC) * (H - 14)}`).join(" ");
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Palette convergence {live && <span className="ml-1 animate-pulse text-fuchsia-400">● live</span>}</span>
        <span>
          <span className="text-fuchsia-400">━</span> ΔE error <span className="ml-2 text-cyan-400">╌</span> colours
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-zinc-800 bg-zinc-950">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="#27272a" strokeWidth="1" />
        ))}
        {cPts && <polyline points={cPts} fill="none" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="3 3" />}
        {ePts && <polyline points={ePts} fill="none" stroke="#e879f9" strokeWidth="2" strokeLinejoin="round" />}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [src, setSrc] = useState<Source | null>(null);
  const [preset, setPreset] = useState("anime");
  const [opts, setOpts] = useState<VectorOptions>(PRESETS.anime.o);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [liveErr, setLiveErr] = useState<number[]>([]);
  const [liveCols, setLiveCols] = useState<number[]>([]);
  const [result, setResult] = useState<VectorResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fidelity, setFidelity] = useState<{ psnr: number; sim: number } | null>(null);
  const [mode, setMode] = useState<"split" | "vector" | "original">("split");
  const [split, setSplit] = useState(50);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);

  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const fileRef = useRef<HTMLInputElement>(null);

  /* ---------- viewer state ---------- */
  const viewerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const base = src ? Math.min(box.w / src.w, box.h / src.h) * 0.96 : 1;
  const dispW = src ? src.w * base : 0;
  const dispH = src ? src.h * base : 0;

  const fit = useCallback(() => {
    setView({ z: 1, x: (box.w - dispW) / 2, y: (box.h - dispH) / 2 });
  }, [box, dispW, dispH]);

  const actual = () => {
    const z = 1 / base;
    setView({ z, x: (box.w - dispW * z) / 2, y: (box.h - dispH * z) / 2 });
  };

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [src]);

  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, box.w, box.h]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const nz = Math.max(0.2, Math.min(60, v.z * Math.exp(-e.deltaY * 0.0016)));
        const k = nz / v.z;
        return { z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [src]);

  /* ---------- file handling ---------- */
  const setImage = useCallback(async (url: string, name: string) => {
    try {
      const img = await loadImage(url);
      setSrc({ url, name, w: img.naturalWidth, h: img.naturalHeight, img });
      setResult(null);
      setFidelity(null);
      setHidden(new Set());
      setReveal(1000);
      setError(null);
      setLiveErr([]);
      setLiveCols([]);
      setProgress(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onFile = (f?: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("Please choose a PNG, JPG, WebP or GIF image.");
      return;
    }
    setImage(URL.createObjectURL(f), f.name);
  };

  /* ---------- run ---------- */
  const run = async () => {
    if (!src || busy) return;
    abortRef.current = { aborted: false };
    const sig = abortRef.current;
    setBusy(true);
    setError(null);
    setLiveErr([]);
    setLiveCols([]);
    setFidelity(null);
    const t0 = performance.now();
    try {
      let s = opts.scale;
      if (src.w * src.h * s * s > MAX_WORK_PIXELS) s = Math.sqrt(MAX_WORK_PIXELS / (src.w * src.h));
      const W = Math.max(8, Math.round(src.w * s));
      const H = Math.max(8, Math.round(src.h * s));
      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src.img, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H);
      const effScale = W / src.w;

      const errs: number[] = [];
      const cols: number[] = [];
      const res = await runVectorize(
        data,
        src.w,
        src.h,
        { ...opts, scale: effScale },
        (p) => {
          setProgress(p);
          if (p.iteration) {
            errs[p.iteration - 1] = p.error!;
            cols[p.iteration - 1] = p.colors!;
            setLiveErr([...errs]);
            setLiveCols([...cols]);
          }
        },
        sig
      );
      setElapsed((performance.now() - t0) / 1000);
      setHidden(new Set());
      setReveal(1000);
      setResult(res);
      setProgress({ phase: "Done", pct: 100 });
    } catch (e) {
      if ((e as Error).message !== "aborted") setError("Vectorisation failed: " + (e as Error).message);
      else setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    abortRef.current.aborted = true;
  };

  /* ---------- derived svg ---------- */
  const fullSvg = useMemo(() => (result ? buildSvg(result.width, result.height, result.background, result.layers) : ""), [result]);
  const deferredReveal = useDeferredValue(reveal);
  const viewSvg = useMemo(() => {
    if (!result) return "";
    const h = new Set(hidden);
    result.layers.forEach((l, i) => {
      if (i >= deferredReveal) h.add(l.id);
    });
    return h.size === 0 ? fullSvg : buildSvg(result.width, result.height, result.background, result.layers, h);
  }, [result, hidden, deferredReveal, fullSvg]);

  useEffect(() => {
    if (!viewSvg) {
      setSvgUrl(null);
      return;
    }
    const u = URL.createObjectURL(new Blob([viewSvg], { type: "image/svg+xml" }));
    setSvgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [viewSvg]);

  // fidelity measurement: rasterise the finished SVG and compare it with the source
  useEffect(() => {
    if (!result || !src || !fullSvg) return;
    let dead = false;
    (async () => {
      try {
        const u = URL.createObjectURL(new Blob([fullSvg], { type: "image/svg+xml" }));
        const im = await loadImage(u);
        const k = Math.min(1, 1600 / Math.max(src.w, src.h));
        const W = Math.round(src.w * k), H = Math.round(src.h * k);
        const mk = (draw: (c: CanvasRenderingContext2D) => void) => {
          const c = document.createElement("canvas");
          c.width = W;
          c.height = H;
          const x = c.getContext("2d", { willReadFrequently: true })!;
          x.fillStyle = "#fff";
          x.fillRect(0, 0, W, H);
          draw(x);
          return x.getImageData(0, 0, W, H).data;
        };
        const a = mk((x) => x.drawImage(src.img, 0, 0, W, H));
        const b = mk((x) => x.drawImage(im, 0, 0, W, H));
        URL.revokeObjectURL(u);
        let se = 0, ae = 0;
        const n = W * H * 3;
        for (let i = 0; i < a.length; i += 4)
          for (let c = 0; c < 3; c++) {
            const d = a[i + c] - b[i + c];
            se += d * d;
            ae += Math.abs(d);
          }
        const mse = se / n;
        if (!dead) setFidelity({ psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), sim: 100 * (1 - ae / n / 255) });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      dead = true;
    };
  }, [result, src, fullSvg]);

  const download = () => {
    if (!fullSvg || !src) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([fullSvg], { type: "image/svg+xml" }));
    a.download = src.name.replace(/\.[^.]+$/, "") + ".svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullSvg);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard not available — use Download instead.");
    }
  };

  const toggleLayer = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const applyPreset = (k: string) => {
    setPreset(k);
    setOpts(PRESETS[k].o);
  };
  const set = <K extends keyof VectorOptions>(k: K, v: VectorOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
    setPreset("custom");
  };

  /* ================================================================ */
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-200 lg:h-screen lg:overflow-hidden">
      {/* header */}
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-600 shadow-lg shadow-fuchsia-900/40">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
              <path d="M4 18C8 4 14 20 20 6" />
              <circle cx="4" cy="18" r="1.6" fill="white" />
              <circle cx="20" cy="6" r="1.6" fill="white" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">
              Vector<span className="text-fuchsia-400">Forge</span> <span className="font-normal text-zinc-500">Anime</span>
            </h1>
            <p className="mt-0.5 text-[11px] text-zinc-500">Sub-pixel coverage contours · seam-free underlap stacking · 100-pass CIELAB palette search</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 text-[11px] sm:flex">
          <span className="rounded-full border border-emerald-700/50 bg-emerald-950/50 px-2.5 py-1 text-emerald-300">
            0 embedded rasters · pure &lt;path&gt;
          </span>
          {src && (
            <button onClick={() => fileRef.current?.click()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800">
              Replace image
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ------------- sidebar ------------- */}
        <aside className="w-full shrink-0 space-y-5 overflow-y-auto border-b border-zinc-800 bg-zinc-900/40 p-4 lg:w-80 lg:border-b-0 lg:border-r">
          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Preset</h2>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(PRESETS).map(([k, p]) => (
                <button
                  key={k}
                  onClick={() => applyPreset(k)}
                  className={`rounded-lg border px-2.5 py-2 text-left transition ${
                    preset === k ? "border-fuchsia-500 bg-fuchsia-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-600"
                  }`}
                >
                  <div className="text-xs font-semibold text-zinc-100">{p.label}</div>
                  <div className="text-[10px] leading-tight text-zinc-500">{p.hint}</div>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-3.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Colour engine</h2>
            <Slider label="Refinement iterations" value={opts.iterations} min={10} max={100} step={5} onChange={(v) => set("iterations", v)} hint="Error-driven palette passes (split worst cluster → Lloyd polish). 100 = deepest search." />
            <Slider label="Palette ceiling" value={opts.maxColors} min={8} max={96} step={1} onChange={(v) => set("maxColors", v)} hint="Colours grow where the error is highest (shadows, skin tones, highlights)." />
            <Slider label="Detail focus" value={opts.detail} min={0} max={1} step={0.05} fmt={(v) => Math.round(v * 100) + "%"} onChange={(v) => set("detail", v)} hint="Boosts thin ink lines, eyelashes, fingers, text and glints in the palette search." />
            <Slider label="Denoise passes" value={opts.denoise} min={0} max={3} step={1} onChange={(v) => set("denoise", v)} hint="Edge-preserving; removes JPEG blocks without blurring lines." />
          </section>

          <section className="space-y-3.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Curve engine</h2>
            <Slider label="Curve tolerance" value={opts.tolerance} min={0.15} max={2} step={0.05} fmt={(v) => v.toFixed(2) + " px"} onChange={(v) => set("tolerance", v)} hint="Lower = more nodes, closer to the pixels." />
            <Slider label="Contour smoothing σ" value={opts.sigma} min={0} max={1} step={0.05} fmt={(v) => (v === 0 ? "off (exact)" : v.toFixed(2))} onChange={(v) => set("sigma", v)} hint="0 traces the exact sub-pixel coverage contour. Any blur rounds corners and thins hairlines." />
            <Slider label="Thin-stroke correction" value={opts.thin ?? 1} min={0} max={1.5} step={0.05} fmt={(v) => Math.round(v * 100) + "%"} onChange={(v) => set("thin", v)} hint="Mass-preserving iso-level: strokes narrower than a pixel keep their true weight (small text, hairlines)." />
            <Slider label="Anti-alias ramp pruning" value={opts.prune ?? 7} min={0} max={14} step={1} fmt={(v) => (v === 0 ? "off" : "ΔE " + v)} onChange={(v) => set("prune", v)} hint="Drops edge-blend colours so the renderer's own anti-aliasing rebuilds them – fewer layers, crisper edges." />
            <Slider label="Seam underlap" value={opts.underlap ?? 1} min={0} max={3} step={0.5} fmt={(v) => v + " px"} onChange={(v) => set("underlap", v)} hint="Each layer slips under the ones above it, so no hairline gaps ever show through." />
            <Slider label="Corner threshold" value={opts.cornerAngle} min={25} max={100} step={1} fmt={(v) => v + "°"} onChange={(v) => set("cornerAngle", v)} hint="Sharper than this stays a hard corner (hair tips, nails, bolts)." />
            <Slider label="Despeckle" value={opts.minArea} min={0} max={30} step={1} fmt={(v) => v + " px²"} onChange={(v) => set("minArea", v)} />
            <div>
              <div className="mb-1 text-xs font-medium text-zinc-200">Sub-pixel precision</div>
              <div className="grid grid-cols-2 gap-2">
                {[1, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => set("scale", s)}
                    className={`rounded-md border py-1.5 text-xs ${opts.scale === s ? "border-fuchsia-500 bg-fuchsia-500/10 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600"}`}
                  >
                    {s}× {s === 2 ? "(slower, not needed)" : "(recommended)"}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-[11px] leading-relaxed text-zinc-400">
            <div className="mb-1 font-semibold text-zinc-200">What actually happens</div>
            <ol className="list-decimal space-y-0.5 pl-4">
              <li>Optional edge-preserving denoise, CIELAB conversion</li>
              <li>{opts.iterations} passes: split worst cluster → Lloyd refine, then polished on every pixel</li>
              <li>Final labels + soft coverage fields in sRGB (how renderers blend anti-aliasing)</li>
              <li>Layers painted big → small, each slipping under the next: no seams, edges traced ~2×</li>
              <li>Thin strokes keep their true weight via a mass-preserving iso-level</li>
              <li>Sub-pixel iso-contours → corner-aware Schneider Bézier fit</li>
            </ol>
          </section>
        </aside>

        {/* ------------- main ------------- */}
        <main className="flex min-h-[70vh] min-w-0 flex-1 flex-col lg:min-h-0">
          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/30 px-3 py-2">
            <div className="flex overflow-hidden rounded-md border border-zinc-800 text-xs">
              {(["original", "split", "vector"] as const).map((m) => (
                <button
                  key={m}
                  disabled={!result && m !== "original"}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 capitalize disabled:opacity-30 ${mode === m ? "bg-fuchsia-600 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            {mode === "split" && result && (
              <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(+e.target.value)} className="w-32 accent-fuchsia-500" title="Compare slider" />
            )}
            <div className="ml-1 flex items-center gap-1 text-xs">
              <button onClick={fit} className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-800">Fit</button>
              <button onClick={actual} className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-zinc-400 hover:bg-zinc-800">100%</button>
              <span className="w-14 text-center tabular-nums text-zinc-500">{Math.round(view.z * base * 100)}%</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {busy ? (
                <button onClick={cancel} className="rounded-md border border-red-700 px-4 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-950">Cancel</button>
              ) : (
                <button
                  onClick={run}
                  disabled={!src}
                  className="rounded-md bg-gradient-to-r from-fuchsia-600 to-violet-600 px-5 py-1.5 text-xs font-bold text-white shadow-lg shadow-fuchsia-900/30 hover:brightness-110 disabled:opacity-30"
                >
                  {result ? "Re-vectorise" : "Vectorise"}
                </button>
              )}
              <button onClick={copy} disabled={!result} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-30">
                {copied ? "Copied ✓" : "Copy SVG"}
              </button>
              <button onClick={download} disabled={!result} className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-30">
                Download .svg
              </button>
            </div>
          </div>

          {/* progress */}
          {(busy || (progress && progress.pct < 100)) && progress && (
            <div className="border-b border-zinc-800 bg-zinc-900/60 px-4 py-2">
              <div className="mb-1 flex justify-between text-[11px]">
                <span className="text-zinc-300">{progress.phase}</span>
                <span className="tabular-nums text-fuchsia-300">
                  {progress.colors ? `${progress.colors} colours · ΔE ${progress.error?.toFixed(2)} · ` : ""}
                  {Math.round(progress.pct)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500 transition-all" style={{ width: progress.pct + "%" }} />
              </div>
            </div>
          )}
          {error && <div className="border-b border-red-900 bg-red-950/50 px-4 py-2 text-xs text-red-300">{error}</div>}

          {/* viewer */}
          <div
            ref={viewerRef}
            className={`relative min-h-[360px] flex-1 touch-none select-none overflow-hidden ${src ? "cursor-grab active:cursor-grabbing" : ""}`}
            style={{
              backgroundColor: "#0c0c0f",
              backgroundImage: "radial-gradient(#1f1f26 1px, transparent 1px)",
              backgroundSize: "18px 18px",
            }}
            onPointerDown={(e) => {
              if (!src) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
            }}
            onPointerUp={() => (drag.current = null)}
            onDoubleClick={fit}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onFile(e.dataTransfer.files?.[0]);
            }}
          >
            {!src && (
              <div className="absolute inset-0 grid place-items-center p-6">
                <div className={`w-full max-w-xl rounded-2xl border-2 border-dashed p-10 text-center transition ${dragOver ? "border-fuchsia-400 bg-fuchsia-500/10" : "border-zinc-700 bg-zinc-900/50"}`}>
                  <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500/20 to-violet-500/20 ring-1 ring-fuchsia-500/40">
                    <svg viewBox="0 0 24 24" className="h-7 w-7 text-fuchsia-300" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 16V4m0 0L7 9m5-5 5 5" />
                      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
                    </svg>
                  </div>
                  <h2 className="text-lg font-semibold text-white">Drop an anime frame, manga page or illustration</h2>
                  <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
                    Output is a real, editable stack of Bézier paths — never an embedded bitmap. Everything runs locally in your browser.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <button onClick={() => fileRef.current?.click()} className="rounded-lg bg-fuchsia-600 px-5 py-2 text-sm font-semibold text-white hover:bg-fuchsia-500">
                      Choose image
                    </button>
                    <button onClick={() => setImage(sampleUrl, "sample-anime.jpg")} className="rounded-lg border border-zinc-600 px-5 py-2 text-sm text-zinc-200 hover:bg-zinc-800">
                      Try the demo frame
                    </button>
                  </div>
                </div>
              </div>
            )}

            {src && (
              <div
                className="absolute left-0 top-0 origin-top-left will-change-transform"
                style={{ width: dispW, height: dispH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
              >
                <img src={src.url} alt="original" draggable={false} className="absolute inset-0 h-full w-full" style={{ imageRendering: view.z * base > 3 ? "pixelated" : "auto" }} />
                {result && svgUrl && mode !== "original" && (
                  <img
                    src={svgUrl}
                    alt="vector"
                    draggable={false}
                    className="absolute inset-0 h-full w-full"
                    style={{ clipPath: mode === "split" ? `inset(0 0 0 ${split}%)` : undefined, background: mode === "vector" ? "#fff" : undefined }}
                  />
                )}
                {result && mode === "split" && (
                  <div className="pointer-events-none absolute top-0 h-full bg-white shadow-[0_0_8px_rgba(0,0,0,0.8)]" style={{ left: split + "%", width: 1.5 / (view.z * base) * base }} />
                )}
              </div>
            )}

            {src && result && mode === "split" && (
              <>
                <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-2 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300">Original bitmap</span>
                <span className="pointer-events-none absolute right-3 top-3 rounded bg-fuchsia-700/90 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white">Vector</span>
              </>
            )}
            {src && !result && !busy && (
              <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-xs text-zinc-300">
                {src.w}×{src.h} loaded — press <b className="text-fuchsia-300">Vectorise</b>
              </div>
            )}
            {src && (
              <div className="pointer-events-none absolute bottom-3 right-3 rounded bg-black/60 px-2 py-0.5 text-[10px] text-zinc-500">scroll to zoom · drag to pan · double-click to fit</div>
            )}
          </div>

          {/* bottom panel */}
          {(result || busy) && (
            <div className="grid gap-4 border-t border-zinc-800 bg-zinc-900/40 p-4 lg:max-h-[38vh] lg:grid-cols-[1.1fr_1fr] lg:overflow-y-auto">
              <div className="space-y-3">
                {result && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                    <Stat label="Layers" value={String(result.layers.length + 1)} sub="stacked" />
                    <Stat label="Shapes" value={result.loops.toLocaleString()} sub="closed paths" />
                    <Stat label="Nodes" value={result.nodes.toLocaleString()} sub="Bézier segments" />
                    <Stat label="File size" value={fmtBytes(new Blob([fullSvg]).size)} />
                    <Stat label="PSNR" value={fidelity ? fidelity.psnr.toFixed(1) + " dB" : "…"} sub={fidelity ? fidelity.sim.toFixed(2) + "% similar" : "measuring"} />
                    <Stat label="Time" value={elapsed.toFixed(1) + " s"} />
                  </div>
                )}
                <ConvergenceChart errors={busy ? liveErr : result?.errors ?? liveErr} colors={busy ? liveCols : result?.colorHistory ?? liveCols} live={busy} />
                {result && (
                  <div>
                    <button onClick={() => setShowCode((s) => !s)} className="text-[11px] text-fuchsia-300 hover:underline">
                      {showCode ? "Hide" : "Show"} SVG source preview
                    </button>
                    {showCode && (
                      <pre className="mt-1 max-h-32 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[10px] leading-snug text-zinc-400">
                        {fullSvg.slice(0, 1800)}…
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {result && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
                    <span>Layer inspector · paint order ↑ light → dark</span>
                    <button onClick={() => { setHidden(new Set()); setReveal(1000); }} className="text-fuchsia-300 normal-case hover:underline">reset</button>
                  </div>
                  <label className="mb-2 block text-[11px] text-zinc-400">
                    Build-up scrubber ({Math.min(reveal, result.layers.length)}/{result.layers.length})
                    <input type="range" min={0} max={result.layers.length} value={Math.min(reveal, result.layers.length)} onChange={(e) => setReveal(+e.target.value)} className="mt-1 w-full accent-fuchsia-500" />
                  </label>
                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
                    <div className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px]">
                      <span className="h-4 w-4 rounded-sm ring-1 ring-white/20" style={{ background: result.background }} />
                      <span className="text-zinc-300">background</span>
                      <span className="ml-auto tabular-nums text-zinc-600">rect</span>
                    </div>
                    {result.layers.map((l, i) => {
                      const off = hidden.has(l.id) || i >= reveal;
                      return (
                        <button key={l.id} onClick={() => toggleLayer(l.id)} className={`flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-left text-[11px] hover:border-zinc-600 ${off ? "opacity-40" : ""}`}>
                          <span className="h-4 w-4 shrink-0 rounded-sm ring-1 ring-white/20" style={{ background: l.color }} />
                          <span className="font-mono text-zinc-300">{l.color}</span>
                          <span className="ml-auto tabular-nums text-zinc-600">{l.loops} · {l.nodes}n</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
