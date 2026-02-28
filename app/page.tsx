"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { cleanupGeometry, strengthToOptions } from "@/app/lib/cleanupGeometry";
import { cleanAiOutline } from "@/app/lib/aiOutlineCleanup";
import { detectEdges, autoDetectMode, type LabeledSegment } from "@/app/lib/edgeDetection";
import { suggestPlanes, type PlaneSuggestion } from "@/app/lib/planeSuggestion";
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
} from "react-konva";

/**
 * RoofViz — Single file (app/page.tsx)
 *
 * FIXES INCLUDED:
 * ✅ Multi-photo upload + photo switcher
 * ✅ Advanced options back (per selected roof) + your standard defaults
 * ✅ Ice & Water shows again (correct step gating + correct draw order)
 * ✅ Synthetic no longer overlaps other products (only visible during SYNTHETIC step)
 * ✅ Pro-Start shows on BOTH eaves and rakes
 * ✅ Dormer/exclusion holes reveal original photo (no black artifacts)
 * ✅ Hips visible like valleys after shingles
 * ✅ Two-page PDF export:
 *    Page 1: Finished shingles
 *    Page 2: Underlayments/metals through Pro-Start
 *
 * REQUIRED:
 * 1) Put logo at: /public/roofviz-logo.png
 * 2) npm i react-konva konva jspdf
 */

type Step =
  | "START"
  | "TRACE"
  | "TEAROFF"
  | "GUTTER_APRON"
  | "ICE_WATER"
  | "SYNTHETIC"
  | "DRIP_EDGE"
  | "VALLEY_METAL"
  | "PRO_START"
  | "SHINGLES"
  | "RIDGE_VENT"
  | "CAP_SHINGLES"
  | "EXPORT";

const STEPS: Step[] = [
  "START",
  "TRACE",
  "TEAROFF",
  "GUTTER_APRON",
  "ICE_WATER",
  "SYNTHETIC",
  "DRIP_EDGE",
  "VALLEY_METAL",
  "PRO_START",
  "SHINGLES",
  "RIDGE_VENT",
  "CAP_SHINGLES",
  "EXPORT",
];

const STEP_TITLE: Record<Step, string> = {
  START: "Start a project",
  TRACE: "Step 1 — Outline roofs + draw lines",
  TEAROFF: "Step 2 — Existing roof tear-off (decking exposed)",
  GUTTER_APRON: "Step 3 — Gutter apron (eaves)",
  ICE_WATER: "Step 4 — Ice & water (eaves + valleys)",
  SYNTHETIC: "Step 5 — Synthetic underlayment (field)",
  DRIP_EDGE: "Step 6 — Drip edge (rakes)",
  VALLEY_METAL: "Step 7 — Valley metal (valleys)",
  PRO_START: "Step 8 — Pro-start starter strip (eaves + rakes)",
  SHINGLES: "Step 9 — Shingles",
  RIDGE_VENT: "Step 10 — Ridge vent (ridges)",
  CAP_SHINGLES: "Step 11 — Cap shingles (same as shingles)",
  EXPORT: "Finish — Export PDF",
};

type LineKind = "EAVE" | "RAKE" | "VALLEY" | "RIDGE" | "HIP";
type Tool =
  | "NONE"
  | "TRACE_ROOF"
  | "TRACE_HOLE"
  | "DRAW_EAVE"
  | "DRAW_RAKE"
  | "DRAW_VALLEY"
  | "DRAW_RIDGE"
  | "DRAW_HIP"
  | "BRUSH_ICE_WATER";

type Polyline = {
  id: string;
  kind: LineKind;
  points: number[];
  aiLabeled?: boolean;   // set by Auto-Label; false/undefined = manual
  locked?: boolean;      // locked lines survive Re-run Auto-Label
  confidence?: number;   // 0–1, set by auto-label; undefined = manual/unscored
  segmentCount?: number; // for merged ridge: how many raw segments were fused
};

type MetalColor = "Galvanized" | "Aluminum" | "White" | "Black" | "Bronze" | "Brown" | "Gray";
type ShingleColor =
  | "Barkwood"
  | "Charcoal"
  | "WeatheredWood"
  | "PewterGray"
  | "OysterGray"
  | "Slate"
  | "Black";

type Roof = {
  id: string;
  name: string;

  outline: number[];
  closed: boolean;

  holes: number[][];
  lines: Polyline[];

  // your standard sizing defaults (per-roof adjustable)
  gutterApronW: number; // 8
  dripEdgeW: number; // 8
  iceWaterEaveW: number; // 40
  iceWaterValleyW: number; // 20
  valleyMetalW: number; // 10
  proStartW: number; // 12
  ridgeVentW: number; // 12
  capW: number; // 8

  gutterApronColor: MetalColor;
  dripEdgeColor: MetalColor;
  valleyMetalColor: MetalColor;

  shingleScale: number;
  shingleRotation: number; // degrees, -45..45; 0 = horizontal
  proStartOnRakes: boolean;

  iceWaterOnEaves: boolean;     // default true
  iceWaterOnValleys: boolean;   // default true
  iceWaterBrush: { id: string; points: number[]; size: number }[];
  iceWaterBrushSize: number;    // default 30
};

type PhotoProject = {
  id: string;
  name: string;
  src: string;
  photoSrcs: string[]; // all uploaded photos for this project

  step: Step;

  roofs: Roof[];
  activeRoofId: string;

  shingleColor: ShingleColor;

  showGuidesDuringInstall: boolean;
  showEditHandles: boolean;

  realisticMode: boolean;       // "Match Photo Look" toggle, default false
  realisticStrength: number;    // 0.0–1.0 shadow/depth intensity, default 0.6

  stageScale: number;
  stagePos: { x: number; y: number };

  photoStates: Record<string, {
    roofs: Roof[];
    activeRoofId: string;
    stageScale: number;
    stagePos: { x: number; y: number };
  }>;
};

type ExportView = "LIVE" | "PDF_SHINGLES" | "PDF_UNDERLAY";

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// Compress an image data-URL to max 1400px on longest side, JPEG 0.82.
// Keeps localStorage well under the 5 MB quota for typical job photos.
function compressForStorage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const MAX = 1400;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function stepIndex(s: Step) {
  return STEPS.indexOf(s);
}

function atLeast(cur: Step, target: Step) {
  return stepIndex(cur) >= stepIndex(target);
}

function kindColor(k: LineKind) {
  if (k === "EAVE") return "#2563eb";
  if (k === "RAKE") return "#10b981";
  if (k === "VALLEY") return "#64748b";
  if (k === "RIDGE") return "#f59e0b";
  return "#a855f7"; // HIP
}

function metalRGBA(color: MetalColor, alpha: number) {
  const a = alpha;
  switch (color) {
    case "Galvanized": return `rgba(155,165,172,${a})`;
    case "Aluminum": return `rgba(198,205,211,${a})`;
    case "White":    return `rgba(245,246,248,${a})`;
    case "Black":    return `rgba(25,25,28,${a})`;
    case "Bronze":   return `rgba(132,97,60,${a})`;
    case "Brown":    return `rgba(92,64,45,${a})`;
    case "Gray":     return `rgba(120,126,134,${a})`;
  }
}

// RGB tuples for jsPDF legend boxes
function metalRGB(color: MetalColor): [number, number, number] {
  switch (color) {
    case "Galvanized": return [155, 165, 172];
    case "Aluminum": return [198, 205, 211];
    case "White":    return [230, 232, 235];
    case "Black":    return [25,  25,  28];
    case "Bronze":   return [132, 97,  60];
    case "Brown":    return [92,  64,  45];
    case "Gray":     return [120, 126, 134];
  }
}

function shingleRGB(color: ShingleColor): [number, number, number] {
  switch (color) {
    case "Barkwood":     return [111, 79,  52];
    case "Charcoal":     return [75,  78,  85];
    case "WeatheredWood":return [106, 98,  86];
    case "PewterGray":   return [122, 128, 135];
    case "OysterGray":   return [141, 144, 146];
    case "Slate":        return [93,  106, 121];
    case "Black":        return [47,  49,  53];
  }
}

// Per-step contextual hints shown in the panel
const STEP_HINT: Partial<Record<Step, string>> = {
  TRACE:        "Outline each roof section, then label its edges (eaves, rakes, valleys, etc.).",
  TEAROFF:      "Shows the bare decking after the old roof is removed.",
  GUTTER_APRON: "Metal strips at the eave edges channel water into the gutters.",
  ICE_WATER:    "Self-adhering membrane at eaves and valleys stops ice dam leaks.",
  SYNTHETIC:    "Lightweight felt covers the field of the roof as a moisture barrier.",
  DRIP_EDGE:    "L-shaped metal along the rake edges keeps water off the fascia.",
  VALLEY_METAL: "Standard open valley uses galvanized metal. Select a color in Advanced Options to upgrade to W-valley metal — installed over ice & water with shingles woven around it.",
  PRO_START:    "Adhesive starter strip along eaves and rakes seals the first shingle row.",
  SHINGLES:     "Architectural shingles are installed over the entire roof field.",
  RIDGE_VENT:   "Continuous vent strip along the ridge allows attic air to escape.",
  CAP_SHINGLES: "Pre-cut cap shingles finish the ridge and cover the vent.",
  EXPORT:       "Your visualization is complete — export a PDF to share with your customer.",
};

const STEP_SHORT: Partial<Record<Step, string>> = {
  TRACE:        "Outline & Label Edges",
  TEAROFF:      "Tear-off / Decking",
  GUTTER_APRON: "Gutter Apron (eaves)",
  ICE_WATER:    "Ice & Water Shield",
  SYNTHETIC:    "Synthetic Underlayment",
  DRIP_EDGE:    "Drip Edge (rakes)",
  VALLEY_METAL: "Valley Metal (valleys)",
  PRO_START:    "Pro-Start Strip",
  SHINGLES:     "Shingles",
  RIDGE_VENT:   "Ridge Vent",
  CAP_SHINGLES: "Cap Shingles",
  EXPORT:       "Export PDF",
};

const STEP_TIP: Partial<Record<Step, string>> = {
  TRACE:        "Click to place outline points. Click the first point again to close the shape.",
  TEAROFF:      "The decking texture appears once your outline is closed.",
  GUTTER_APRON: "Gutter apron sits beneath ice & water at the eave — installed first.",
  ICE_WATER:    "Apply at least 24\" up from the eave and 36\" into each valley.",
  SYNTHETIC:    "Laps 2\" at each course. Runs horizontally across the full field.",
  DRIP_EDGE:    "Installed on rake edges after underlayment, before cap shingles.",
  VALLEY_METAL: "Set a color in Settings to upgrade from galvanized to W-valley metal.",
  PRO_START:    "Starter strip provides the sealant bond for the first shingle course.",
  SHINGLES:     "Architectural shingles install bottom-to-top with a 5⅝\" exposure.",
  RIDGE_VENT:   "Size the vent to match the attic's net free area for proper airflow.",
  CAP_SHINGLES: "Each cap piece overlaps 5\" and is nailed through the ridge vent.",
  EXPORT:       "The PDF has two pages: finished shingles + underlayment/metals layer.",
};

// Returns the subset of STEPS that should appear given the lines drawn across all roofs.
// Steps for which no relevant edge type exists are silently skipped during navigation.
function relevantSteps(roofs: Roof[]): Set<Step> {
  const allLines = roofs.flatMap((r) => r.lines);
  const has = (k: LineKind) => allLines.some((l) => l.kind === k);
  const s = new Set<Step>([
    "START", "TRACE", "TEAROFF", "ICE_WATER", "SYNTHETIC", "SHINGLES", "EXPORT",
  ]);
  if (has("EAVE"))                   s.add("GUTTER_APRON");
  if (has("RAKE"))                   s.add("DRIP_EDGE");
  if (has("VALLEY"))                 s.add("VALLEY_METAL");
  if (has("EAVE") || has("RAKE"))    s.add("PRO_START");
  if (has("RIDGE")) { s.add("RIDGE_VENT"); s.add("CAP_SHINGLES"); }
  return s;
}

function useHtmlImage(src?: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    // Clear stale image immediately so a previous project's photo never leaks
    // into a different project while the new image is loading.
    setImg(null);
    if (!src) return;
    const i = new window.Image();
    // crossOrigin only for data: URLs — needed for canvas export.
    // External URLs (Vercel Blob CDN) load without it; setting it can block
    // the load if the CDN doesn't return the expected CORS header.
    if (src.startsWith("data:")) i.crossOrigin = "anonymous";
    i.onload = () => setImg(i);
    i.onerror = () => setImg(null);
    i.src = src;
  }, [src]);

  return img;
}

function clipPolygonPath(ctx: any, pts: number[]) {
  if (!pts || pts.length < 6) return;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
}

function defaultRoof(name: string): Roof {
  return {
    id: uid(),
    name,
    outline: [],
    closed: false,
    holes: [],
    lines: [],

    // standards
    gutterApronW: 3,
    dripEdgeW: 3,
    iceWaterEaveW: 40,
    iceWaterValleyW: 20,
    valleyMetalW: 10,
    proStartW: 12,
    ridgeVentW: 4,
    capW: 3,

    gutterApronColor: "Aluminum",
    dripEdgeColor: "Aluminum",
    valleyMetalColor: "Galvanized",

    // smaller shingles by default
    shingleScale: 0.20,
    shingleRotation: 0,
    proStartOnRakes: true,

    iceWaterOnEaves: true,
    iceWaterOnValleys: true,
    iceWaterBrush: [],
    iceWaterBrushSize: 30,
  };
}

/* ---------- Procedural textures (big canvas => no obvious tile boxes) ---------- */
function addNoise(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  count: number,
  a1: number,
  a2: number
) {
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = a1 + Math.random() * (a2 - a1);
    ctx.fillStyle = Math.random() > 0.5 ? "#000" : "#fff";
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1);
  }
  ctx.globalAlpha = 1;
}

function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, a = 0.08) {
  const g = ctx.createRadialGradient(
    w * 0.5,
    h * 0.45,
    Math.min(w, h) * 0.15,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.8
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function shinglePalette(c: ShingleColor) {
  switch (c) {
    case "Barkwood":
      return { top: "#6f4f34", bot: "#24140e" };
    case "Charcoal":
      return { top: "#4b4e55", bot: "#151619" };
    case "WeatheredWood":
      return { top: "#6a6256", bot: "#231f1a" };
    case "PewterGray":
      return { top: "#7a8087", bot: "#262b31" };
    case "OysterGray":
      return { top: "#8d9092", bot: "#33373c" };
    case "Slate":
      return { top: "#5d6a79", bot: "#1b2128" };
    case "Black":
      return { top: "#2f3135", bot: "#070809" };
  }
}

function makeDeckingTexture(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1200, Math.floor(w));
  c.height = Math.max(1200, Math.floor(h));
  const ctx = c.getContext("2d")!;
  const W = c.width,
    H = c.height;

  const bg = ctx.createLinearGradient(0, 0, W, 0);
  bg.addColorStop(0, "#e1b781");
  bg.addColorStop(1, "#c28a49");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < 2400; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const len = 12 + Math.random() * 52;
    const thick = 1 + Math.random() * 4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.random() * Math.PI);
    ctx.globalAlpha = 0.1 + Math.random() * 0.22;
    ctx.fillStyle = Math.random() > 0.5 ? "#b77d40" : "#a66e36";
    ctx.fillRect(-len * 0.5, -thick * 0.5, len, thick);
    ctx.restore();
  }

  addNoise(ctx, W, H, 180000, 0.004, 0.05);
  vignette(ctx, W, H, 0.06);
  return c.toDataURL("image/png");
}

function makeSyntheticTexture(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1200, Math.floor(w));
  c.height = Math.max(1200, Math.floor(h));
  const ctx = c.getContext("2d")!;
  const W = c.width,
    H = c.height;

  const bg = ctx.createLinearGradient(0, 0, W, 0);
  bg.addColorStop(0, "#f8fbff");
  bg.addColorStop(1, "#d7e6f5");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = "#92a4b3";
  ctx.lineWidth = 1;
  const spacing = 22;
  for (let x = 0; x < W; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = "rgba(25,103,210,0.35)";
  ctx.lineWidth = 2;
  for (let y = 0; y < H; y += 170) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  addNoise(ctx, W, H, 200000, 0.003, 0.04);
  vignette(ctx, W, H, 0.06);
  return c.toDataURL("image/png");
}

function makeShingleTexture(_w: number, _h: number, color: ShingleColor) {
  // Flat-color base so the tile seams never show as color bands on large roofs.
  const W = 2400, H = 2400;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;

  const pal = shinglePalette(color);

  // Uniform base — no gradient so the repeating tile is invisible.
  ctx.fillStyle = pal.top;
  ctx.fillRect(0, 0, W, H);

  const courseH = 11; // exposure height — must match fillPatternOffsetY calculation
  const tabW    = 16; // shingle tab width

  for (let row = 0; row * courseH < H + courseH; row++) {
    const y = row * courseH;
    const offset = (row % 2) * (tabW / 2);

    // Shadow strip at the butt edge of each course (uses the shingle's own dark tone).
    ctx.globalAlpha = 0.40;
    ctx.fillStyle = pal.bot;
    ctx.fillRect(0, y, W, 2);

    // Very faint highlight just below, giving the butt edge a slight lift.
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, y + 2, W, 1);

    // Tab cut dividers — faint, top 55% of exposure only.
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = pal.bot;
    ctx.lineWidth = 0.9;
    for (let col = 0; col < Math.ceil(W / tabW) + 2; col++) {
      const tx = col * tabW + offset;
      ctx.beginPath();
      ctx.moveTo(tx, y + 2);
      ctx.lineTo(tx, y + courseH * 0.55);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  // Minimal noise for a slight granular texture.
  addNoise(ctx, W, H, 28000, 0.003, 0.022);
  return c.toDataURL("image/png");
}

// ── Photo-derived shingle texture ──────────────────────────────────────────
// Samples the uploaded photo in a mosaic of patches, adds shingle course lines,
// contrast/desaturation normalization, noise, and vignette.
// Returns a data URL (jpeg); empty string on any error → caller falls back to
// the procedural makeShingleTexture.
function makePhotoShingleTexture(photoImg: HTMLImageElement): string {
  try {
    const SIZE = 1024;
    const c = document.createElement("canvas");
    c.width = SIZE; c.height = SIZE;
    const ctx = c.getContext("2d")!;

    const iw = photoImg.naturalWidth  || photoImg.width;
    const ih = photoImg.naturalHeight || photoImg.height;
    if (iw < 4 || ih < 4) throw new Error("image too small");

    // ── 1. Mosaic: sample random patches from a central region of the photo ──
    const PATCH = 96;
    const cols = Math.ceil(SIZE / PATCH) + 1;
    const rows = Math.ceil(SIZE / PATCH) + 1;
    const MARGIN = 0.08; // avoid extreme edges of the photo

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // Reproducible-enough random via Math.sin hash
        const seed = (row * 31 + col * 17 + 3);
        const rand = (n: number) => Math.abs(Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1;

        const sx = (MARGIN + rand(0) * (1 - 2 * MARGIN)) * iw;
        const sy = (MARGIN + rand(1) * (1 - 2 * MARGIN)) * ih;
        const sw = Math.max(8, Math.min(iw * 0.22, iw - sx));
        const sh = Math.max(8, Math.min(ih * 0.22, ih - sy));
        const dx = col * PATCH;
        const dy = row * PATCH;
        const jitter = (rand(2) - 0.5) * 6;

        ctx.save();
        ctx.translate(dx + PATCH / 2, dy + PATCH / 2);
        ctx.rotate((rand(3) - 0.5) * 0.05); // tiny rotation
        ctx.drawImage(photoImg, sx, sy, sw, sh, -PATCH / 2 + jitter, -PATCH / 2 + jitter, PATCH, PATCH);
        ctx.restore();
      }
    }

    // ── 2. Color normalize: slight desaturation + contrast bump ──
    const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = imgData.data;
    let lumSum = 0;
    for (let i = 0; i < d.length; i += 4) lumSum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const mean = lumSum / (d.length / 4);
    const factor = 1.16; // contrast multiplier
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      // Desaturate 12%
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      r = r * 0.88 + lum * 0.12;
      g = g * 0.88 + lum * 0.12;
      b = b * 0.88 + lum * 0.12;
      // Contrast
      d[i]     = Math.max(0, Math.min(255, Math.round((r - mean) * factor + mean)));
      d[i + 1] = Math.max(0, Math.min(255, Math.round((g - mean) * factor + mean)));
      d[i + 2] = Math.max(0, Math.min(255, Math.round((b - mean) * factor + mean)));
    }
    ctx.putImageData(imgData, 0, 0);

    // ── 3. Shingle course lines (horizontal) + tab cuts ──
    const courseH = 11;
    const tabW    = 16;
    ctx.globalCompositeOperation = "multiply";
    for (let y = 0; y < SIZE; y += courseH) {
      // Butt-edge shadow
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, y, SIZE, 2);
      // Highlight below butt edge
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, y + 2, SIZE, 1);
      ctx.globalCompositeOperation = "multiply";
      // Tab dividers (faint, upper half of course)
      ctx.globalAlpha = 0.06;
      ctx.fillStyle = "#000000";
      const offset = (Math.round(y / courseH) % 2) * (tabW / 2);
      for (let x = offset; x < SIZE; x += tabW) {
        ctx.fillRect(x, y + 2, 1, Math.round(courseH * 0.55));
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // ── 4. Noise ──
    addNoise(ctx, SIZE, SIZE, 14000, 0.002, 0.014);

    // ── 5. Subtle vignette ──
    const vg = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.28, SIZE / 2, SIZE / 2, SIZE * 0.80);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.13)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    return c.toDataURL("image/jpeg", 0.88);
  } catch {
    return ""; // fallback to procedural shingle texture
  }
}

