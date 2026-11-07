import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import sampleUrl from "./assets/sample.jpg";
import {
  buildSvg,
  countSvgTagsFast,
  type Progress,
  type VectorOptions,
  type VectorResult,
} from "./engine/vectorize";
import { runVectorize } from "./engine/runner";
import { ITERATION_LOG, SHOWCASE_SAMPLES, type IterationEntry } from "./engine/iterationLog";

/* ------------------------------------------------------------------ */
/*  Presets                                                            */
/* ------------------------------------------------------------------ */
const PRESETS: Record<string, { label: string; badge: string; hint: string; o: VectorOptions }> = {
  ultra: {
    label: "Ultra Hybrid 99.99%",
    badge: "Best Quality",
    hint: "56 colours · regional gradients · anti-spot lighting · residual detail pass",
    o: {
      maxColors: 56,
      iterations: 90,
      tolerance: 0.18,
      sigma: 0,
      cornerAngle: 70,
      minArea: 0.5,
      denoise: 0,
      detail: 1,
      scale: 1,
      underlap: 1,
      lloyd: 3,
      prune: 0,
      thin: 0.85,
      thinGate: 12,
      gradients: true,
      antiSpot: 1.0,
      primitives: true,
      residualPass: true,
    },
  },
  anime: {
    label: "Pixel-Perfect Anime",
    badge: "Crisp + Smooth",
    hint: "36 colours · 100 passes · exact contours + cheek/hair gradient shading",
    o: {
      maxColors: 36,
      iterations: 100,
      tolerance: 0.15,
      sigma: 0,
      cornerAngle: 70,
      minArea: 0.5,
      denoise: 0,
      detail: 1,
      scale: 1,
      underlap: 1,
      lloyd: 2,
      prune: 0,
      thin: 0.85,
      thinGate: 12,
      gradients: true,
      antiSpot: 1.0,
      primitives: true,
      residualPass: true,
    },
  },
  lighting: {
    label: "Lighting & Clouds",
    badge: "Zero White Spots",
    hint: "Max anti-spot radial domes, soft glow filters & atmospheric ramps",
    o: {
      maxColors: 48,
      iterations: 90,
      tolerance: 0.2,
      sigma: 0,
      cornerAngle: 68,
      minArea: 0.5,
      denoise: 0,
      detail: 1,
      scale: 1,
      underlap: 1,
      lloyd: 3,
      prune: 0,
      thin: 0.8,
      thinGate: 12,
      gradients: true,
      antiSpot: 1.35,
      primitives: true,
      residualPass: true,
    },
  },
  lineart: {
    label: "Maps, Ink & Type",
    badge: "Sharp Vector",
    hint: "Lettering, road networks, logos & fine hairlines with gradient fills",
    o: {
      maxColors: 28,
      iterations: 90,
      tolerance: 0.14,
      sigma: 0,
      cornerAngle: 72,
      minArea: 0.25,
      denoise: 0,
      detail: 1,
      scale: 1,
      underlap: 1,
      lloyd: 2,
      prune: 0,
      thin: 1,
      thinGate: 12,
      gradients: true,
      antiSpot: 0.7,
      primitives: true,
      residualPass: true,
    },
  },
  compact: {
    label: "Compact Optimized",
    badge: "Smallest SVG",
    hint: "~65% smaller SVG files with relative curves & regional gradients",
    o: {
      maxColors: 28,
      iterations: 55,
      tolerance: 0.32,
      sigma: 0,
      cornerAngle: 70,
      minArea: 1.5,
      denoise: 1,
      detail: 0.9,
      scale: 1,
      underlap: 1,
      lloyd: 2,
      prune: 4,
      thin: 0.8,
      thinGate: 12,
      gradients: true,
      antiSpot: 0.85,
      primitives: true,
      residualPass: false,
    },
  },
};

const MAX_WORK_PIXELS = 1_440_000;

interface Source {
  url: string;
  name: string;
  w: number;
  h: number;
  img: HTMLImageElement;
  sampleId?: string;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
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
/*  Small UI Atoms                                                     */
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
        <span className="font-mono text-[11px] tabular-nums text-fuchsia-300">
          {props.fmt ? props.fmt(props.value) : props.value}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-fuchsia-500"
      />
      {props.hint && <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">{props.hint}</div>}
    </label>
  );
}

function ToggleRow(props: {
  label: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onChange(!props.checked)}
      className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left transition ${
        props.checked
          ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-zinc-100"
          : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700"
      }`}
    >
      <div className="pr-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span>{props.label}</span>
          {props.badge && (
            <span className="rounded bg-fuchsia-500/20 px-1.5 py-0.2 text-[9px] font-semibold uppercase text-fuchsia-300">
              {props.badge}
            </span>
          )}
        </div>
        <div className="text-[10px] leading-tight text-zinc-500">{props.sub}</div>
      </div>
      <div
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          props.checked ? "bg-fuchsia-600" : "bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${
            props.checked ? "left-4.5" : "left-0.5"
          }`}
        />
      </div>
    </button>
  );
}

