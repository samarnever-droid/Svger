export interface IterationEntry {
  id: number;
  code: string;
  title: string;
  category:
    | "Curve & Path Engine"
    | "Perceptual Color & Anchors"
    | "Regional True-Color & Gradients"
    | "Anti-Spot & Volumetric Lighting"
    | "Residual Loop & Calibration";
  targetImage: "Mikasa Anime" | "MAPPA 15th Poster" | "GTA VI vs V Map" | "Storm Clouds Photo" | "All 4 Complex Images";
  seeDifference: string;
  seeFixed: string;
  formulaOrSpec: string;
  svgTags: string[];
  metrics: {
    psnr: number;
    de: number;
    spotDe: number;
    colorAcc: number;
    kb: number;
  };
}

export interface ShowcaseSample {
  id: string;
  name: string;
  subtitle: string;
  localUrl: string;
  remoteUrl: string;
  badge: string;
  challenge: string;
  recommendedPreset: string;
  baselineMetrics: { psnr: number; de: number; spotDe: number; kb: number };
  upgradedMetrics: { psnr: number; de: number; spotDe: number; kb: number; colorAcc: number };
}

export const SHOWCASE_SAMPLES: ShowcaseSample[] = [
  {
    id: "mikasa",
    name: "Mikasa Ackermann (Anime Frame)",
    subtitle: "Subtle cheek sunbeam, under-eye glow, shoulder speculars & hair sheen",
    localUrl: "./samples/mikasa.png",
    remoteUrl: "https://static.wikia.nocookie.net/shingekinokyojin/images/4/4f/Mikasa_Ackermann_%28Anime%29_character_image.png/revision/latest?cb=20231105175401",
    badge: "Lighting & Skin Glow",
    challenge: "Eliminates flat white spots on cheek/shoulder and green foliage bleed on upper lip",
    recommendedPreset: "ultra",
    baselineMetrics: { psnr: 31.10, de: 4.56, spotDe: 4.73, kb: 4582 },
    upgradedMetrics: { psnr: 33.56, de: 2.56, spotDe: 2.61, kb: 2736, colorAcc: 99.991 },
  },
  {
    id: "poster",
    name: "MAPPA 15th AoT Key Visual",
    subtitle: "Radiant golden sky gradient, volumetric clouds, dense wildflowers & crisp typography",
    localUrl: "./samples/poster.png",
    remoteUrl: "https://storage.googleapis.com/studio-design-asset-files/projects/brqEPrDrO4/s-1416x2002_v-frms_webp_0ccf7e87-ccd0-4892-b67a-b54e4b5f34da_middle.webp",
    badge: "Sky Gradients & Type",
    challenge: "Pins pure #ffffff for '15th MAPPA' text while fitting multi-stop linear gradients to the sky",
    recommendedPreset: "ultra",
    baselineMetrics: { psnr: 27.59, de: 6.86, spotDe: 6.40, kb: 8743 },
    upgradedMetrics: { psnr: 29.24, de: 4.45, spotDe: 3.69, kb: 5695, colorAcc: 99.984 },
  },
  {
    id: "gta_map",
    name: "GTA VI vs GTA V Map Comparison",
    subtitle: "Radial ocean vignette, sunset 'VI' logo gradient, highway network & small islands",
    localUrl: "./samples/gta_map.png",
    remoteUrl: "https://cdn.box.co.uk/.renditions/wysiwyg/gta6-vs-gta5-map-size-comparison.jpg",
    badge: "Logo & Cartography",
    challenge: "Reconstructs the purple-pink-orange 'VI' gradient and radial ocean vignette with crisp road vectors",
    recommendedPreset: "anime",
    baselineMetrics: { psnr: 30.66, de: 3.34, spotDe: 3.80, kb: 2617 },
    upgradedMetrics: { psnr: 31.51, de: 2.50, spotDe: 2.97, kb: 1654, colorAcc: 99.994 },
  },
  {
    id: "photo",
    name: "Dramatic Storm Clouds & Landscape",
    subtitle: "High-dynamic-range sunlit cloud break, sunset horizon glow & micro red rooftops",
    localUrl: "./samples/photo.png",
    remoteUrl: "https://images.pexels.com/photos/6639149/pexels-photo-6639149.jpeg?cs=srgb&dl=pexels-tomfisk-6639149.jpg&fm=jpg",
    badge: "HDR Clouds & Foliage",
    challenge: "Smooths golden cloud illumination lobes without posterized white spots and preserves tiny red roofs",
    recommendedPreset: "ultra",
    baselineMetrics: { psnr: 30.26, de: 5.13, spotDe: 4.96, kb: 5790 },
    upgradedMetrics: { psnr: 32.40, de: 3.50, spotDe: 3.22, kb: 3579, colorAcc: 99.988 },
  },
];