/* ---------- strokes ---------- */
function ShinyMetalStroke({
  points,
  width,
  color,
  opacity = 0.98,
}: {
  points: number[];
  width: number;
  color: MetalColor;
  opacity?: number;
}) {
  return (
    <Group>
      <Line
        points={points}
        stroke={metalRGBA(color, opacity)}
        strokeWidth={width}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        shadowColor="rgba(0,0,0,0.18)"
        shadowBlur={6}
        shadowOffset={{ x: 0, y: 1 }}
        shadowOpacity={0.14}
      />
      <Line
        points={points}
        stroke="rgba(255,255,255,0.28)"
        strokeWidth={Math.max(2, width * 0.22)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        opacity={0.9}
      />
      <Line
        points={points}
        stroke="rgba(0,0,0,0.14)"
        strokeWidth={Math.max(1, width * 0.1)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        dash={[6, 10]}
        opacity={0.65}
      />
    </Group>
  );
}

function StarterStroke({ points, width }: { points: number[]; width: number }) {
  return (
    <Group>
      <Line
        points={points}
        stroke="rgba(18,18,20,0.92)"
        strokeWidth={width}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        shadowColor="rgba(0,0,0,0.12)"
        shadowBlur={5}
        shadowOffset={{ x: 0, y: 1 }}
        shadowOpacity={0.12}
      />
      <Line
        points={points}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={Math.max(2, width * 0.18)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        opacity={0.82}
      />
    </Group>
  );
}

function RidgeVentStroke({ points, width }: { points: number[]; width: number }) {
  return (
    <Group>
      <Line
        points={points}
        stroke="rgba(15,15,16,0.90)"
        strokeWidth={width}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        shadowColor="rgba(0,0,0,0.12)"
        shadowBlur={5}
        shadowOffset={{ x: 0, y: 1 }}
        shadowOpacity={0.12}
      />
      <Line
        points={points}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={Math.max(2, width * 0.16)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        opacity={0.85}
      />
      <Line
        points={points}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={Math.max(2, width * 0.10)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
        dash={[6, 8]}
        opacity={0.75}
      />
    </Group>
  );
}

function CapBand({
  points,
  width,
  shinglesImg,
  patternScale,
  clipStrokeWidth,
}: {
  points: number[];
  width: number;
  shinglesImg: HTMLImageElement;
  patternScale: number;
  clipStrokeWidth?: number;
}) {
  if (points.length < 4) return null;

  const clipW = clipStrokeWidth ?? width;

  return (
    <Group
      clipFunc={(ctx) => {
        ctx.save();
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = clipW;
        ctx.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
        ctx.stroke();
        ctx.restore();
      }}
    >
      <Rect
        x={-5000}
        y={-5000}
        width={12000}
        height={12000}
        fillPatternImage={shinglesImg}
        fillPatternRepeat="repeat"
        fillPatternScaleX={patternScale}
        fillPatternScaleY={patternScale}
        opacity={0.98}
      />
      <Rect x={-5000} y={-5000} width={12000} height={12000} fill="rgba(255,255,255,0.35)" />
      <Line
        points={points}
        stroke="rgba(0,0,0,0.18)"
        strokeWidth={Math.max(1, width * 0.18)}
        strokeScaleEnabled={false}
        lineCap="round"
        lineJoin="round"
      />
    </Group>
  );
}

/* ------------------- Roof auto-detection ------------------- */

// Andrew's monotone-chain convex hull
function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const s = [...pts].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  const cross = (o: [number,number], a: [number,number], b: [number,number]) =>
    (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const lower: [number,number][] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number,number][] = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0,-1), ...upper.slice(0,-1)];
}

type AutoSuggest = { outline: number[]; lines: Array<{ kind: LineKind; points: number[] }> };

// Sobel-edge + Hough-transform roof line detector (runs client-side on a small canvas).
function autoDetectRoof(img: HTMLImageElement, displayW: number, displayH: number): AutoSuggest {
  const MAX = 350;
  const sc = Math.min(MAX / img.naturalWidth, MAX / img.naturalHeight);
  const pw = Math.max(1, Math.round(img.naturalWidth * sc));
  const ph = Math.max(1, Math.round(img.naturalHeight * sc));
  const toX = (x: number) => (x / sc) * (displayW / img.naturalWidth);
  const toY = (y: number) => (y / sc) * (displayH / img.naturalHeight);

  // Draw image to small processing canvas
  const tc = document.createElement("canvas");
  tc.width = pw; tc.height = ph;
  const tCtx = tc.getContext("2d")!;
  tCtx.drawImage(img, 0, 0, pw, ph);
  const { data } = tCtx.getImageData(0, 0, pw, ph);

  // Grayscale
  const gray = new Float32Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    gray[i] = 0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2];
  }

  // Gaussian blur 3×3 (reduces noise before edge detection)
  const bl = new Float32Array(pw * ph);
  for (let y = 1; y < ph-1; y++) for (let x = 1; x < pw-1; x++) {
    bl[y*pw+x] = (
      gray[(y-1)*pw+(x-1)] + 2*gray[(y-1)*pw+x] + gray[(y-1)*pw+(x+1)] +
      2*gray[y*pw+(x-1)] + 4*gray[y*pw+x] + 2*gray[y*pw+(x+1)] +
      gray[(y+1)*pw+(x-1)] + 2*gray[(y+1)*pw+x] + gray[(y+1)*pw+(x+1)]
    ) / 16;
  }

  // Sobel edge magnitude + binary threshold at 22% of max
  const mag = new Float32Array(pw * ph);
  let mx = 0;
  for (let y = 1; y < ph-1; y++) for (let x = 1; x < pw-1; x++) {
    const gx = -bl[(y-1)*pw+(x-1)] + bl[(y-1)*pw+(x+1)] - 2*bl[y*pw+(x-1)] + 2*bl[y*pw+(x+1)] - bl[(y+1)*pw+(x-1)] + bl[(y+1)*pw+(x+1)];
    const gy = -bl[(y-1)*pw+(x-1)] - 2*bl[(y-1)*pw+x] - bl[(y-1)*pw+(x+1)] + bl[(y+1)*pw+(x-1)] + 2*bl[(y+1)*pw+x] + bl[(y+1)*pw+(x+1)];
    mag[y*pw+x] = Math.hypot(gx, gy);
    if (mag[y*pw+x] > mx) mx = mag[y*pw+x];
  }
  const edge = new Uint8Array(pw * ph);
  for (let i = 0; i < pw*ph; i++) edge[i] = mag[i] >= mx * 0.22 ? 1 : 0;

  // Standard Hough transform
  const diag = Math.ceil(Math.hypot(pw, ph));
  const NT = 180, NR = 2*diag+1;
  const acc = new Int32Array(NT * NR);
  const cLUT = new Float32Array(NT), sLUT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cLUT[t] = Math.cos(t*Math.PI/NT); sLUT[t] = Math.sin(t*Math.PI/NT); }
  for (let y = 1; y < ph-1; y++) for (let x = 1; x < pw-1; x++) {
    if (!edge[y*pw+x]) continue;
    for (let t = 0; t < NT; t++) {
      const r = Math.round(x*cLUT[t] + y*sLUT[t]) + diag;
      if (r >= 0 && r < NR) acc[t*NR+r]++;
    }
  }

  // Extract top 7 peaks with tighter neighbourhood suppression
  const minV = Math.max(25, Math.min(pw, ph) * 0.16);
  const peaks: {t: number; r: number; v: number}[] = [];
  const sup = new Uint8Array(NT * NR);
  for (let i = 0; i < 7; i++) {
    let best = 0, bt = 0, br = 0;
    for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) {
      if (!sup[t*NR+r] && acc[t*NR+r] > best) { best = acc[t*NR+r]; bt = t; br = r; }
    }
    if (best < minV) break;
    peaks.push({ t: bt, r: br, v: best });
    // Wider suppression window to prevent near-duplicate lines
    for (let dt = -15; dt <= 15; dt++) for (let dr = -30; dr <= 30; dr++) {
      const nt = ((bt+dt)%NT+NT)%NT, nr = br+dr;
      if (nr >= 0 && nr < NR) sup[nt*NR+nr] = 1;
    }
  }

  // Classify each detected line
  const classify = (tIdx: number, pts: number[]): LineKind => {
    const deg = (tIdx * 180) / NT;
    if (deg > 65 && deg < 115) return (pts[1] + pts[3]) / 2 < displayH * 0.5 ? "RIDGE" : "EAVE";
    if (deg < 25 || deg > 155) return "RAKE";
    return deg < 90 ? "HIP" : "VALLEY";
  };

  const allLines: AutoSuggest["lines"] = [];
  const lineEqs: { ct: number; st: number; rho: number }[] = [];
  for (const { t, r } of peaks) {
    const rho = r - diag, ct = cLUT[t], st = sLUT[t];
    lineEqs.push({ ct, st, rho });
    const cp: number[] = [];
    const addPt = (px: number, py: number) => {
      if (px >= -1 && px <= pw+1 && py >= -1 && py <= ph+1) cp.push(px, py);
    };
    if (Math.abs(st) > 0.01) { addPt(0, rho/st); addPt(pw, (rho-pw*ct)/st); }
    if (Math.abs(ct) > 0.01) { addPt(rho/ct, 0); addPt((rho-ph*st)/ct, ph); }
    if (cp.length >= 4) {
      const pts = [toX(cp[0]), toY(cp[1]), toX(cp[cp.length-2]), toY(cp[cp.length-1])];
      allLines.push({ kind: classify(t, pts), points: pts });
    }
  }

  // Limit to at most 2 lines per kind so the result stays clean
  const maxPerKind: Record<LineKind, number> = { EAVE: 2, RAKE: 2, VALLEY: 2, RIDGE: 1, HIP: 2 };
  const kindCounts: Partial<Record<LineKind, number>> = {};
  const lines = allLines.filter((l) => {
    const cnt = kindCounts[l.kind] ?? 0;
    if (cnt >= maxPerKind[l.kind]) return false;
    kindCounts[l.kind] = cnt + 1;
    return true;
  });

  // Find intersections of line pairs → convex hull → outline polygon
  const iPts: [number, number][] = [];
  for (let i = 0; i < lineEqs.length; i++) for (let j = i+1; j < lineEqs.length; j++) {
    const { ct: c1, st: s1, rho: r1 } = lineEqs[i], { ct: c2, st: s2, rho: r2 } = lineEqs[j];
    const det = c1*s2 - c2*s1;
    if (Math.abs(det) < 0.01) continue;
    const ix = (r1*s2 - r2*s1) / det, iy = (c1*r2 - c2*r1) / det;
    if (ix >= 0 && ix <= pw && iy >= 0 && iy <= ph) iPts.push([toX(ix), toY(iy)]);
  }
  // Fall back to image corners if too few intersections
  if (iPts.length < 3) {
    iPts.push([toX(0),toY(0)],[toX(pw),toY(0)],[toX(pw),toY(ph)],[toX(0),toY(ph)]);
  }
  const outline = convexHull(iPts).flatMap(p => p);
  return { outline, lines };
}

/* ------------------- Ramer-Douglas-Peucker polygon simplification --------- */
function rdpSimplify(pts: [number, number][], epsilon: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  let maxDist = 0, maxIdx = 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const dist = len > 0
      ? Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len
      : Math.hypot(px - x1, py - y1);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    return [
      ...rdpSimplify(pts.slice(0, maxIdx + 1), epsilon).slice(0, -1),
      ...rdpSimplify(pts.slice(maxIdx), epsilon),
    ];
  }
  return [pts[0], pts[pts.length - 1]];
}

type PhotoTransform = { scale: number; drawW: number; drawH: number; offX: number; offY: number; imgW: number; imgH: number };