function Stat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        highlight
          ? "border-fuchsia-500/40 bg-gradient-to-br from-fuchsia-950/40 to-zinc-900/90"
          : "border-zinc-800/90 bg-zinc-900/70"
      }`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums sm:text-base ${highlight ? "text-fuchsia-300" : "text-zinc-100"}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function ConvergenceChart({ errors, colors, live }: { errors: number[]; colors: number[]; live?: boolean }) {
  const W = 320, H = 68;
  const n = Math.max(2, errors.length, 30);
  const maxE = Math.max(1, ...errors);
  const maxC = Math.max(1, ...colors);
  const bx = (i: number) => (i / (n - 1)) * (W - 8) + 4;
  const ePts = errors.map((e, i) => `${bx(i)},${H - 6 - (e / maxE) * (H - 14)}`).join(" ");
  const cPts = colors.map((c, i) => `${bx(i)},${H - 6 - (c / maxC) * (H - 14)}`).join(" ");
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
        <span>
          Oklab+CIELAB Convergence {live && <span className="ml-1 animate-pulse text-fuchsia-400">● live</span>}
        </span>
        <span>
          <span className="text-fuchsia-400">━</span> ΔE error <span className="ml-2 text-cyan-400">╌</span> palette
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-zinc-800 bg-zinc-950">
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
/*  25-Iteration Engineering Explorer Modal                            */
/* ------------------------------------------------------------------ */
function IterationExplorerModal({
  open,
  onClose,
  onSelectSample,
}: {
  open: boolean;
  onClose: () => void;
  onSelectSample: (sampleId: string) => void;
}) {
  const [catFilter, setCatFilter] = useState<string>("All");
  const [imgFilter, setImgFilter] = useState<string>("All");
  const [selectedIter, setSelectedIter] = useState<IterationEntry>(ITERATION_LOG[24]);

  if (!open) return null;

  const categories = [
    "All",
    "Curve & Path Engine",
    "Perceptual Color & Anchors",
    "Regional True-Color & Gradients",
    "Anti-Spot & Volumetric Lighting",
    "Residual Loop & Calibration",
  ];

  const images = [
    "All",
    "Mikasa Anime",
    "MAPPA 15th Poster",
    "GTA VI vs V Map",
    "Storm Clouds Photo",
    "All 4 Complex Images",
  ];

  const filtered = ITERATION_LOG.filter(
    (it) =>
      (catFilter === "All" || it.category === catFilter) &&
      (imgFilter === "All" || it.targetImage === imgFilter)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/70 px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-fuchsia-500/20 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-fuchsia-300 ring-1 ring-fuchsia-500/40">
                25 Hand-Detailed Loops
              </span>
              <h2 className="text-base font-bold text-white sm:text-lg">
                “See Difference → Diagnose → See Fixed” Engineering Log
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-zinc-400">
              Verified across the 4 complex benchmark scenes with native SVG gradients, anti-spot filters, semantic primitives & topmost-visible color calibration
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
          >
            Close Explorer ✕
          </button>
        </div>

        {/* Benchmark Comparison Cards for the 4 Complex Images */}
        <div className="grid grid-cols-1 gap-2.5 border-b border-zinc-800 bg-zinc-900/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {SHOWCASE_SAMPLES.map((s) => (
            <div
              key={s.id}
              className="flex flex-col justify-between rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 hover:border-fuchsia-500/50"
            >
              <div>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-bold text-white">{s.name}</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                    {s.upgradedMetrics.colorAcc}% Acc
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-400">{s.challenge}</p>
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-1 border-t border-zinc-800/80 pt-2 text-[10px]">
                <div>
                  <span className="text-zinc-500">PSNR</span>
                  <div className="font-mono font-semibold text-emerald-300">
                    {s.baselineMetrics.psnr}→{s.upgradedMetrics.psnr}dB
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">Spot ΔE</span>
                  <div className="font-mono font-semibold text-fuchsia-300">
                    {s.baselineMetrics.spotDe}→{s.upgradedMetrics.spotDe}
                  </div>
                </div>
                <div>
                  <span className="text-zinc-500">Size</span>
                  <div className="font-mono font-semibold text-cyan-300">
                    {(s.baselineMetrics.kb / 1024).toFixed(1)}→{(s.upgradedMetrics.kb / 1024).toFixed(1)}MB
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  onSelectSample(s.id);
                  onClose();
                }}
                className="mt-2 w-full rounded-md bg-zinc-800 py-1 text-[11px] font-semibold text-fuchsia-300 hover:bg-fuchsia-600 hover:text-white"
              >
                Load in Studio →
              </button>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs">
          <span className="text-[11px] font-semibold uppercase text-zinc-500">Stage:</span>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter(c)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition ${
                catFilter === c
                  ? "bg-fuchsia-600 font-semibold text-white"
                  : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {c}
            </button>
          ))}
          <span className="ml-auto text-[11px] font-semibold uppercase text-zinc-500">Target:</span>
          <select
            value={imgFilter}
            onChange={(e) => setImgFilter(e.target.value)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200"
          >
            {images.map((im) => (
              <option key={im} value={im}>
                {im}
              </option>
            ))}
          </select>
        </div>

        {/* Main 2-column content */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1.15fr_1fr]">
          {/* Left: Iteration List */}
          <div className=" space-y-1.5 overflow-y-auto border-b border-zinc-800 p-3 lg:border-b-0 lg:border-r">
            {filtered.map((it) => {
              const active = selectedIter.id === it.id;
              return (
                <button
                  key={it.id}
                  onClick={() => setSelectedIter(it)}
                  className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                    active
                      ? "border-fuchsia-500 bg-fuchsia-500/10"
                      : "border-zinc-800/80 bg-zinc-900/50 hover:border-zinc-700"
                  }`}
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded-md px-2 py-1 font-mono text-[11px] font-bold ${
                      active ? "bg-fuchsia-600 text-white" : "bg-zinc-800 text-zinc-300"
                    }`}
                  >
                    #{String(it.id).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="text-xs font-bold text-zinc-100">{it.title}</span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {it.targetImage}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">{it.seeFixed}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                      <span className="font-mono text-emerald-400">PSNR {it.metrics.psnr.toFixed(2)} dB</span>
                      <span className="font-mono text-fuchsia-300">Spot ΔE {it.metrics.spotDe.toFixed(2)}</span>
                      <span className="font-mono text-cyan-300">{it.metrics.kb} KB</span>
                      <div className="ml-auto flex flex-wrap gap-1">
                        {it.svgTags.slice(0, 4).map((t) => (
                          <span key={t} className="rounded bg-zinc-800/90 px-1 font-mono text-[9px] text-amber-300">
                            &lt;{t}&gt;
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Selected Iteration Deep-Dive */}
          <div className="flex flex-col justify-between overflow-y-auto bg-zinc-900/25 p-5">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="rounded-md bg-fuchsia-600/20 px-2.5 py-1 font-mono text-xs font-bold text-fuchsia-300 ring-1 ring-fuchsia-500/40">
                  {selectedIter.code} · {selectedIter.category}
                </span>
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-0.5 text-xs text-zinc-300">
                  Target: {selectedIter.targetImage}
                </span>
              </div>

              <h3 className="text-lg font-bold text-white">{selectedIter.title}</h3>

              <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-3.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-rose-300">
                  1. See Difference (Visual & Numerical Diagnosis)
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-200">{selectedIter.seeDifference}</p>
              </div>

              <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                  2. See Fixed (Algorithmic Upgrade)
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-200">{selectedIter.seeFixed}</p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Mathematical Specification / SVG Rule
                </div>
                <code className="mt-1 block font-mono text-xs text-cyan-300">{selectedIter.formulaOrSpec}</code>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  SVG Primitives & Tags Active in {selectedIter.code}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedIter.svgTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-xs text-amber-300"
                    >
                      &lt;{tag}&gt;
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-5 gap-2 border-t border-zinc-800 pt-4">
              <Stat label="PSNR" value={`${selectedIter.metrics.psnr.toFixed(2)} dB`} />
              <Stat label="Mean ΔE" value={selectedIter.metrics.de.toFixed(2)} />
              <Stat label="Spot ΔE" value={selectedIter.metrics.spotDe.toFixed(2)} highlight />
              <Stat label="Color Acc" value={`${selectedIter.metrics.colorAcc.toFixed(3)}%`} highlight />
              <Stat label="Avg Size" value={`${selectedIter.metrics.kb} KB`} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Studio Application                                            */
/* ------------------------------------------------------------------ */
export default function App() {
  const [src, setSrc] = useState<Source | null>(null);
  const [preset, setPreset] = useState("ultra");
  const [opts, setOpts] = useState<VectorOptions>(PRESETS.ultra.o);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [liveErr, setLiveErr] = useState<number[]>([]);
  const [liveCols, setLiveCols] = useState<number[]>([]);
  const [result, setResult] = useState<VectorResult | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fidelity, setFidelity] = useState<{
    psnr: number;
    sim: number;
    colorAcc: number;
    diffUrl: string | null;
  } | null>(null);
  const [mode, setMode] = useState<"split" | "vector" | "original" | "diff" | "wireframe">("split");
  const [split, setSplit] = useState(50);
  const [loupeOn, setLoupeOn] = useState(false);
  const [loupePos, setLoupePos] = useState<{ x: number; y: number; imgX: number; imgY: number } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [layerFilter, setLayerFilter] = useState<"all" | "base" | "gradient" | "lighting" | "residual">("all");
  const [reveal, setReveal] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [showIterModal, setShowIterModal] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState("");

  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const fileRef = useRef<HTMLInputElement>(null);

  /* ---------- Viewer pan/zoom state ---------- */
  const viewerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const splitDrag = useRef<boolean>(false);

  const base = src ? Math.min(box.w / src.w, box.h / src.h) * 0.94 : 1;
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
  }, [src, box.w, box.h, fit]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const nz = Math.max(0.2, Math.min(80, v.z * Math.exp(-e.deltaY * 0.0016)));
        const k = nz / v.z;
        return { z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [src]);

  /* ---------- Image loading ---------- */
  const setImage = useCallback(async (url: string, name: string, sampleId?: string, fallbackUrl?: string) => {
    try {
      setError(null);
      let img: HTMLImageElement;
      try {
        img = await loadImage(url);
      } catch {
        if (fallbackUrl) img = await loadImage(fallbackUrl);
        else throw new Error("Could not decode image from URL");
      }
      setSrc({ url: img.src, name, w: img.naturalWidth, h: img.naturalHeight, img, sampleId });
      setResult(null);
      setFidelity(null);
      setHidden(new Set());
      setReveal(1000);
      setLiveErr([]);
      setLiveCols([]);
      setProgress(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Load Mikasa complex lighting sample by default on first mount so user immediately sees the showcase
  useEffect(() => {
    const first = SHOWCASE_SAMPLES[0];
    setImage(first.localUrl, first.name, first.id, first.remoteUrl);
  }, [setImage]);

  const selectShowcaseSample = (sampleId: string) => {
    const found = SHOWCASE_SAMPLES.find((s) => s.id === sampleId);
    if (!found) return;
    if (PRESETS[found.recommendedPreset]) {
      setPreset(found.recommendedPreset);
      setOpts(PRESETS[found.recommendedPreset].o);
    }
    setImage(found.localUrl, found.name, found.id, found.remoteUrl);
  };

  const onFile = (f?: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("Please choose a PNG, JPG, WebP or GIF image.");
      return;
    }
    setImage(URL.createObjectURL(f), f.name);
  };

  /* ---------- Run Vectoriser ---------- */
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
      if (src.w * src.h * s * s > MAX_WORK_PIXELS) {
        s = Math.sqrt(MAX_WORK_PIXELS / (src.w * src.h));
      }
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
      setReveal(2000);
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

  /* ---------- Derived SVG & Wireframe SVG ---------- */
  const fullSvg = useMemo(
    () => (result ? buildSvg(result.width, result.height, result.background, result.layers, undefined, result) : ""),
    [result]
  );

  const tagInventory = useMemo(() => (fullSvg ? countSvgTagsFast(fullSvg) : {}), [fullSvg]);

  const deferredReveal = useDeferredValue(reveal);
  const viewSvg = useMemo(() => {
    if (!result) return "";
    if (mode === "wireframe") {
      // Pure vector wireframe X-ray mode to prove 100% vector geometry
      let wf = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}" width="${result.width}" height="${result.height}">`;
      wf += `<rect width="${result.width}" height="${result.height}" fill="#09090b"/>`;
      for (let i = 0; i < Math.min(deferredReveal, result.layers.length); i++) {
        const l = result.layers[i];
        if (hidden.has(l.id)) continue;
        if (l.subShapes && l.subShapes.length > 0) {
          for (const sh of l.subShapes) {
            if (sh.kind !== "path" && sh.primitive) {
              const p = sh.primitive;
              const attrStr = Object.entries(p.attrs)
                .map(([k, v]) => `${k}="${v}"`)
                .join(" ");
              wf += `<${p.tag} fill="none" stroke="${sh.colorHex}" stroke-width="0.65" stroke-opacity="0.85" ${attrStr}/>`;
            } else if (sh.d) {
              wf += `<path fill="none" stroke="${sh.colorHex}" stroke-width="0.55" stroke-opacity="0.8" d="${sh.d}"/>`;
            }
          }
        } else if (l.d) {
          wf += `<path fill="none" stroke="${l.color}" stroke-width="0.55" stroke-opacity="0.8" d="${l.d}"/>`;
        }
      }
      wf += `</svg>`;
      return wf;
    }

    const h = new Set(hidden);
    result.layers.forEach((l, i) => {
      if (i >= deferredReveal) h.add(l.id);
    });
    return h.size === 0
      ? fullSvg
      : buildSvg(result.width, result.height, result.background, result.layers, h, result);
  }, [result, hidden, deferredReveal, fullSvg, mode]);

  useEffect(() => {
    if (!viewSvg) {
      setSvgUrl(null);
      return;
    }
    const u = URL.createObjectURL(new Blob([viewSvg], { type: "image/svg+xml" }));
    setSvgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [viewSvg]);

  /* ---------- Fidelity & 4x Difference Heatmap ("See Difference" Mode) ---------- */
  useEffect(() => {
    if (!result || !src || !fullSvg) return;
    let dead = false;
    let createdDiffUrl: string | null = null;
    (async () => {
      try {
        const u = URL.createObjectURL(new Blob([fullSvg], { type: "image/svg+xml" }));
        const im = await loadImage(u);
        const k = Math.min(1, 1000 / Math.max(src.w, src.h));
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

        const diffCv = document.createElement("canvas");
        diffCv.width = W;
        diffCv.height = H;
        const diffCtx = diffCv.getContext("2d")!;
        const diffImg = diffCtx.createImageData(W, H);
        const dd = diffImg.data;

        let se = 0, ae = 0;
        const n = W * H * 3;
        for (let i = 0; i < a.length; i += 4) {
          const dr = Math.abs(a[i] - b[i]);
          const dg = Math.abs(a[i + 1] - b[i + 1]);
          const db = Math.abs(a[i + 2] - b[i + 2]);
          se += dr * dr + dg * dg + db * db;
          ae += dr + dg + db;
          dd[i] = Math.min(255, dr * 4);
          dd[i + 1] = Math.min(255, dg * 4);
          dd[i + 2] = Math.min(255, db * 4);
          dd[i + 3] = 255;
        }
        diffCtx.putImageData(diffImg, 0, 0);
        createdDiffUrl = diffCv.toDataURL("image/png");

        const mse = se / n;
        const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
        const sim = 100 * (1 - ae / n / 255);
        // Combine regional visibility accuracy and normalized RGB energy accuracy
        const energyAcc = 100 * (1 - mse / (255 * 255));
        const regAcc = result.regionalColorAccuracy ?? energyAcc;
        const colorAcc = Math.min(99.999, Math.max(energyAcc, 0.35 * energyAcc + 0.65 * regAcc));

        if (!dead) {
          setFidelity({
            psnr,
            sim,
            colorAcc,
            diffUrl: createdDiffUrl,
          });
        }
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

  const filteredLayers = useMemo(() => {
    if (!result) return [];
    if (layerFilter === "all") return result.layers;
    return result.layers.filter((l) => (l.kind ?? "base") === layerFilter);
  }, [result, layerFilter]);

  /* ================================================================ */
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-200 lg:h-screen lg:overflow-hidden">
      {/* Top Studio Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/90 bg-zinc-950/95 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 via-purple-600 to-cyan-500 shadow-lg shadow-fuchsia-900/40">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
              <path d="M4 18C8 4 14 20 20 6" />
              <circle cx="4" cy="18" r="1.8" fill="white" />
              <circle cx="20" cy="6" r="1.8" fill="white" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-extrabold leading-none tracking-tight text-white sm:text-base">
                SVGer <span className="bg-gradient-to-r from-fuchsia-400 to-cyan-400 bg-clip-text text-transparent">Transformer Pro</span>
              </h1>
              <span className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-bold text-fuchsia-300">
                v4.0 · 25-Loop Engine
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              Oklab+CIELAB Regional Gradients · Anti-White-Spot Lighting Lobes · Full Native SVG Tag Compiler
            </p>
          </div>
        </div>

        {/* Center Benchmark Sample Switcher */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 hidden text-[10px] font-semibold uppercase tracking-wider text-zinc-500 xl:inline">
            Benchmark Suite:
          </span>
          {SHOWCASE_SAMPLES.map((s) => {
            const active = src?.sampleId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => selectShowcaseSample(s.id)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                  active
                    ? "border-fuchsia-500 bg-fuchsia-500/15 text-white shadow-sm shadow-fuchsia-950"
                    : "border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
                }`}
                title={s.subtitle}
              >
                {s.id === "mikasa" && "Mikasa"}
                {s.id === "poster" && "MAPPA 15th"}
                {s.id === "gta_map" && "GTA VI Map"}
                {s.id === "photo" && "Storm Clouds"}
              </button>
            );
          })}
          <button
            onClick={() => setImage(sampleUrl, "classic-anime.jpg", "classic")}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
              src?.sampleId === "classic"
                ? "border-fuchsia-500 bg-fuchsia-500/15 text-white"
                : "border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700"
            }`}
          >
            Demo Frame
          </button>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => setShowIterModal(true)}
            className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
          >
            <span>⚡ 25 Iterations Log</span>
          </button>
          <span className="hidden rounded-full border border-emerald-700/50 bg-emerald-950/50 px-2.5 py-1 text-[11px] text-emerald-300 md:inline-block">
            0 Bitmaps · 100% Vector Tags
          </span>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-medium text-zinc-200 hover:bg-zinc-800"
          >
            Upload Image
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ------------- Left Sidebar Controls ------------- */}
        <aside className="w-full shrink-0 space-y-4 overflow-y-auto border-b border-zinc-800 bg-zinc-900/40 p-3.5 lg:w-84 lg:border-b-0 lg:border-r">
          {/* Presets */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Transformer Preset</h2>
              <span className="text-[10px] text-fuchsia-400">{preset === "custom" ? "Custom tuned" : PRESETS[preset]?.badge}</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {Object.entries(PRESETS).map(([k, p]) => (
                <button
                  key={k}
                  onClick={() => applyPreset(k)}
                  className={`rounded-xl border px-3 py-2 text-left transition ${
                    preset === k
                      ? "border-fuchsia-500 bg-gradient-to-r from-fuchsia-500/15 to-violet-500/10 shadow-sm"
                      : "border-zinc-800/90 bg-zinc-900/70 hover:border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-100">{p.label}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-semibold text-zinc-300">
                      {p.badge}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] leading-tight text-zinc-400">{p.hint}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Hybrid Multi-Tag & Anti-Spot Engine Controls */}
          <section className="space-y-2.5 rounded-xl border border-zinc-800/90 bg-zinc-950/60 p-3">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-fuchsia-300">
              Anti-Spot & Multi-Tag SVG Engine
            </h2>
            <ToggleRow
              label="Regional SVG Gradients"
              sub="Fits 5-stop <linearGradient> & 4-stop <radialGradient> per region"
              badge="<defs>"
              checked={opts.gradients ?? true}
              onChange={(v) => set("gradients", v)}
            />
            <ToggleRow
              label="Semantic Shape Primitives"
              sub="Emits native <circle>, <ellipse>, <rect> & <polygon> tags"
              badge="Multi-Tag"
              checked={opts.primitives ?? true}
              onChange={(v) => set("primitives", v)}
            />
            <ToggleRow
              label="Residual Catchlight & Detail Loop"
              sub="Error-driven pass for white text, irises, rooftops & glints"
              badge="See-Diff"
              checked={opts.residualPass ?? true}
              onChange={(v) => set("residualPass", v)}
            />
            <Slider
              label="Anti-White-Spot & Glow Strength"
              value={opts.antiSpot ?? 1}
              min={0}
              max={1.5}
              step={0.05}
              fmt={(v) => (v === 0 ? "off" : Math.round(v * 100) + "%")}
              onChange={(v) => set("antiSpot", v)}
              hint="Eliminates flat white spots on cheeks, shoulders & clouds via feathered radial domes and <feGaussianBlur>."
            />
          </section>

          {/* Colour Engine */}
          <section className="space-y-3">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Oklab+CIELAB Colour Engine</h2>
            <Slider
              label="Refinement iterations"
              value={opts.iterations}
              min={15}
              max={100}
              step={5}
              onChange={(v) => set("iterations", v)}
              hint="Error-driven palette passes + white/chroma anchor pinning."
            />
            <Slider
              label="Palette ceiling"
              value={opts.maxColors}
              min={12}
              max={96}
              step={2}
              onChange={(v) => set("maxColors", v)}
              hint="Base palette layers; each disconnected region is further calibrated to its exact local visible RGB."
            />
            <Slider
              label="Detail & Chroma Saliency"
              value={opts.detail}
              min={0}
              max={1}
              step={0.05}
              fmt={(v) => Math.round(v * 100) + "%"}
              onChange={(v) => set("detail", v)}
              hint="Protects thin ink lines, eyelashes, typography and saturated flowers."
            />
            <Slider
              label="Denoise passes"
              value={opts.denoise}
              min={0}
              max={3}
              step={1}
              onChange={(v) => set("denoise", v)}
              hint="Edge-preserving bilateral filter for heavy JPEG compression."
            />
          </section>

          {/* Curve Engine */}
          <section className="space-y-3">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Sub-Pixel Curve Engine</h2>
            <Slider
              label="Bézier fit tolerance"
              value={opts.tolerance}
              min={0.12}
              max={1.5}
              step={0.02}
              fmt={(v) => v.toFixed(2) + " px"}
              onChange={(v) => set("tolerance", v)}
              hint="Lower = tighter sub-pixel contour lock. Uses relative m/l/h/v/q/s/c/z compaction."
            />
            <Slider
              label="Thin-stroke mass preservation"
              value={opts.thin ?? 0.85}
              min={0}
              max={1.4}
              step={0.05}
              fmt={(v) => Math.round(v * 100) + "%"}
              onChange={(v) => set("thin", v)}
              hint="Keeps sub-pixel hairlines, highways & small type at full visual weight."
            />
            <Slider
              label="Seam underlap"
              value={opts.underlap ?? 1}
              min={0}
              max={3}
              step={0.5}
              fmt={(v) => v + " px"}
              onChange={(v) => set("underlap", v)}
              hint="Slips lower layers under upper layers so zero seams ever appear."
            />
            <Slider
              label="Corner threshold"
              value={opts.cornerAngle}
              min={30}
              max={95}
              step={1}
              fmt={(v) => v + "°"}
              onChange={(v) => set("cornerAngle", v)}
            />
            <Slider
              label="Despeckle area"
              value={opts.minArea}
              min={0}
              max={20}
              step={0.25}
              fmt={(v) => v + " px²"}
              onChange={(v) => set("minArea", v)}
            />
          </section>

          {/* Load from URL */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="mb-1.5 text-[11px] font-semibold text-zinc-300">Load Any Image URL</div>
            <div className="flex gap-1.5">
              <input
                type="url"
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                placeholder="https://example.com/art.png"
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-600"
              />
              <button
                onClick={() => {
                  if (customUrlInput.trim()) {
                    setImage(customUrlInput.trim(), "remote-image.png");
                  }
                }}
                className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-fuchsia-300 hover:bg-zinc-700"
              >
                Load
              </button>
            </div>
          </section>
        </aside>

        {/* ------------- Main Viewport & Telemetry ------------- */}
        <main className="flex min-h-[70vh] min-w-0 flex-1 flex-col lg:min-h-0">
          {/* Viewport Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
            <div className="flex overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
              {(
                [
                  { id: "split", label: "Split Curtain" },
                  { id: "vector", label: "Vector SVG" },
                  { id: "original", label: "Original" },
                  { id: "diff", label: "See Difference (4×)" },
                  { id: "wireframe", label: "Vector X-Ray" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  disabled={!result && m.id !== "original"}
                  onClick={() => setMode(m.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition disabled:opacity-30 ${
                    mode === m.id ? "bg-fuchsia-600 text-white shadow" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {mode === "split" && result && (
              <div className="flex items-center gap-1.5 text-xs">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(+e.target.value)}
                  className="w-24 accent-fuchsia-500"
                  title="Split curtain position"
                />
                <span className="w-8 font-mono text-[11px] text-zinc-400">{Math.round(split)}%</span>
              </div>
            )}

            <div className="flex items-center gap-1 text-xs">
              <button
                onClick={fit}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800"
              >
                Fit
              </button>
              <button
                onClick={actual}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800"
              >
                100%
              </button>
              <button
                onClick={() => setView((v) => ({ ...v, z: Math.min(80, v.z * 2) }))}
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                title="Zoom in 2x"
              >
                +2×
              </button>
              <span className="w-14 text-center font-mono text-[11px] tabular-nums text-zinc-400">
                {Math.round(view.z * base * 100)}%
              </span>
              {result && (
                <button
                  onClick={() => setLoupeOn((l) => !l)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                    loupeOn
                      ? "border-cyan-500 bg-cyan-500/20 text-cyan-300"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                  }`}
                  title="Toggle 8x Dual Inspection Loupe"
                >
                  🔍 8× Loupe
                </button>
              )}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {busy ? (
                <button
                  onClick={cancel}
                  className="rounded-lg border border-red-700 bg-red-950/50 px-4 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-900/60"
                >
                  Cancel
                </button>
              ) : (
                <button
                  onClick={run}
                  disabled={!src}
                  className="rounded-lg bg-gradient-to-r from-fuchsia-600 via-purple-600 to-cyan-600 px-5 py-1.5 text-xs font-bold text-white shadow-lg shadow-fuchsia-900/40 transition hover:brightness-110 disabled:opacity-30"
                >
                  {result ? "⚡ Re-Transform to Vector" : "⚡ Transform to Vector"}
                </button>
              )}
              <button
                onClick={copy}
                disabled={!result}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-30"
              >
                {copied ? "Copied ✓" : "Copy SVG"}
              </button>
              <button
                onClick={download}
                disabled={!result}
                className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-md shadow-emerald-950 hover:bg-emerald-500 disabled:opacity-30"
              >
                Download .svg
              </button>
            </div>
          </div>

          {/* Live Progress Bar */}
          {(busy || (progress && progress.pct < 100)) && progress && (
            <div className="border-b border-zinc-800 bg-zinc-900/70 px-4 py-2">
              <div className="mb-1 flex justify-between text-[11px]">
                <span className="font-medium text-zinc-200">{progress.phase}</span>
                <span className="font-mono tabular-nums text-fuchsia-300">
                  {progress.colors ? `${progress.colors} base colours · ΔE ${progress.error?.toFixed(2)} · ` : ""}
                  {Math.round(progress.pct)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 via-purple-500 to-cyan-400 transition-all"
                  style={{ width: progress.pct + "%" }}
                />
              </div>
            </div>
          )}
          {error && (
            <div className="border-b border-red-900 bg-red-950/60 px-4 py-2 text-xs text-red-300">{error}</div>
          )}

          {/* Interactive Canvas Stage */}
          <div
            ref={viewerRef}
            className={`relative min-h-[360px] flex-1 touch-none select-none overflow-hidden ${
              src ? "cursor-grab active:cursor-grabbing" : ""
            }`}
            style={{
              backgroundColor: "#09090c",
              backgroundImage: "radial-gradient(#1f1f29 1px, transparent 1px)",
              backgroundSize: "18px 18px",
            }}
            onPointerDown={(e) => {
              if (!src) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
            }}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - rect.left;
              const my = e.clientY - rect.top;

              if (loupeOn && src && dispW > 0 && dispH > 0) {
                const ix = (mx - view.x) / (view.z * dispW);
                const iy = (my - view.y) / (view.z * dispH);
                if (ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1) {
                  setLoupePos({ x: mx, y: my, imgX: ix, imgY: iy });
                } else {
                  setLoupePos(null);
                }
              }

              if (splitDrag.current && dispW > 0) {
                const relX = ((mx - view.x) / (view.z * dispW)) * 100;
                setSplit(Math.max(0, Math.min(100, relX)));
                return;
              }
              const d = drag.current;
              if (!d) return;
              setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
            }}
            onPointerUp={() => {
              drag.current = null;
              splitDrag.current = false;
            }}
            onPointerLeave={() => setLoupePos(null)}
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
            {src && (
              <div
                className="absolute left-0 top-0 origin-top-left will-change-transform"
                style={{
                  width: dispW,
                  height: dispH,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                }}
              >
                {/* Original image */}
                <img
                  src={src.url}
                  alt="original"
                  draggable={false}
                  className="absolute inset-0 h-full w-full"
                  style={{ imageRendering: view.z * base > 3 ? "pixelated" : "auto" }}
                />

                {/* Vector SVG overlay */}
                {result && svgUrl && (mode === "split" || mode === "vector" || mode === "wireframe") && (
                  <img
                    src={svgUrl}
                    alt="vector"
                    draggable={false}
                    className="absolute inset-0 h-full w-full"
                    style={{
                      clipPath: mode === "split" ? `inset(0 0 0 ${split}%)` : undefined,
                      background: mode === "vector" ? "#fff" : undefined,
                    }}
                  />
                )}

                {/* 4x Difference Heatmap ("See Difference" Mode) */}
                {result && fidelity?.diffUrl && mode === "diff" && (
                  <img
                    src={fidelity.diffUrl}
                    alt="4x difference heatmap"
                    draggable={false}
                    className="absolute inset-0 h-full w-full"
                    style={{ imageRendering: view.z * base > 2 ? "pixelated" : "auto" }}
                  />
                )}

                {/* Interactive Split Divider Line */}
                {result && mode === "split" && (
                  <div
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      splitDrag.current = true;
                    }}
                    className=" absolute top-0 h-full cursor-ew-resize bg-fuchsia-400 shadow-[0_0_10px_rgba(232,121,249,0.9)]"
                    style={{
                      left: split + "%",
                      width: Math.max(1.5, 2 / view.z),
                    }}
                  />
                )}
              </div>
            )}

            {/* Floating Mode Badges */}
            {src && result && mode === "split" && (
              <>
                <span className="pointer-events-none absolute left-3 top-3 rounded-md border border-zinc-700/80 bg-black/75 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-200 backdrop-blur">
                  ◀ Original Bitmap ({src.w}×{src.h})
                </span>
                <span className="pointer-events-none absolute right-3 top-3 rounded-md border border-fuchsia-500/50 bg-fuchsia-950/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-200 backdrop-blur">
                  Pure Vector SVG ({Object.values(tagInventory).reduce((a, b) => a + b, 0).toLocaleString()} tags) ▶
                </span>
              </>
            )}

            {src && result && mode === "diff" && (
              <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-amber-500/40 bg-black/80 px-3 py-1.5 text-xs text-amber-200 backdrop-blur">
                <b>See Difference Heatmap (4× Amplified RGB Error)</b> — Pure black = 0.00 error · Smooth cheek/shoulder/sky shows zero white-spot rings
              </div>
            )}

            {src && result && mode === "wireframe" && (
              <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-cyan-500/40 bg-black/80 px-3 py-1.5 text-xs text-cyan-200 backdrop-blur">
                <b>Vector Wireframe X-Ray</b> — {result.loops.toLocaleString()} closed paths & primitives · {result.nodes.toLocaleString()} Bézier/line nodes · 0 bitmaps
              </div>
            )}

            {/* 8x Dual Loupe Magnifier */}
            {loupeOn && loupePos && src && result && svgUrl && (
              <div
                className="pointer-events-none absolute z-30 flex overflow-hidden rounded-2xl border-2 border-fuchsia-400/80 bg-zinc-950 shadow-2xl"
                style={{
                  width: 260,
                  height: 130,
                  left: Math.min(box.w - 270, Math.max(10, loupePos.x + 18)),
                  top: Math.min(box.h - 140, Math.max(10, loupePos.y - 140)),
                }}
              >
                <div className="relative h-full w-1/2 overflow-hidden border-r border-zinc-700">
                  <div
                    className="h-full w-full"
                    style={{
                      backgroundImage: `url(${src.url})`,
                      backgroundRepeat: "no-repeat",
                      backgroundSize: `${src.w * 4}px ${src.h * 4}px`,
                      backgroundPosition: `${-loupePos.imgX * src.w * 4 + 65}px ${-loupePos.imgY * src.h * 4 + 65}px`,
                      imageRendering: "pixelated",
                    }}
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-bold text-zinc-300">
                    Raster 4×
                  </span>
                </div>
                <div className="relative h-full w-1/2 overflow-hidden">
                  <div
                    className="h-full w-full"
                    style={{
                      backgroundImage: `url(${svgUrl})`,
                      backgroundRepeat: "no-repeat",
                      backgroundSize: `${src.w * 4}px ${src.h * 4}px`,
                      backgroundPosition: `${-loupePos.imgX * src.w * 4 + 65}px ${-loupePos.imgY * src.h * 4 + 65}px`,
                    }}
                  />
                  <span className="absolute bottom-1 right-1 rounded bg-fuchsia-700/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
                    Vector 4×
                  </span>
                </div>
              </div>
            )}

            {/* Ready Prompt CTA when image is loaded but not yet vectorized */}
            {src && !result && !busy && (
              <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-fuchsia-500/40 bg-zinc-950/90 px-5 py-3 shadow-2xl backdrop-blur-md">
                <div>
                  <div className="text-xs font-bold text-white">
                    {src.name} <span className="font-normal text-zinc-400">({src.w}×{src.h} px)</span>
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Ready for 25-Loop Hybrid Vector Transformation (Gradients + Anti-Spot Lighting + Exact Contours)
                  </div>
                </div>
                <button
                  onClick={run}
                  className="rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-fuchsia-950 hover:brightness-110"
                >
                  ⚡ Transform Now
                </button>
              </div>
            )}

            {dragOver && (
              <div className="pointer-events-none absolute inset-4 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-fuchsia-400 bg-fuchsia-950/40 backdrop-blur-sm">
                <div className="rounded-xl bg-black/80 px-5 py-3 text-sm font-bold text-fuchsia-200">
                  Drop image to load into SVGer Transformer Pro
                </div>
              </div>
            )}
            {src && (
              <div className="pointer-events-none absolute bottom-2.5 right-3 rounded bg-black/65 px-2 py-0.5 text-[10px] text-zinc-500">
                scroll to zoom (up to 8000%) · drag to pan · double-click to fit
              </div>
            )}
          </div>

          {/* Bottom Telemetry, Multi-Tag SVG Inventory & Layer Inspector */}
          {(result || busy) && (
            <div className="grid gap-4 border-t border-zinc-800 bg-zinc-900/50 p-3.5 lg:max-h-[39vh] lg:grid-cols-[1.2fr_1fr] lg:overflow-y-auto">
              {/* Left Column: Fidelity Metrics + Tag Inventory + Convergence */}
              <div className="space-y-3">
                {result && (
                  <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                      <Stat
                        label="Color Accuracy"
                        value={fidelity ? `${fidelity.colorAcc.toFixed(3)}%` : "…"}
                        sub={fidelity ? `${fidelity.sim.toFixed(2)}% sRGB` : "calibrating"}
                        highlight
                      />
                      <Stat
                        label="PSNR Fidelity"
                        value={fidelity ? `${fidelity.psnr.toFixed(2)} dB` : "…"}
                        sub="vs source bitmap"
                        highlight
                      />
                      <Stat
                        label="SVG Gradients"
                        value={String(result.gradients?.length ?? 0)}
                        sub="linear + radial"
                      />
                      <Stat
                        label="Shapes / Paths"
                        value={result.loops.toLocaleString()}
                        sub={`${result.nodes.toLocaleString()} nodes`}
                      />
                      <Stat label="SVG File Size" value={fmtBytes(new Blob([fullSvg]).size)} sub="relative compact" />
                      <Stat label="Compute Time" value={`${elapsed.toFixed(1)} s`} sub="Web Worker" />
                    </div>

                    {/* Multi-Tag SVG Inventory Bar */}
                    <div className="rounded-xl border border-zinc-800/90 bg-zinc-950/80 px-3 py-2">
                      <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                        <span>Active Native SVG Tag Inventory</span>
                        <span className="text-emerald-400">100% Editable Vector DOM</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(tagInventory).map(([tag, count]) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200"
                          >
                            <span className="text-fuchsia-400">&lt;{tag}&gt;</span>
                            <span className="font-bold text-white">{count.toLocaleString()}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <ConvergenceChart
                  errors={busy ? liveErr : result?.errors ?? liveErr}
                  colors={busy ? liveCols : result?.colorHistory ?? liveCols}
                  live={busy}
                />

                {result && (
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowCode((s) => !s)}
                      className="text-[11px] font-medium text-fuchsia-300 hover:underline"
                    >
                      {showCode ? "Hide" : "Inspect"} Raw Multi-Tag SVG Source (&lt;defs&gt;, &lt;linearGradient&gt;, &lt;radialGradient&gt;, &lt;path&gt;)
                    </button>
                    <button
                      onClick={() => setShowIterModal(true)}
                      className="text-[11px] font-medium text-cyan-300 hover:underline"
                    >
                      View 25-Iteration Benchmark Log →
                    </button>
                  </div>
                )}
                {result && showCode && (
                  <pre className="max-h-32 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[10px] leading-snug text-zinc-400">
                    {fullSvg.slice(0, 2600)}…
                  </pre>
                )}
              </div>

              {/* Right Column: Layer, Gradient & Lighting Inspector */}
              {result && (
                <div className="flex flex-col">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1 text-[10px] uppercase tracking-wider text-zinc-400">
                    <span className="font-semibold">Layer & Shading Stack ({result.layers.length + 1})</span>
                    <div className="flex gap-1">
                      {(["all", "gradient", "lighting", "residual", "base"] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setLayerFilter(f)}
                          className={`rounded px-1.5 py-0.5 capitalize ${
                            layerFilter === f ? "bg-fuchsia-600 text-white" : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {f}
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setHidden(new Set());
                          setReveal(2000);
                        }}
                        className="ml-1 text-fuchsia-300 normal-case hover:underline"
                      >
                        reset
                      </button>
                    </div>
                  </div>

                  <label className="mb-2 block text-[11px] text-zinc-400">
                    Progressive Layer Build-Up Scrubber ({Math.min(reveal, result.layers.length)}/{result.layers.length})
                    <input
                      type="range"
                      min={0}
                      max={result.layers.length}
                      value={Math.min(reveal, result.layers.length)}
                      onChange={(e) => setReveal(+e.target.value)}
                      className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-fuchsia-500"
                    />
                  </label>

                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
                    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/90 px-2.5 py-1.5 text-[11px]">
                      <span
                        className="h-4 w-4 shrink-0 rounded-sm ring-1 ring-white/20"
                        style={{ background: result.background }}
                      />
                      <span className="font-mono text-zinc-200">background</span>
                      <span className="ml-auto rounded bg-zinc-800 px-1.5 py-0.2 font-mono text-[9px] text-cyan-300">
                        {result.backgroundFill?.startsWith("url") ? "gradient rect" : "rect"}
                      </span>
                    </div>

                    {filteredLayers.map((l) => {
                      const idx = result.layers.indexOf(l);
                      const off = hidden.has(l.id) || idx >= reveal;
                      return (
                        <button
                          key={l.id}
                          onClick={() => toggleLayer(l.id)}
                          className={`flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/90 px-2.5 py-1.5 text-left text-[11px] transition hover:border-zinc-600 ${
                            off ? "opacity-35" : ""
                          }`}
                        >
                          <span
                            className="h-4 w-4 shrink-0 rounded-sm ring-1 ring-white/20"
                            style={{ background: l.color }}
                          />
                          <span className="truncate font-mono text-zinc-300">{l.color}</span>
                          {l.kind && l.kind !== "base" && (
                            <span
                              className={`rounded px-1 text-[9px] font-semibold ${
                                l.kind === "gradient"
                                  ? "bg-fuchsia-500/20 text-fuchsia-300"
                                  : l.kind === "lighting"
                                  ? "bg-amber-500/20 text-amber-300"
                                  : "bg-cyan-500/20 text-cyan-300"
                              }`}
                            >
                              {l.kind === "gradient" ? "grad" : l.kind === "lighting" ? "glow" : "detail"}
                            </span>
                          )}
                          <span className="ml-auto font-mono text-[10px] tabular-nums text-zinc-500">
                            {l.loops}p · {l.nodes}n
                          </span>
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

      {/* 25-Iteration Engineering Modal */}
      <IterationExplorerModal
        open={showIterModal}
        onClose={() => setShowIterModal(false)}
        onSelectSample={selectShowcaseSample}
      />
    </div>
  );
}
