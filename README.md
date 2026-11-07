# Svger – pixel-accurate raster → SVG

Engine pipeline (src/engine):
1. optional edge-preserving denoise, CIELAB palette search (error-driven split + Lloyd, N passes)
2. full-pixel Lloyd polish using *core* pixels only (edge pixels never bias a colour)
3. final labels + **soft coverage fields in sRGB** – anti-aliasing is blended linearly in sRGB by renderers,
   so `m = d_other/(d_other+d_self)` is the exact coverage of an edge pixel
4. layers painted big → small, each **underlapping** the next (seam-free) with hole filling (≈2× edge tracing, not K×)
5. **thin-stroke correction**: contour level P/(1+P) (line) or 1/(2−Q) (gap) so sub-pixel strokes keep their weight
6. sub-pixel marching squares → corner-aware Schneider Bézier fit; runs in a Web Worker

Benchmark / tuning harness (needs `npm i -D tsx @resvg/resvg-js jpeg-js pngjs`):
```
npx tsx bench/gen.ts                                  # synthetic text stress image
npx tsx bench/run.ts bench/img/text.png maxColors=24 tolerance=0.15 --save=out
npx tsx bench/tune.ts 100                             # coordinate-descent autotuner
```