/** Compute a "contain" photo transform — photo fits inside stage without distortion */
function getPhotoTransform(imgW: number, imgH: number, sw: number, sh: number): PhotoTransform {
  const scale = Math.min(sw / imgW, sh / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return { scale, drawW, drawH, offX: (sw - drawW) / 2, offY: (sh - drawH) / 2, imgW, imgH };
}

/** Image-space flat array → stage-space flat array */
function imgToStage(pts: number[], tx: PhotoTransform): number[] {
  return pts.map((v, i) => (i % 2 === 0 ? tx.offX + v * tx.scale : tx.offY + v * tx.scale));
}

/** Stage-space flat array → image-space flat array */
function stageToImgPts(pts: number[], tx: PhotoTransform): number[] {
  return pts.map((v, i) => (i % 2 === 0 ? (v - tx.offX) / tx.scale : (v - tx.offY) / tx.scale));
}

/* ------------------- Main ------------------- */
export default function Page() {
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [projectName, setProjectName] = useState("My Roof Project");

  const [w, setW] = useState(1100);
  const [h, setH] = useState(700);
  const [stageKey, setStageKey] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setW(Math.max(1, Math.floor(r.width)));
      setH(Math.max(1, Math.floor(r.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [photos, setPhotos] = useState<PhotoProject[]>([]);
  const [activePhotoId, setActivePhotoId] = useState<string>("");
  const [screen, setScreen] = useState<"MENU" | "PROJECT" | "CUSTOMER_VIEW">("MENU");
  const [customerViewData, setCustomerViewData] = useState<{
    name: string;
    shingleColor: ShingleColor;
    photos: Array<{ src: string; roofs: Roof[]; canvasW: number; canvasH: number }>;
  } | null>(null);
  const [customerPhotoIdx, setCustomerPhotoIdx] = useState(0);
  const [customerStep, setCustomerStep] = useState<Step>("TEAROFF");
  const [customerShingleColor, setCustomerShingleColor] = useState<ShingleColor>("Barkwood");
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [shareEmailSending, setShareEmailSending] = useState(false);
  const [shareEmailSent, setShareEmailSent] = useState(false);
  const [shareStatus, setShareStatus] = useState<"" | "compressing" | "uploading" | "sending" | "copied">("");
  const [shareErrorMsg, setShareErrorMsg] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);

  const active = useMemo(() => {
    if (screen === "CUSTOMER_VIEW" && customerViewData) {
      const photoData = customerViewData.photos[customerPhotoIdx] ?? customerViewData.photos[0];
      if (!photoData) return null;
      const cw = photoData.canvasW || 0;
      const ch = photoData.canvasH || 0;

      // Fit the stage to the roof polygon bounding box so the roof fills the view.
      const allPts = photoData.roofs.flatMap((r) => r.closed ? r.outline : []);
      const ptXs = allPts.filter((_, i) => i % 2 === 0);
      const ptYs = allPts.filter((_, i) => i % 2 === 1);
      let fitScale = 1, fitX = 0, fitY = 0;

      if (ptXs.length >= 2 && w > 0 && h > 0) {
        const minX = Math.min(...ptXs), maxX = Math.max(...ptXs);
        const minY = Math.min(...ptYs), maxY = Math.max(...ptYs);
        const bboxW = maxX - minX || 1;
        const bboxH = maxY - minY || 1;
        const pad = 0.14;
        fitScale = Math.min(
          (w * (1 - 2 * pad)) / bboxW,
          (h * (1 - 2 * pad)) / bboxH,
        );
        fitX = w / 2 - ((minX + maxX) / 2) * fitScale;
        fitY = h / 2 - ((minY + maxY) / 2) * fitScale;
      } else if (cw > 0 && ch > 0 && w > 0 && h > 0) {
        fitScale = Math.min(w / cw, h / ch) * 0.90;
        fitX = (w - cw * fitScale) / 2;
        fitY = (h - ch * fitScale) / 2;
      }

      return {
        id: "customer-view",
        name: customerViewData.name,
        src: photoData.src,
        photoSrcs: [],
        step: customerStep,
        roofs: photoData.roofs,
        activeRoofId: photoData.roofs[0]?.id ?? "",
        shingleColor: customerShingleColor,
        showGuidesDuringInstall: false,
        showEditHandles: false,
        realisticMode: false,
        realisticStrength: 0.6,
        stageScale: fitScale,
        stagePos: { x: fitX, y: fitY },
        photoStates: {},
        _customerCanvasW: cw,
        _customerCanvasH: ch,
      } as PhotoProject & { _customerCanvasW: number; _customerCanvasH: number };
    }
    return photos.find((p) => p.id === activePhotoId) || null;
  }, [photos, activePhotoId, screen, customerViewData, customerPhotoIdx, customerStep, customerShingleColor, w, h]);
  const photoImg = useHtmlImage(active?.src);

  const activeRoof = useMemo(() => {
    if (!active) return null;
    return active.roofs.find((r) => r.id === active.activeRoofId) || null;
  }, [active]);

  const [tool, setTool] = useState<Tool>("NONE");
  const [draftLine, setDraftLine] = useState<Polyline | null>(null);
  const [draftHole, setDraftHole] = useState<number[] | null>(null);
  const brushPaintingRef = useRef(false);
  const brushStrokeRef = useRef<number[]>([]);
  const [brushDraft, setBrushDraft] = useState<{ points: number[]; size: number } | null>(null);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [uiTab, setUiTab] = useState<"edit" | "settings">("edit");
  const [presentationMode, setPresentationMode] = useState(false);
  const [isCustomerView, setIsCustomerView] = useState(false);
  // Save stageScale/stagePos before entering customer view so we can restore on exit
  const savedEditViewRef = useRef<{ stageScale: number; stagePos: { x: number; y: number } } | null>(null);

  const photoTx = useMemo((): PhotoTransform => {
    const img = photoImg as HTMLImageElement | undefined;
    if (!img?.naturalWidth || !img?.naturalHeight) {
      return { scale: 1, drawW: w, drawH: h, offX: 0, offY: 0, imgW: w, imgH: h };
    }
    return getPhotoTransform(img.naturalWidth, img.naturalHeight, w, h);
  }, [photoImg, w, h]);

  // ── Cleanup state ─────────────────────────────────────────────────────────
  const [cleanupOpen, setCleanupOpen]           = useState(false);
  const [cleanupStrength, setCleanupStrength]   = useState(0.5);       // 0–1
  const [cleanupSnapAngles, setCleanupSnapAngles] = useState(false);
  const [cleanupLockedIds, setCleanupLockedIds] = useState<Set<string>>(new Set());
  // Snapshot of the roof BEFORE the last applied cleanup — enables one-step undo
  const [cleanupUndoRoof, setCleanupUndoRoof]   = useState<Roof | null>(null);

  // ── Edge Detection + Plane Suggestion state ────────────────────────────────
  const [edgePanel, setEdgePanel]               = useState(false);
  const [edgeDetecting, setEdgeDetecting]       = useState(false);
  const [detectedSegs, setDetectedSegs]         = useState<LabeledSegment[]>([]);
  const [erasedSegIds, setErasedSegIds]         = useState<Set<string>>(new Set());
  // Spatial erase mask: midpoints of erased segments — survives re-detection
  const [edgeErasedMask, setEdgeErasedMask]     = useState<Array<{x: number; y: number}>>([]);
  const [userAddedSegs, setUserAddedSegs]       = useState<LabeledSegment[]>([]);
  const [edgeSensitivity, setEdgeSensitivity]   = useState(0.5);
  const [edgeDetailSuppression, setEdgeDetailSuppression] = useState(0.5);
  const [edgeMinLine, setEdgeMinLine]           = useState(0.06); // 6% default (roof-optimised)
  const [edgeDominantOnly, setEdgeDominantOnly] = useState(true);
  const [edgeNumDirections, setEdgeNumDirections] = useState(3);
  const [edgeMaxLines, setEdgeMaxLines]         = useState(80);
  const [showDetectedLayer, setShowDetectedLayer] = useState(true);
  const [edgeTool, setEdgeTool]                 = useState<"NONE" | "ERASE_EDGE" | "ADD_EDGE">("NONE");
  const [edgeAddDraft, setEdgeAddDraft]         = useState<[number, number] | null>(null);
  const [planeSuggs, setPlaneSuggs]             = useState<PlaneSuggestion[]>([]);
  const [hoveredSuggId, setHoveredSuggId]       = useState<string | null>(null);
  const [suggestingPlanes, setSuggestingPlanes] = useState(false);
  // Facade vs top-down mode
  const [edgeMode, setEdgeMode]                 = useState<"facade" | "topDown">("topDown");
  const [edgeRoofRegionFraction, setEdgeRoofRegionFraction] = useState(0.5);
  const [edgeIgnoreVertical, setEdgeIgnoreVertical] = useState(true);
  const [edgeSkyBoundaryBias, setEdgeSkyBoundaryBias] = useState(true);
  const [edgeContrastThreshold, setEdgeContrastThreshold] = useState(0.06);
  const [edgePerDirectionCap, setEdgePerDirectionCap] = useState(2);

  // All visible segments (detected − erased + user-added), capped + sorted for display
  const visibleSegs = useMemo<LabeledSegment[]>(() => {
    const base = detectedSegs.filter((s) => !erasedSegIds.has(s.id));
    return [...base, ...userAddedSegs];
  }, [detectedSegs, erasedSegIds, userAddedSegs]);

  // Display-capped version sorted by length descending
  const displaySegs = useMemo<LabeledSegment[]>(() => {
    return visibleSegs.slice().sort((a, b) => b.length - a.length).slice(0, edgeMaxLines);
  }, [visibleSegs, edgeMaxLines]);

  // Live preview of cleaned geometry — recomputed whenever the panel is open or settings change
  const cleanupPreview = useMemo<Roof | null>(() => {
    if (!cleanupOpen || !activeRoof) return null;
    const opts = strengthToOptions(cleanupStrength, cleanupSnapAngles, cleanupLockedIds);
    return cleanupGeometry(activeRoof, opts) as Roof;
  }, [cleanupOpen, activeRoof, cleanupStrength, cleanupSnapAngles, cleanupLockedIds]);

  const [exportView, setExportView] = useState<ExportView>("LIVE");
  const [autoSuggest, setAutoSuggest] = useState<AutoSuggest | null>(null);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [aiState, setAiState]       = useState<"idle" | "loading" | "preview" | "error">("idle");
  const [aiPolygon, setAiPolygon]   = useState<number[] | null>(null);
  const [aiPolygonRaw, setAiPolygonRaw] = useState<number[] | null>(null);
  const [aiShowRaw, setAiShowRaw]   = useState(false);
  const [aiError, setAiError]       = useState<string | null>(null);
  const [autoLabelState, setAutoLabelState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [autoLabelSuggestions, setAutoLabelSuggestions] = useState<
    { kind: "RIDGE" | "VALLEY"; points: number[]; confidence: number }[]
  >([]);
  const [autoLabelError, setAutoLabelError] = useState<string | null>(null);
  const [aiJudgeResult, setAiJudgeResult] = useState<{
    eave: { count: number };
    rake: { count: number };
    ridge: { confidence: "high" | "medium" | "low" | "none"; reasons: string[]; hasCandidates: boolean };
    valley: { confidence: "labeled" | "possible" | "none"; reasons: string[]; hasCandidates: boolean };
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");

  // Persist projects to localStorage whenever they change.
  useEffect(() => {
    if (typeof window === "undefined" || photos.length === 0) return;
    try { localStorage.setItem("roofviz_v3", JSON.stringify(photos)); } catch {}
    try { if (activePhotoId) localStorage.setItem("roofviz_v3_active", activePhotoId); } catch {}
  }, [photos, activePhotoId]);

  // On mount: check for customer share link, then load localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Customer share link takes priority — if ?share= is present, ALWAYS
    // show customer view, never fall through to the full editor.
    const params = new URLSearchParams(window.location.search);
    const shareParam = params.get("share");
    if (shareParam) {
      try {
        const json = decodeURIComponent(escape(atob(shareParam.replace(/-/g, "+").replace(/_/g, "/"))));
        const raw = JSON.parse(json);
        // Support both compact keys (new) and full keys (legacy links)
        const name = raw.n ?? raw.name ?? "Roof Preview";
        const shingleColor: ShingleColor = raw.c ?? raw.shingleColor ?? "Barkwood";

        function decodeRoofs(rawRoofs: any[]): Roof[] {
          return rawRoofs.map((r: any) => ({
            id: r.id ?? uid(),
            name: r.name ?? "Roof 1",
            closed: r.cl === 1 || r.closed === true,
            outline: r.o ?? r.outline ?? [],
            holes: r.h ?? r.holes ?? [],
            lines: (r.l ?? r.lines ?? []).map((l: any) => ({
              id: l.id ?? uid(),
              kind: l.k ?? l.kind,
              points: l.p ?? l.points ?? [],
            })),
            shingleScale: r.sc ?? r.shingleScale ?? 0.20,
            shingleRotation: r.sr ?? 0,
            valleyMetalColor: r.vc ?? r.valleyMetalColor ?? "Galvanized",
            valleyMetalW: r.vw ?? r.valleyMetalW ?? 18,
            gutterApronW: r.gaw ?? 8,
            gutterApronColor: r.gac ?? "Aluminum",
            dripEdgeW: r.dew ?? 8,
            dripEdgeColor: r.dec ?? "Aluminum",
            iceWaterEaveW: r.iwe ?? 40,
            iceWaterValleyW: r.iwv ?? 20,
            proStartW: r.psw ?? 12,
            ridgeVentW: r.rvw ?? 12,
            capW: r.cpw ?? 8,
            proStartOnRakes: r.por === 1,
            iceWaterOnEaves: r.iwe_on !== false,
            iceWaterOnValleys: r.iwv_on !== false,
            iceWaterBrush: [],
            iceWaterBrushSize: r.iwbs ?? 30,
          }));
        }

        // New multi-photo format: raw.photos array
        // Legacy single-photo format: raw.r + raw.p + raw.cw + raw.ch
        let photos: Array<{ src: string; roofs: Roof[]; canvasW: number; canvasH: number }>;
        if (Array.isArray(raw.photos) && raw.photos.length > 0) {
          photos = raw.photos.map((ph: any) => ({
            src: ph.p ?? "",
            roofs: decodeRoofs(ph.r ?? []),
            canvasW: ph.cw ?? 0,
            canvasH: ph.ch ?? 0,
          }));
        } else {
          // Legacy: single photo
          photos = [{
            src: raw.p ?? "",
            roofs: decodeRoofs(raw.r ?? raw.roofs ?? []),
            canvasW: raw.cw ?? 0,
            canvasH: raw.ch ?? 0,
          }];
        }

        setCustomerViewData({ name, shingleColor, photos });
        setCustomerPhotoIdx(0);
        setCustomerShingleColor(shingleColor);
        setCustomerStep("TEAROFF");
      } catch {
        // Decode failed — show blank customer view rather than exposing the editor
        setCustomerViewData({ name: "Preview", shingleColor: "Barkwood", photos: [{ src: "", roofs: [], canvasW: 0, canvasH: 0 }] });
      }
      setScreen("CUSTOMER_VIEW");
      return;
    }

    // Load saved projects and auto-navigate back to active project
    try {
      const raw = localStorage.getItem("roofviz_v3");
      if (raw) {
        const parsed = JSON.parse(raw) as PhotoProject[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = parsed.map((p) => ({
            ...p,
            photoSrcs: p.photoSrcs ?? (p.src ? [p.src] : []),
            photoStates: p.photoStates ?? {},
            realisticMode: p.realisticMode ?? false,
            realisticStrength: p.realisticStrength ?? 0.6,
          }));
          const savedActiveId = localStorage.getItem("roofviz_v3_active");
          const restoredId = migrated.find((p) => p.id === savedActiveId)?.id ?? migrated[0].id;
          setPhotos(migrated);
          setActivePhotoId(restoredId);
          setScreen("MENU");
        }
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Customer View (fullscreen presentation) ────────────────────────────────

  function enterCustomerView() {
    // Save edit-mode zoom/pan so we can restore it after customer view
    savedEditViewRef.current = {
      stageScale: active?.stageScale ?? 1,
      stagePos: active?.stagePos ?? { x: 0, y: 0 },
    };
    setIsCustomerView(true);
    try { document.documentElement.requestFullscreen?.(); } catch {}
  }

  function exitCustomerView() {
    // Restore zoom/pan to what it was before entering customer view
    const saved = savedEditViewRef.current;
    if (saved) {
      patchActive((p) => ({ ...p, stageScale: saved.stageScale, stagePos: saved.stagePos }));
      savedEditViewRef.current = null;
    }
    setIsCustomerView(false);
    if (document.fullscreenElement) {
      try { document.exitFullscreen?.(); } catch {}
    }
  }

  function showToast(msg: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 3200);
  }

  // Helper: measure container after layout settles (double RAF) and bump stageKey
  function scheduleRemeasure() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      setW(Math.max(1, Math.floor(r.width)));
      setH(Math.max(1, Math.floor(r.height)));
    }));
  }

  // Handle native ESC exit from fullscreen (button exit is handled by exitCustomerView directly)
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement && isCustomerView) {
        exitCustomerView();
      }
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomerView]);

  // Force Konva to fully repaint after customer view toggle or any dimension/project change
  useLayoutEffect(() => {
    requestAnimationFrame(() => { stageRef.current?.batchDraw?.(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomerView, w, h, activePhotoId]);

  // Re-measure on window resize / orientation change
  useEffect(() => {
    const handler = () => scheduleRemeasure();
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("orientationchange", handler);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchActive(updater: (p: PhotoProject) => PhotoProject) {
    setPhotos((prev) => prev.map((p) => (p.id === activePhotoId ? updater(p) : p)));
  }

  function patchActiveRoof(updater: (r: Roof) => Roof) {
    if (!active || !activeRoof) return;
    patchActive((p) => ({
      ...p,
      roofs: p.roofs.map((r) => (r.id === activeRoof.id ? updater(r) : r)),
    }));
  }

  // ── AI Roof Outline ────────────────────────────────────────────────────────

  function adoptAiOutline() {
    if (!aiPolygon) return;
    patchActiveRoof((r) => ({ ...r, outline: aiPolygon, closed: true }));
    setAiState("idle"); setAiPolygon(null); setAiPolygonRaw(null); setAiShowRaw(false); setAiError(null);
  }

  function discardAiOutline() {
    setAiState("idle"); setAiPolygon(null); setAiPolygonRaw(null); setAiShowRaw(false); setAiError(null);
    setAutoLabelState("idle"); setAutoLabelSuggestions([]); setAutoLabelError(null);
  }

  async function generateAiOutline() {
    if (!active?.src) return;
    setAiState("loading"); setAiError(null);
    try {
      // Get natural image dimensions (= world coordinate space)
      const [imgNatW, imgNatH] = await new Promise<[number, number]>((resolve, reject) => {
        const img = document.createElement("img");
        img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
        img.onerror = reject;
        img.src = active.src;
      });
      // Resize to max 1024px for API efficiency
      const base64 = await new Promise<string>((resolve, reject) => {
        const img = document.createElement("img");
        img.onload = () => {
          const maxPx = 1024;
          const sc = Math.min(1, maxPx / Math.max(img.width, img.height));
          const cw = Math.round(img.width * sc), ch = Math.round(img.height * sc);
          const cv = document.createElement("canvas");
          cv.width = cw; cv.height = ch;
          cv.getContext("2d")!.drawImage(img, 0, 0, cw, ch);
          resolve(cv.toDataURL("image/jpeg", 0.85).split(",")[1]);
        };
        img.onerror = reject;
        img.src = active.src;
      });

      const res = await fetch("/api/ai/roof-outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { polygon?: { x: number; y: number }[]; confidence?: number; error?: string };

      if (data.error || !data.polygon || data.polygon.length < 3) {
        setAiState("error");
        setAiError("AI couldn't confidently detect this roof. Try manual tracing.");
        return;
      }

      // Normalize → world coords
      const worldPts: [number, number][] = data.polygon.map((pt) => [pt.x * imgNatW, pt.y * imgNatH]);
      if (worldPts.length < 3) {
        setAiState("error");
        setAiError("AI couldn't confidently detect this roof. Try manual tracing.");
        return;
      }
      const rawFlat = worldPts.flatMap(([x, y]) => [x, y]);
      setAiPolygonRaw(rawFlat);
      setAiShowRaw(false);
      // Run cleanup pipeline (RDP + edge snap + straightening)
      const cleaned = await cleanAiOutline(rawFlat, active.src, imgNatW, imgNatH);
      setAiPolygon(cleaned.length >= 6 ? cleaned : rawFlat);
      setAiState("preview");
    } catch (err) {
      console.error("[generateAiOutline]", err);
      setAiState("error");
      setAiError("AI couldn't confidently detect this roof. Try manual tracing.");
    }
  }

  // ── Auto-Label Roof Edges ───────────────────────────────────────────────────

  // ── Ridge cluster helper ──────────────────────────────────────────────────
  // Collects near-horizontal outline edges in the top 40% of Y-range, clusters
  // them by Y-proximity, and merges each qualifying cluster into one span.
  // Does NOT apply the rake-support gate — callers decide.
  function buildRidgeClusters(
    pts: number[], roofWidth: number, roofHeight: number, minY: number
  ): { x1: number; y1: number; x2: number; y2: number; segCount: number; confidence: number }[] {
    const n = pts.length / 2;
    if (n < 3 || roofWidth <= 0) return [];
    const ridgeYZone = minY + 0.40 * roofHeight;

    type RawSeg = { x1: number; y1: number; x2: number; y2: number; len: number };
    const raws: RawSeg[] = [];
    for (let i = 0; i < n; i++) {
      const x1 = pts[i * 2], y1 = pts[i * 2 + 1];
      const j = (i + 1) % n;
      const x2 = pts[j * 2], y2 = pts[j * 2 + 1];
      const dx = x2 - x1, dy = y2 - y1;
      if (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI < 20
          && (y1 + y2) / 2 <= ridgeYZone) {
        raws.push({ x1, y1, x2, y2, len: Math.hypot(dx, dy) });
      }
    }
    if (raws.length === 0) return [];

    raws.sort((a, b) => (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2);
    const yTol = roofHeight * 0.10;
    const clusters: RawSeg[][] = [];
    for (const c of raws) {
      const cMidY = (c.y1 + c.y2) / 2;
      const existing = clusters.find(cl => {
        const clMidY = cl.reduce((s, x) => s + (x.y1 + x.y2) / 2, 0) / cl.length;
        return Math.abs(cMidY - clMidY) <= yTol;
      });
      if (existing) existing.push(c); else clusters.push([c]);
    }

    const result: { x1: number; y1: number; x2: number; y2: number; segCount: number; confidence: number }[] = [];
    for (const cluster of clusters) {
      const totalLen = cluster.reduce((s, c) => s + c.len, 0);
      if (totalLen < roofWidth * 0.30) continue; // too short to be a real ridge (≥30% of width required)
      let minRX = Infinity, maxRX = -Infinity, sumY = 0;
      for (const c of cluster) {
        const lx = Math.min(c.x1, c.x2), rx = Math.max(c.x1, c.x2);
        if (lx < minRX) minRX = lx;
        if (rx > maxRX) maxRX = rx;
        sumY += c.y1 + c.y2;
      }
      const avgY = sumY / (cluster.length * 2);
      const ratio = Math.min(1, totalLen / roofWidth);
      result.push({ x1: minRX, y1: avgY, x2: maxRX, y2: avgY,
        segCount: cluster.length, confidence: Math.min(0.95, 0.65 + ratio * 0.35) });
    }
    return result;
  }

  function autoLabelEdges(roof: Roof): Polyline[] {
    const pts = roof.outline;
    const n = pts.length / 2;
    if (n < 3) return [];

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const roofWidth = maxX - minX;
    const roofHeight = maxY - minY;
    const eaveYThreshold = minY + 0.75 * roofHeight;

    const result: Polyline[] = [];

    for (let i = 0; i < n; i++) {
      const x1 = pts[i * 2], y1 = pts[i * 2 + 1];
      const j = (i + 1) % n;
      const x2 = pts[j * 2], y2 = pts[j * 2 + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const rawAngle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
      const midY = (y1 + y2) / 2;

      if (rawAngle < 20 && midY >= eaveYThreshold) {
        result.push({ id: uid(), kind: "EAVE", points: [x1, y1, x2, y2], aiLabeled: true, confidence: 0.95 });
      } else if (rawAngle >= 20 && rawAngle <= 70) {
        result.push({ id: uid(), kind: "RAKE", points: [x1, y1, x2, y2], aiLabeled: true, confidence: 0.90 });
      }
      // Ridge is never auto-labeled — use "Suggest Ridge" button instead.
    }

    return result;
  }

  // Returns ridge cluster candidates WITHOUT the rake-support gate.
  // Used by the "Suggest Ridge" button.
  function suggestRidges(roof: Roof): { kind: "RIDGE"; points: number[]; confidence: number }[] {
    const pts = roof.outline;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length / 2; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const roofWidth = maxX - minX;

    // Use labeled rakes to boost/gate confidence
    const rakeLns = roof.lines.filter(l => l.kind === "RAKE");
    const snapTol = roofWidth * 0.04;
    const rakeEPs = rakeLns.flatMap(l => [
      { x: l.points[0], y: l.points[1] }, { x: l.points[2], y: l.points[3] },
    ]);
    const hasSupport = (ex: number, ey: number) =>
      rakeEPs.some(p => Math.hypot(p.x - ex, p.y - ey) <= snapTol);
    // If no rakes are labeled yet, skip the support gate (graceful fallback)
    const noRakesLabeled = rakeLns.length === 0;

    return buildRidgeClusters(pts, roofWidth, maxY - minY, minY)
      .flatMap(c => {
        const leftOK = hasSupport(c.x1, c.y1);
        const rightOK = hasSupport(c.x2, c.y2);
        // Require at least one end supported unless no rakes exist yet
        if (!noRakesLabeled && !leftOK && !rightOK) return [];
        // Adjust confidence based on support quality
        let conf = c.confidence;
        if (!noRakesLabeled) {
          if (leftOK && rightOK) conf = Math.min(0.95, conf + 0.05);
          else conf = Math.max(0.60, conf - 0.10); // partial support
        }
        // Only surface Medium+ confidence (≥0.70) suggestions
        if (conf < 0.70) return [];
        return [{ kind: "RIDGE" as const, points: [c.x1, c.y1, c.x2, c.y2], confidence: conf }];
      });
  }

  // Detect valley candidates from concave (inward-dipping) vertices in the outline polygon.
  // A valley vertex is a local Y-maximum in the middle zone between eave and ridge levels.
  function suggestValleys(roof: Roof): { kind: "VALLEY"; points: number[]; confidence: number }[] {
    const pts = roof.outline;
    const n = pts.length / 2;
    if (n < 4) return [];

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const roofWidth = maxX - minX;
    const eaveYThreshold = minY + 0.75 * (maxY - minY);
    const ridgeYZone = minY + 0.35 * (maxY - minY);

    const suggestions: { kind: "VALLEY"; points: number[]; confidence: number }[] = [];
    const seen = new Set<string>();

    const addEdge = (ax: number, ay: number, bx: number, by: number, ia: number, ib: number) => {
      const key = `${Math.min(ia, ib)}-${Math.max(ia, ib)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ddx = bx - ax, ddy = by - ay;
      const angle = Math.atan2(Math.abs(ddy), Math.abs(ddx)) * 180 / Math.PI;
      if (angle >= 15 && angle <= 75) {
        const len = Math.hypot(ddx, ddy);
        const conf = Math.min(0.85, 0.55 + (len / roofWidth) * 0.55);
        suggestions.push({ kind: "VALLEY", points: [ax, ay, bx, by], confidence: conf });
      }
    };

    for (let i = 0; i < n; i++) {
      const prev = ((i - 1) + n) % n;
      const next = (i + 1) % n;
      const py = pts[prev * 2 + 1];
      const cx = pts[i * 2], cy = pts[i * 2 + 1];
      const ny = pts[next * 2 + 1];
      // Valley vertex: local Y-maximum in middle zone (dips down between two peaks in screen coords)
      const isLocalYMax = cy > py && cy > ny;
      const inMiddleZone = cy < eaveYThreshold && cy > ridgeYZone;
      if (isLocalYMax && inMiddleZone) {
        addEdge(pts[prev * 2], py, cx, cy, prev, i);
        addEdge(cx, cy, pts[next * 2], ny, i, next);
      }
    }

    return suggestions;
  }

  function runAiJudgeLocally(roof: Roof, lines: Polyline[]) {
    const pts = roof.outline;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length / 2; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const roofWidth = maxX - minX;
    const roofHeight = maxY - minY;

    // ── EAVE / RAKE ──────────────────────────────────────────────────────────
    const eaveLns = lines.filter(l => l.kind === "EAVE");
    const rakeLns = lines.filter(l => l.kind === "RAKE");

    // ── RIDGE ─────────────────────────────────────────────────────────────────
    const ridgeLns = lines.filter(l => l.kind === "RIDGE");
    const ridgeClusters = buildRidgeClusters(pts, roofWidth, roofHeight, minY);
    const snapTol = roofWidth * 0.04;
    const rakeEPs = rakeLns.flatMap(l => [
      { x: l.points[0], y: l.points[1] }, { x: l.points[2], y: l.points[3] },
    ]);
    const rakeSupport = (ex: number, ey: number) =>
      rakeEPs.some(p => Math.hypot(p.x - ex, p.y - ey) <= snapTol);

    const ridgeReasons: string[] = [];
    let ridgeConf: "high" | "medium" | "low" | "none" = "none";
    let ridgeHasCandidates = ridgeClusters.length > 0;

    if (ridgeLns.length > 0) {
      const r = ridgeLns[0];
      const spanPct = Math.round(Math.abs(r.points[2] - r.points[0]) / roofWidth * 100);
      const lOK = rakeSupport(r.points[0], r.points[1]);
      const rOK = rakeSupport(r.points[2], r.points[3]);
      if (lOK && rOK) {
        ridgeConf = "high";
        ridgeReasons.push("Supported by rakes on both ends");
        ridgeReasons.push(`Span covers ~${spanPct}% of roof width`);
      } else {
        ridgeConf = "medium";
        ridgeReasons.push(`Span covers ~${spanPct}% of roof width`);
        if (!lOK) ridgeReasons.push("No rake support near left end");
        if (!rOK) ridgeReasons.push("No rake support near right end");
        ridgeReasons.push("Consider re-labeling or adjusting rakes");
      }
    } else if (ridgeClusters.length > 0) {
      const best = ridgeClusters[0];
      const spanPct = Math.round((best.x2 - best.x1) / roofWidth * 100);
      const lOK = rakeSupport(best.x1, best.y1);
      const rOK = rakeSupport(best.x2, best.y2);
      if (lOK && rOK) {
        ridgeConf = "medium";
        ridgeReasons.push("Candidate found with rake support — not yet labeled");
        ridgeReasons.push(`Span covers ~${spanPct}% of roof width`);
        ridgeReasons.push("Use 'Suggest Ridge' to adopt");
      } else {
        ridgeConf = "low";
        ridgeReasons.push("No confident ridge detected from this view");
        ridgeReasons.push(`Candidate span covers ~${spanPct}% of roof width`);
        if (rakeLns.length < 2) ridgeReasons.push("Fewer than 2 rakes — trace rakes first");
        else ridgeReasons.push("No rake endpoint near ridge candidate ends");
      }
    } else {
      ridgeConf = "none";
      ridgeReasons.push("No confident ridge detected from this view");
      ridgeReasons.push("No near-horizontal edges found in top 40% of outline");
      ridgeReasons.push("Ridge may not be visible in this facade view");
    }

    // ── VALLEY ───────────────────────────────────────────────────────────────
    const valleyLns = lines.filter(l => l.kind === "VALLEY");
    const valleyCands = suggestValleys(roof);
    const valleyReasons: string[] = [];
    let valleyConf: "labeled" | "possible" | "none" = "none";
    const valleyHasCandidates = valleyCands.length > 0;

    if (valleyLns.length > 0) {
      valleyConf = "labeled";
      valleyReasons.push(`${valleyLns.length} valley(s) labeled`);
    } else if (valleyCands.length > 0) {
      valleyConf = "possible";
      valleyReasons.push("Interior convergence suggests possible valley");
      valleyReasons.push("Use 'Suggest Valley' to review candidates");
    } else {
      valleyConf = "none";
      valleyReasons.push("No valley vertices detected in this outline");
      valleyReasons.push("Valley intersections not visible from facade");
    }

    setAiJudgeResult({
      eave: { count: eaveLns.length },
      rake: { count: rakeLns.length },
      ridge: { confidence: ridgeConf, reasons: ridgeReasons, hasCandidates: ridgeHasCandidates },
      valley: { confidence: valleyConf, reasons: valleyReasons, hasCandidates: valleyHasCandidates },
    });
  }

  function lineLength(pts: number[]): number {
    let total = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    }
    return total;
  }

  function triggerAutoLabel() {
    if (!activeRoof?.closed) return;
    setAutoLabelState("loading");
    setAutoLabelSuggestions([]);
    setAutoLabelError(null);
    setAiJudgeResult(null);

    // Classify outline edges into eave/rake/ridge, preserving locked lines
    patchActiveRoof((r) => {
      const locked = r.lines.filter(l => l.locked);
      return { ...r, lines: [...locked, ...autoLabelEdges(r)] };
    });

    setAutoLabelState("done");
  }

  function triggerSuggestValleys() {
    if (!activeRoof?.closed) return;
    setAutoLabelError(null);
    const suggestions = suggestValleys(activeRoof);
    setAutoLabelSuggestions(suggestions);
    if (suggestions.length === 0) {
      setAutoLabelError("No valley candidates detected — try tracing manually.");
    }
  }

  function triggerSuggestRidges() {
    if (!activeRoof?.closed) return;
    setAutoLabelError(null);
    // suggestRidges already applies 0.70 threshold internally
    const suggestions = suggestRidges(activeRoof);
    setAutoLabelSuggestions(suggestions);
    if (suggestions.length === 0) {
      setAutoLabelError("No confident ridge detected from this view — draw manually.");
    }
  }

  function adoptAutoLabelSuggestion(idx: number) {
    const s = autoLabelSuggestions[idx];
    if (!s) return;
    patchActiveRoof((r) => ({
      ...r,
      lines: [...r.lines, { id: uid(), kind: s.kind as LineKind, points: s.points, aiLabeled: true, confidence: s.confidence, locked: true }],
    }));
    setAutoLabelSuggestions((prev) => prev.filter((_, j) => j !== idx));
  }

  function startProject() {
    const id = uid();
    const roof1 = defaultRoof("Roof 1");
    const existingNums = photos
      .map((p) => {
        const m = p.name.match(/^New Project(?: (\d+))?$/);
        return m ? (m[1] ? parseInt(m[1]) : 1) : 0;
      })
      .filter(Boolean);
    const nextNum = existingNums.length === 0 ? 0 : Math.max(...existingNums) + 1;
    const name = nextNum === 0 ? "New Project" : `New Project ${nextNum}`;
    const item: PhotoProject = {
      id,
      name,
      src: "",
      photoSrcs: [],
      step: "TRACE",
      roofs: [roof1],
      activeRoofId: roof1.id,
      shingleColor: "Barkwood",
      showGuidesDuringInstall: false,
      showEditHandles: false,
      realisticMode: false,
      realisticStrength: 0.6,
      stageScale: 1,
      stagePos: { x: 0, y: 0 },
      photoStates: {},
    };
    setPhotos((prev) => [item, ...prev]);
    setActivePhotoId(id);
    setScreen("PROJECT");
  }

  function openProject(id: string) {
    setActivePhotoId(id);
    setScreen("PROJECT");
  }

  function deleteProject(id: string) {
    setPhotos((prev) => {
      const next = prev.filter((p) => p.id !== id);
      // If we deleted the active project, switch active to first remaining.
      if (id === activePhotoId) setActivePhotoId(next[0]?.id ?? "");
      return next;
    });
  }

  function renameProject(id: string, name: string) {
    setPhotos((prev) => prev.map((p) => p.id === id ? { ...p, name } : p));
  }

  function runAutoDetect() {
    if (!photoImg || !active) return;
    setAutoDetecting(true);
    setAutoSuggest(null);
    // Defer to next tick so the "Detecting…" label renders before the heavy computation.
    setTimeout(() => {
      try {
        const result = autoDetectRoof(photoImg, w, h);
        setAutoSuggest(result);
      } catch {
        // Detection failed silently; user can trace manually.
      } finally {
        setAutoDetecting(false);
      }
    }, 0);
  }

  function acceptAutoSuggest() {
    if (!autoSuggest) return;
    patchActiveRoof((r) => ({
      ...r,
      outline: stageToImgPts(autoSuggest.outline, photoTx),
      closed: true,
      lines: autoSuggest.lines.map((l) => ({ ...l, id: uid(), points: stageToImgPts(l.points, photoTx) })),
    }));
    setAutoSuggest(null);
    setTool("NONE");
  }

  // Upload one or more photos into the currently active project.
  // All selected files are added to photoSrcs; src switches to the first new one.
  function addFiles(files: FileList | null) {
    if (!files || files.length === 0 || !activePhotoId) return;
    const targetId = activePhotoId;
    const promises = Array.from(files).map(
      (file) =>
        new Promise<string>((resolve) => {
          const fr = new FileReader();
          fr.onload = () => compressForStorage(String(fr.result)).then(resolve);
          fr.readAsDataURL(file);
        })
    );
    Promise.all(promises).then((newSrcs) => {
      setPhotos((prev) =>
        prev.map((p) => {
          if (p.id !== targetId) return p;
          const existing = p.photoSrcs ?? [];
          const merged = [...existing, ...newSrcs];
          // Save current photo's state before switching
          const saved = { ...p.photoStates };
          if (p.src) {
            saved[p.src] = { roofs: p.roofs, activeRoofId: p.activeRoofId,
                             stageScale: p.stageScale, stagePos: p.stagePos };
          }
          // New photos start with fresh state (not inherited from current)
          const firstNewSrc = newSrcs[0];
          const freshRoof = defaultRoof("Roof 1");
          return {
            ...p,
            photoSrcs: merged,
            src: firstNewSrc,
            photoStates: saved,
            roofs: [freshRoof],
            activeRoofId: freshRoof.id,
            stageScale: 1,
            stagePos: { x: 0, y: 0 },
          };
        })
      );
    });
  }

  function addRoof() {
    if (!active) return;
    const r = defaultRoof(`Roof ${active.roofs.length + 1}`);
    patchActive((p) => ({
      ...p,
      roofs: [...p.roofs, r],
      activeRoofId: r.id,
      step: "TRACE",
    }));
    setTool("TRACE_ROOF");
    setDraftLine(null);
    setDraftHole(null);
    showToast("Roof added — trace its outline on the canvas");
  }

  function switchToPhoto(newSrc: string) {
    patchActive((p) => {
      const saved = { ...p.photoStates };
      if (p.src) {
        saved[p.src] = { roofs: p.roofs, activeRoofId: p.activeRoofId,
                         stageScale: p.stageScale, stagePos: p.stagePos };
      }
      const next = saved[newSrc];
      if (next) {
        return { ...p, src: newSrc, photoStates: saved, roofs: next.roofs,
                 activeRoofId: next.activeRoofId, stageScale: next.stageScale, stagePos: next.stagePos };
      }
      const freshRoof = defaultRoof("Roof 1");
      return { ...p, src: newSrc, photoStates: saved, roofs: [freshRoof],
               activeRoofId: freshRoof.id, stageScale: 1, stagePos: { x: 0, y: 0 } };
    });
    setTool("NONE"); setDraftLine(null); setDraftHole(null);
    setAutoLabelState("idle"); setAutoLabelSuggestions([]); setAutoLabelError(null);
  }

  function removeCurrentPhoto() {
    if (!active || !active.src) return;
    const removedSrc = active.src;
    patchActive((p) => {
      const saved = { ...p.photoStates };
      // Save current state before removing
      saved[removedSrc] = { roofs: p.roofs, activeRoofId: p.activeRoofId,
                             stageScale: p.stageScale, stagePos: p.stagePos };
      const newSrcs = (p.photoSrcs ?? []).filter((s) => s !== removedSrc);
      // Remove the deleted photo's saved state
      delete saved[removedSrc];
      const nextSrc = newSrcs[0] ?? "";
      const nextState = nextSrc ? saved[nextSrc] : null;
      if (nextState) {
        return { ...p, photoSrcs: newSrcs, src: nextSrc, photoStates: saved,
                 roofs: nextState.roofs, activeRoofId: nextState.activeRoofId,
                 stageScale: nextState.stageScale, stagePos: nextState.stagePos };
      }
      const freshRoof = defaultRoof("Roof 1");
      return { ...p, photoSrcs: newSrcs, src: nextSrc, photoStates: saved,
               roofs: [freshRoof], activeRoofId: freshRoof.id, stageScale: 1, stagePos: { x: 0, y: 0 } };
    });
    setTool("NONE"); setDraftLine(null); setDraftHole(null);
  }

  function deleteLine(lineId: string) {
    patchActiveRoof((r) => ({ ...r, lines: r.lines.filter((l) => l.id !== lineId) }));
  }

  function deleteHole(holeIndex: number) {
    patchActiveRoof((r) => ({ ...r, holes: r.holes.filter((_, i) => i !== holeIndex) }));
  }

  function resetSelectedRoof() {
    if (!activeRoof || !active) return;
    patchActiveRoof((r) => ({ ...r, outline: [], closed: false, lines: [], holes: [] }));
    patchActive((p) => ({ ...p, step: "TRACE" }));
    setTool("TRACE_ROOF");
    setDraftLine(null);
    setDraftHole(null);
  }

  function canGoNext() {
    if (!active) return false;
    if (active.step === "TRACE") {
      if (!active.roofs.some((r) => r.closed)) return false;
    }
    const rel = relevantSteps(active.roofs);
    let nextIdx = stepIndex(active.step) + 1;
    while (nextIdx < STEPS.length && !rel.has(STEPS[nextIdx])) nextIdx++;
    return nextIdx < STEPS.length;
  }

  function goNext() {
    if (!active || !canGoNext()) return;
    const rel = relevantSteps(active.roofs);
    let nextIdx = stepIndex(active.step) + 1;
    while (nextIdx < STEPS.length && !rel.has(STEPS[nextIdx])) nextIdx++;
    if (nextIdx >= STEPS.length) return;
    const next = STEPS[nextIdx];
    patchActive((p) => ({ ...p, step: next, showEditHandles: next === "TRACE" ? p.showEditHandles : false }));
    setDraftLine(null);
    setDraftHole(null);
    // Auto-activate the trace tool when entering TRACE so users know to click the canvas.
    if (next === "TRACE" && !activeRoof?.closed) {
      setTool("TRACE_ROOF");
    } else {
      setTool("NONE");
    }
    if (next === "EXPORT") showToast("Visualization complete — export your PDF below");
  }

  function goBack() {
    if (!active) return;
    const idx = stepIndex(active.step);
    if (idx <= 0) return;
    const rel = relevantSteps(active.roofs);
    let prevIdx = idx - 1;
    while (prevIdx > 0 && !rel.has(STEPS[prevIdx])) prevIdx--;
    const prev = STEPS[prevIdx];
    patchActive((p) => ({ ...p, step: prev }));
    setTool("NONE");
    setDraftLine(null);
    setDraftHole(null);
  }

  function jumpToStep(step: Step) {
    if (!active) return;
    patchActive((p) => ({ ...p, step }));
    setTool("NONE");
    setDraftLine(null);
    setDraftHole(null);
  }

  function beginDraw(kind: LineKind) {
    if (!activeRoof?.closed) return;
    const t: Tool =
      kind === "EAVE" ? "DRAW_EAVE" :
      kind === "RAKE" ? "DRAW_RAKE" :
      kind === "VALLEY" ? "DRAW_VALLEY" :
      kind === "RIDGE" ? "DRAW_RIDGE" :
      "DRAW_HIP";
    setTool(t);
    setDraftLine({ id: uid(), kind, points: [] });
    setDraftHole(null);
  }

  function beginHole() {
    if (!activeRoof?.closed) return;
    setTool("TRACE_HOLE");
    setDraftHole([]);
    setDraftLine(null);
  }

  function finishDraftLine() {
    if (!activeRoof || !draftLine || draftLine.points.length < 4) return;
    patchActiveRoof((r) => ({ ...r, lines: [...r.lines, { ...draftLine, id: uid() }] }));
    setDraftLine({ id: uid(), kind: draftLine.kind, points: [] });
  }

  function finishHole() {
    if (!activeRoof || !draftHole || draftHole.length < 6) return;
    patchActiveRoof((r) => ({ ...r, holes: [...r.holes, draftHole] }));
    setDraftHole([]);
  }

  function undoDraftPoint() {
    if (!draftLine) return;
    setDraftLine((d) => d ? { ...d, points: d.points.slice(0, Math.max(0, d.points.length - 2)) } : d);
  }

  function undoHolePoint() {
    if (!draftHole) return;
    setDraftHole((pts) => pts ? pts.slice(0, Math.max(0, pts.length - 2)) : pts);
  }

  function undoOutlinePoint() {
    if (!activeRoof || activeRoof.closed) return;
    patchActiveRoof((r) => ({ ...r, outline: r.outline.slice(0, Math.max(0, r.outline.length - 2)) }));
  }

  function onWheel(e: any) {
    if (!active) return;
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = active.stageScale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.05;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = clamp(direction > 0 ? oldScale * scaleBy : oldScale / scaleBy, 0.6, 3);

    const mousePointTo = {
      x: (pointer.x - active.stagePos.x) / oldScale,
      y: (pointer.y - active.stagePos.y) / oldScale,
    };

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };

    patchActive((p) => ({ ...p, stageScale: newScale, stagePos: newPos }));
  }

  const CLOSE_DIST = 18;
  function dist(x1: number, y1: number, x2: number, y2: number) {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Ramer–Douglas–Peucker simplification ──────────────────────────────────
  function rdpSimplify(pts: number[], epsilon: number): number[] {
    if (pts.length < 6) return pts; // fewer than 3 points — nothing to simplify
    // Convert flat [x,y,x,y,...] to [{x,y}] pairs
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i += 2) points.push({ x: pts[i], y: pts[i + 1] });

    function perpendicularDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    function rdp(pts: { x: number; y: number }[], start: number, end: number, eps: number, keep: boolean[]) {
      if (end <= start + 1) return;
      let maxDist = 0, maxIdx = start;
      for (let i = start + 1; i < end; i++) {
        const d = perpendicularDist(pts[i], pts[start], pts[end]);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
      }
      if (maxDist > eps) {
        keep[maxIdx] = true;
        rdp(pts, start, maxIdx, eps, keep);
        rdp(pts, maxIdx, end, eps, keep);
      }
    }

    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    rdp(points, 0, points.length - 1, epsilon, keep);

    const result: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (keep[i]) result.push(points[i].x, points[i].y);
    }
    return result;
  }

  // Snap each segment angle to the nearest of {0,45,90,135}° if within 12°
  function snapAngles(pts: number[]): number[] {
    if (pts.length < 4) return pts;
    const snapped: number[] = [pts[0], pts[1]];
    const SNAP_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
    const THRESHOLD = 12; // degrees

    for (let i = 2; i < pts.length; i += 2) {
      const px = snapped[snapped.length - 2], py = snapped[snapped.length - 1];
      const cx = pts[i], cy = pts[i + 1];
      const angleDeg = (Math.atan2(cy - py, cx - px) * 180) / Math.PI;
      const normAngle = ((angleDeg % 360) + 360) % 360;
      let bestDiff = Infinity, bestSnap = normAngle;
      for (const sa of SNAP_ANGLES) {
        const diff = Math.abs(((normAngle - sa + 180) % 360) - 180);
        if (diff < bestDiff) { bestDiff = diff; bestSnap = sa; }
      }
      if (bestDiff <= THRESHOLD) {
        const len = Math.hypot(cx - px, cy - py);
        const rad = (bestSnap * Math.PI) / 180;
        snapped.push(px + len * Math.cos(rad), py + len * Math.sin(rad));
      } else {
        snapped.push(cx, cy);
      }
    }
    return snapped;
  }

  function onStageDown(e: any) {
    if (presentationMode) return;
    if (!active || !activeRoof || !photoImg) return;
    const stage = e.target.getStage();
    const rawPos = stage.getPointerPosition();
    if (!rawPos) return;

    // Convert from screen/container coords → world coords, accounting for
    // the stage's current scale and pan offset.
    const scale = stage.scaleX();
    const pos = {
      x: (rawPos.x - stage.x()) / scale,
      y: (rawPos.y - stage.y()) / scale,
    };
    // Keep the close-snap radius constant in screen pixels regardless of zoom.
    const imageCloseRadius = CLOSE_DIST / (scale * photoTx.scale);

    if (active.step === "TRACE" && tool === "TRACE_ROOF" && !activeRoof.closed) {
      const iPos = stageToImgPts([pos.x, pos.y], photoTx);
      const pts = activeRoof.outline;
      if (pts.length >= 6) {
        const x0 = pts[0], y0 = pts[1];
        if (dist(iPos[0], iPos[1], x0, y0) <= imageCloseRadius) {
          patchActiveRoof((r) => ({ ...r, closed: true }));
          setTool("NONE");
          showToast("Roof outline closed ✓");
          return;
        }
      }
      patchActiveRoof((r) => ({ ...r, outline: [...r.outline, iPos[0], iPos[1]] }));
      return;
    }

    if (active.step === "TRACE" && tool === "TRACE_HOLE") {
      if (!draftHole) return;
      const iPos = stageToImgPts([pos.x, pos.y], photoTx);
      if (draftHole.length >= 6) {
        const x0 = draftHole[0], y0 = draftHole[1];
        if (dist(iPos[0], iPos[1], x0, y0) <= imageCloseRadius) {
          patchActiveRoof((r) => ({ ...r, holes: [...r.holes, draftHole] }));
          setDraftHole([]);
          setTool("NONE");
          return;
        }
      }
      setDraftHole((pts) => (pts ? [...pts, iPos[0], iPos[1]] : [iPos[0], iPos[1]]));
      return;
    }

    if (
      active.step === "TRACE" &&
      (tool === "DRAW_EAVE" ||
        tool === "DRAW_RAKE" ||
        tool === "DRAW_VALLEY" ||
        tool === "DRAW_RIDGE" ||
        tool === "DRAW_HIP")
    ) {
      if (!draftLine) return;
      const iPos = stageToImgPts([pos.x, pos.y], photoTx);
      setDraftLine((d) => (d ? { ...d, points: [...d.points, iPos[0], iPos[1]] } : d));
      return;
    }

    // Edge detection tools
    if (active.step === "TRACE" && edgeTool === "ERASE_EDGE") {
      const ERASE_RADIUS = 20 / ((active.stageScale || 1) * photoTx.scale);
      const toErase = visibleSegs.filter((s) => {
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1) return false;
        const t = Math.max(0, Math.min(1, ((pos.x - s.x1) * dx + (pos.y - s.y1) * dy) / len2));
        const nearX = s.x1 + t * dx, nearY = s.y1 + t * dy;
        const d2 = (pos.x - nearX) ** 2 + (pos.y - nearY) ** 2;
        return d2 <= ERASE_RADIUS * ERASE_RADIUS;
      });
      if (toErase.length > 0) {
        const ids = new Set(erasedSegIds);
        const addIds = new Set(userAddedSegs.map((s) => s.id));
        const newMask: Array<{x: number; y: number}> = [];
        toErase.forEach((s) => {
          if (addIds.has(s.id)) setUserAddedSegs((prev) => prev.filter((u) => u.id !== s.id));
          else {
            ids.add(s.id);
            newMask.push({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 });
          }
        });
        setErasedSegIds(ids);
        if (newMask.length > 0) setEdgeErasedMask((prev) => [...prev, ...newMask]);
        setPlaneSuggs([]);
      }
      return;
    }

    if (active.step === "TRACE" && edgeTool === "ADD_EDGE") {
      if (!edgeAddDraft) {
        setEdgeAddDraft([pos.x, pos.y]);
      } else {
        const dx = pos.x - edgeAddDraft[0], dy = pos.y - edgeAddDraft[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 5) {
          let angle = Math.atan2(dy, dx);
          if (angle < 0) angle += Math.PI;
          setUserAddedSegs((prev) => [...prev, {
            id: Math.random().toString(16).slice(2),
            x1: edgeAddDraft[0], y1: edgeAddDraft[1],
            x2: pos.x, y2: pos.y,
            angle, length: len,
            label: "unknown" as const,
            confidence: 0.5,
            source: "auto-detect" as const,
          }]);
          setPlaneSuggs([]); // reset suggestions
        }
        setEdgeAddDraft(null);
      }
      return;
    }

    // Brush ice & water painting — start a new stroke (store in photo-space)
    if (active.step === "ICE_WATER" && tool === "BRUSH_ICE_WATER" && activeRoof.closed) {
      const bPos = stageToImgPts([pos.x, pos.y], photoTx);
      brushPaintingRef.current = true;
      brushStrokeRef.current = [bPos[0], bPos[1]];
      setBrushDraft({ points: [bPos[0], bPos[1]], size: activeRoof.iceWaterBrushSize ?? 30 });
      return;
    }
  }

  function onStageMove() {
    if (!brushPaintingRef.current || tool !== "BRUSH_ICE_WATER") return;
    const stage = stageRef.current;
    if (!stage) return;
    const rawPos = stage.getPointerPosition();
    if (!rawPos) return;
    const sc = stage.scaleX();
    const wx = (rawPos.x - stage.x()) / sc;
    const wy = (rawPos.y - stage.y()) / sc;
    const bPos = stageToImgPts([wx, wy], photoTx);
    const prev = brushStrokeRef.current;
    if (prev.length >= 2) {
      const lx = prev[prev.length - 2], ly = prev[prev.length - 1];
      if ((bPos[0] - lx) ** 2 + (bPos[1] - ly) ** 2 < 9) return; // skip if <3px movement in photo-space
    }
    brushStrokeRef.current = [...prev, bPos[0], bPos[1]];
    setBrushDraft({ points: brushStrokeRef.current, size: activeRoof?.iceWaterBrushSize ?? 30 });
  }

  function onStageUp() {
    if (!brushPaintingRef.current) return;
    const rawPts = brushStrokeRef.current;
    if (activeRoof && rawPts.length >= 4) {
      const size = activeRoof.iceWaterBrushSize ?? 30;
      const epsilon = Math.max(3, Math.min(12, size * 0.35));
      const simplified = rdpSimplify(rawPts, epsilon);
      const finalPts = simplified.length >= 4 ? snapAngles(simplified) : rawPts;
      const newStroke = { id: uid(), points: finalPts, size };
      patchActiveRoof((r) => ({ ...r, iceWaterBrush: [...(r.iceWaterBrush ?? []), newStroke] }));
    }
    brushPaintingRef.current = false;
    brushStrokeRef.current = [];
    setBrushDraft(null);
  }

  function updateOutlinePoint(i: number, photoX: number, photoY: number) {
    if (!activeRoof) return;
    patchActiveRoof((r) => {
      const next = r.outline.slice();
      next[i * 2] = photoX;
      next[i * 2 + 1] = photoY;
      return { ...r, outline: next };
    });
  }

  // Enter key shortcut: finish the current line or hole without clicking the button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (tool === "TRACE_HOLE") {
        if (!activeRoof || !draftHole || draftHole.length < 6) return;
        patchActiveRoof((r) => ({ ...r, holes: [...r.holes, draftHole] }));
        setDraftHole([]);
        setTool("NONE");
      } else if (
        tool === "DRAW_EAVE" || tool === "DRAW_RAKE" || tool === "DRAW_VALLEY" ||
        tool === "DRAW_RIDGE" || tool === "DRAW_HIP"
      ) {
        if (!activeRoof || !draftLine || draftLine.points.length < 4) return;
        patchActiveRoof((r) => ({ ...r, lines: [...r.lines, { ...draftLine, id: uid() }] }));
        setDraftLine({ id: uid(), kind: draftLine.kind, points: [] });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // Re-register whenever the captured state changes so the handler is never stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, draftLine, draftHole, activeRoof, active]);

  // textures
  const texW = Math.floor(w * 2.4);
  const texH = Math.floor(h * 2.4);

  const deckingSrc = useMemo(() => {
    if (!active || typeof window === "undefined") return "";
    return makeDeckingTexture(texW, texH);
  }, [active?.id, texW, texH]);
  const deckingImg = useHtmlImage(deckingSrc);

  const syntheticSrc = useMemo(() => {
    if (!active || typeof window === "undefined") return "";
    return makeSyntheticTexture(texW, texH);
  }, [active?.id, texW, texH]);
  const syntheticImg = useHtmlImage(syntheticSrc);

  const shingleSrc = useMemo(() => {
    if (!active || typeof window === "undefined") return "";
    return makeShingleTexture(texW, texH, active.shingleColor);
  }, [active?.id, active?.shingleColor, texW, texH]);
  const shinglesImg = useHtmlImage(shingleSrc);

  // Photo-derived shingle texture — regenerated only when photo / realism settings change
  const realisticShingleSrc = useMemo(() => {
    if (!active?.realisticMode || !photoImg || typeof window === "undefined") return "";
    return makePhotoShingleTexture(photoImg);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.src, active?.realisticMode, photoImg]);
  const realisticShinglesImg = useHtmlImage(realisticShingleSrc);

  // Resolved texture: photo-derived when realistic + loaded, else procedural
  const activeShinglesImg = (active?.realisticMode && realisticShinglesImg) ? realisticShinglesImg : shinglesImg;

  const metalOptions: MetalColor[] = ["Galvanized", "Aluminum", "White", "Black", "Bronze", "Brown", "Gray"];

  // export view overrides rendering step
  const liveStep: Step = active?.step ?? "START";
  const currentStep: Step =
    exportView === "PDF_SHINGLES" ? "CAP_SHINGLES" :
    exportView === "PDF_UNDERLAY" ? "PRO_START" :
    liveStep;

  const showGuides = (active?.step === "TRACE") || !!active?.showGuidesDuringInstall;

  // Customer view step navigation
  const customerNavSteps = useMemo(() => {
    if (!customerViewData) return [] as Step[];
    const currentRoofs = customerViewData.photos[customerPhotoIdx]?.roofs ?? customerViewData.photos[0]?.roofs ?? [];
    const rel = relevantSteps(currentRoofs);
    rel.delete("START"); rel.delete("TRACE"); rel.delete("EXPORT");
    return STEPS.filter((s) => rel.has(s));
  }, [customerViewData, customerPhotoIdx]);
  const customerStepIdx = customerNavSteps.indexOf(customerStep);

  // Generate a shareable read-only URL encoding the current project structure.
  // photoUrl is the Vercel Blob URL of the compressed uploaded photo.
  function generateShareUrl(urlMap: Map<string, string> = new Map()): string {
    if (!active || screen === "CUSTOMER_VIEW") return "";

    // Merge live state for the current photo into the full state map
    const allStates: Record<string, { roofs: Roof[] }> = { ...active.photoStates };
    if (active.src) {
      allStates[active.src] = { ...active.photoStates[active.src], roofs: active.roofs };
    }

    function encodeRoofs(roofs: Roof[]) {
      return roofs.map((r) => ({
        id: r.id,
        cl: r.closed ? 1 : 0,
        o: r.outline.map((n) => Math.round(n)),
        h: r.holes.map((hole) => hole.map((n) => Math.round(n))),
        l: r.lines.map((l) => ({ k: l.kind, p: l.points.map((n) => Math.round(n)) })),
        sc: r.shingleScale,
        sr: r.shingleRotation,
        vc: r.valleyMetalColor,
        vw: r.valleyMetalW,
        gaw: r.gutterApronW,
        gac: r.gutterApronColor,
        dew: r.dripEdgeW,
        dec: r.dripEdgeColor,
        iwe: r.iceWaterEaveW,
        iwv: r.iceWaterValleyW,
        psw: r.proStartW,
        rvw: r.ridgeVentW,
        cpw: r.capW,
        por: r.proStartOnRakes ? 1 : 0,
      }));
    }

    const photos = (active.photoSrcs ?? []).map((src) => ({
      p: urlMap.get(src) ?? "",
      cw: w,
      ch: h,
      r: encodeRoofs(allStates[src]?.roofs ?? []),
    }));

    const shareData = {
      n: active.name,
      c: active.shingleColor,
      photos,
    };

    const json = JSON.stringify(shareData);
    const encoded = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const base = process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin + window.location.pathname : "");
    return `${base}?share=${encoded}`;
  }

  // Compress the current photo to a JPEG at reduced resolution for blob storage.
  async function compressPhoto(src: string, maxWidth = 1200, quality = 0.55): Promise<string> {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(src); // fallback: use original
      img.src = src;
    });
  }

  // Compress + upload all photos in the project; returns Map<src, blobUrl>.
  async function prepareAllPhotoUrls(): Promise<Map<string, string>> {
    if (!active) return new Map();
    const srcs = active.photoSrcs ?? [];
    const urlMap = new Map<string, string>();
    for (const src of srcs) {
      try {
        setShareStatus("compressing");
        const compressed = await compressPhoto(src, 1200, 0.55);
        setShareStatus("uploading");
        const uploadRes = await fetch("/api/store-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageData: compressed }),
        });
        const uploadData = await uploadRes.json() as { url?: string; error?: string };
        if (!uploadRes.ok || uploadData.error) throw new Error(uploadData.error ?? `store-photo ${uploadRes.status}`);
        if (uploadData.url) urlMap.set(src, uploadData.url);
      } catch {
        // Continue without this photo's blob URL rather than blocking the whole share
      }
    }
    return urlMap;
  }

  // Two-page PDF with material legends (multi-photo grid)
  async function exportPdfTwoPages() {
    if (!active || !stageRef.current) return;

    const mod: any = await import("jspdf");
    const jsPDF = mod.jsPDF || mod.default || mod;

    // Fetch the RoofViz logo as a data URL for embedding in the PDF
    let logoDataUrl = "";
    try {
      const blob = await fetch("/roofviz-logo.png").then((r) => r.blob());
      logoDataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } catch { /* logo unavailable — continue without it */ }

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    const pageW = pdf.internal.pageSize.getWidth();  // 792
    const pageH = pdf.internal.pageSize.getHeight(); // 612

    async function snap(view: ExportView) {
      setExportView(view);
      await new Promise((r) => setTimeout(r, 200));
      return stageRef.current.toDataURL({ pixelRatio: 2 });
    }

    // Shrink image slightly to leave room for the legend at the bottom.
    const imgX = 36, imgY = 76;
    const imgW = pageW - 72;
    const imgH = pageH - 160; // leaves ~84pt for legend

    const legendY = imgY + imgH + 14;
    const boxS = 11; // legend swatch size
    const boxGap = 8;

    // Helper: draw legend items in up to 2 rows of up to 3 columns each.
    function drawLegend(items: Array<{ r: number; g: number; b: number; label: string; lineStyle?: boolean }>) {
      const cols = 3;
      const itemW = imgW / cols;
      const rowH = boxS + 10; // spacing between rows
      pdf.setFontSize(8.5);
      pdf.setFont("helvetica", "normal");
      items.forEach((item, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = imgX + col * itemW;
        const rowY = legendY + row * rowH;
        const cy = rowY + boxS / 2;
        if (item.lineStyle) {
          pdf.setDrawColor(item.r, item.g, item.b);
          pdf.setLineWidth(2.5);
          pdf.line(x, cy, x + boxS * 1.6, cy);
          pdf.setDrawColor(0, 0, 0);
          pdf.setLineWidth(0.5);
          pdf.setTextColor(55, 65, 80);
          pdf.text(item.label, x + boxS * 1.6 + 4, rowY + boxS - 1);
        } else {
          pdf.setFillColor(item.r, item.g, item.b);
          pdf.setDrawColor(160, 160, 160);
          pdf.setLineWidth(0.4);
          pdf.rect(x, rowY, boxS, boxS, "FD");
          pdf.setTextColor(55, 65, 80);
          pdf.text(item.label, x + boxS + boxGap, rowY + boxS - 1);
        }
      });
    }

    // Build a map of all per-photo states (including the live current photo)
    const fullStates: Record<string, { roofs: Roof[]; activeRoofId: string; stageScale: number; stagePos: { x: number; y: number } }> = { ...active.photoStates };
    if (active.src) {
      fullStates[active.src] = { roofs: active.roofs, activeRoofId: active.activeRoofId,
                                  stageScale: active.stageScale, stagePos: active.stagePos };
    }
    const allPhotos = active.photoSrcs ?? [];
    const originalSrc = active.src;

    // Helper: switch the canvas to show a specific photo's saved state
    async function showPhoto(src: string) {
      await new Promise<void>((resolve) => {
        setPhotos((prev) => prev.map((p) => {
          if (p.id !== activePhotoId) return p;
          const st = fullStates[src];
          if (!st) return { ...p, src, roofs: [], activeRoofId: "", stageScale: 1, stagePos: { x: 0, y: 0 } };
          return { ...p, src, roofs: st.roofs, activeRoofId: st.activeRoofId,
                   stageScale: st.stageScale, stagePos: st.stagePos };
        }));
        setTimeout(resolve, 200);
      });
    }

    // Capture shingle + underlay snaps for all photos
    const shingleSnaps: string[] = [];
    const underlaySnaps: string[] = [];
    for (const src of allPhotos) {
      await showPhoto(src);
      shingleSnaps.push(await snap("PDF_SHINGLES"));
      underlaySnaps.push(await snap("PDF_UNDERLAY"));
    }
    // Restore original photo
    await showPhoto(originalSrc);
    setExportView("LIVE");

    // Use the first photo's first roof for legend colors
    const firstState = fullStates[allPhotos[0]];
    const r0 = firstState ? (firstState.roofs[0] ?? null) : null;
    const sc = active.shingleColor;

    // Determine which line types exist across all photos' roofs
    const allRoofLines = Object.values(fullStates).flatMap((st) => st.roofs.flatMap((r) => r.lines));
    const hasEave   = allRoofLines.some((l) => l.kind === "EAVE");
    const hasRake   = allRoofLines.some((l) => l.kind === "RAKE");
    const hasValley = allRoofLines.some((l) => l.kind === "VALLEY");
    const hasRidge  = allRoofLines.some((l) => l.kind === "RIDGE");
    const hasHip    = allRoofLines.some((l) => l.kind === "HIP");

    // Logo dimensions: maintain 165:48 aspect ratio
    const logoW = 150, logoH = Math.round(150 * 48 / 165);

    const [sr, sg, sb] = shingleRGB(sc);
    const [ar, ag, ab] = r0 ? metalRGB(r0.gutterApronColor) : [198, 205, 211];
    const [dr, dg, db] = r0 ? metalRGB(r0.dripEdgeColor)    : [198, 205, 211];
    const [vr, vg, vb] = r0 ? metalRGB(r0.valleyMetalColor) : [198, 205, 211];

    const page1Items = [
      { r: sr,  g: sg,  b: sb,  label: `${sc} Shingles (field)` },
      ...(hasRidge ? [{ r: sr,  g: sg,  b: sb,  label: "Cap Shingles (ridge)" }] : []),
      ...(hasValley ? [{ r: 200, g: 200, b: 200, label: "Valley seam", lineStyle: true }] : []),
      ...(hasHip    ? [{ r: 200, g: 200, b: 200, label: "Hip seam",    lineStyle: true }] : []),
    ];
    const page2Items = [
      { r: 18,  g: 23,  b: 38,  label: "Ice & Water Shield (eaves + valleys)" },
      { r: 215, g: 230, b: 245, label: "Synthetic Underlayment (field)" },
      ...(hasEave   ? [{ r: ar, g: ag, b: ab, label: `Gutter Apron — ${r0?.gutterApronColor ?? ""}` }] : []),
      ...(hasRake   ? [{ r: dr, g: dg, b: db, label: `Drip Edge — ${r0?.dripEdgeColor ?? ""}` }] : []),
      ...(hasValley ? [{ r: vr, g: vg, b: vb, label: `Valley Metal — ${r0?.valleyMetalColor ?? ""}` }] : []),
      ...((hasEave || hasRake) ? [{ r: 18, g: 18, b: 20, label: "Pro-Start Starter Strip" }] : []),
    ];

    // Grid layout: 1 col for single photo, 2 cols for multiple
    const N = allPhotos.length;
    const cols = N <= 1 ? 1 : 2;
    const rows = Math.ceil(N / cols);
    const gapX = cols > 1 ? 10 : 0;
    const gapY = rows > 1 ? 10 : 0;
    const cellW = (imgW - (cols - 1) * gapX) / cols;
    const cellH = (imgH - (rows - 1) * gapY) / rows;

    // Place each image maintaining its natural aspect ratio (letterbox to avoid distortion)
    const stageAspect = stageRef.current.width() / stageRef.current.height();
    function addImageFit(imgData: string, cx: number, cy: number, cw: number, ch: number) {
      const cellAspect = cw / ch;
      let iw: number, ih: number, ix: number, iy: number;
      if (stageAspect > cellAspect) {
        iw = cw; ih = cw / stageAspect;
        ix = cx; iy = cy + (ch - ih) / 2;
      } else {
        ih = ch; iw = ch * stageAspect;
        ix = cx + (cw - iw) / 2; iy = cy;
      }
      pdf.addImage(imgData, "PNG", ix, iy, iw, ih);
    }

    function addGrid(snaps: string[]) {
      snaps.forEach((s, i) => {
        addImageFit(s,
          imgX + (i % cols) * (cellW + gapX),
          imgY + Math.floor(i / cols) * (cellH + gapY),
          cellW, cellH);
      });
    }

    function writePage(title: string, subtitle: string, snaps: string[], items: typeof page1Items) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(16);
      pdf.setTextColor(15, 23, 42);
      pdf.text((active?.name || projectName) ?? "", imgX, 28);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.setTextColor(100, 116, 139);
      pdf.text(subtitle, imgX, 46);
      if (logoDataUrl) pdf.addImage(logoDataUrl, "PNG", pageW - imgX - logoW, 14, logoW, logoH);
      addGrid(snaps);
      drawLegend(items);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7.5);
      pdf.setTextColor(148, 163, 184);
      pdf.text("MATERIAL KEY", imgX, legendY - 4);
    }

    writePage("Finished Roof", "Page 1 of 2  ·  Finished Roof", shingleSnaps, page1Items);
    pdf.addPage();
    writePage("Underlayments", "Page 2 of 2  ·  Underlayments & Metals", underlaySnaps, page2Items);

    pdf.save(`${projectName.replaceAll(" ", "_")}_RoofViz.pdf`);
  }

  // ── Design tokens ──────────────────────────────────────────────────────────
  const sectionCard: React.CSSProperties = {
    background: "#ffffff",
    borderRadius: 14,
    padding: "16px 18px",
    boxShadow: "0 2px 8px rgba(15,23,42,0.07), 0 0 0 1px rgba(15,23,42,0.05)",
    marginBottom: 10,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.07em",
    color: "#94a3b8",
    textTransform: "uppercase",
  };

  const fieldLabel: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 500,
    color: "#475569",
    marginBottom: 5,
  };

  const inputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "9px 13px",
    borderRadius: 9,
    border: "1.5px solid rgba(15,23,42,0.12)",
    fontSize: 13,
    fontWeight: 500,
    background: "#ffffff",
    color: "#0f172a",
    boxSizing: "border-box",
    marginBottom: 12,
    outline: "none",
    transition: "border-color 0.15s ease",
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 11px",
    borderRadius: 8,
    border: "1.5px solid rgba(15,23,42,0.11)",
    fontSize: 12,
    fontWeight: 500,
    background: "#ffffff",
    color: "#334155",
    outline: "none",
  };

  const primaryBtn: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "11px 20px",
    minHeight: 42,
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 60%, #1e40af 100%)",
    color: "#ffffff",
    boxShadow: "0 3px 10px rgba(37,99,235,0.40), 0 1px 3px rgba(37,99,235,0.20)",
    marginTop: 8,
    letterSpacing: "0.01em",
  };

  const greenBtn: React.CSSProperties = {
    ...primaryBtn,
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    boxShadow: "0 2px 6px rgba(22,163,74,0.26)",
  };

  const ghostBtn: React.CSSProperties = {
    padding: "9px 14px",
    borderRadius: 9,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    border: "1.5px solid rgba(15,23,42,0.11)",
    background: "#ffffff",
    color: "#475569",
    letterSpacing: "0.01em",
  };

  const smallBtn: React.CSSProperties = {
    padding: "6px 11px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    border: "1.5px solid rgba(15,23,42,0.09)",
    background: "#ffffff",
    color: "#475569",
  };

  const topBarBtn: React.CSSProperties = {
    padding: "6px 13px", borderRadius: 7, fontSize: 12, fontWeight: 500,
    cursor: "pointer", border: "1.5px solid rgba(15,23,42,0.10)",
    background: "#ffffff", color: "#475569", whiteSpace: "nowrap" as const,
    letterSpacing: "0.01em",
  };

  const tabBtnBase: React.CSSProperties = {
    flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
    cursor: "pointer", border: "none", borderRadius: 7,
    transition: "background 0.15s, color 0.15s",
  };

  const lineKindBtn = (kind: LineKind): React.CSSProperties => {
    const map: Record<LineKind, [string, string, string]> = {
      EAVE:   ["rgba(37,99,235,0.08)",   "rgba(37,99,235,0.28)",   "#1d4ed8"],
      RAKE:   ["rgba(16,185,129,0.08)",  "rgba(16,185,129,0.28)",  "#065f46"],
      VALLEY: ["rgba(100,116,139,0.08)", "rgba(100,116,139,0.28)", "#334155"],
      RIDGE:  ["rgba(245,158,11,0.08)",  "rgba(245,158,11,0.35)",  "#92400e"],
      HIP:    ["rgba(168,85,247,0.08)",  "rgba(168,85,247,0.28)",  "#5b21b6"],
    };
    const [bg, border, color] = map[kind];
    return {
      padding: "8px 6px",
      borderRadius: 8,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.04em",
      cursor: "pointer",
      border: `1.5px solid ${border}`,
      background: bg,
      color,
    };
  };

  const accentSectionHeader: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8,
    marginBottom: 10, paddingLeft: 10, borderLeft: "3px solid #2563eb",
  };
  const stepBadge: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 22, height: 22, borderRadius: 6,
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#ffffff", fontSize: 11, fontWeight: 700, flexShrink: 0,
  };
  const tipBox: React.CSSProperties = {
    marginTop: 8, padding: "9px 12px", borderRadius: 9,
    background: "rgba(37,99,235,0.05)", border: "1px solid rgba(37,99,235,0.12)",
    fontSize: 12, color: "#475569", lineHeight: 1.55,
  };

  const stageW = w;
  const stageH = h;

  // ── MENU SCREEN ────────────────────────────────────────────────────────────
  if (screen === "MENU") {
    return (
      <div className="rv-fade-in" style={{ minHeight: "100vh", background: "#f8fafc" }}>
        {/* Header */}
        <header style={{
          background: "#ffffff",
          borderBottom: "1px solid rgba(15,23,42,0.06)",
          padding: "0 32px",
          height: 60,
          display: "flex",
          alignItems: "center",
          gap: 16,
          boxShadow: "0 1px 4px rgba(15,23,42,0.04)",
          position: "sticky",
          top: 0,
          zIndex: 20,
        }}>
          <Image src="/roofviz-logo.png" alt="RoofViz" width={140} height={41} priority />
          <div style={{ flex: 1 }} />
          <button
            onClick={startProject}
            className="rv-btn-primary"
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "9px 20px", borderRadius: 9, fontSize: 13, fontWeight: 600,
              cursor: "pointer", border: "none",
              background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
              color: "#ffffff",
              boxShadow: "0 2px 6px rgba(37,99,235,0.26)",
              width: "auto", marginTop: 0, minHeight: 0, letterSpacing: "0.01em",
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1, fontWeight: 400 }}>+</span> New Project
          </button>
        </header>

        {/* Content */}
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 24px 72px" }}>

          {photos.length === 0 ? (
            /* Empty state */
            <div className="rv-fade-in" style={{
              textAlign: "center", padding: "80px 24px 88px",
              background: "#ffffff", borderRadius: 20,
              boxShadow: "0 1px 4px rgba(15,23,42,0.05), 0 0 0 1px rgba(15,23,42,0.04)",
            }}>
              <div style={{
                width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg,#eff6ff,#dbeafe)",
                display: "flex", alignItems: "center", justifyContent: "center",
                margin: "0 auto 20px", fontSize: 28,
              }}>🏠</div>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: "#0f172a", margin: "0 0 8px" }}>
                No projects yet
              </h2>
              <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 28px", lineHeight: 1.65, maxWidth: 340, marginLeft: "auto", marginRight: "auto" }}>
                Create your first project to start visualizing a roof installation.
              </p>
              <button
                onClick={startProject}
                className="rv-btn-primary"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "11px 28px", borderRadius: 10, fontSize: 14, fontWeight: 600,
                  cursor: "pointer", border: "none", width: "auto", marginTop: 0, minHeight: 0,
                  background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
                  color: "#ffffff",
                  boxShadow: "0 2px 8px rgba(37,99,235,0.28)",
                  letterSpacing: "0.01em",
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 400 }}>+</span> Create First Project
              </button>
            </div>
          ) : (
            <>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 24,
              }}>
                <div>
                  <h1 style={{ fontSize: 18, fontWeight: 600, color: "#0f172a", margin: 0 }}>Projects</h1>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                    {photos.length} project{photos.length !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 16,
              }}>
                {photos.map((p) => (
                  <div
                    key={p.id}
                    className="rv-project-card rv-fade-in-up"
                    style={{
                      background: "#ffffff",
                      borderRadius: 16,
                      overflow: "hidden",
                      boxShadow: "0 1px 4px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.04)",
                      cursor: "pointer",
                    }}
                    onClick={() => openProject(p.id)}
                  >
                    {/* Thumbnail */}
                    <div style={{
                      height: 148,
                      background: p.src ? "none" : "linear-gradient(135deg, #f1f5f9, #e2e8f0)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      overflow: "hidden", position: "relative",
                    }}>
                      {p.src
                        ? <img src={p.src} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <div style={{ fontSize: 36, opacity: 0.15 }}>🏠</div>
                      }
                      {p.step && p.step !== "TRACE" && (
                        <div style={{
                          position: "absolute", bottom: 8, right: 8,
                          background: "rgba(15,23,42,0.70)", color: "#e2e8f0",
                          fontSize: 10, fontWeight: 600, padding: "3px 8px",
                          borderRadius: 20, backdropFilter: "blur(6px)",
                          letterSpacing: "0.03em",
                        }}>
                          {STEP_TITLE[p.step] ?? p.step}
                        </div>
                      )}
                    </div>

                    {/* Info row */}
                    <div
                      style={{ padding: "10px 12px 12px", display: "flex", alignItems: "center", gap: 8 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {renamingId === p.id ? (
                        <input
                          autoFocus
                          value={renamingName}
                          onChange={(e) => setRenamingName(e.target.value)}
                          onBlur={() => { renameProject(p.id, renamingName); setRenamingId(null); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { renameProject(p.id, renamingName); setRenamingId(null); }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          style={{
                            flex: 1, padding: "4px 8px", borderRadius: 6,
                            border: "1.5px solid rgba(37,99,235,0.40)",
                            fontSize: 13, fontWeight: 500, outline: "none",
                            background: "#f8fafc",
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div
                          style={{
                            flex: 1, fontSize: 13, fontWeight: 600, color: "#1e293b",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            cursor: "text", padding: "4px 2px",
                          }}
                          title="Click to rename"
                          onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenamingName(p.name); }}
                        >
                          {p.name}
                        </div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${p.name}"? This cannot be undone.`)) {
                            setPhotos((prev) => prev.filter((x) => x.id !== p.id));
                            if (activePhotoId === p.id) setActivePhotoId(prev => prev === p.id ? (photos.find(x => x.id !== p.id)?.id ?? "") : prev);
                          }
                        }}
                        title="Delete project"
                        className="rv-btn-small"
                        style={{
                          width: 28, height: 28, borderRadius: 7, border: "none",
                          background: "transparent", color: "#cbd5e1",
                          cursor: "pointer", fontSize: 14, display: "flex",
                          alignItems: "center", justifyContent: "center", flexShrink: 0,
                          padding: 0,
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(239,68,68,0.08)"; (e.currentTarget as HTMLButtonElement).style.color = "#ef4444"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; (e.currentTarget as HTMLButtonElement).style.color = "#cbd5e1"; }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── PROJECT SCREEN ──────────────────────────────────────────────────────────
  return (
    <div style={
      screen === "CUSTOMER_VIEW"
        ? { display: "flex", flexDirection: "row", height: "100dvh", overflow: "hidden" }
        : isCustomerView
        ? { position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: "#0c1524" }
        : { display: "flex", flexDirection: "column", height: "100vh", background: "#f8fafc" }
    }>

      {/* ── CUSTOMER VIEW TOP BAR ── */}
      {isCustomerView && active && (
        <div style={{
          height: 52, flexShrink: 0,
          background: "rgba(255,255,255,0.06)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex", alignItems: "center",
          padding: "0 20px", gap: 16,
        }}>
          <Image src="/roofviz-logo.png" alt="RoofViz" width={90} height={26} priority style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, textAlign: "center" as const, fontSize: 14, fontWeight: 700, color: "#f1f5f9" }}>
            {STEP_TITLE[liveStep] ?? liveStep}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={goBack}
              disabled={stepIndex(liveStep) === 0}
              style={{ padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: stepIndex(liveStep) === 0 ? "default" : "pointer",
                border: "1.5px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)",
                color: stepIndex(liveStep) === 0 ? "rgba(255,255,255,0.25)" : "#e2e8f0" }}
            >← Back</button>
            <button
              onClick={goNext}
              disabled={!canGoNext()}
              style={{ padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: canGoNext() ? "pointer" : "default", border: "none",
                background: canGoNext() ? "linear-gradient(135deg,#2563eb,#1d4ed8)" : "rgba(255,255,255,0.08)",
                color: canGoNext() ? "#ffffff" : "rgba(255,255,255,0.25)" }}
            >Next →</button>
            <button
              onClick={exitCustomerView}
              style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700,
                cursor: "pointer", border: "1.5px solid rgba(255,100,100,0.35)",
                background: "rgba(255,80,80,0.12)", color: "#fca5a5", marginLeft: 4 }}
            >✕ Exit</button>
          </div>
        </div>
      )}

      {/* ── TOP BAR (PROJECT editor only) ── */}
      {screen !== "CUSTOMER_VIEW" && !isCustomerView && (
        <header style={{
          flexShrink: 0,
          background: "#ffffff",
          boxShadow: "0 2px 8px rgba(15,23,42,0.06), 0 1px 0 rgba(15,23,42,0.04)",
          zIndex: 10,
        }}>
          {/* Row 1 — main bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 56, padding: "0 18px" }}>
          <button onClick={() => setScreen("MENU")}
            className="rv-topbar-btn"
            style={{ ...topBarBtn, padding: "5px 10px", color: "#64748b", flexShrink: 0 }}>
            ← Menu
          </button>
          <button onClick={() => setScreen("MENU")} className="rv-logo-btn"
            style={{ background: "none", border: "none", cursor: "pointer",
              padding: 0, flexShrink: 0, display: "flex", alignItems: "center" }}
            title="Back to menu">
            <Image src="/roofviz-logo.png" alt="RoofViz" width={140} height={41} priority />
          </button>
          {active && (
            <input
              value={active.name}
              onChange={(e) => patchActive((p) => ({ ...p, name: e.target.value }))}
              placeholder="Project name"
              style={{
                flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "#0f172a",
                background: "transparent", border: "none",
                padding: "4px 8px", outline: "none",
                letterSpacing: "0.01em", textAlign: "center",
              }}
            />
          )}
          {active && (
            <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
              {!presentationMode && (
                <button
                  className="rv-topbar-btn"
                  style={{ ...topBarBtn,
                    background: active.showGuidesDuringInstall ? "rgba(37,99,235,0.06)" : "#ffffff",
                    color: active.showGuidesDuringInstall ? "#2563eb" : "#64748b",
                    borderColor: active.showGuidesDuringInstall ? "rgba(37,99,235,0.22)" : "rgba(15,23,42,0.10)" }}
                  onClick={() => patchActive((p) => ({ ...p, showGuidesDuringInstall: !p.showGuidesDuringInstall }))}
                >
                  {active.showGuidesDuringInstall ? "⊙ Guides On" : "⊙ Guides"}
                </button>
              )}
              <button
                className="rv-topbar-btn"
                style={{ ...topBarBtn,
                  background: presentationMode ? "linear-gradient(135deg,#7c3aed,#6d28d9)" : "#ffffff",
                  color: presentationMode ? "#ffffff" : "#64748b",
                  border: presentationMode ? "none" : "1.5px solid rgba(15,23,42,0.10)",
                  fontWeight: 600,
                  boxShadow: presentationMode ? "0 2px 6px rgba(109,40,217,0.28)" : "none",
                }}
                onClick={() => {
                  const next = !presentationMode;
                  setPresentationMode(next);
                  setDrawerOpen(!next);
                  if (next && active) {
                    patchActive((p) => ({ ...p, step: "TEAROFF" }));
                    setUiTab("edit");
                  }
                }}
              >
                {presentationMode ? "✦ Presenting" : "✦ Present"}
              </button>
              {presentationMode && (
                <button
                  className="rv-topbar-btn"
                  style={{ ...topBarBtn,
                    background: "linear-gradient(135deg,#0ea5e9,#0284c7)",
                    color: "#ffffff", border: "none", fontWeight: 600,
                    boxShadow: "0 2px 6px rgba(2,132,199,0.28)",
                  }}
                  onClick={enterCustomerView}
                >
                  ⛶ Customer View
                </button>
              )}
              <button
                className="rv-topbar-btn"
                style={{ ...topBarBtn,
                  background: liveStep === "EXPORT" ? "linear-gradient(135deg,#16a34a,#15803d)" : "#f8fafc",
                  color: liveStep === "EXPORT" ? "#ffffff" : "#94a3b8",
                  border: liveStep === "EXPORT" ? "none" : "1.5px solid rgba(15,23,42,0.09)",
                  fontWeight: liveStep === "EXPORT" ? 600 : 500,
                  cursor: liveStep === "EXPORT" ? "pointer" : "default",
                  boxShadow: liveStep === "EXPORT" ? "0 2px 6px rgba(22,163,74,0.28)" : "none",
                }}
                disabled={liveStep !== "EXPORT"}
                onClick={liveStep === "EXPORT" ? exportPdfTwoPages : undefined}
              >
                ↓ Export PDF
              </button>
              {!presentationMode && (
                <button className="rv-topbar-btn"
                  style={{ ...topBarBtn,
                    background: drawerOpen ? "rgba(37,99,235,0.07)" : "#ffffff",
                    color: drawerOpen ? "#2563eb" : "#64748b",
                    borderColor: drawerOpen ? "rgba(37,99,235,0.25)" : "rgba(15,23,42,0.10)",
                  }}
                  onClick={() => setDrawerOpen(v => !v)}
                >
                  {drawerOpen ? "× Panel" : "☰ Panel"}
                </button>
              )}
            </div>
          )}
          </div>
          {/* Row 2 — step progress strip */}
          {active && liveStep !== "START" && !presentationMode && (
            <div style={{ height: 34, display: "flex", alignItems: "center",
              padding: "0 18px", gap: 0, background: "#f8fafc",
              borderBottom: "1px solid rgba(15,23,42,0.06)", overflowX: "auto",
              flexShrink: 0, scrollbarWidth: "none" as any }}>
              {STEPS.filter(s => s !== "START").map((step, i) => {
                const liveIdx = stepIndex(liveStep);
                const thisIdx = stepIndex(step);
                const isCompleted = thisIdx < liveIdx;
                const isCurrent = step === liveStep;
                const isRelevant = relevantSteps(active.roofs).has(step);
                return (
                  <React.Fragment key={step}>
                    {i > 0 && (
                      <div style={{ width: 12, height: 1, flexShrink: 0,
                        background: isCompleted ? "#bbf7d0" : "#e2e8f0" }} />
                    )}
                    <button onClick={() => jumpToStep(step)} style={{
                      padding: "3px 9px", borderRadius: 99, fontSize: 11,
                      fontWeight: isCurrent ? 700 : 500,
                      border: isCurrent ? "1.5px solid rgba(37,99,235,0.35)" : "1.5px solid transparent",
                      background: isCurrent ? "rgba(37,99,235,0.08)" : "transparent",
                      color: isCurrent ? "#2563eb" : isCompleted ? "#16a34a" : "#94a3b8",
                      opacity: !isRelevant && !isCurrent && !isCompleted ? 0.4 : 1,
                      cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" as const,
                    }}>
                      {isCompleted ? "✓ " : ""}{STEP_SHORT[step] ?? step}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </header>
      )}

      {/* ── CONTENT AREA: canvas + floating drawer overlay ── */}
      <div style={
        screen === "CUSTOMER_VIEW"
          ? { display: "contents" }
          : isCustomerView
        ? { display: "flex", flexDirection: "row", flex: 1, overflow: "hidden", minHeight: 0 }
        : { display: "flex", flex: 1, overflow: "hidden", minHeight: 0, position: "relative" }
      }>

      {/* ── CUSTOMER RIGHT SIDEBAR ── */}
      {screen === "CUSTOMER_VIEW" && customerViewData && (
        <div style={{
          order: 2,
          width: 176,
          flexShrink: 0,
          background: "#ffffff",
          borderLeft: "1.5px solid #e2e8f0",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: "100dvh",
        }}>
          {/* Logo + project name */}
          <div style={{ padding: "14px 14px 12px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 }}>
            <Image src="/roofviz-logo.png" alt="RoofViz" width={120} height={35} priority />
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#1e293b", lineHeight: 1.35, wordBreak: "break-word" as const }}>
              {customerViewData.name}
            </div>
          </div>

          {/* Step checklist — scrollable */}
          <div style={{ flex: "1 1 0", overflowY: "auto", padding: "6px 0", scrollbarWidth: "none" as any }}>
            {customerNavSteps.map((s, i) => {
              const isPast = i < customerStepIdx;
              const isCurrent = i === customerStepIdx;
              return (
                <button
                  key={s}
                  onClick={() => setCustomerStep(s)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "8px 14px",
                    border: "none",
                    background: isCurrent ? "#eff6ff" : "transparent",
                    borderLeft: isCurrent ? "3px solid #2563eb" : "3px solid transparent",
                    cursor: "pointer",
                    textAlign: "left" as const,
                  }}
                >
                  <span style={{
                    flexShrink: 0,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    fontWeight: 700,
                    background: isCurrent ? "#2563eb" : isPast ? "#dcfce7" : "#f1f5f9",
                    color: isCurrent ? "#fff" : isPast ? "#16a34a" : "#cbd5e1",
                    border: isCurrent ? "none" : isPast ? "1.5px solid #86efac" : "1.5px solid #e2e8f0",
                  }}>
                    {isPast ? "✓" : ""}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: isCurrent ? 700 : 500, color: isCurrent ? "#1e40af" : isPast ? "#334155" : "#94a3b8", lineHeight: 1.3 }}>
                    {STEP_SHORT[s] ?? s}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Prev / Next navigation */}
          <div style={{ borderTop: "1px solid #f1f5f9", padding: "10px 14px", flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              onClick={() => customerStepIdx > 0 && setCustomerStep(customerNavSteps[customerStepIdx - 1])}
              disabled={customerStepIdx <= 0}
              style={{ width: "100%", padding: "8px 0", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontSize: 12, fontWeight: 600, color: "#475569", cursor: customerStepIdx > 0 ? "pointer" : "default", opacity: customerStepIdx > 0 ? 1 : 0.35 }}
            >← Previous</button>
            <button
              onClick={() => customerStepIdx < customerNavSteps.length - 1 && setCustomerStep(customerNavSteps[customerStepIdx + 1])}
              disabled={customerStepIdx >= customerNavSteps.length - 1}
              style={{ width: "100%", padding: "8px 0", borderRadius: 8, border: "none", background: customerStepIdx < customerNavSteps.length - 1 ? "linear-gradient(135deg,#2563eb,#1d4ed8)" : "#e2e8f0", fontSize: 12, fontWeight: 700, color: customerStepIdx < customerNavSteps.length - 1 ? "#fff" : "#94a3b8", cursor: customerStepIdx < customerNavSteps.length - 1 ? "pointer" : "default", opacity: customerStepIdx < customerNavSteps.length - 1 ? 1 : 0.5 }}
            >Next →</button>
          </div>

          {/* Photo switcher — only if multiple photos */}
          {customerViewData.photos.length > 1 && (
            <div style={{ borderTop: "1px solid #f1f5f9", padding: "8px 14px", flexShrink: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 7 }}>Photos</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <button
                  onClick={() => setCustomerPhotoIdx(Math.max(0, customerPhotoIdx - 1))}
                  disabled={customerPhotoIdx === 0}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontSize: 14, fontWeight: 600, cursor: customerPhotoIdx > 0 ? "pointer" : "default", opacity: customerPhotoIdx > 0 ? 1 : 0.3, color: "#475569" }}
                >‹</button>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#475569" }}>{customerPhotoIdx + 1} / {customerViewData.photos.length}</span>
                <button
                  onClick={() => setCustomerPhotoIdx(Math.min(customerViewData.photos.length - 1, customerPhotoIdx + 1))}
                  disabled={customerPhotoIdx >= customerViewData.photos.length - 1}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "1.5px solid #e2e8f0", background: "#f8fafc", fontSize: 14, fontWeight: 600, cursor: customerPhotoIdx < customerViewData.photos.length - 1 ? "pointer" : "default", opacity: customerPhotoIdx < customerViewData.photos.length - 1 ? 1 : 0.3, color: "#475569" }}
                >›</button>
              </div>
            </div>
          )}

          {/* Shingle color swatches — only at SHINGLES+ */}
          {atLeast(customerStep, "SHINGLES") && (
            <div style={{ borderTop: "1px solid #f1f5f9", padding: "10px 14px 12px", flexShrink: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>Shingle Color</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>{customerShingleColor}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {(["Barkwood","Charcoal","WeatheredWood","PewterGray","OysterGray","Slate","Black"] as ShingleColor[]).map((c) => {
                  const [cr, cg, cb] = shingleRGB(c);
                  return (
                    <div
                      key={c}
                      onClick={() => setCustomerShingleColor(c)}
                      title={c}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: "50%",
                        background: `rgb(${cr},${cg},${cb})`,
                        cursor: "pointer",
                        border: c === customerShingleColor ? "2.5px solid #2563eb" : "2px solid rgba(15,23,42,0.12)",
                        boxShadow: c === customerShingleColor ? "0 0 0 2px rgba(37,99,235,0.3)" : "none",
                        transition: "box-shadow 0.15s",
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── FLOATING DRAWER ── */}
      {screen !== "CUSTOMER_VIEW" && !isCustomerView && (
        <AnimatePresence>
          {drawerOpen && !presentationMode && (
            <motion.aside
              key="drawer"
              initial={{ x: 310, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 310, opacity: 0 }}
              transition={{ type: "tween", duration: 0.20, ease: "easeOut" }}
              style={{
                position: "absolute", right: 12, top: 12, bottom: 12,
                width: 300, zIndex: 20,
                background: "#ffffff",
                borderRadius: 16,
                boxShadow: "0 8px 40px rgba(15,23,42,0.16), 0 0 0 1px rgba(15,23,42,0.06)",
                display: "flex", flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {/* Drawer header: step badge + step name + close button */}
              <div style={{ padding: "10px 14px 8px",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                borderBottom: "1px solid rgba(15,23,42,0.06)", flexShrink: 0 }}>
                <div style={{ ...accentSectionHeader, marginBottom: 0 }}>
                  <span key={liveStep} className="rv-badge-pop" style={stepBadge}>
                    {stepIndex(liveStep) + 1}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#334155",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {STEP_SHORT[liveStep] ?? liveStep}
                  </span>
                </div>
                <button onClick={() => setDrawerOpen(false)}
                  style={{ background: "none", border: "none", cursor: "pointer",
                    color: "#94a3b8", fontSize: 18, lineHeight: 1, padding: "2px 6px",
                    borderRadius: 6 }}>×</button>
              </div>

              {/* Progress bar */}
              <div style={{ height: 3, background: "#e2e8f0", flexShrink: 0 }}>
                <div style={{ height: "100%",
                  width: `${((stepIndex(liveStep) + 1) / STEPS.length) * 100}%`,
                  background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                  transition: "width 0.4s ease" }} />
              </div>

              {/* Photo switcher — presentation mode with >1 photo */}
              {presentationMode && (active?.photoSrcs?.length ?? 0) > 1 && (() => {
                const srcs = active!.photoSrcs;
                const idx = srcs.indexOf(active!.src);
                const total = srcs.length;
                return (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px 0", gap: 6 }}>
                    <button
                      onClick={() => switchToPhoto(srcs[(idx - 1 + total) % total])}
                      className="rv-btn-small"
                      style={{ padding: "4px 10px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1.5px solid rgba(15,23,42,0.10)", background: "#fff", color: "#334155", flexShrink: 0 }}
                    >‹</button>
                    <span style={{ fontSize: 11, fontWeight: 500, color: "#64748b", textAlign: "center" as const }}>
                      Photo {idx + 1} / {total}
                    </span>
                    <button
                      onClick={() => switchToPhoto(srcs[(idx + 1) % total])}
                      className="rv-btn-small"
                      style={{ padding: "4px 10px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1.5px solid rgba(15,23,42,0.10)", background: "#fff", color: "#334155", flexShrink: 0 }}
                    >›</button>
                  </div>
                );
              })()}

              {/* Scrollable body */}
              <div style={{ flex: 1, overflow: "auto", padding: "14px" }}>

          {/* ── Edit / Settings tab switcher ── */}
          {active && liveStep !== "START" && !presentationMode && (
            <div style={{ display: "flex", gap: 0, flexShrink: 0,
              background: "#f1f5f9", borderRadius: 10, padding: "3px", marginBottom: 10 }}>
              {(["edit", "settings"] as const).map((tab) => (
                <button key={tab} onClick={() => setUiTab(tab)} className="rv-tab-btn"
                  style={{ ...tabBtnBase, position: "relative", background: "transparent",
                    color: uiTab === tab ? "#1e293b" : "#94a3b8",
                    fontWeight: uiTab === tab ? 600 : 500, zIndex: 1 }}>
                  {uiTab === tab && (
                    <motion.span layoutId="tab-indicator"
                      style={{ position: "absolute", inset: 0, borderRadius: 7,
                        background: "#ffffff", boxShadow: "0 1px 3px rgba(15,23,42,0.10)", zIndex: -1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                  )}
                  {tab === "edit" ? "Edit" : "⚙ Settings"}
                </button>
              ))}
            </div>
          )}

          {/* ── START screen ── */}
          {liveStep === "START" && (
            <div style={sectionCard}>
              <div style={sectionLabel}>New Project</div>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", margin: "10px 0 6px", lineHeight: 1.2 }}>
                Create a roof visualization
              </h2>
              <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20, lineHeight: 1.6 }}>
                Upload a job photo, trace the roof, and walk your customer through every installation layer.
              </p>
              <label style={fieldLabel}>Project name</label>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                style={inputStyle}
                placeholder="e.g. 123 Oak Street"
              />
              <button style={primaryBtn} onClick={startProject}>
                Start Project →
              </button>
            </div>
          )}

          {/* ── ACTIVE PROJECT (Edit tab) ── */}
          {liveStep !== "START" && uiTab === "edit" && (
            <>
              {/* Photo — current project only — hidden in presentation mode */}
              {!presentationMode && <div style={sectionCard} className="rv-section-card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={accentSectionHeader}>
                    <span style={sectionLabel}>
                      Photo{(active?.photoSrcs?.length ?? 0) > 1 ? ` (${(active?.photoSrcs?.indexOf(active?.src) ?? 0) + 1}/${active?.photoSrcs?.length})` : ""}
                    </span>
                  </div>
                  {active?.src && (
                    <button
                      className="rv-btn-small"
                      onClick={removeCurrentPhoto}
                      style={{ ...smallBtn, fontSize: 11, color: "#dc2626", borderColor: "rgba(220,38,38,0.22)", padding: "4px 9px" }}
                    >
                      Remove
                    </button>
                  )}
                </div>

                {active?.src ? (
                  <div style={{ marginTop: 10, borderRadius: 10, overflow: "hidden", border: "1.5px solid rgba(15,23,42,0.08)" }}>
                    <img src={active.src} alt={active.name} style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
                  </div>
                ) : (
                  <label className="rv-upload-zone" style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    marginTop: 10,
                    padding: "18px 16px",
                    borderRadius: 10,
                    border: "1.5px dashed rgba(37,99,235,0.28)",
                    background: "rgba(37,99,235,0.03)",
                    cursor: "pointer",
                    gap: 6,
                  }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(37,99,235,0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="3"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", letterSpacing: "0.04em" }}>Upload Photo</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>PNG or JPG</div>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }}
                      style={{ display: "none" }}
                    />
                  </label>
                )}

                {/* Thumbnail strip — shown when multiple photos exist */}
                {(active?.photoSrcs?.length ?? 0) > 1 && (
                  <div style={{ display: "flex", gap: 5, marginTop: 8, overflowX: "auto", paddingBottom: 2 }}>
                    {active!.photoSrcs.map((s, i) => (
                      <div
                        key={i}
                        onClick={() => switchToPhoto(s)}
                        style={{
                          width: 48, height: 34, borderRadius: 6, overflow: "hidden",
                          cursor: "pointer", flexShrink: 0,
                          border: s === active!.src ? "2px solid #2563eb" : "2px solid rgba(15,23,42,0.08)",
                          opacity: s === active!.src ? 1 : 0.55,
                          transition: "opacity 0.15s, border-color 0.15s",
                        }}
                      >
                        <img src={s} alt={`Photo ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Add more photos */}
                {active?.src && (
                  <label className="rv-upload-zone" style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 8,
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "1.5px dashed rgba(37,99,235,0.20)",
                    background: "rgba(37,99,235,0.02)",
                    cursor: "pointer",
                    gap: 6,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#2563eb" }}>+ Add more photos</div>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }}
                      style={{ display: "none" }}
                    />
                  </label>
                )}
              </div>}

              {/* Step navigation — checklist */}
              {active && (
                <div style={sectionCard}>
                  {/* Checklist */}
                  <div style={{ display: "grid", gap: 2, marginBottom: 14 }}>
                    {STEPS.filter(s => s !== "START").map((step) => {
                      const rel = relevantSteps(active.roofs);
                      const isCurrent   = liveStep === step;
                      const isCompleted = stepIndex(liveStep) > stepIndex(step);
                      const isSkipped   = !rel.has(step) && !isCurrent && !isCompleted;
                      return (
                        <div
                          key={step}
                          className="rv-step-row"
                          onClick={() => isCompleted ? jumpToStep(step) : undefined}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "5px 8px",
                            borderRadius: 7,
                            cursor: isCompleted ? "pointer" : "default",
                            background: isCurrent ? "rgba(37,99,235,0.07)" : "transparent",
                            opacity: isSkipped ? 0.38 : 1,
                          }}
                        >
                          {/* Status icon */}
                          <div style={{ flexShrink: 0, width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {isCompleted ? (
                              <svg width="16" height="16" viewBox="0 0 16 16">
                                <circle cx="8" cy="8" r="7" fill="#2563eb"/>
                                <polyline points="4.5,8.5 7,11 11.5,5.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            ) : isCurrent ? (
                              <svg width="16" height="16" viewBox="0 0 16 16">
                                <circle cx="8" cy="8" r="7" fill="none" stroke="#2563eb" strokeWidth="2"/>
                                <circle cx="8" cy="8" r="3.5" fill="#2563eb"/>
                              </svg>
                            ) : isSkipped ? (
                              <span style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1 }}>—</span>
                            ) : (
                              <svg width="16" height="16" viewBox="0 0 16 16">
                                <circle cx="8" cy="8" r="7" fill="none" stroke="#cbd5e1" strokeWidth="1.5"/>
                              </svg>
                            )}
                          </div>
                          {/* Step name */}
                          <span style={{
                            fontSize: 12,
                            fontWeight: isCurrent ? 600 : isCompleted ? 500 : 400,
                            color: isCurrent ? "#1d4ed8" : isCompleted ? "#334155" : "#94a3b8",
                            flex: 1,
                          }}>
                            {STEP_SHORT[step]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Current step detail */}
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b", marginBottom: 5, paddingTop: 8, borderTop: "1px solid rgba(15,23,42,0.05)" }}>
                    {STEP_TITLE[liveStep]}
                  </div>
                  {STEP_HINT[liveStep] && (
                    <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.55, margin: "0 0 8px" }}>
                      {STEP_HINT[liveStep]}
                    </p>
                  )}
                  {STEP_TIP[liveStep] && (
                    <div style={tipBox}>💡 {STEP_TIP[liveStep]}</div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                    <button className="rv-btn-ghost" style={ghostBtn} onClick={goBack}
                      disabled={stepIndex(liveStep) === 0}>← Back</button>
                    <button
                      className="rv-btn-primary"
                      style={{ ...primaryBtn, margin: 0 }}
                      onClick={goNext}
                      disabled={!canGoNext()}
                      title={!canGoNext() && liveStep === "TRACE" ? "Complete roof outline to continue" : undefined}
                    >
                      Continue →
                    </button>
                  </div>
                  {liveStep === "EXPORT" && (
                    <div style={{ marginTop: 12 }}>
                      <button className="rv-btn-primary" style={greenBtn} onClick={exportPdfTwoPages}>
                        ↓ Export PDF
                      </button>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, textAlign: "center" }}>
                        Page 1: Shingles &nbsp;·&nbsp; Page 2: Underlayments + metals
                      </div>
                      <button
                        style={{ ...ghostBtn, width: "100%", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxSizing: "border-box" as const }}
                        onClick={() => { setShowShareModal((v) => !v); setShareEmail(""); setShareEmailSent(false); setShareErrorMsg(""); setShareStatus(""); }}
                      >
                        Share with Customer
                      </button>
                      {showShareModal && (() => {
                        const projectName = active?.name || "Your Roof";
                        const canSend = shareEmail.includes("@") && shareEmail.includes(".");
                        const isBusy = shareEmailSending || shareStatus === "compressing" || shareStatus === "uploading";
                        const statusLabel = shareStatus === "compressing" ? "Preparing photos…" : shareStatus === "uploading" ? "Uploading photos…" : shareStatus === "sending" ? "Sending email…" : "";
                        return (
                          <div style={{ marginTop: 10, padding: 14, background: "#f8fafc", borderRadius: 10, border: "1.5px solid rgba(37,99,235,0.18)" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>Share with Customer</div>
                            {shareEmailSent ? (
                              <div style={{ textAlign: "center", padding: "14px 0" }}>
                                <div style={{ fontSize: 22, marginBottom: 6 }}>✓</div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: "#16a34a" }}>Link sent to {shareEmail}</div>
                                <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>The customer can open it on any device.</div>
                              </div>
                            ) : (
                              <>
                                {/* Email input + send */}
                                <input
                                  type="email"
                                  placeholder="customer@email.com"
                                  value={shareEmail}
                                  onChange={(e) => { setShareEmail(e.target.value); setShareErrorMsg(""); }}
                                  style={{ ...inputStyle, fontSize: 13, padding: "9px 12px", marginBottom: 6 }}
                                />
                                <button
                                  style={{ ...primaryBtn, marginTop: 0, padding: "9px 14px", fontSize: 12, width: "100%", boxSizing: "border-box" as const, opacity: canSend && !isBusy ? 1 : 0.45 }}
                                  disabled={!canSend || isBusy}
                                  onClick={async () => {
                                    setShareEmailSending(true);
                                    setShareErrorMsg("");
                                    try {
                                      const urlMap = await prepareAllPhotoUrls();
                                      const shareUrl = generateShareUrl(urlMap);
                                      setShareStatus("sending");
                                      const res = await fetch("/api/send-email", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ to: shareEmail, shareUrl, projectName }),
                                      });
                                      const text = await res.text();
                                      let body: { ok?: boolean; error?: string } = {};
                                      try { body = JSON.parse(text); } catch { /* non-JSON */ }
                                      if (!res.ok || body.error) {
                                        setShareErrorMsg(`Send failed (${res.status}): ${body.error || text.slice(0, 120)}`);
                                      } else {
                                        setShareEmailSent(true);
                                      }
                                    } catch (e) {
                                      setShareErrorMsg(`Network error: ${e}`);
                                    } finally {
                                      setShareEmailSending(false);
                                      setShareStatus("");
                                    }
                                  }}
                                >
                                  {statusLabel || "Send Link"}
                                </button>
                                {shareErrorMsg && (
                                  <div style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, padding: "7px 10px", marginTop: 6, lineHeight: 1.4 }}>
                                    {shareErrorMsg}
                                  </div>
                                )}

                                {/* Divider */}
                                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
                                  <div style={{ flex: 1, height: 1, background: "rgba(15,23,42,0.10)" }} />
                                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>or copy link</span>
                                  <div style={{ flex: 1, height: 1, background: "rgba(15,23,42,0.10)" }} />
                                </div>

                                {/* Copy link button */}
                                <button
                                  style={{ ...primaryBtn, marginTop: 0, padding: "8px 14px", fontSize: 12, width: "100%", boxSizing: "border-box" as const, background: shareStatus === "copied" ? "linear-gradient(135deg,#16a34a,#15803d)" : "linear-gradient(135deg,#475569,#334155)", opacity: isBusy ? 0.45 : 1 }}
                                  disabled={isBusy}
                                  onClick={async () => {
                                    setShareErrorMsg("");
                                    const urlMap = await prepareAllPhotoUrls();
                                    const shareUrl = generateShareUrl(urlMap);
                                    try {
                                      await navigator.clipboard.writeText(shareUrl);
                                      setShareStatus("copied");
                                      setTimeout(() => setShareStatus(""), 2500);
                                    } catch {
                                      setShareErrorMsg("Clipboard unavailable — link: " + shareUrl.slice(0, 80));
                                    }
                                  }}
                                >
                                  {shareStatus === "copied" ? "Copied!" : statusLabel || "Copy Link"}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* Roofs — hidden in presentation mode */}
              {active && !presentationMode && (
                <div style={sectionCard}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={accentSectionHeader}>
                      <span style={sectionLabel}>Roofs</span>
                    </div>
                    <button className="rv-btn-small" style={smallBtn} onClick={addRoof}>+ Add Roof</button>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    {active.roofs.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => patchActive((p) => ({ ...p, activeRoofId: r.id }))}
                        style={{
                          padding: "5px 14px",
                          borderRadius: 99,
                          fontSize: 12, fontWeight: 600,
                          cursor: "pointer",
                          border: r.id === active.activeRoofId
                            ? "1.5px solid rgba(37,99,235,0.35)"
                            : "1.5px solid rgba(15,23,42,0.10)",
                          background: r.id === active.activeRoofId ? "rgba(37,99,235,0.08)" : "#fff",
                          color: r.id === active.activeRoofId ? "#2563eb" : "#475569",
                        }}
                      >
                        {r.name}{r.closed ? " ✓" : ""}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <button
                      style={{ ...smallBtn, flex: 1 }}
                      onClick={() => patchActive((p) => ({ ...p, showGuidesDuringInstall: !p.showGuidesDuringInstall }))}
                    >
                      {active.showGuidesDuringInstall ? "Hide guides" : "Show guides"}
                    </button>
                    <button
                      style={{ ...smallBtn, flex: 1 }}
                      onClick={() => patchActive((p) => ({ ...p, showEditHandles: !p.showEditHandles }))}
                    >
                      {active.showEditHandles ? "Hide handles" : "Edit handles"}
                    </button>
                  </div>

                  {/* Ice & Water brush tools */}
                  {activeRoof && liveStep === "ICE_WATER" && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(15,23,42,0.07)" }}>
                      <button
                        style={{
                          ...ghostBtn,
                          width: "100%",
                          background: tool === "BRUSH_ICE_WATER" ? "rgba(18,23,38,0.10)" : "#ffffff",
                          border: `1.5px solid ${tool === "BRUSH_ICE_WATER" ? "rgba(18,23,38,0.45)" : "rgba(15,23,42,0.12)"}`,
                          color: tool === "BRUSH_ICE_WATER" ? "#0f172a" : "#475569",
                          fontWeight: tool === "BRUSH_ICE_WATER" ? 700 : 600,
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                        }}
                        onClick={() => {
                          setTool(tool === "BRUSH_ICE_WATER" ? "NONE" : "BRUSH_ICE_WATER");
                        }}
                      >
                        🖌 {tool === "BRUSH_ICE_WATER" ? "Painting — drag on canvas" : "Paint Custom Ice & Water"}
                      </button>
                      {tool === "BRUSH_ICE_WATER" && (
                        <div style={{ marginTop: 6, background: "rgba(18,23,38,0.06)", borderRadius: 8, padding: "8px 10px", fontSize: 11, color: "#334155" }}>
                          Drag on the roof to paint. Stroke auto-straightens on release.
                          <div style={{ marginTop: 6 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                              <span>Brush size</span>
                              <span style={{ fontWeight: 700 }}>{activeRoof.iceWaterBrushSize ?? 30}px</span>
                            </div>
                            <input
                              type="range" min={5} max={100} step={1}
                              value={activeRoof.iceWaterBrushSize ?? 30}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, iceWaterBrushSize: Number(e.target.value) }))}
                              style={{ width: "100%", accentColor: "#0f172a" }}
                            />
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button
                              style={{ ...smallBtn, flex: 1, fontSize: 11 }}
                              onClick={() => patchActiveRoof((r) => ({ ...r, iceWaterBrush: (r.iceWaterBrush ?? []).slice(0, -1) }))}
                              disabled={!(activeRoof.iceWaterBrush ?? []).length}
                            >↩ Undo</button>
                            <button
                              style={{ ...smallBtn, flex: 1, fontSize: 11, color: "#dc2626", borderColor: "rgba(220,38,38,0.22)" }}
                              onClick={() => patchActiveRoof((r) => ({ ...r, iceWaterBrush: [] }))}
                              disabled={!(activeRoof.iceWaterBrush ?? []).length}
                            >Clear all</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Trace tools */}
                  {activeRoof && liveStep === "TRACE" && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(15,23,42,0.07)" }}>
                      {!activeRoof.closed ? (
                        /* ── Step A: outline the roof ── */
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={sectionLabel}>Step A — Outline the Roof</div>

                          <button
                            className={tool === "TRACE_ROOF" ? "rv-btn-tracing" : "rv-btn-ghost"}
                            style={{
                              ...ghostBtn,
                              background: tool === "TRACE_ROOF" ? "rgba(37,99,235,0.10)" : "rgba(37,99,235,0.04)",
                              border: `1.5px solid rgba(37,99,235,${tool === "TRACE_ROOF" ? "0.45" : "0.25"})`,
                              color: "#1d4ed8",
                              fontWeight: tool === "TRACE_ROOF" ? 700 : 600,
                            }}
                            onClick={() => { setTool("TRACE_ROOF"); setDraftLine(null); setDraftHole(null); }}
                          >
                            {tool === "TRACE_ROOF" ? "✦ Tracing — click the canvas" : "Start Tracing Roof Edge"}
                          </button>
                          <button style={ghostBtn} onClick={undoOutlinePoint} disabled={activeRoof.outline.length < 2}>
                            Undo Last Point
                          </button>
                          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.55, background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
                            Click around the roof edge on the photo. Click the <strong>first point again</strong> to close and finish the outline.
                          </div>
                        </div>
                      ) : (
                        /* ── Step B: label the edges ── */
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={sectionLabel}>Label Roof Edges</div>
                          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5 }}>
                            AI labels your drawn edges automatically. Click any label to edit.
                          </div>

                          {/* Auto-Label primary CTA */}
                          <button
                            style={{ ...primaryBtn, fontSize: 13, display: "flex", alignItems: "center",
                              justifyContent: "center", gap: 8 }}
                            onClick={triggerAutoLabel}
                            disabled={autoLabelState === "loading"}
                          >
                            {autoLabelState === "loading"
                              ? <><span className="spinner" />Analyzing edges…</>
                              : activeRoof.lines.length > 0
                                ? <>↺ Re-run Auto-Label</>
                                : <>⚡ Auto-Label Roof Edges</>}
                            <span style={{ fontSize: 10, background: "rgba(16,185,129,0.12)", color: "#059669",
                              border: "1px solid rgba(16,185,129,0.3)", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>AI</span>
                          </button>

                          {/* Run AI Judge button — above suggest buttons */}
                          <button
                            style={{ ...smallBtn, width: "100%", fontSize: 12, display: "flex",
                              alignItems: "center", justifyContent: "center", gap: 6,
                              color: "#6366f1", borderColor: "rgba(99,102,241,0.3)",
                              background: "rgba(99,102,241,0.05)" }}
                            onClick={() => runAiJudgeLocally(activeRoof, activeRoof.lines)}
                          >
                            🔍 Run AI Judge
                            <span style={{ fontSize: 9, background: "rgba(99,102,241,0.12)", color: "#6366f1",
                              border: "1px solid rgba(99,102,241,0.25)", borderRadius: 3,
                              padding: "1px 4px", fontWeight: 700 }}>QC</span>
                          </button>

                          {/* Suggest Ridge / Suggest Valleys secondary buttons */}
                          <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.4 }}>
                            Facade photos may not show true ridges/valleys clearly.
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                            <button
                              style={{ ...smallBtn, fontSize: 11, display: "flex",
                                alignItems: "center", justifyContent: "center", gap: 5,
                                color: "#d97706", borderColor: "rgba(245,158,11,0.25)",
                                background: "rgba(245,158,11,0.04)" }}
                              onClick={triggerSuggestRidges}
                            >
                              ⬡ Suggest Ridge
                            </button>
                            <button
                              style={{ ...smallBtn, fontSize: 11, display: "flex",
                                alignItems: "center", justifyContent: "center", gap: 5,
                                color: "#64748b", borderColor: "rgba(100,116,139,0.25)",
                                background: "rgba(100,116,139,0.04)" }}
                              onClick={triggerSuggestValleys}
                            >
                              ◈ Suggest Valley
                            </button>
                          </div>

                          {/* AI Judge result card */}
                          {aiJudgeResult && (() => {
                            const { eave, rake, ridge, valley } = aiJudgeResult;
                            const ridgeBadge = ridge.confidence === "high"
                              ? { label: "High", color: "#059669", bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.25)" }
                              : ridge.confidence === "medium"
                                ? { label: "Medium", color: "#d97706", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" }
                                : ridge.confidence === "low"
                                  ? { label: "Low", color: "#dc2626", bg: "rgba(220,38,38,0.07)", border: "rgba(220,38,38,0.25)" }
                                  : { label: "Not detected", color: "#94a3b8", bg: "rgba(15,23,42,0.03)", border: "rgba(15,23,42,0.10)" };
                            const valleyBadge = valley.confidence === "labeled"
                              ? { label: "Labeled", color: "#059669", bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.25)" }
                              : valley.confidence === "possible"
                                ? { label: "Possible", color: "#d97706", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)" }
                                : { label: "Not visible", color: "#94a3b8", bg: "rgba(15,23,42,0.03)", border: "rgba(15,23,42,0.10)" };
                            return (
                              <div style={{ background: "#f8fafc", border: "1px solid rgba(15,23,42,0.09)",
                                borderRadius: 8, padding: "10px 12px", display: "grid", gap: 7 }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: "#0f172a" }}>AI Judge</div>
                                  <button style={{ ...smallBtn, padding: "1px 6px", fontSize: 10 }}
                                    onClick={() => setAiJudgeResult(null)}>✕</button>
                                </div>
                                {/* Eave row */}
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                                  <span>{eave.count > 0 ? "✅" : "⚠️"}</span>
                                  <span style={{ flex: 1, color: "#475569" }}>Eaves ({eave.count})</span>
                                  <span style={{ color: eave.count > 0 ? "#059669" : "#dc2626", fontWeight: 600 }}>
                                    {eave.count > 0 ? "OK" : "None found"}
                                  </span>
                                </div>
                                {/* Rake row */}
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                                  <span>{rake.count > 0 ? "✅" : "⚠️"}</span>
                                  <span style={{ flex: 1, color: "#475569" }}>Rakes ({rake.count})</span>
                                  <span style={{ color: rake.count > 0 ? "#059669" : "#dc2626", fontWeight: 600 }}>
                                    {rake.count > 0 ? "OK" : "None found"}
                                  </span>
                                </div>
                                {/* Ridge row */}
                                <div style={{ display: "grid", gap: 3 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                                    <span>{ridge.confidence === "high" ? "✅" : ridge.confidence === "none" ? "—" : "⚠️"}</span>
                                    <span style={{ flex: 1, color: "#475569" }}>Ridge</span>
                                    <span style={{ fontSize: 9, fontWeight: 700, color: ridgeBadge.color,
                                      background: ridgeBadge.bg, border: `1px solid ${ridgeBadge.border}`,
                                      borderRadius: 3, padding: "1px 5px" }}>{ridgeBadge.label}</span>
                                  </div>
                                  {ridge.reasons.map((r, i) => (
                                    <div key={i} style={{ fontSize: 10, color: "#94a3b8", paddingLeft: 20 }}>• {r}</div>
                                  ))}
                                  {(ridge.confidence === "medium" || ridge.confidence === "low") && ridge.hasCandidates && (
                                    <button style={{ ...smallBtn, fontSize: 10, marginLeft: 18, alignSelf: "start",
                                      color: "#d97706", borderColor: "rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.05)" }}
                                      onClick={triggerSuggestRidges}>⬡ Suggest Ridge</button>
                                  )}
                                </div>
                                {/* Valley row */}
                                <div style={{ display: "grid", gap: 3 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                                    <span>{valley.confidence === "labeled" ? "✅" : valley.confidence === "none" ? "—" : "⚠️"}</span>
                                    <span style={{ flex: 1, color: "#475569" }}>Valley</span>
                                    <span style={{ fontSize: 9, fontWeight: 700, color: valleyBadge.color,
                                      background: valleyBadge.bg, border: `1px solid ${valleyBadge.border}`,
                                      borderRadius: 3, padding: "1px 5px" }}>{valleyBadge.label}</span>
                                  </div>
                                  {valley.reasons.map((r, i) => (
                                    <div key={i} style={{ fontSize: 10, color: "#94a3b8", paddingLeft: 20 }}>• {r}</div>
                                  ))}
                                  {valley.confidence === "possible" && valley.hasCandidates && (
                                    <button style={{ ...smallBtn, fontSize: 10, marginLeft: 18, alignSelf: "start",
                                      color: "#64748b", borderColor: "rgba(100,116,139,0.3)", background: "rgba(100,116,139,0.05)" }}
                                      onClick={triggerSuggestValleys}>◈ Suggest Valley</button>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {autoLabelError && (
                            <div style={{ fontSize: 11, color: "#dc2626" }}>{autoLabelError}</div>
                          )}

                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                            {([
                              ["EAVE",   "Bottom edge"],
                              ["RAKE",   "Side edge"],
                              ["VALLEY", "Valley"],
                              ["RIDGE",  "Ridge (top)"],
                              ["HIP",    "Hip"],
                            ] as [LineKind, string][]).map(([kind, desc]) => (
                              <button
                                key={kind}
                                style={{
                                  ...lineKindBtn(kind),
                                  background: tool === `DRAW_${kind}` ? lineKindBtn(kind).background : "rgba(15,23,42,0.03)",
                                  opacity: tool === `DRAW_${kind}` ? 1 : 0.85,
                                }}
                                title={desc}
                                onClick={() => beginDraw(kind)}
                              >
                                {kind}
                              </button>
                            ))}
                            <button
                              style={{ ...lineKindBtn("VALLEY"), background: "rgba(15,23,42,0.04)", borderColor: "rgba(15,23,42,0.12)", color: "#475569" }}
                              onClick={beginHole}
                            >
                              DORMER
                            </button>
                          </div>

                          {/* Active tool controls */}
                          {(tool === "TRACE_HOLE" || tool.startsWith("DRAW_")) && (
                            <div style={{ background: "rgba(37,99,235,0.04)", border: "1px solid rgba(37,99,235,0.15)", borderRadius: 8, padding: "8px 10px", display: "grid", gap: 6 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#1d4ed8" }}>
                                {tool === "TRACE_HOLE" ? "Drawing dormer/exclusion" : `Drawing ${tool.replace("DRAW_", "")} line`}
                              </div>
                              <div style={{ fontSize: 11, color: "#64748b" }}>Click points on the canvas · Press <kbd style={{ background: "#e2e8f0", borderRadius: 4, padding: "1px 5px", fontFamily: "monospace" }}>Enter</kbd> or tap Finish to save</div>
                              <div style={{ display: "flex", gap: 6 }}>
                                {tool === "TRACE_HOLE" ? (
                                  <button style={{ ...smallBtn, flex: 1 }} onClick={finishHole} disabled={!draftHole || draftHole.length < 6}>Finish hole</button>
                                ) : (
                                  <button style={{ ...smallBtn, flex: 1 }} onClick={finishDraftLine} disabled={!draftLine || draftLine.points.length < 4}>Finish line</button>
                                )}
                                <button style={{ ...smallBtn, flex: 1 }} onClick={tool === "TRACE_HOLE" ? undoHolePoint : undoDraftPoint}>Undo point</button>
                                <button style={{ ...smallBtn }} onClick={() => { setTool("NONE"); setDraftLine(null); setDraftHole(null); }}>✕</button>
                              </div>
                            </div>
                          )}

                          {/* Lines drawn */}
                          {activeRoof.lines.length > 0 && (
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 2 }}>Lines drawn</div>
                              {(["EAVE","RAKE","VALLEY","RIDGE","HIP"] as LineKind[])
                                .filter(kind => activeRoof.lines.some(l => l.kind === kind))
                                .map(kind => (
                                  <div key={kind} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                    {/* Kind section header */}
                                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
                                      color: kindColor(kind), padding: "3px 2px 1px", textTransform: "uppercase" }}>
                                      {kind === "RIDGE" ? "Main Ridge" : kind}
                                    </div>
                                    {activeRoof.lines
                                      .filter(l => l.kind === kind)
                                      .map((line, i) => (
                                        <div key={line.id} style={{ display: "flex", alignItems: "center", gap: 6,
                                          background: "rgba(15,23,42,0.03)", borderRadius: 6, padding: "4px 8px" }}>
                                          <span style={{ width: 8, height: 8, borderRadius: "50%",
                                            background: kindColor(line.kind), flexShrink: 0, display: "inline-block" }} />
                                          <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>
                                            {kind === "RIDGE"
                                              ? `Main Ridge${line.segmentCount && line.segmentCount > 1 ? ` (${line.segmentCount} segs)` : ""}`
                                              : `${kind} ${i + 1}`}
                                          </span>
                                          {line.aiLabeled && (
                                            <span style={{ fontSize: 9, background: "rgba(16,185,129,0.1)", color: "#059669",
                                              border: "1px solid rgba(16,185,129,0.25)", borderRadius: 3,
                                              padding: "1px 4px", fontWeight: 700, flexShrink: 0 }}>AI</span>
                                          )}
                                          {line.confidence !== undefined && (() => {
                                            const c = line.confidence;
                                            const label = c >= 0.8 ? "High" : c >= 0.6 ? "Med" : "Low";
                                            const color = c >= 0.8 ? "#059669" : c >= 0.6 ? "#d97706" : "#dc2626";
                                            const bg = c >= 0.8 ? "rgba(16,185,129,0.08)" : c >= 0.6 ? "rgba(245,158,11,0.08)" : "rgba(220,38,38,0.07)";
                                            const border = c >= 0.8 ? "rgba(16,185,129,0.25)" : c >= 0.6 ? "rgba(245,158,11,0.25)" : "rgba(220,38,38,0.25)";
                                            return (
                                              <span style={{ fontSize: 9, background: bg, color,
                                                border: `1px solid ${border}`, borderRadius: 3,
                                                padding: "1px 4px", fontWeight: 700, flexShrink: 0 }}>{label}</span>
                                            );
                                          })()}
                                          <select
                                            value={line.kind}
                                            style={{ fontSize: 11, border: "1px solid rgba(15,23,42,0.15)", borderRadius: 4, padding: "1px 4px", flex: 1 }}
                                            onChange={e => patchActiveRoof(r => ({
                                              ...r, lines: r.lines.map(li => li.id === line.id ? { ...li, kind: e.target.value as LineKind } : li)
                                            }))}
                                          >
                                            {(["EAVE","RAKE","VALLEY","RIDGE","HIP"] as LineKind[]).map(k =>
                                              <option key={k} value={k}>{k}</option>
                                            )}
                                          </select>
                                          <button
                                            title={line.locked ? "Unlock — allow re-label" : "Lock label"}
                                            style={{ ...smallBtn, padding: "2px 6px", fontSize: 12,
                                              color: line.locked ? "#d97706" : "#cbd5e1",
                                              borderColor: line.locked ? "rgba(217,119,6,0.3)" : "rgba(15,23,42,0.08)" }}
                                            onClick={() => patchActiveRoof(r => ({
                                              ...r, lines: r.lines.map(li => li.id === line.id ? { ...li, locked: !li.locked } : li)
                                            }))}
                                          >
                                            {line.locked ? "🔒" : "🔓"}
                                          </button>
                                          <button
                                            style={{ ...smallBtn, padding: "2px 7px", fontSize: 11,
                                              color: "#dc2626", borderColor: "rgba(220,38,38,0.22)" }}
                                            onClick={() => deleteLine(line.id)}
                                          >×</button>
                                        </div>
                                      ))}
                                  </div>
                                ))
                              }
                            </div>
                          )}

                          {/* Ridge / Valley Suggestions */}
                          {autoLabelSuggestions.length > 0 && (
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b" }}>
                                {autoLabelSuggestions[0]?.kind === "RIDGE" ? "Ridge Suggestions" : "Valley Suggestions"}
                              </div>
                              {autoLabelSuggestions.map((s, i) => {
                                const c = s.confidence;
                                const confLabel = c >= 0.8 ? "High" : c >= 0.6 ? "Med" : "Low";
                                const confColor = c >= 0.8 ? "#059669" : c >= 0.6 ? "#d97706" : "#dc2626";
                                const confBg = c >= 0.8 ? "rgba(16,185,129,0.08)" : c >= 0.6 ? "rgba(245,158,11,0.08)" : "rgba(220,38,38,0.07)";
                                const confBorder = c >= 0.8 ? "rgba(16,185,129,0.25)" : c >= 0.6 ? "rgba(245,158,11,0.25)" : "rgba(220,38,38,0.25)";
                                return (
                                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
                                    background: "rgba(15,23,42,0.03)", borderRadius: 6, padding: "4px 8px" }}>
                                    <span style={{ width: 8, height: 8, borderRadius: "50%",
                                      background: kindColor(s.kind as LineKind), flexShrink: 0, display: "inline-block" }} />
                                    <span style={{ fontSize: 11, fontWeight: 600, color: "#475569" }}>
                                      {s.kind === "RIDGE" ? "Ridge" : "Valley"} {i + 1}
                                    </span>
                                    <span style={{ fontSize: 9, background: confBg, color: confColor,
                                      border: `1px solid ${confBorder}`, borderRadius: 3,
                                      padding: "1px 4px", fontWeight: 700, flexShrink: 0 }}>{confLabel}</span>
                                    <span style={{ flex: 1 }} />
                                    <button style={{ ...smallBtn, padding: "2px 7px", fontSize: 11 }}
                                      onClick={() => adoptAutoLabelSuggestion(i)}>Adopt</button>
                                    <button style={{ ...smallBtn, padding: "2px 7px", fontSize: 11,
                                      color: "#dc2626", borderColor: "rgba(220,38,38,0.22)" }}
                                      onClick={() => setAutoLabelSuggestions(prev => prev.filter((_, j) => j !== i))}>✕</button>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Edge Length Totals */}
                          {activeRoof.lines.length > 0 && (() => {
                            const byKind = (k: LineKind) =>
                              activeRoof.lines.filter(l => l.kind === k).reduce((s, l) => s + lineLength(l.points), 0);
                            const rows = (["EAVE","RAKE","RIDGE","VALLEY","HIP"] as LineKind[])
                              .map(k => ({ k, len: Math.round(byKind(k)) }))
                              .filter(r => r.len > 0);
                            if (!rows.length) return null;
                            return (
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b" }}>Edge Lengths</div>
                                {rows.map(({ k, len }) => (
                                  <div key={k} style={{ display: "flex", justifyContent: "space-between",
                                    fontSize: 11, padding: "2px 8px" }}>
                                    <span style={{ color: kindColor(k), fontWeight: 600 }}>{k}</span>
                                    <span style={{ color: "#475569" }}>{len} px</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}

                          {/* Dormer holes */}
                          {activeRoof.holes.length > 0 && (
                            <div style={{ display: "grid", gap: 4 }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 2 }}>Dormer holes</div>
                              {activeRoof.holes.map((_, i) => (
                                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6,
                                  background: "rgba(15,23,42,0.03)", borderRadius: 6, padding: "4px 8px" }}>
                                  <span style={{ flex: 1, fontSize: 11, color: "#475569", fontWeight: 600 }}>
                                    Dormer {i + 1}
                                  </span>
                                  <button
                                    style={{ ...smallBtn, padding: "2px 7px", fontSize: 11,
                                      color: "#dc2626", borderColor: "rgba(220,38,38,0.22)" }}
                                    onClick={() => deleteHole(i)}
                                  >×</button>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* ── Clean Up Lines ── */}
                          {!cleanupOpen ? (
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <button
                                style={{ ...smallBtn, flex: 1, background: "linear-gradient(135deg,#eff6ff,#dbeafe)", borderColor: "#93c5fd", color: "#1d4ed8", fontWeight: 700 }}
                                onClick={() => { setCleanupOpen(true); setCleanupLockedIds(new Set()); }}
                              >
                                ✦ Clean Up Lines
                              </button>
                              {cleanupUndoRoof && (
                                <button
                                  title="Undo last cleanup"
                                  style={{ ...smallBtn, color: "#7c3aed", borderColor: "rgba(124,58,237,0.3)", flexShrink: 0 }}
                                  onClick={() => {
                                    if (!activeRoof || !cleanupUndoRoof) return;
                                    patchActiveRoof(() => cleanupUndoRoof);
                                    setCleanupUndoRoof(null);
                                  }}
                                >↩ Undo</button>
                              )}
                            </div>
                          ) : (
                            /* ── Cleanup panel (inline) ── */
                            <div style={{ background: "#f0f9ff", border: "1.5px solid #93c5fd", borderRadius: 10, padding: "12px 12px 10px", display: "grid", gap: 10 }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: "#1e40af" }}>✦ Clean Up Lines</div>
                                <button
                                  style={{ ...smallBtn, padding: "2px 7px", fontSize: 11, color: "#475569" }}
                                  onClick={() => setCleanupOpen(false)}
                                >✕</button>
                              </div>

                              {/* Strength slider */}
                              <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                                  <span style={{ fontSize: 11, fontWeight: 600, color: "#334155" }}>Strength</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8" }}>{Math.round(cleanupStrength * 100)}%</span>
                                </div>
                                <input
                                  type="range" min={0} max={100}
                                  value={Math.round(cleanupStrength * 100)}
                                  onChange={(e) => setCleanupStrength(Number(e.target.value) / 100)}
                                  style={{ width: "100%", accentColor: "#2563eb" }}
                                />
                                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#94a3b8", marginTop: 1 }}>
                                  <span>Conservative</span><span>Aggressive</span>
                                </div>
                              </div>

                              {/* Angle snap toggle */}
                              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 600, color: "#334155", cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={cleanupSnapAngles}
                                  onChange={(e) => setCleanupSnapAngles(e.target.checked)}
                                  style={{ accentColor: "#2563eb", width: 14, height: 14 }}
                                />
                                Snap to 0° / 45° / 90°
                              </label>

                              {/* Lock lines */}
                              {activeRoof && activeRoof.lines.length > 0 && (
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", letterSpacing: "0.07em", textTransform: "uppercase", marginBottom: 5 }}>
                                    Lock lines (skip cleanup)
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    {activeRoof.lines.map((l, i) => (
                                      <label key={l.id} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "3px 6px", borderRadius: 6, background: "rgba(255,255,255,0.6)" }}>
                                        <input
                                          type="checkbox"
                                          checked={cleanupLockedIds.has(l.id)}
                                          onChange={(e) => {
                                            setCleanupLockedIds((prev) => {
                                              const next = new Set(prev);
                                              if (e.target.checked) next.add(l.id); else next.delete(l.id);
                                              return next;
                                            });
                                          }}
                                          style={{ accentColor: "#7c3aed", width: 13, height: 13 }}
                                        />
                                        <span style={{ flex: 1, fontSize: 11, color: "#475569", fontWeight: 500 }}>
                                          {l.kind} {activeRoof.lines.filter((x) => x.kind === l.kind).indexOf(l) + 1}
                                        </span>
                                        <span style={{ width: 10, height: 10, borderRadius: "50%", background: kindColor(l.kind), flexShrink: 0, display: "inline-block" }} />
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Preview hint */}
                              <div style={{ fontSize: 10, color: "#60a5fa", fontStyle: "italic", lineHeight: 1.4 }}>
                                Green lines show the result. Adjust strength, then Apply.
                              </div>

                              {/* Action buttons */}
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  style={{ ...smallBtn, flex: 1, color: "#475569" }}
                                  onClick={() => setCleanupOpen(false)}
                                >Cancel</button>
                                <button
                                  style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#2563eb,#1d4ed8)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}
                                  onClick={() => {
                                    if (!activeRoof || !cleanupPreview) return;
                                    setCleanupUndoRoof({ ...activeRoof });
                                    patchActiveRoof(() => cleanupPreview);
                                    setCleanupOpen(false);
                                  }}
                                >Apply</button>
                              </div>
                            </div>
                          )}


                          <button
                            style={{ ...smallBtn, color: "#dc2626", borderColor: "rgba(220,38,38,0.22)", fontSize: 11 }}
                            onClick={resetSelectedRoof}
                          >
                            Reset this roof outline
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                </div>
              )}
            </>
          )}

          {/* ── SETTINGS TAB ── */}
          {uiTab === "settings" && active && !presentationMode && (
            <div style={{ padding: "4px 0 16px" }}>

              {/* Roof selector */}
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>Editing roof</label>
                <select
                  value={active.activeRoofId}
                  onChange={(e) => patchActive((p) => ({ ...p, activeRoofId: e.target.value }))}
                  style={selectStyle}
                >
                  {active.roofs.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              {activeRoof && (
                <div style={{ display: "grid", gap: 16 }}>

                  {/* Ice & Water Placement */}
                  <div>
                    <div style={fieldLabel}>Ice & Water Placement</div>
                    <div style={{ display: "grid", gap: 8 }}>
                      {([
                        ["On Eaves", "iceWaterOnEaves"],
                        ["On Valleys", "iceWaterOnValleys"],
                      ] as [string, "iceWaterOnEaves" | "iceWaterOnValleys"][]).map(([label, key]) => (
                        <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={(activeRoof as any)[key] !== false}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, [key]: e.target.checked }))}
                            style={{ accentColor: "#2563eb", width: 14, height: 14 }}
                          />
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Ice & Water Brush */}
                  <div>
                    <div style={fieldLabel}>Ice & Water Brush</div>
                    <label style={{ display: "block", marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                        <span>Brush size</span>
                        <span style={{ fontWeight: 700, color: "#334155" }}>{activeRoof.iceWaterBrushSize ?? 30}px</span>
                      </div>
                      <input
                        type="range" min={5} max={100} step={1}
                        value={activeRoof.iceWaterBrushSize ?? 30}
                        onChange={(e) => patchActiveRoof((r) => ({ ...r, iceWaterBrushSize: Number(e.target.value) }))}
                        style={{ width: "100%", accentColor: "#2563eb" }}
                      />
                    </label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        style={{ ...smallBtn, flex: 1 }}
                        onClick={() => patchActiveRoof((r) => ({ ...r, iceWaterBrush: (r.iceWaterBrush ?? []).slice(0, -1) }))}
                        disabled={!(activeRoof.iceWaterBrush ?? []).length}
                      >↩ Undo stroke</button>
                      <button
                        style={{ ...smallBtn, flex: 1, color: "#dc2626", borderColor: "rgba(220,38,38,0.22)" }}
                        onClick={() => patchActiveRoof((r) => ({ ...r, iceWaterBrush: [] }))}
                        disabled={!(activeRoof.iceWaterBrush ?? []).length}
                      >Clear all</button>
                    </div>
                  </div>

                  <div>
                    <label style={fieldLabel}>Shingle Color</label>
                    <select
                      value={active.shingleColor}
                      onChange={(e) => patchActive((p) => ({ ...p, shingleColor: e.target.value as ShingleColor }))}
                      style={selectStyle}
                    >
                      {(["Barkwood","Charcoal","WeatheredWood","PewterGray","OysterGray","Slate","Black"] as ShingleColor[]).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>

                  {/* Pro-Start placement */}
                  <div>
                    <div style={fieldLabel}>Pro-Start Placement</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      {([
                        [false, "Eaves Only"],
                        [true,  "Eaves + Rakes"],
                      ] as [boolean, string][]).map(([val, label]) => (
                        <button
                          key={label}
                          onClick={() => patchActiveRoof((r) => ({ ...r, proStartOnRakes: val }))}
                          style={{
                            ...smallBtn,
                            background: activeRoof.proStartOnRakes === val ? "rgba(37,99,235,0.10)" : "#fff",
                            borderColor: activeRoof.proStartOnRakes === val ? "rgba(37,99,235,0.40)" : "rgba(15,23,42,0.10)",
                            color: activeRoof.proStartOnRakes === val ? "#1d4ed8" : "#475569",
                            fontWeight: activeRoof.proStartOnRakes === val ? 700 : 600,
                          }}
                        >{label}</button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div style={fieldLabel}>Metal Colors</div>
                    <div style={{ display: "grid", gap: 8 }}>
                      {([
                        ["Gutter Apron", "gutterApronColor"],
                        ["Drip Edge", "dripEdgeColor"],
                        ["Valley Metal", "valleyMetalColor"],
                      ] as const).map(([label, key]) => (
                        <label key={key} style={{ display: "block" }}>
                          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{label}</div>
                          <select
                            value={(activeRoof as any)[key]}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, [key]: e.target.value as MetalColor }))}
                            style={selectStyle}
                          >
                            {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div style={fieldLabel}>Product Widths</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {([
                        ["Gutter apron", "gutterApronW", 4, 24],
                        ["Drip edge", "dripEdgeW", 4, 24],
                        ["Ice & water (eaves)", "iceWaterEaveW", 10, 90],
                        ["Ice & water (valleys)", "iceWaterValleyW", 6, 70],
                        ["Valley metal", "valleyMetalW", 4, 35],
                        ["Pro-start", "proStartW", 6, 45],
                        ["Ridge vent", "ridgeVentW", 6, 45],
                        ["Cap shingles", "capW", 4, 30],
                      ] as const).map(([label, key, min, max]) => (
                        <label key={key} style={{ display: "block" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                            <span>{label}</span>
                            <span style={{ fontWeight: 700, color: "#334155" }}>{(activeRoof as any)[key]}px</span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={1}
                            value={(activeRoof as any)[key]}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, [key]: Number(e.target.value) } as any))}
                            style={{ width: "100%", accentColor: "#2563eb" }}
                          />
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div style={fieldLabel}>Shingle Scale</div>
                    <label style={{ display: "block" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                        <span>Size</span>
                        <span style={{ fontWeight: 700, color: "#334155" }}>{activeRoof.shingleScale.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0.12}
                        max={0.32}
                        step={0.01}
                        value={activeRoof.shingleScale}
                        onChange={(e) => patchActiveRoof((r) => ({ ...r, shingleScale: Number(e.target.value) }))}
                        style={{ width: "100%", accentColor: "#2563eb" }}
                      />
                    </label>
                  </div>

                  <div>
                    <div style={fieldLabel}>Shingle Rotation</div>
                    <label style={{ display: "block" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                        <span>Angle (degrees)</span>
                        <span style={{ fontWeight: 700, color: "#334155" }}>{(activeRoof.shingleRotation ?? 0).toFixed(0)}°</span>
                      </div>
                      <input
                        type="range"
                        min={-45}
                        max={45}
                        step={1}
                        value={activeRoof.shingleRotation ?? 0}
                        onChange={(e) => patchActiveRoof((r) => ({ ...r, shingleRotation: Number(e.target.value) }))}
                        style={{ width: "100%", accentColor: "#2563eb" }}
                      />
                    </label>
                    <button
                      style={{ ...smallBtn, marginTop: 6, width: "100%", fontSize: 11 }}
                      onClick={() => {
                        const firstEave = activeRoof.lines.find((l) => l.kind === "EAVE");
                        if (!firstEave || firstEave.points.length < 4) {
                          patchActiveRoof((r) => ({ ...r, shingleRotation: 0 }));
                          return;
                        }
                        const angle = Math.atan2(
                          firstEave.points[3] - firstEave.points[1],
                          firstEave.points[2] - firstEave.points[0]
                        ) * 180 / Math.PI;
                        patchActiveRoof((r) => ({ ...r, shingleRotation: Math.round(angle) }));
                      }}
                    >
                      Auto-align to Eave Line
                    </button>
                  </div>
                </div>
              )}

              {/* ── Match Photo Look (Realistic) ── per-project setting ── */}
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(15,23,42,0.06)" }}>
                <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>✦ Match Photo Look</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>Photo-sampled texture + depth lighting</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={active.realisticMode ?? false}
                    onChange={(e) => patchActive((p) => ({ ...p, realisticMode: e.target.checked }))}
                    style={{ accentColor: "#2563eb", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }}
                  />
                </label>
                {active.realisticMode && (
                  <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                    <label style={{ display: "block" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                        <span>Realism strength</span>
                        <span style={{ fontWeight: 700, color: "#334155" }}>{Math.round((active.realisticStrength ?? 0.6) * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0} max={1} step={0.05}
                        value={active.realisticStrength ?? 0.6}
                        onChange={(e) => patchActive((p) => ({ ...p, realisticStrength: Number(e.target.value) }))}
                        style={{ width: "100%", accentColor: "#2563eb" }}
                      />
                    </label>
                    {!active.src && (
                      <div style={{ fontSize: 11, color: "#94a3b8", background: "#f8fafc", borderRadius: 7, padding: "7px 10px", lineHeight: 1.5 }}>
                        Upload a photo first — the texture is sampled directly from it.
                      </div>
                    )}
                  </div>
                )}
              </div>

            </div>
          )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      )}

      {/* Drawer "open" tab — shown when drawer is closed */}
      {screen !== "CUSTOMER_VIEW" && !isCustomerView && !presentationMode && !drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          style={{
            position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
            zIndex: 20, background: "#ffffff", border: "none", cursor: "pointer",
            width: 28, height: 56, borderRadius: "10px 0 0 10px",
            boxShadow: "-2px 0 10px rgba(15,23,42,0.10), 0 0 0 1px rgba(15,23,42,0.06)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#64748b", fontSize: 14,
          }}
        >‹</button>
      )}

      {/* ── CANVAS ── */}
      <main ref={containerRef} style={{
        background: screen === "CUSTOMER_VIEW" ? "#e8edf2" : presentationMode ? "#0f172a" : "#1e293b",
        backgroundImage: screen === "CUSTOMER_VIEW" ? "none" : "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
        position: "relative",
        overflow: "hidden",
        // In customer view: fill all remaining flex space and center the fixed-size Stage
        ...(isCustomerView ? { flex: "1 1 0", minWidth: 0, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" } : {}),
        ...(screen === "CUSTOMER_VIEW" ? { order: 1, flex: "1 1 0", minWidth: 0 } : {}),
      }}>
        <div>
        <Stage
          key={stageKey}
          ref={stageRef}
          width={stageW}
          height={stageH}
          onMouseDown={screen !== "CUSTOMER_VIEW" ? onStageDown : undefined}
          onMouseMove={screen !== "CUSTOMER_VIEW" ? onStageMove : undefined}
          onMouseUp={screen !== "CUSTOMER_VIEW" ? onStageUp : undefined}
          onTouchStart={screen !== "CUSTOMER_VIEW" ? onStageDown : undefined}
          onTouchMove={screen !== "CUSTOMER_VIEW" ? onStageMove : undefined}
          onTouchEnd={screen !== "CUSTOMER_VIEW" ? onStageUp : undefined}
          onWheel={screen !== "CUSTOMER_VIEW" ? onWheel : undefined}
          draggable={!!active && screen !== "CUSTOMER_VIEW" && tool !== "BRUSH_ICE_WATER"}
          scaleX={active?.stageScale ?? 1}
          scaleY={active?.stageScale ?? 1}
          x={active?.stagePos?.x ?? 0}
          y={active?.stagePos?.y ?? 0}
          onDragEnd={(e) => {
            if (!active) return;
            patchActive((p) => ({ ...p, stagePos: { x: e.target.x(), y: e.target.y() } }));
          }}
          style={{ touchAction: "none" }}
        >
          <Layer>
            {/* Dev overlay: show measured dimensions in customer view */}
            {isCustomerView && process.env.NODE_ENV === "development" && (
              <Text text={`${stageW}×${stageH}`} x={8} y={8} fontSize={12} fill="rgba(255,255,255,0.55)" listening={false} />
            )}
            {/* Customer view: light background covers entire world space */}
            {screen === "CUSTOMER_VIEW" && (
              <Rect x={-50000} y={-50000} width={200000} height={200000} fill="#e8edf2" />
            )}

            {!photoImg && liveStep !== "START" && screen !== "CUSTOMER_VIEW" && (
              <>
                <Text
                  text="Upload a photo to begin"
                  x={0}
                  y={stageH / 2 - 22}
                  width={stageW}
                  align="center"
                  fill="rgba(255,255,255,0.55)"
                  fontSize={17}
                  fontStyle="600"
                />
                <Text
                  text="Use the Photo panel on the left"
                  x={0}
                  y={stageH / 2 + 6}
                  width={stageW}
                  align="center"
                  fill="rgba(255,255,255,0.28)"
                  fontSize={13}
                />
              </>
            )}

            {/* ── PHOTO GROUP: photo + all geometry overlays in photo-space ─────── */}
            {photoImg && (
              <Group x={photoTx.offX} y={photoTx.offY} scaleX={photoTx.scale} scaleY={photoTx.scale}>

                {/* Photo at natural size */}
                <KonvaImage image={photoImg} x={0} y={0} width={photoTx.imgW} height={photoTx.imgH} />

                {/* Draft visuals — hidden in presentation mode */}
                {!presentationMode && active?.step === "TRACE" && draftLine && (
                  <Line points={draftLine.points} stroke="rgba(255,255,255,0.9)" strokeWidth={3} strokeScaleEnabled={false} dash={[8, 6]} lineCap="round" lineJoin="round" />
                )}
                {!presentationMode && active?.step === "TRACE" && draftHole && draftHole.length >= 2 && (
                  <Line points={draftHole} stroke="rgba(255,255,255,0.9)" strokeWidth={3} strokeScaleEnabled={false} dash={[6, 6]} lineCap="round" lineJoin="round" />
                )}

                {/* Guide lines — hidden in presentation mode */}
                {!presentationMode && active && showGuides && active.roofs.flatMap((r) => {
                  const all = [...r.lines];
                  if (r.id === activeRoof?.id && draftLine && draftLine.points.length >= 4) all.push({ ...draftLine, id: "draft" });
                  const baseOpacity = cleanupPreview ? 0.18 : (active.step === "TRACE" ? 0.95 : 0.45);
                  return all.map((l) => (
                    <React.Fragment key={`guide-${r.id}-${l.id}`}>
                      <Line
                        points={l.points}
                        stroke="#000"
                        strokeWidth={7}
                        strokeScaleEnabled={false}
                        dash={[10, 7]}
                        lineCap="round"
                        lineJoin="round"
                        opacity={baseOpacity * 0.35}
                      />
                      <Line
                        points={l.points}
                        stroke={kindColor(l.kind)}
                        strokeWidth={4}
                        strokeScaleEnabled={false}
                        dash={[10, 7]}
                        lineCap="round"
                        lineJoin="round"
                        opacity={baseOpacity}
                      />
                    </React.Fragment>
                  ));
                })}

                {/* Roof outlines — hidden in presentation mode */}
                {!presentationMode && active && (active.step === "TRACE" || active.showGuidesDuringInstall) && active.roofs.map((r) =>
                  r.outline.length >= 2 ? (
                    <Line
                      key={`outline-${r.id}`}
                      points={r.outline}
                      closed={r.closed}
                      stroke={r.id === active.activeRoofId ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)"}
                      strokeWidth={r.id === active.activeRoofId ? 2.5 : 2}
                      strokeScaleEnabled={false}
                      opacity={cleanupPreview && r.id === active.activeRoofId ? 0.18 : 1}
                    />
                  ) : null
                )}

                {/* ── AI Outline Overlay ── hidden in presentation mode */}
                {!presentationMode && active?.step === "TRACE" && aiState === "preview" && (() => {
                  const dispPoly = aiShowRaw ? aiPolygonRaw : aiPolygon;
                  if (!dispPoly || dispPoly.length < 4) return null;
                  const isRaw = aiShowRaw;
                  return (
                    <>
                      <Line
                        points={dispPoly}
                        closed={true}
                        fill={isRaw ? "rgba(239,68,68,0.06)" : "rgba(16,185,129,0.08)"}
                        stroke={isRaw ? "rgba(239,68,68,0.80)" : "rgba(16,185,129,0.92)"}
                        strokeWidth={2.5}
                        strokeScaleEnabled={false}
                        dash={isRaw ? [5, 7] : [9, 5]}
                        lineCap="round"
                        lineJoin="round"
                        listening={false}
                        shadowColor={isRaw ? "rgba(239,68,68,0.4)" : "rgba(16,185,129,0.5)"}
                        shadowBlur={8}
                      />
                      {Array.from({ length: dispPoly.length / 2 }).map((_, i) => (
                        <Circle
                          key={i}
                          x={dispPoly[i * 2]}
                          y={dispPoly[i * 2 + 1]}
                          radius={5 / photoTx.scale}
                          fill={isRaw ? "#ef4444" : "#10b981"}
                          stroke="#fff"
                          strokeWidth={1.5}
                          strokeScaleEnabled={false}
                          listening={false}
                        />
                      ))}
                    </>
                  );
                })()}

                {/* ── Auto-Label Suggestion Overlay ── hidden in presentation mode */}
                {!presentationMode && active?.step === "TRACE" && autoLabelSuggestions.map((s, i) => (
                  <Line
                    key={`ailabel-${i}`}
                    points={s.points}
                    stroke={s.kind === "RIDGE" ? "rgba(245,158,11,0.92)" : "rgba(100,116,139,0.92)"}
                    strokeWidth={3}
                    strokeScaleEnabled={false}
                    dash={[12, 6]}
                    lineCap="round"
                    lineJoin="round"
                    listening={false}
                    shadowColor={s.kind === "RIDGE" ? "rgba(245,158,11,0.4)" : "rgba(100,116,139,0.4)"}
                    shadowBlur={8}
                  />
                ))}

                {/* ── Cleanup preview overlay ── hidden in presentation mode */}
                {!presentationMode && cleanupPreview && activeRoof && active?.step === "TRACE" && (
                  <>
                    {/* After: cleaned outline */}
                    {cleanupPreview.outline.length >= 4 && (
                      <Line
                        points={cleanupPreview.outline}
                        closed={cleanupPreview.closed}
                        stroke="rgba(74,222,128,0.95)"
                        strokeWidth={2.5}
                        strokeScaleEnabled={false}
                        lineCap="round"
                        lineJoin="round"
                      />
                    )}
                    {/* After: cleaned lines */}
                    {cleanupPreview.lines.map((l) => (
                      <Line
                        key={`cp-after-${l.id}`}
                        points={l.points}
                        stroke="rgba(74,222,128,0.95)"
                        strokeWidth={4}
                        strokeScaleEnabled={false}
                        lineCap="round"
                        lineJoin="round"
                      />
                    ))}
                  </>
                )}

                {/* Hole outlines — hidden in presentation mode */}
                {!presentationMode && active && (active.step === "TRACE" || active.showGuidesDuringInstall) && active.roofs.flatMap((r) =>
                  r.holes.map((holePts, i) => (
                    <Line
                      key={`hole-${r.id}-${i}`}
                      points={holePts}
                      closed={holePts.length >= 6}
                      stroke="rgba(255,255,255,0.82)"
                      dash={[8, 6]}
                      strokeWidth={2}
                      strokeScaleEnabled={false}
                      lineCap="round"
                      lineJoin="round"
                      opacity={0.9}
                    />
                  ))
                )}

                {/* Install overlays per roof */}
                {active && active.roofs.map((r) => {
                  if (!r.closed || r.outline.length < 6) return null;

                  const eaves = r.lines.filter((l) => l.kind === "EAVE");
                  const rakes = r.lines.filter((l) => l.kind === "RAKE");
                  const valleys = r.lines.filter((l) => l.kind === "VALLEY");
                  const ridges = r.lines.filter((l) => l.kind === "RIDGE");
                  const hips = r.lines.filter((l) => l.kind === "HIP");

                  // Shingle eave alignment — compute in photo-space, use stage-space equivalent for offset
                  const eaveYsPhoto = eaves.flatMap((l) => l.points.filter((_, idx) => idx % 2 === 1));
                  const eaveYPhoto = eaveYsPhoto.length > 0 ? eaveYsPhoto.reduce((a, b) => a + b, 0) / eaveYsPhoto.length : 0;
                  const eaveY = photoTx.offY + eaveYPhoto * photoTx.scale; // equiv. stage-space Y for alignment
                  const courseH = 11;
                  const effectivePatternScale = r.shingleScale / photoTx.scale;
                  const shingleOffsetY = ((-(eaveY + 5000) / r.shingleScale % courseH) + courseH) % courseH;

                  return (
                    <Group key={`install-${r.id}`} clipFunc={(ctx) => clipPolygonPath(ctx, r.outline)}>
                      {/* Tearoff (decking) */}
                      {atLeast(currentStep, "TEAROFF") && deckingImg && (
                        <KonvaImage image={deckingImg} x={0} y={0} width={photoTx.imgW} height={photoTx.imgH} opacity={0.92} />
                      )}

                      {/* Subtle structure guides — faint valley/hip/ridge lines visible during install */}
                      {atLeast(currentStep, "TEAROFF") && !atLeast(currentStep, "SHINGLES") && (
                        <>
                          {valleys.map((l) => (
                            <Line key={`guide-v-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.13)" strokeWidth={3} strokeScaleEnabled={false} dash={[10, 8]} lineCap="round" lineJoin="round" />
                          ))}
                          {ridges.map((l) => (
                            <Line key={`guide-r-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.10)" strokeWidth={2} strokeScaleEnabled={false} dash={[8, 7]} lineCap="round" lineJoin="round" />
                          ))}
                          {hips.map((l) => (
                            <Line key={`guide-h-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.11)" strokeWidth={2} strokeScaleEnabled={false} dash={[9, 7]} lineCap="round" lineJoin="round" />
                          ))}
                        </>
                      )}

                      {/*
                        IMPORTANT FIX: draw order + step gating
                        - Synthetic should ONLY show during SYNTHETIC step window (>=SYNTHETIC and <SHINGLES)
                        - Ice & Water should ALWAYS show when step >= ICE_WATER (and it draws ON TOP of synthetic)
                        - Metals and starter strips draw on top of underlayments
                      */}

                      {/* Synthetic (field) — only before shingles */}
                      {stepIndex(currentStep) >= stepIndex("SYNTHETIC") &&
                        stepIndex(currentStep) < stepIndex("SHINGLES") &&
                        syntheticImg && (
                          <KonvaImage image={syntheticImg} x={0} y={0} width={photoTx.imgW} height={photoTx.imgH} opacity={0.86} />
                        )}

                      {/* Ice & water — always visible once reached */}
                      {atLeast(currentStep, "ICE_WATER") && (
                        <>
                          {(r.iceWaterOnEaves !== false) && eaves.map((l) => (
                            <Group key={`iwe-${r.id}-${l.id}`}>
                              <Line points={l.points} stroke="#111827" strokeWidth={r.iceWaterEaveW} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                              <Line points={l.points} stroke="rgba(255,255,255,0.07)" strokeWidth={r.iceWaterEaveW * 0.14} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            </Group>
                          ))}
                          {(r.iceWaterOnValleys !== false) && valleys.map((l) => (
                            <Group key={`iwv-${r.id}-${l.id}`}>
                              <Line points={l.points} stroke="#111827" strokeWidth={r.iceWaterValleyW} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                              <Line points={l.points} stroke="rgba(255,255,255,0.07)" strokeWidth={r.iceWaterValleyW * 0.14} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            </Group>
                          ))}
                          {(r.iceWaterBrush ?? []).map((stroke) => (
                            <Group key={`iwb-${r.id}-${stroke.id}`} listening={false}>
                              <Line points={stroke.points} stroke="#111827" strokeWidth={stroke.size} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                              <Line points={stroke.points} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke.size * 0.14} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            </Group>
                          ))}
                        </>
                      )}
                      {/* Live brush stroke preview while painting */}
                      {tool === "BRUSH_ICE_WATER" && brushDraft && brushDraft.points.length >= 4 && r.id === active?.activeRoofId && (
                        <Line
                          points={brushDraft.points}
                          stroke="#111827"
                          strokeWidth={brushDraft.size}
                          strokeScaleEnabled={false}
                          lineCap="round"
                          lineJoin="round"
                          listening={false}
                        />
                      )}

                      {/* GUTTER APRON (eaves) */}
                      {atLeast(currentStep, "GUTTER_APRON") && eaves.map((l) => (
                        <ShinyMetalStroke key={`apron-${r.id}-${l.id}`} points={l.points} width={r.gutterApronW} color={r.gutterApronColor} />
                      ))}

                      {/* DRIP EDGE (rakes) */}
                      {atLeast(currentStep, "DRIP_EDGE") && rakes.map((l) => (
                        <ShinyMetalStroke key={`drip-${r.id}-${l.id}`} points={l.points} width={r.dripEdgeW} color={r.dripEdgeColor} />
                      ))}

                      {/* VALLEY METAL (valleys) — Galvanized: narrow strip; W-Valley (colored): wider channel */}
                      {atLeast(currentStep, "VALLEY_METAL") && valleys.map((l) => (
                        <ShinyMetalStroke
                          key={`vm-${r.id}-${l.id}`}
                          points={l.points}
                          width={r.valleyMetalColor === "Galvanized" ? r.valleyMetalW : r.valleyMetalW * 2.5}
                          color={r.valleyMetalColor}
                          opacity={0.995}
                        />
                      ))}

                      {/* PRO-START (eaves always; rakes optional based on proStartOnRakes) */}
                      {atLeast(currentStep, "PRO_START") && (
                        <>
                          {eaves.map((l) => (
                            <StarterStroke key={`ps-e-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />
                          ))}
                          {r.proStartOnRakes && rakes.map((l) => (
                            <StarterStroke key={`ps-r-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />
                          ))}
                        </>
                      )}

                      {/* SHINGLES — aligned to eave line via fillPatternOffsetY */}
                      {atLeast(currentStep, "SHINGLES") && activeShinglesImg && (
                        <>
                          <Rect
                            x={-5000}
                            y={-5000}
                            width={12000}
                            height={12000}
                            opacity={0.98}
                            fillPatternImage={activeShinglesImg}
                            fillPatternRepeat="repeat"
                            fillPatternScaleX={effectivePatternScale}
                            fillPatternScaleY={effectivePatternScale}
                            fillPatternOffsetY={shingleOffsetY}
                            fillPatternRotation={r.shingleRotation ?? 0}
                          />
                          <Rect x={0} y={0} width={photoTx.imgW} height={photoTx.imgH} fill="rgba(0,0,0,0.06)" />
                        </>
                      )}

                      {/* ── Realistic lighting pass ──
                          Subtle shadow / highlight strokes along structure lines
                          to give depth. Only renders when realisticMode is ON. */}
                      {atLeast(currentStep, "SHINGLES") && (active?.realisticMode) && (() => {
                        const str = Math.max(0, Math.min(1, active?.realisticStrength ?? 0.6));
                        return (
                          <Group listening={false}>
                            {/* Valleys — concave, so a wide dark stroke centered on the line */}
                            {valleys.map((l) => (
                              <Group key={`rlt-v-${r.id}-${l.id}`}>
                                <Line points={l.points} stroke={`rgba(0,0,0,${(0.32 * str).toFixed(3)})`} strokeWidth={18} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                <Line points={l.points} stroke={`rgba(0,0,0,${(0.22 * str).toFixed(3)})`} strokeWidth={9}  strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                <Line points={l.points} stroke={`rgba(0,0,0,${(0.12 * str).toFixed(3)})`} strokeWidth={4}  strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                              </Group>
                            ))}
                            {/* Ridges + hips — convex, so shadow below and highlight above (top-left light) */}
                            {[...ridges, ...hips].map((l) => {
                              const shPts  = l.points.map((v, i) => i % 2 === 0 ? v + 1.5 : v + 2.5);
                              const hiPts  = l.points.map((v, i) => i % 2 === 0 ? v - 1.0 : v - 2.0);
                              return (
                                <Group key={`rlt-rh-${r.id}-${l.id}`}>
                                  <Line points={shPts} stroke={`rgba(0,0,0,${(0.20 * str).toFixed(3)})`}         strokeWidth={10} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                  <Line points={shPts} stroke={`rgba(0,0,0,${(0.12 * str).toFixed(3)})`}         strokeWidth={5}  strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                  <Line points={hiPts} stroke={`rgba(255,255,255,${(0.22 * str).toFixed(3)})`}   strokeWidth={6}  strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                  <Line points={hiPts} stroke={`rgba(255,255,255,${(0.12 * str).toFixed(3)})`}   strokeWidth={2.5} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                                </Group>
                              );
                            })}
                          </Group>
                        );
                      })()}

                      {/* RIDGE VENT */}
                      {atLeast(currentStep, "RIDGE_VENT") && ridges.map((l) => (
                        <RidgeVentStroke key={`rv-${r.id}-${l.id}`} points={l.points} width={r.ridgeVentW} />
                      ))}

                      {/* CAP SHINGLES */}
                      {atLeast(currentStep, "CAP_SHINGLES") && activeShinglesImg && ridges.map((l) => (
                        <CapBand key={`cap-${r.id}-${l.id}`} points={l.points} width={r.capW} clipStrokeWidth={r.capW / photoTx.scale} shinglesImg={activeShinglesImg} patternScale={effectivePatternScale} />
                      ))}

                      {/* Valley seam / W-Valley on top of shingles */}
                      {atLeast(currentStep, "SHINGLES") && valleys.map((l) =>
                        r.valleyMetalColor === "Galvanized" ? (
                          /* Galvanized open valley: subtle crease visible through shingles */
                          <Group key={`vline-${r.id}-${l.id}`}>
                            <Line points={l.points} stroke="rgba(0,0,0,0.12)"      strokeWidth={5}   strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            <Line points={l.points} stroke="rgba(220,225,230,0.28)" strokeWidth={2.5} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            <Line points={l.points} stroke="rgba(255,255,255,0.12)" strokeWidth={1}   strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                          </Group>
                        ) : (
                          /* W-Valley: colored metal channel sits ON TOP of shingles — shingles woven around it */
                          <ShinyMetalStroke
                            key={`vline-${r.id}-${l.id}`}
                            points={l.points}
                            width={r.valleyMetalW * 2.5}
                            color={r.valleyMetalColor}
                            opacity={0.99}
                          />
                        )
                      )}

                      {/* Hip seam — subtle crease visible through shingles */}
                      {atLeast(currentStep, "SHINGLES") && hips.map((l) => (
                        <Group key={`hline-${r.id}-${l.id}`}>
                          <Line points={l.points} stroke="rgba(0,0,0,0.30)"      strokeWidth={5}   strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                          <Line points={l.points} stroke="rgba(210,215,220,0.55)" strokeWidth={2.5} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                        </Group>
                      ))}

                      {/* Ridge fold — crease tinted to match shingle color so it blends naturally */}
                      {atLeast(currentStep, "SHINGLES") && !atLeast(currentStep, "CAP_SHINGLES") && (() => {
                        const [rr, rg, rb] = shingleRGB(active.shingleColor);
                        return ridges.map((l) => (
                          <Group key={`ridgefold-${r.id}-${l.id}`}>
                            <Line points={l.points} stroke="rgba(0,0,0,0.22)"                    strokeWidth={5}   strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            <Line points={l.points} stroke={`rgba(${rr},${rg},${rb},0.55)`}      strokeWidth={2.5} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                            <Line points={l.points} stroke={`rgba(${rr+30},${rg+30},${rb+30},0.22)`} strokeWidth={1} strokeScaleEnabled={false} lineCap="round" lineJoin="round" />
                          </Group>
                        ));
                      })()}

                      {/* dormer holes reveal original photo */}
                      {photoImg && r.holes.map((holePts, idx) => (
                        <Group key={`hole-reveal-${r.id}-${idx}`} clipFunc={(ctx) => clipPolygonPath(ctx, holePts)}>
                          <KonvaImage image={photoImg} x={0} y={0} width={photoTx.imgW} height={photoTx.imgH} />
                        </Group>
                      ))}
                    </Group>
                  );
                })}

                {/* edit handles — hidden in presentation mode */}
                {!presentationMode &&
                  active &&
                  active.step === "TRACE" &&
                  active.showEditHandles &&
                  activeRoof?.closed &&
                  activeRoof.outline.length >= 6 &&
                  Array.from({ length: activeRoof.outline.length / 2 }).map((_, idx) => (
                    <Circle
                      key={`pt-${idx}`}
                      x={activeRoof.outline[idx * 2]}
                      y={activeRoof.outline[idx * 2 + 1]}
                      radius={10 / photoTx.scale}
                      fill="rgba(255,255,255,0.90)"
                      stroke="rgba(15,23,42,0.45)"
                      strokeWidth={2}
                      strokeScaleEnabled={false}
                      draggable
                      onDragMove={(e) => updateOutlinePoint(idx, e.target.x(), e.target.y())}
                    />
                  ))}

              </Group>
            )}
            {/* ── END PHOTO GROUP ── */}

            {/* ── Facade roof region mask (stage-space) ── hidden in presentation mode */}
            {!presentationMode && active?.step === "TRACE" && edgePanel && edgeMode === "facade" && (
              <>
                {/* Dimmed band below the roof region */}
                <Rect
                  x={0} y={Math.round(stageH * edgeRoofRegionFraction)}
                  width={stageW} height={stageH - Math.round(stageH * edgeRoofRegionFraction)}
                  fill="rgba(0,0,0,0.35)"
                  listening={false}
                />
                {/* Dashed boundary line */}
                <Line
                  points={[0, Math.round(stageH * edgeRoofRegionFraction), stageW, Math.round(stageH * edgeRoofRegionFraction)]}
                  stroke="rgba(56,189,248,0.9)"
                  strokeWidth={2}
                  dash={[10, 6]}
                  lineCap="round"
                  listening={false}
                />
              </>
            )}

            {/* ── Edge Detection overlays (stage-space) ── hidden in presentation mode */}
            {!presentationMode && active?.step === "TRACE" && edgePanel && showDetectedLayer && displaySegs.length > 0 && (
              <>
                {displaySegs.map((s) => (
                  <Line
                    key={`edge-${s.id}`}
                    points={[s.x1, s.y1, s.x2, s.y2]}
                    stroke={
                      s.label === "eaveCandidate"        ? "rgba(59,130,246,0.90)"  :
                      s.label === "ridgeCandidate"       ? "rgba(249,115,22,0.90)"  :
                      s.label === "valleyCandidate"      ? "rgba(168,85,247,0.90)"  :
                      s.label === "rakeCandidateLeft"    ? "rgba(20,184,166,0.90)"  :
                      s.label === "rakeCandidateRight"   ? "rgba(132,204,22,0.90)"  :
                      s.label === "rakeCandidate"        ? "rgba(16,185,129,0.85)"  :
                      "rgba(250,204,21,0.75)"
                    }
                    strokeWidth={2}
                    lineCap="round"
                    lineJoin="round"
                  />
                ))}
              </>
            )}
            {/* Edge-add draft line — hidden in presentation mode */}
            {!presentationMode && active?.step === "TRACE" && edgeTool === "ADD_EDGE" && edgeAddDraft && (
              <Circle x={edgeAddDraft[0]} y={edgeAddDraft[1]} radius={5} fill="rgba(250,204,21,0.9)" />
            )}
            {/* Plane suggestion polygons — hidden in presentation mode */}
            {!presentationMode && active?.step === "TRACE" && planeSuggs.map((ps) => {
              const isHovered = ps.id === hoveredSuggId;
              return (
                <Line
                  key={`plane-${ps.id}`}
                  points={ps.polygon}
                  closed
                  stroke={isHovered ? "rgba(59,130,246,1)" : "rgba(59,130,246,0.55)"}
                  strokeWidth={isHovered ? 3 : 2}
                  fill={isHovered ? "rgba(59,130,246,0.18)" : "rgba(59,130,246,0.07)"}
                  lineCap="round"
                  lineJoin="round"
                />
              );
            })}

            {/* Auto-detect overlay — stage-space, hidden in presentation mode */}
            {!presentationMode && autoSuggest && active?.step === "TRACE" && (
              <>
                <Line
                  points={autoSuggest.outline}
                  closed
                  stroke="rgba(245,158,11,0.85)"
                  strokeWidth={2.5}
                  dash={[8, 5]}
                  lineCap="round"
                  lineJoin="round"
                />
                {autoSuggest.lines.map((l, i) => (
                  <Line
                    key={`suggest-${i}`}
                    points={l.points}
                    stroke={kindColor(l.kind)}
                    strokeWidth={2}
                    dash={[10, 6]}
                    lineCap="round"
                    opacity={0.75}
                  />
                ))}
              </>
            )}
          </Layer>
        </Stage>
        </div>{/* end CSS-scale wrapper */}

              {/* Floating presentation controls */}
              {presentationMode && !isCustomerView && (
                <div className="rv-float-ctrl" style={{
                  position: "absolute", bottom: 28, left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex", alignItems: "center", gap: 8,
                  background: "rgba(15,23,42,0.82)",
                  backdropFilter: "blur(12px)",
                  borderRadius: 14,
                  padding: "8px 12px",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.06)",
                  zIndex: 50,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,0.50)", paddingRight: 4, letterSpacing: "0.03em" }}>
                    {STEP_TITLE[liveStep]?.replace(/^Step \d+ — /, "") ?? liveStep}
                  </span>
                  <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />
                  <button
                    onClick={goBack}
                    disabled={stepIndex(liveStep) === 0}
                    style={{
                      padding: "5px 14px", borderRadius: 8, fontSize: 12, fontWeight: 500,
                      cursor: stepIndex(liveStep) === 0 ? "default" : "pointer",
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(255,255,255,0.07)",
                      color: stepIndex(liveStep) === 0 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.80)",
                      transition: "background 0.15s",
                    }}
                  >← Back</button>
                  <button
                    onClick={goNext}
                    disabled={!canGoNext()}
                    style={{
                      padding: "5px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      cursor: canGoNext() ? "pointer" : "default",
                      border: "none",
                      background: canGoNext() ? "linear-gradient(135deg,#2563eb,#1d4ed8)" : "rgba(255,255,255,0.07)",
                      color: canGoNext() ? "#ffffff" : "rgba(255,255,255,0.25)",
                      boxShadow: canGoNext() ? "0 2px 6px rgba(37,99,235,0.40)" : "none",
                      transition: "background 0.15s, box-shadow 0.15s",
                    }}
                  >Next →</button>
                  {(active?.photoSrcs?.length ?? 0) > 1 && (() => {
                    const srcs = active!.photoSrcs;
                    const idx = srcs.indexOf(active!.src);
                    const total = srcs.length;
                    return (
                      <>
                        <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />
                        <button
                          onClick={() => switchToPhoto(srcs[(idx - 1 + total) % total])}
                          style={{ padding: "4px 10px", borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)" }}
                        >‹</button>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", fontWeight: 500 }}>{idx+1}/{total}</span>
                        <button
                          onClick={() => switchToPhoto(srcs[(idx + 1) % total])}
                          style={{ padding: "4px 10px", borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: "pointer", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.75)" }}
                        >›</button>
                      </>
                    );
                  })()}
                  <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />
                  <button
                    onClick={() => { setPresentationMode(false); setUiTab("edit"); }}
                    style={{ padding: "4px 10px", borderRadius: 7, fontSize: 11, fontWeight: 500, cursor: "pointer", border: "1px solid rgba(255,100,100,0.25)", background: "rgba(255,80,80,0.10)", color: "rgba(255,160,160,0.85)" }}
                  >✕ Exit</button>
                </div>
              )}
      </main>
      <AnimatePresence>
        {toastVisible && (
          <motion.div key="toast"
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
            style={{
              position: "fixed", bottom: 28, left: "50%",
              transform: "translateX(-50%)", zIndex: 9999,
              background: "rgba(15,23,42,0.90)", backdropFilter: "blur(10px)",
              color: "#ffffff", fontSize: 13, fontWeight: 500,
              padding: "10px 18px", borderRadius: 10,
              boxShadow: "0 8px 28px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.08)",
              pointerEvents: "none", whiteSpace: "nowrap" as const,
            }}>
            {toastMsg}
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}