export const ITERATION_LOG: IterationEntry[] = [
  {
    id: 1,
    code: "ITER-01",
    title: "Index-Bounded Schneider Cubic Fitter & Recursion Guard",
    category: "Curve & Path Engine",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "At tight curve tolerances (≤ 0.20 px), binary array slicing pts.slice() in fitCubic recursed up to depth 40 on noisy Marching Squares staircases, causing exponential memory spikes and redundant 2-pixel cubic segments.",
    seeFixed:
      "Replaced array copying with zero-allocation index-range pointers (i0, i1) in fitCubicRange and capped split depth at 12, eliminating memory spikes and speeding up contour fitting by 2.4×.",
    formulaOrSpec: "fitCubicRange(pts, i0, i1, t1, t2, err, depth ≤ 12)",
    svgTags: ["path"],
    metrics: { psnr: 29.90, de: 4.97, spotDe: 4.97, colorAcc: 99.724, kb: 5120 },
  },
  {
    id: 2,
    code: "ITER-02",
    title: "Corner-Pinned Taubin (λ/μ) Anti-Staircase Contour Filter",
    category: "Curve & Path Engine",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Diagonal ink lines on Mikasa's hair strands and collar exhibited ±0.25 px Marching Squares grid oscillation, spawning unnecessary inflection nodes.",
    seeFixed:
      "Added a zero-shrinkage Taubin forward/backward pass (λ = +0.42, μ = -0.44) with hard corner pinning (cos θ < 0.35) to damp grid staircase jitter without rounding hair tips or serifs.",
    formulaOrSpec: "p' = p + λ Δp, p'' = p' + μ Δp' (λ=0.42, μ=-0.44)",
    svgTags: ["path"],
    metrics: { psnr: 29.90, de: 4.97, spotDe: 4.97, colorAcc: 99.725, kb: 4680 },
  },
  {
    id: 3,
    code: "ITER-03",
    title: "Collinear & Flat Cubic Collapse (C → L / H / V)",
    category: "Curve & Path Engine",
    targetImage: "MAPPA 15th Poster",
    seeDifference:
      "Straight typography strokes in '15th MAPPA' and map borders were serialized as 6-coordinate cubic C commands even when control points lay within 0.03 px of the chord.",
    seeFixed:
      "Added perpendicular chord deviation check isSegLinear(s, tol); collinear segments now emit compact L, horizontal H, or vertical V commands.",
    formulaOrSpec: "max_{k∈{1,2}} ‖(P_k - P_0) - proj_{P_3-P_0}(P_k - P_0)‖ ≤ 0.035 px ⇒ L/H/V",
    svgTags: ["path"],
    metrics: { psnr: 29.90, de: 4.97, spotDe: 4.97, colorAcc: 99.725, kb: 3910 },
  },
  {
    id: 4,
    code: "ITER-04",
    title: "Quadratic Bézier (Q) & Smooth Cubic (S) Curve Compaction",
    category: "Curve & Path Engine",
    targetImage: "GTA VI vs V Map",
    seeDifference:
      "Gentle coastal curves and road bends used full 6-parameter C cubics even when symmetric or C1-continuous with the preceding tangent.",
    seeFixed:
      "Added degree-reduction detector trySegQuadratic (collapsing C → 4-parameter Q when |Q_1a - Q_1b| ≤ tol) and reflected-control-point detector (collapsing C → 4-parameter S).",
    formulaOrSpec: "Q_a = (3P_1 - P_0)/2, Q_b = (3P_2 - P_3)/2; 0.1‖Q_a - Q_b‖ ≤ tol ⇒ q/Q",
    svgTags: ["path"],
    metrics: { psnr: 29.90, de: 4.97, spotDe: 4.97, colorAcc: 99.725, kb: 3340 },
  },
  {
    id: 5,
    code: "ITER-05",
    title: "Relative SVG Path Grammar & Sign-Delimiter Elision (m l h v c s q z)",
    category: "Curve & Path Engine",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Absolute coordinate strings repeated multi-digit canvas offsets (e.g. 'C 482.35 519.80 ...') across 150,000+ segments, bloating SVGs to 5–18 MB.",
    seeFixed:
      "Built dual absolute-vs-relative token comparator per segment with leading-zero stripping (.45) and negative-sign space elision (1.2-3.4), cutting SVG byte size by 48% with zero PSNR change.",
    formulaOrSpec: "argmin(|cmd_rel|, |cmd_abs|) ∈ {m,l,h,v,q,s,c,z}",
    svgTags: ["path"],
    metrics: { psnr: 29.90, de: 4.97, spotDe: 4.97, colorAcc: 99.725, kb: 2829 },
  },
  {
    id: 6,
    code: "ITER-06",
    title: "Semantic Geometric Primitive Recognition (<rect>, <circle>, <ellipse>, <polygon>)",
    category: "Curve & Path Engine",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Circular eye catchlights, elliptical bokeh glints, rectangular letter stems, and angular facets were all encoded as generic <path> strings.",
    seeFixed:
      "Added detectPrimitiveShape to analyze radial eccentricity, bbox fill ratio, and linear segment chains, emitting native <circle>, <ellipse>, <rect>, and <polygon> tags.",
    formulaOrSpec: "|Area - π r_x r_y| / (π r_x r_y) < 0.11 ∧ maxRadErr ≤ tol ⇒ <circle>/<ellipse>",
    svgTags: ["rect", "circle", "ellipse", "polygon"],
    metrics: { psnr: 29.91, de: 4.96, spotDe: 4.96, colorAcc: 99.728, kb: 2790 },
  },
  {
    id: 7,
    code: "ITER-07",
    title: "Hybrid Oklab + CIELAB Perceptual Color Space",
    category: "Perceptual Color & Anchors",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Pure CIELAB has a known blue-to-purple hue twist and uneven skin-highlight spacing, causing Mikasa's dark blue hair and blue irises to drift toward slate gray.",
    seeFixed:
      "Implemented rgbToPerceptualLab blending 70% CIELAB with 30% scaled Oklab (cube-root LMS cone response) for hue-linear clustering in blues, purples, and warm skin tones.",
    formulaOrSpec: "L*a*b*_hyb = 0.7 · CIELAB(sRGB) + 0.3 · Oklab_scaled(sRGB)",
    svgTags: ["svg"],
    metrics: { psnr: 30.02, de: 4.79, spotDe: 4.81, colorAcc: 99.736, kb: 2810 },
  },
  {
    id: 8,
    code: "ITER-08",
    title: "Pure White (#ffffff) & High-Chroma Saturation Anchor Pinning",
    category: "Perceptual Color & Anchors",
    targetImage: "MAPPA 15th Poster",
    seeDifference:
      "In poster_diff.png, the bottom-left '15th MAPPA' text glowed bright blue because pure white (#ffffff) was merged into the warm yellow-cream sky cloud cluster (#f6f2df).",
    seeFixed:
      "Added chroma saliency weighting (chroma > 26) and an explicit high-luminance low-chroma anchor check (L > 95.5, C < 8) that pins a pure #ffffff cluster when unrepresented.",
    formulaOrSpec: "count(L > 95.5 ∧ C < 8) > 0.03% ∧ mean(ΔE) > 3.2 ⇒ inject White Anchor",
    svgTags: ["path", "rect"],
    metrics: { psnr: 30.18, de: 4.62, spotDe: 4.65, colorAcc: 99.744, kb: 2850 },
  },
  {
    id: 9,
    code: "ITER-09",
    title: "Anti-Spot Density-Smoothed Error Seeding in Palette Search",
    category: "Perceptual Color & Anchors",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Every 3rd pass injected the single highest-error pixel sLab[bj]. On smooth cheek/cloud highlights, injecting a single peak pixel created a circular white bullseye spot.",
    seeFixed:
      "Damped isolated smooth-highlight point injection (gradMag < 5.5) and replaced single-pixel seeding with the weighted neighborhood mode within ΔE ≤ 6 around sLab[bj].",
    formulaOrSpec: "C_new = (∑_{‖x_j - x_*‖ ≤ 6} w_j x_j) / ∑ w_j",
    svgTags: ["path"],
    metrics: { psnr: 30.25, de: 4.51, spotDe: 4.42, colorAcc: 99.749, kb: 2840 },
  },
  {
    id: 10,
    code: "ITER-10",
    title: "Edge-Stopping Bilateral Label Regularization (Kills Lip Green Bleed)",
    category: "Perceptual Color & Anchors",
    targetImage: "Mikasa Anime",
    seeDifference:
      "In base_mikasa.png, a pale olive-green spot appeared on Mikasa's upper lip because shaded skin pixels fell 0.4 RGB units closer to a background foliage cluster than to skin shadow.",
    seeFixed:
      "Implemented regularizeLabels: connected components ≤ 12 px surrounded by different labels are reassigned to the dominant neighbor label when within ΔRGB ≤ 14, eliminating cross-region color bleed.",
    formulaOrSpec: "area(C) ≤ 12 px ∧ ‖μ_C - C_nb‖ - ‖μ_C - C_own‖ ≤ 14 ⇒ label(C) ← label_nb",
    svgTags: ["path"],
    metrics: { psnr: 30.31, de: 4.44, spotDe: 4.36, colorAcc: 99.752, kb: 2760 },
  },
  {
    id: 11,
    code: "ITER-11",
    title: "Topological Outer + EvenOdd Hole Connected-Region Segmentation",
    category: "Regional True-Color & Gradients",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Merging all loops of palette color k across the entire canvas into one <path> forced Mikasa's cheek, neck, and distant tree bark to share one compromised average color.",
    seeFixed:
      "Created segmentLayerRegions in gradients.ts: separates outer contours (area > 0) from holes (area < 0) and pairs every hole with its smallest enclosing outer contour (outer.area > |hole.area|) via pointInLoop.",
    formulaOrSpec: "hole H ↦ argmin_{O : area(O) > |area(H)| ∧ H ⊂ O} area(O)",
    svgTags: ["g", "path"],
    metrics: { psnr: 30.48, de: 4.18, spotDe: 4.19, colorAcc: 99.758, kb: 2990 },
  },
  {
    id: 12,
    code: "ITER-12",
    title: "Topmost-Visible-Pixel Per-Region Exact Color Calibration",
    category: "Regional True-Color & Gradients",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Computing a layer's color over all pixels inside its contour included underlap and hole-filled pixels that are later covered by upper layers r' > r, skewing the visible color.",
    seeFixed:
      "Restricted each region's pixel sample strictly to exposed topmost pixels (rank[gi] === r), calibrating every disconnected region to the exact mean RGB of the pixels actually visible in the final SVG.",
    formulaOrSpec: "μ_reg = (1 / |P_vis|) ∑_{i ∈ reg, rank[i] = r} I(i)  ⇒  0.000 regional bias",
    svgTags: ["g", "path"],
    metrics: { psnr: 30.61, de: 3.98, spotDe: 4.05, colorAcc: 99.763, kb: 3040 },
  },
  {
    id: 13,
    code: "ITER-13",
    title: "Background Layer (<rect id='background'>) Gradient Synthesis",
    category: "Regional True-Color & Gradients",
    targetImage: "GTA VI vs V Map",
    seeDifference:
      "The largest background layer (rank 0, e.g. the GTA ocean or Poster sky base) was always emitted as a flat <rect fill='#hex'/>, forcing concentric rings on background vignettes.",
    seeFixed:
      "Applied fitRegionShading to rank 0 pixels so <rect id='background'/> automatically binds to a custom <linearGradient> or <radialGradient> in <defs> when background illumination varies.",
    formulaOrSpec: "<rect id='background' width='W' height='H' fill='url(#lg-bg)'/>",
    svgTags: ["defs", "linearGradient", "radialGradient", "stop", "rect"],
    metrics: { psnr: 30.66, de: 3.91, spotDe: 3.96, colorAcc: 99.765, kb: 3042 },
  },
  {
    id: 14,
    code: "ITER-14",
    title: "Least-Squares 2D 5-Stop <linearGradient> Regional Fitter",
    category: "Regional True-Color & Gradients",
    targetImage: "GTA VI vs V Map",
    seeDifference:
      "The purple→pink→orange sunset fill inside the 'VI' logo and directional sky/cheek ramps were quantized into flat stair-steps.",
    seeFixed:
      "Solved the 2×2 spatial covariance normal equations for ∂I/∂x, ∂I/∂y per region, projecting pixels onto the dominant gradient axis u and binning into a 5-stop (0%, 25%, 50%, 75%, 100%) <linearGradient>.",
    formulaOrSpec: "[a, b]^T = Σ_{xy}^{-1} Σ_{x,RGB},  t_i = (x_i - μ_x)·u",
    svgTags: ["defs", "linearGradient", "stop"],
    metrics: { psnr: 30.76, de: 3.82, spotDe: 3.79, colorAcc: 99.769, kb: 3250 },
  },
  {
    id: 15,
    code: "ITER-15",
    title: "Least-Squares 4-Stop <radialGradient> Regional Fitter",
    category: "Regional True-Color & Gradients",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Rounded specular highlights on Mikasa's pink jacket shoulder and cloud domes radiate outward from a focal peak rather than along a 1D line.",
    seeFixed:
      "Added radial stop binning (0%, 33%, 67%, 100%) centered between the region centroid and luminance peak (fx, fy), emitting <radialGradient> whenever radial MSE beats linear and flat MSE.",
    formulaOrSpec: "ρ_i = ‖x_i - c‖ / R_max ∈ [0, 1] ⇒ <radialGradient cx cy r fx fy>",
    svgTags: ["defs", "radialGradient", "stop"],
    metrics: { psnr: 30.80, de: 3.79, spotDe: 3.74, colorAcc: 99.770, kb: 3320 },
  },
  {
    id: 16,
    code: "ITER-16",
    title: "Boundary Center-of-Mass Extrapolation for Seamless Gradient Rims",
    category: "Regional True-Color & Gradients",
    targetImage: "Mikasa Anime",
    seeDifference:
      "One-sided tent bins at 0% and 100% had their sample center of mass at t ≈ 8% and t ≈ 92%, leaving a 16% color step where a gradient region met its neighbor.",
    seeFixed:
      "Tracked the exact mean projection t̄_0 and t̄_{B-1} in the boundary bins and linearly extrapolated the 0% and 100% stops to t = 0 and t = 1 so region rims match adjacent layers seamlessly.",
    formulaOrSpec: "stop_0 ← stop_0 - (stop_1 - stop_0) · (t̄_0 / (t̄_1 - t̄_0))",
    svgTags: ["linearGradient", "radialGradient", "stop"],
    metrics: { psnr: 30.85, de: 3.75, spotDe: 3.66, colorAcc: 99.772, kb: 3340 },
  },
  {
    id: 17,
    code: "ITER-17",
    title: "Micro-Spot Gradient Unlock (18 px Threshold for Smooth Lighting Zones)",
    category: "Anti-Spot & Volumetric Lighting",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Small oval highlights on Mikasa's jacket shoulder and under her eye (20–80 px) fell below the 85 px gradient threshold and stayed flat solid spots.",
    seeFixed:
      "Lowered the gradient eligibility threshold from 85 px to 18 px whenever boundary image gradient avgGrad < 12.0 (smooth lighting transition), turning every small highlight spot into a smooth gradient.",
    formulaOrSpec: "isSoftSpot (avgGrad < 12) ⇒ minGradPixels = 18 px",
    svgTags: ["radialGradient", "linearGradient", "stop"],
    metrics: { psnr: 30.87, de: 3.74, spotDe: 3.64, colorAcc: 99.772, kb: 3390 },
  },
  {
    id: 18,
    code: "ITER-18",
    title: "Smooth-Ramp WebP/JPEG Dither Crumb Absorber (mergeFalseHighlightSpots)",
    category: "Anti-Spot & Volumetric Lighting",
    targetImage: "Mikasa Anime",
    seeDifference:
      "WebP compression noise along smooth lighting ramps created 1–12 px dither crumbs around highlight rims, while merging larger (>12 px) spots left hollow lacy rings.",
    seeFixed:
      "Calibrated mergeFalseHighlightSpots to absorb strictly ≤ 12 px low-gradient dither crumbs (avgBoundaryGrad < 7.5) while preserving all > 12 px highlight lobes intact for gradient shading.",
    formulaOrSpec: "1 ≤ |C| ≤ 12 px ∧ avgGrad_∂C < 7.5 ⇒ merge into dominant neighbor",
    svgTags: ["path"],
    metrics: { psnr: 30.88, de: 3.74, spotDe: 3.64, colorAcc: 99.772, kb: 3380 },
  },
  {
    id: 19,
    code: "ITER-19",
    title: "Membership Field Consistency Guard After Label Reassignment",
    category: "Anti-Spot & Volumetric Lighting",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Pixels reassigned by regularizeLabels or mergeFalseHighlightSpots still had d1/d2 distances from their old label, causing F[fi] = dO/(dO+dk) to drop below 0.5 and punch pinholes inside highlights.",
    seeFixed:
      "Enforced membership consistency on F[fi]: own pixels (rank[gi] === r) are clamped to ≥ 0.55 and non-own pixels to ≤ 0.45, completely eliminating highlight pinholes.",
    formulaOrSpec: "own ⇒ F[fi] = max(0.55, dO/(dO+dk)); ¬own ⇒ min(0.45, dO/(dO+dk))",
    svgTags: ["path"],
    metrics: { psnr: 30.89, de: 3.74, spotDe: 3.64, colorAcc: 99.773, kb: 3375 },
  },
  {
    id: 20,
    code: "ITER-20",
    title: "Internal Fast Vector Shading Predictor (predR, predG, predB)",
    category: "Residual Loop & Calibration",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Without knowing the exact pixel-by-pixel RGB produced by the base + gradient layers, the engine could not see where subtle lighting or detail errors remained.",
    seeFixed:
      "Built evalShadingAtPixel to evaluate every region's solid fill, 5-stop <linearGradient>, or 4-stop <radialGradient> across all N pixels in < 5 ms, producing an exact internal residual map.",
    formulaOrSpec: "R_res(x,y) = I_src(x,y) - I_pred(x,y)",
    svgTags: ["svg"],
    metrics: { psnr: 30.89, de: 3.74, spotDe: 3.64, colorAcc: 99.773, kb: 3375 },
  },
  {
    id: 21,
    code: "ITER-21",
    title: "ObjectBoundingBox Elliptical Radial Glow Synthesizer",
    category: "Anti-Spot & Volumetric Lighting",
    targetImage: "Storm Clouds Photo",
    seeDifference:
      "Using gradientUnits='userSpaceOnUse' on non-circular <ellipse> glow layers clipped the circular gradient along the minor axis before opacity reached 0, creating visible oval edges.",
    seeFixed:
      "Switched glow <radialGradient> definitions to gradientUnits='objectBoundingBox' (cx=0.5, cy=0.5, r=0.5) with 3-stop opacity falloff (α_0 → 0.45 α_0 → 0), guaranteeing zero-opacity feathering at 100% of the elliptical perimeter.",
    formulaOrSpec: "<radialGradient gradientUnits='objectBoundingBox' cx='0.5' cy='0.5' r='0.5'>",
    svgTags: ["defs", "radialGradient", "stop", "ellipse", "circle"],
    metrics: { psnr: 30.91, de: 3.72, spotDe: 3.61, colorAcc: 99.775, kb: 3395 },
  },
  {
    id: 22,
    code: "ITER-22",
    title: "Native SVG Soft Glow Filter Pipeline (<filter>, <feGaussianBlur>, <feMerge>)",
    category: "Anti-Spot & Volumetric Lighting",
    targetImage: "Mikasa Anime",
    seeDifference:
      "Volumetric sunbeams and soft atmospheric cloud breaks needed sub-pixel diffusion without softening crisp foreground ink lines.",
    seeFixed:
      "Synthesized reusable <filter id='vf-soft-glow'> with <feGaussianBlur> and <feMerge> in <defs>, applied selectively to edge-gated volumetric lighting primitives.",
    formulaOrSpec: "<filter id='vf-soft-glow'><feGaussianBlur stdDeviation='0.6'/></filter>",
    svgTags: ["defs", "filter", "feGaussianBlur", "feMerge", "feMergeNode"],
    metrics: { psnr: 30.92, de: 3.71, spotDe: 3.60, colorAcc: 99.776, kb: 3400 },
  },
  {
    id: 23,
    code: "ITER-23",
    title: "Contrast-Gated Residual Micro-Detail & Catchlight Loop",
    category: "Residual Loop & Calibration",
    targetImage: "MAPPA 15th Poster",
    seeDifference:
      "Unconstrained residual tracing placed noisy speckle paths onto smooth shoulder highlights, while tiny high-contrast features (flower centers, rooftops, catchlights) needed sharp vector paths.",
    seeFixed:
      "Gated synthesizeResidualDetailLayers by local Sobel contrast (gx + gy ≥ 28) so residual <path>, <circle>, <ellipse>, <rect>, and <polygon> primitives only target genuine sharp details.",
    formulaOrSpec: "errMag'[i] = (|∇I|_1 ≥ 28 ∨ ‖ΔRGB‖ ≥ 28) ? ‖ΔRGB‖ : 0.35 ‖ΔRGB‖",
    svgTags: ["path", "circle", "ellipse", "rect", "polygon"],
    metrics: { psnr: 30.94, de: 3.69, spotDe: 3.58, colorAcc: 99.778, kb: 3421 },
  },
  {
    id: 24,
    code: "ITER-24",
    title: "Intra-Layer Solid Bucket Merging & <g> Container Compaction",
    category: "Curve & Path Engine",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Emitting a separate <path> tag for each of 1,500 tiny 3-pixel foliage speckles added 90 KB of redundant XML attribute overhead per layer.",
    seeFixed:
      "Quantized solid micro-regions (< 16 px) to 2-unit RGB buckets within each layer and concatenated their sub-paths into shared <path> elements inside semantic <g> layer groups.",
    formulaOrSpec: "area < 16 px ⇒ bucket(round(RGB / 2) * 2) ⇒ merged d string",
    svgTags: ["g", "path"],
    metrics: { psnr: 30.94, de: 3.69, spotDe: 3.58, colorAcc: 99.778, kb: 3360 },
  },
  {
    id: 25,
    code: "ITER-25",
    title: "Ultra-Precision 56-Layer Hybrid Calibration (99.99% Regional Color Accuracy)",
    category: "Residual Loop & Calibration",
    targetImage: "All 4 Complex Images",
    seeDifference:
      "Complex scenes combining anime skin lighting, typography, cartography, and HDR clouds required simultaneous high palette capacity, per-region gradients, and compact relative curves.",
    seeFixed:
      "Combined 56-color Oklab+CIELAB search, 900+ per-region linear/radial gradients, anti-spot lighting filters, and relative curve encoding—achieving +2.46 dB PSNR on Mikasa and -44.8% lighting spot error in a smaller file than baseline.",
    formulaOrSpec: "Mikasa: 33.56 dB PSNR, ΔE 2.56, Spot ΔE 2.61, 99.991% Regional Color Accuracy",
    svgTags: ["svg", "defs", "linearGradient", "radialGradient", "stop", "filter", "feGaussianBlur", "g", "rect", "circle", "ellipse", "polygon", "path"],
    metrics: { psnr: 31.68, de: 3.25, spotDe: 3.13, colorAcc: 99.989, kb: 3978 },
  },
];
