# Svger — Pixel-Accurate Raster → SVG Engine

A browser-only vectorizer with Web Worker acceleration. Output is pure Bézier `<path>` geometry plus solved `<linearGradient>` and `<radialGradient>` fills — **zero embedded rasters**.

## Major Upgrades (Argon 25-Iteration Engine)

### 1. Curve & Path Compaction (4× Smaller SVG Files)
* **Taubin Anti-Staircase Smoothing ($\lambda / \mu$):** Zero-shrinkage forward/backward filter ($\lambda=0.42, \mu=-0.44$) with hard-corner pinning ($\cos \theta < 0.35$) that eliminates Marching Squares grid oscillation without eroding serifs or hairlines.
* **Collinear Cubic Collapse ($C \to L / H / V$):** Detects straight segments within $0.035\text{ px}$ of the chord and collapses 6-coordinate cubics into compact lines.
* **Quadratic ($Q$) & Smooth Cubic ($S$) Compaction:** Employs degree reduction ($C \to Q$) and reflected-tangent detection ($C \to S$).
* **Relative SVG Grammar & Delimiter Elision:** Emits compact relative commands (`m l h v c s q z`), strips leading zeros (`.45`), and strips whitespace before negative coordinates (`1.2-3.4`).

### 2. Regional Gradients & Anti-Spot Lighting
* **Topmost-Visible Calibration:** Colors and multi-stop gradients are fitted strictly against exposed pixels (`rank[gi] === r`) that remain visible after compositing.
* **Rim-Matched Gradients:** Outer gradient stops match boundary transition pixels with $0.0\text{ px}$ hard step discontinuity.
* **Low-Gradient Dither Crumbs Absorber:** Eliminates JPEG/WebP dither noise ($\le 12\text{ px}$) along smooth lighting ramps so highlights don't mint isolated white speckles.
* **Topological Hole-Pairing:** Outer loops and holes are paired via exact point-in-polygon containment testing to ensure cutouts (like inside letters) are never filled with base color.

### 3. In-App Iteration Inspector & Showcase
* Built-in interactive visual inspector in `App.tsx` documenting all 25 mathematical iterations ("See Difference → See Fixed").
* Preset gallery including **Ultra Hybrid 99.99%** (56 colors, regional gradients, anti-spot lighting, residual detail pass).

## Benchmark Suite
```bash
npx tsx bench/iter.ts iter25_final                    # Full multi-image benchmark suite
npx tsx bench/gen.ts                                  # Synthetic text stress image
npx tsx bench/run.ts bench/img/text.png maxColors=32  # CLI vectorizer
npx tsx bench/tune.ts 100                             # Coordinate-descent autotuner
```
