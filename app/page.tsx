"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { cleanupGeometry, strengthToOptions } from "@/app/lib/cleanupGeometry";
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
  | "DRAW_HIP";

type Polyline = { id: string; kind: LineKind; points: number[] };

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
  if (k === "EAVE") return "rgba(37,99,235,0.95)";
  if (k === "RAKE") return "rgba(16,185,129,0.95)";
  if (k === "VALLEY") return "rgba(100,116,139,0.95)";
  if (k === "RIDGE") return "rgba(245,158,11,0.95)";
  return "rgba(168,85,247,0.95)"; // HIP
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
        lineCap="round"
        lineJoin="round"
        opacity={0.9}
      />
      <Line
        points={points}
        stroke="rgba(0,0,0,0.14)"
        strokeWidth={Math.max(1, width * 0.1)}
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
        lineCap="round"
        lineJoin="round"
        opacity={0.85}
      />
      <Line
        points={points}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={Math.max(2, width * 0.10)}
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
}: {
  points: number[];
  width: number;
  shinglesImg: HTMLImageElement;
  patternScale: number;
}) {
  if (points.length < 4) return null;

  return (
    <Group
      clipFunc={(ctx) => {
        ctx.save();
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = width;
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

/* ------------------- Main ------------------- */
export default function Page() {
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [projectName, setProjectName] = useState("My Roof Project");

  const [w, setW] = useState(1100);
  const [h, setH] = useState(700);

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

  const [advancedOpen, setAdvancedOpen] = useState(false);

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
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");

  // Persist projects to localStorage whenever they change.
  useEffect(() => {
    if (typeof window === "undefined" || photos.length === 0) return;
    try { localStorage.setItem("roofviz_v2", JSON.stringify(photos)); } catch {}
    try { if (activePhotoId) localStorage.setItem("roofviz_v2_active", activePhotoId); } catch {}
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
            showEditHandles: false,
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
      const raw = localStorage.getItem("roofviz_v2");
      if (raw) {
        const parsed = JSON.parse(raw) as PhotoProject[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = parsed.map((p) => ({
            ...p,
            photoSrcs: p.photoSrcs ?? (p.src ? [p.src] : []),
            photoStates: p.photoStates ?? {},
          }));
          const savedActiveId = localStorage.getItem("roofviz_v2_active");
          const restoredId = migrated.find((p) => p.id === savedActiveId)?.id ?? migrated[0].id;
          setPhotos(migrated);
          setActivePhotoId(restoredId);
          setScreen("MENU");
        }
      }
    } catch {}
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

  function startProject() {
    const id = uid();
    const roof1 = defaultRoof("Roof 1");
    const item: PhotoProject = {
      id,
      name: projectName || "My Roof Project",
      src: "",
      photoSrcs: [],
      step: "TRACE",
      roofs: [roof1],
      activeRoofId: roof1.id,
      shingleColor: "Barkwood",
      showGuidesDuringInstall: false,
      showEditHandles: false,
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
      outline: autoSuggest.outline,
      closed: true,
      lines: autoSuggest.lines.map((l) => ({ ...l, id: uid() })),
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
          fr.onload = () => resolve(String(fr.result));
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

  function onStageDown(e: any) {
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
    const worldCloseRadius = CLOSE_DIST / scale;

    if (active.step === "TRACE" && tool === "TRACE_ROOF" && !activeRoof.closed) {
      const pts = activeRoof.outline;
      if (pts.length >= 6) {
        const x0 = pts[0], y0 = pts[1];
        if (dist(pos.x, pos.y, x0, y0) <= worldCloseRadius) {
          patchActiveRoof((r) => ({ ...r, closed: true }));
          setTool("NONE");
          return;
        }
      }
      patchActiveRoof((r) => ({ ...r, outline: [...r.outline, pos.x, pos.y] }));
      return;
    }

    if (active.step === "TRACE" && tool === "TRACE_HOLE") {
      if (!draftHole) return;
      if (draftHole.length >= 6) {
        const x0 = draftHole[0], y0 = draftHole[1];
        if (dist(pos.x, pos.y, x0, y0) <= worldCloseRadius) {
          patchActiveRoof((r) => ({ ...r, holes: [...r.holes, draftHole] }));
          setDraftHole([]);
          setTool("NONE");
          return;
        }
      }
      setDraftHole((pts) => (pts ? [...pts, pos.x, pos.y] : [pos.x, pos.y]));
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
      setDraftLine((d) => (d ? { ...d, points: [...d.points, pos.x, pos.y] } : d));
      return;
    }

    // Edge detection tools
    if (active.step === "TRACE" && edgeTool === "ERASE_EDGE") {
      const ERASE_RADIUS = 20 / (active.stageScale || 1);
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
  }

  function updateOutlinePoint(i: number, x: number, y: number) {
    if (!activeRoof) return;
    patchActiveRoof((r) => {
      const next = r.outline.slice();
      next[i * 2] = x;
      next[i * 2 + 1] = y;
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
    padding: "16px",
    boxShadow: "0 1px 3px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.05)",
    marginBottom: 12,
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "#94a3b8",
    textTransform: "uppercase",
  };

  const fieldLabel: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#334155",
    marginBottom: 6,
  };

  const inputStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "10px 14px",
    borderRadius: 10,
    border: "1.5px solid rgba(15,23,42,0.14)",
    fontSize: 14,
    fontWeight: 500,
    background: "#ffffff",
    color: "#0f172a",
    boxSizing: "border-box",
    marginBottom: 12,
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1.5px solid rgba(15,23,42,0.12)",
    fontSize: 13,
    fontWeight: 500,
    background: "#ffffff",
    color: "#0f172a",
  };

  const primaryBtn: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "12px 20px",
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    border: "none",
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#ffffff",
    boxShadow: "0 1px 4px rgba(37,99,235,0.35)",
    marginTop: 8,
  };

  const greenBtn: React.CSSProperties = {
    ...primaryBtn,
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    boxShadow: "0 1px 4px rgba(22,163,74,0.35)",
  };

  const ghostBtn: React.CSSProperties = {
    padding: "10px 16px",
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1.5px solid rgba(15,23,42,0.12)",
    background: "#ffffff",
    color: "#475569",
  };

  const smallBtn: React.CSSProperties = {
    padding: "7px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1.5px solid rgba(15,23,42,0.10)",
    background: "#ffffff",
    color: "#334155",
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

  // ── MENU SCREEN ────────────────────────────────────────────────────────────
  if (screen === "MENU") {
    return (
      <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {/* Top nav */}
        <header style={{
          background: "#fff",
          borderBottom: "1px solid rgba(15,23,42,0.08)",
          padding: "0 48px",
          height: 72,
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
        }}>
          <Image src="/roofviz-logo.png" alt="RoofViz" width={165} height={48} priority />
          <div style={{ marginLeft: "auto", fontSize: 13, color: "#94a3b8", fontWeight: 500, letterSpacing: "0.02em" }}>
            Professional Roof Visualization
          </div>
        </header>

        {/* Hero banner */}
        <div style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)",
          padding: "56px 48px",
          textAlign: "center",
          color: "#fff",
        }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: "0 0 12px", lineHeight: 1.25 }}>
            Walk Customers Through Their New Roof
          </h1>
          <p style={{ fontSize: 15, color: "rgba(255,255,255,0.68)", maxWidth: 560, margin: "0 auto", lineHeight: 1.7 }}>
            Upload a job-site photo, trace the roof, and visualize every installation layer — from tear-off to cap shingles. Export a professional 2-page PDF to share with your customer.
          </p>
        </div>

        {/* Content area */}
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "40px 24px 60px" }}>

          {/* How it works */}
          <div className="rv-fade-in-up" style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", marginBottom: 28, boxShadow: "0 1px 4px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.04)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#94a3b8", textTransform: "uppercase", marginBottom: 20 }}>HOW IT WORKS</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20 }}>

              {/* Step 1 — Upload Photo */}
              <div className="rv-how-step" style={{ textAlign: "center" }}>
                <svg viewBox="0 0 64 56" width="64" height="56" style={{ display: "block", margin: "0 auto 12px" }}>
                  <rect x="6" y="16" width="52" height="34" rx="5" fill="none" stroke="#2563eb" strokeWidth="2"/>
                  <rect x="22" y="8" width="20" height="10" rx="3" fill="none" stroke="#2563eb" strokeWidth="2"/>
                  <circle cx="32" cy="33" r="9" fill="none" stroke="#2563eb" strokeWidth="2"/>
                  <circle cx="32" cy="33" r="4" fill="#2563eb" opacity="0.3"/>
                  <rect x="46" y="20" width="6" height="4" rx="1" fill="#2563eb"/>
                  <line x1="26" y1="28" x2="32" y2="22" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 4 }}>Upload Photo</div>
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>Add a job-site photo of the roof.</div>
              </div>

              {/* Step 2 — Trace the Roof */}
              <div className="rv-how-step" style={{ textAlign: "center" }}>
                <svg viewBox="0 0 64 56" width="64" height="56" style={{ display: "block", margin: "0 auto 12px" }}>
                  <polygon points="32,8 6,34 58,34" fill="rgba(37,99,235,0.07)" stroke="#2563eb" strokeWidth="2" strokeLinejoin="round"/>
                  <line x1="6" y1="34" x2="6" y2="50" stroke="#2563eb" strokeWidth="2"/>
                  <line x1="58" y1="34" x2="58" y2="50" stroke="#2563eb" strokeWidth="2"/>
                  <line x1="6" y1="50" x2="58" y2="50" stroke="#2563eb" strokeWidth="2"/>
                  <circle cx="32" cy="8" r="4" fill="#2563eb"/>
                  <circle cx="6" cy="34" r="4" fill="#2563eb"/>
                  <circle cx="58" cy="34" r="4" fill="#2563eb"/>
                  <circle cx="6" cy="50" r="3" fill="rgba(37,99,235,0.4)"/>
                  <circle cx="58" cy="50" r="3" fill="rgba(37,99,235,0.4)"/>
                </svg>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 4 }}>Trace the Roof</div>
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>Outline each section and label the edges.</div>
              </div>

              {/* Step 3 — Build Layers */}
              <div className="rv-how-step" style={{ textAlign: "center" }}>
                <svg viewBox="0 0 64 56" width="64" height="56" style={{ display: "block", margin: "0 auto 12px" }}>
                  <rect x="6" y="8"  width="52" height="9" rx="2" fill="#0f172a" opacity="0.85"/>
                  <rect x="6" y="19" width="52" height="9" rx="2" fill="#1d4ed8" opacity="0.75"/>
                  <rect x="6" y="30" width="52" height="9" rx="2" fill="#60a5fa" opacity="0.70"/>
                  <rect x="6" y="41" width="52" height="9" rx="2" fill="#4b4e55" opacity="0.85"/>
                  <text x="10" y="16.5" fontSize="5.5" fill="#fff" fontFamily="sans-serif" fontWeight="600">Ice &amp; Water</text>
                  <text x="10" y="27.5" fontSize="5.5" fill="#fff" fontFamily="sans-serif" fontWeight="600">Synthetic</text>
                  <text x="10" y="38.5" fontSize="5.5" fill="#fff" fontFamily="sans-serif" fontWeight="600">Pro-Start</text>
                  <text x="10" y="49.5" fontSize="5.5" fill="#fff" fontFamily="sans-serif" fontWeight="600">Shingles</text>
                </svg>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 4 }}>Build Layers</div>
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>Step through every material layer live.</div>
              </div>

              {/* Step 4 — Export PDF */}
              <div className="rv-how-step" style={{ textAlign: "center" }}>
                <svg viewBox="0 0 64 56" width="64" height="56" style={{ display: "block", margin: "0 auto 12px" }}>
                  <rect x="10" y="4" width="36" height="46" rx="3" fill="none" stroke="#2563eb" strokeWidth="2"/>
                  <polyline points="30,4 30,18 46,18" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinejoin="round"/>
                  <line x1="16" y1="24" x2="40" y2="24" stroke="#2563eb" strokeWidth="1.5"/>
                  <line x1="16" y1="30" x2="40" y2="30" stroke="#2563eb" strokeWidth="1.5"/>
                  <line x1="16" y1="36" x2="32" y2="36" stroke="#2563eb" strokeWidth="1.5"/>
                  <circle cx="51" cy="42" r="9" fill="#2563eb"/>
                  <line x1="51" y1="37" x2="51" y2="45" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
                  <polyline points="47,42 51,46 55,42" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
                </svg>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 4 }}>Export PDF</div>
                <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>Share a 2-page report with your customer.</div>
              </div>

            </div>
          </div>

          {/* Start new project */}
          <div className="rv-fade-in-up" style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", marginBottom: 28, boxShadow: "0 1px 4px rgba(15,23,42,0.06), 0 0 0 1px rgba(15,23,42,0.04)", animationDelay: "0.08s" }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", margin: "0 0 6px" }}>Start a project</h2>
            <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 20px", lineHeight: 1.65 }}>
              Upload a photo and trace the roof to begin your visualization.
            </p>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                  Project name
                </label>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  style={inputStyle}
                  placeholder="e.g. 123 Oak Street"
                />
              </div>
              <button
                className="rv-btn-primary"
                style={{ ...primaryBtn, width: "auto", padding: "12px 28px", marginTop: 0 }}
                onClick={startProject}
              >
                Start Project
              </button>
            </div>
          </div>

          {/* Saved projects */}
          {photos.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#94a3b8", textTransform: "uppercase", marginBottom: 14 }}>
                SAVED PROJECTS
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
                {photos.map((p) => (
                  <div
                    key={p.id}
                    className="rv-project-card rv-fade-in-up"
                    style={{
                      background: "#fff",
                      border: "1.5px solid rgba(15,23,42,0.08)",
                      borderRadius: 14,
                      overflow: "hidden",
                      boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
                    }}
                  >
                    {/* Thumbnail — click to open */}
                    <button
                      onClick={() => openProject(p.id)}
                      style={{
                        display: "block", width: "100%", padding: 0, border: "none",
                        cursor: "pointer", background: "none",
                      }}
                    >
                      <div style={{
                        height: 130,
                        background: p.src ? "none" : "linear-gradient(135deg, #e2e8f0, #cbd5e1)",
                        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
                      }}>
                        {p.src
                          ? <img src={p.src} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : <div style={{ fontSize: 36, opacity: 0.25 }}>🏠</div>
                        }
                      </div>
                    </button>

                    <div style={{ padding: "10px 14px 12px" }}>
                      {/* Inline rename / project name */}
                      {renamingId === p.id ? (
                        <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                          <input
                            autoFocus
                            value={renamingName}
                            onChange={(e) => setRenamingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { renameProject(p.id, renamingName); setRenamingId(null); }
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            style={{ flex: 1, padding: "5px 9px", borderRadius: 7, border: "1.5px solid rgba(37,99,235,0.40)", fontSize: 13, fontWeight: 600 }}
                          />
                          <button
                            onClick={() => { renameProject(p.id, renamingName); setRenamingId(null); }}
                            style={{ padding: "5px 10px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none", background: "#2563eb", color: "#fff" }}
                          >✓</button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                          <div
                            style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                            onClick={() => openProject(p.id)}
                          >
                            {p.name || "Untitled Project"}
                          </div>
                          {/* Rename button */}
                          <button
                            onClick={() => { setRenamingId(p.id); setRenamingName(p.name); }}
                            title="Rename project"
                            style={{ flexShrink: 0, padding: "3px 7px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid rgba(15,23,42,0.12)", background: "#f8fafc", color: "#64748b" }}
                          >✎</button>
                          {/* Delete button */}
                          <button
                            onClick={() => { if (window.confirm(`Delete "${p.name || "Untitled"}"?`)) deleteProject(p.id); }}
                            title="Delete project"
                            style={{ flexShrink: 0, padding: "3px 7px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid rgba(220,38,38,0.22)", background: "rgba(220,38,38,0.05)", color: "#dc2626" }}
                          >✕</button>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#64748b" }}>
                        {STEP_TITLE[p.step]} &nbsp;·&nbsp; {p.roofs.length} roof{p.roofs.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
        : { display: "grid", gridTemplateColumns: "420px 1fr", height: "100vh" }
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

      {/* ── LEFT PANEL ── */}
      <aside style={{
        background: "#f8fafc",
        borderRight: "1px solid rgba(15,23,42,0.08)",
        display: screen === "CUSTOMER_VIEW" ? "none" : "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>

        {/* ── PROJECT EDITOR PANEL ── */}
        {screen !== "CUSTOMER_VIEW" && (<>

        {/* Sticky header */}
        <div style={{
          background: "#ffffff",
          borderBottom: "1px solid rgba(15,23,42,0.08)",
          padding: "16px 20px 14px",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setScreen("MENU")}
              style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1.5px solid rgba(15,23,42,0.10)", background: "#f8fafc", color: "#475569", flexShrink: 0 }}
            >
              ← Menu
            </button>
            <Image src="/roofviz-logo.png" alt="RoofViz" width={148} height={43} priority />
            {active && (
              <div style={{ textAlign: "right", marginLeft: "auto" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#2563eb", letterSpacing: "0.05em" }}>
                  STEP {stepIndex(liveStep) + 1} / {STEPS.length}
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2, letterSpacing: "0.02em" }}>
                  Scroll · Zoom &nbsp;|&nbsp; Drag · Pan
                </div>
              </div>
            )}
          </div>
          {active && (
            <input
              value={active.name}
              onChange={(e) => patchActive((p) => ({ ...p, name: e.target.value }))}
              placeholder="Project name"
              style={{ marginTop: 10, width: "100%", fontSize: 13, fontWeight: 700, color: "#0f172a", background: "transparent", border: "none", borderBottom: "1.5px solid rgba(15,23,42,0.10)", padding: "4px 2px", outline: "none", boxSizing: "border-box" as const }}
            />
          )}
          {active && (
            <div style={{ marginTop: 8, height: 3, background: "#e2e8f0", borderRadius: 99, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${((stepIndex(liveStep) + 1) / STEPS.length) * 100}%`,
                background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                borderRadius: 99,
                transition: "width 0.35s ease",
              }} />
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>

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

          {/* ── ACTIVE PROJECT ── */}
          {liveStep !== "START" && (
            <>
              {/* Photo — current project only */}
              <div style={sectionCard} className="rv-section-card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={sectionLabel}>
                    Photo{(active?.photoSrcs?.length ?? 0) > 1 ? ` (${(active?.photoSrcs?.indexOf(active?.src) ?? 0) + 1}/${active?.photoSrcs?.length})` : ""}
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
              </div>

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
                            fontWeight: isCurrent ? 700 : isCompleted ? 600 : 500,
                            color: isCurrent ? "#1d4ed8" : isCompleted ? "#0f172a" : "#64748b",
                            flex: 1,
                          }}>
                            {STEP_SHORT[step]}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Current step detail */}
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 6, paddingTop: 8, borderTop: "1px solid rgba(15,23,42,0.06)" }}>
                    {STEP_TITLE[liveStep]}
                  </div>
                  {STEP_HINT[liveStep] && (
                    <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.55, margin: "0 0 12px" }}>
                      {STEP_HINT[liveStep]}
                    </p>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <button
                      className="rv-btn-ghost"
                      style={ghostBtn}
                      onClick={goBack}
                      disabled={stepIndex(liveStep) === 0}
                    >
                      ← Back
                    </button>
                    <button
                      className="rv-btn-primary"
                      style={{ ...primaryBtn, margin: 0 }}
                      onClick={goNext}
                      disabled={!canGoNext()}
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

              {/* Roofs */}
              {active && (
                <div style={sectionCard}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={sectionLabel}>Roofs</div>
                    <button style={smallBtn} onClick={addRoof}>+ Add Roof</button>
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
                          <div style={sectionLabel}>Step B — Label Each Edge Type</div>

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
                                    {activeRoof.lines
                                      .filter(l => l.kind === kind)
                                      .map((line, i) => (
                                        <div key={line.id} style={{ display: "flex", alignItems: "center", gap: 6,
                                          background: "rgba(15,23,42,0.03)", borderRadius: 6, padding: "4px 8px" }}>
                                          <span style={{ flex: 1, fontSize: 11, color: "#475569", fontWeight: 600 }}>
                                            {kind} {i + 1}
                                          </span>
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

                          {/* ── Detect Edges + Suggest Planes ── */}
                          {!edgePanel ? (
                            <button
                              style={{ ...smallBtn, flex: 1, background: "linear-gradient(135deg,#fefce8,#fef9c3)", borderColor: "#fde047", color: "#854d0e", fontWeight: 700 }}
                              onClick={async () => {
                                setEdgePanel(true);
                                if (photoImg) {
                                  const detected = await autoDetectMode(photoImg, w, h);
                                  setEdgeMode(detected);
                                }
                              }}
                            >
                              ◈ Detect Edges
                            </button>
                          ) : (
                            <div style={{ background: "#fefce8", border: "1.5px solid #fde047", borderRadius: 10, padding: "12px 12px 10px", display: "grid", gap: 10 }}>
                              {/* Header */}
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: "#854d0e" }}>
                                  {edgeMode === "facade" ? "◈ Roof Edge Assist" : "◈ Edge Detection"}
                                </div>
                                <button
                                  style={{ ...smallBtn, padding: "2px 7px", fontSize: 11, color: "#475569" }}
                                  onClick={() => {
                                    setEdgePanel(false);
                                    setEdgeTool("NONE");
                                    setEdgeAddDraft(null);
                                    setDetectedSegs([]);
                                    setErasedSegIds(new Set());
                                    setEdgeErasedMask([]);
                                    setUserAddedSegs([]);
                                    setPlaneSuggs([]);
                                  }}
                                >✕</button>
                              </div>

                              {/* Mode toggle */}
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                                {(["facade", "topDown"] as const).map((m) => (
                                  <button
                                    key={m}
                                    style={{ ...smallBtn, fontSize: 10, padding: "5px 4px",
                                      background: edgeMode === m ? (m === "facade" ? "#e0f2fe" : "#fef9c3") : undefined,
                                      borderColor: edgeMode === m ? (m === "facade" ? "#7dd3fc" : "#fde047") : undefined,
                                      color: edgeMode === m ? (m === "facade" ? "#0369a1" : "#854d0e") : "#64748b",
                                      fontWeight: edgeMode === m ? 700 : 400,
                                    }}
                                    onClick={() => { setEdgeMode(m); setDetectedSegs([]); setPlaneSuggs([]); }}
                                  >
                                    {m === "facade" ? "🏠 Facade View" : "🛰 Top-Down View"}
                                  </button>
                                ))}
                              </div>
                              {edgeMode === "facade" && (
                                <div style={{ fontSize: 10, color: "#0369a1", background: "#e0f2fe", borderRadius: 6, padding: "5px 8px", lineHeight: 1.5 }}>
                                  Facade mode restricts detection to the roof region and filters window/door edges.
                                </div>
                              )}

                              {/* ── Sliders ── */}
                              {([
                                { label: "Edge Sensitivity", key: "sens", val: edgeSensitivity, set: setEdgeSensitivity, lo: "Fewer", hi: "More" },
                                { label: "Detail Suppression", key: "sup",  val: edgeDetailSuppression, set: setEdgeDetailSuppression, lo: "Light", hi: "Heavy" },
                              ] as const).map(({ label, key, val, set, lo, hi }) => (
                                <div key={key}>
                                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                    <span style={{ fontSize: 11, color: "#78350f", fontWeight: 600 }}>{label}</span>
                                    <span style={{ fontSize: 10, color: "#92400e" }}>{Math.round((val as number) * 100)}%</span>
                                  </div>
                                  <input
                                    type="range" min={0} max={1} step={0.05}
                                    value={val as number}
                                    onChange={(e) => { (set as (v: number) => void)(parseFloat(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                    style={{ width: "100%", accentColor: "#ca8a04" }}
                                  />
                                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ fontSize: 9, color: "#a16207" }}>{lo}</span>
                                    <span style={{ fontSize: 9, color: "#a16207" }}>{hi}</span>
                                  </div>
                                </div>
                              ))}

                              {/* Min line length */}
                              <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                  <span style={{ fontSize: 11, color: "#78350f", fontWeight: 600 }}>Min Line Length</span>
                                  <span style={{ fontSize: 10, color: "#92400e" }}>{Math.round(edgeMinLine * 100)}% width</span>
                                </div>
                                <input
                                  type="range" min={0.01} max={0.12} step={0.005}
                                  value={edgeMinLine}
                                  onChange={(e) => { setEdgeMinLine(parseFloat(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                  style={{ width: "100%", accentColor: "#ca8a04" }}
                                />
                              </div>

                              {/* Facade-specific controls */}
                              {edgeMode === "facade" && (
                                <>
                                  {/* Roof region height */}
                                  <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                      <span style={{ fontSize: 11, color: "#0369a1", fontWeight: 600 }}>Roof Region Height</span>
                                      <span style={{ fontSize: 10, color: "#0369a1" }}>{Math.round(edgeRoofRegionFraction * 100)}% of image</span>
                                    </div>
                                    <input
                                      type="range" min={0.25} max={0.80} step={0.05}
                                      value={edgeRoofRegionFraction}
                                      onChange={(e) => { setEdgeRoofRegionFraction(parseFloat(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ width: "100%", accentColor: "#0369a1" }}
                                    />
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                      <span style={{ fontSize: 9, color: "#0369a1" }}>Less roof</span>
                                      <span style={{ fontSize: 9, color: "#0369a1" }}>More roof</span>
                                    </div>
                                  </div>
                                  {/* Ignore vertical toggle */}
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                                    <input
                                      type="checkbox"
                                      checked={edgeIgnoreVertical}
                                      onChange={(e) => { setEdgeIgnoreVertical(e.target.checked); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ accentColor: "#0369a1", width: 14, height: 14 }}
                                    />
                                    <span style={{ fontSize: 11, color: "#0369a1", fontWeight: 600 }}>Filter vertical lines</span>
                                  </label>
                                  {/* Sky boundary bias toggle */}
                                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                                    <input
                                      type="checkbox"
                                      checked={edgeSkyBoundaryBias}
                                      onChange={(e) => { setEdgeSkyBoundaryBias(e.target.checked); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ accentColor: "#0369a1", width: 14, height: 14 }}
                                    />
                                    <span style={{ fontSize: 11, color: "#0369a1", fontWeight: 600 }}>Prefer sky boundary (ridge bias)</span>
                                  </label>
                                  {/* Edge contrast threshold */}
                                  <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                      <span style={{ fontSize: 11, color: "#0369a1", fontWeight: 600 }}>Edge Contrast Threshold</span>
                                      <span style={{ fontSize: 10, color: "#0369a1" }}>{Math.round(edgeContrastThreshold * 100)}%</span>
                                    </div>
                                    <input
                                      type="range" min={0} max={0.20} step={0.01}
                                      value={edgeContrastThreshold}
                                      onChange={(e) => { setEdgeContrastThreshold(parseFloat(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ width: "100%", accentColor: "#0369a1" }}
                                    />
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                      <span style={{ fontSize: 9, color: "#0369a1" }}>Keep all</span>
                                      <span style={{ fontSize: 9, color: "#0369a1" }}>High contrast only</span>
                                    </div>
                                  </div>
                                  {/* Lines per direction */}
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                    <span style={{ fontSize: 11, color: "#0369a1", fontWeight: 600 }}>Lines per direction</span>
                                    <select
                                      value={edgePerDirectionCap}
                                      onChange={(e) => { setEdgePerDirectionCap(parseInt(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ fontSize: 10, padding: "2px 4px", borderRadius: 4, border: "1px solid #7dd3fc", background: "#e0f2fe", color: "#0369a1", width: 44 }}
                                    >
                                      {[1,2,3].map((n) => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                  </div>
                                </>
                              )}

                              {/* Top-down only: dominant directions toggle */}
                              {edgeMode === "topDown" && (
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", flex: 1 }}>
                                    <input
                                      type="checkbox"
                                      checked={edgeDominantOnly}
                                      onChange={(e) => { setEdgeDominantOnly(e.target.checked); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ accentColor: "#ca8a04", width: 14, height: 14 }}
                                    />
                                    <span style={{ fontSize: 11, color: "#78350f", fontWeight: 600 }}>Dominant Dirs Only</span>
                                  </label>
                                  {edgeDominantOnly && (
                                    <select
                                      value={edgeNumDirections}
                                      onChange={(e) => { setEdgeNumDirections(parseInt(e.target.value)); setDetectedSegs([]); setPlaneSuggs([]); }}
                                      style={{ fontSize: 10, padding: "2px 4px", borderRadius: 4, border: "1px solid #fde047", background: "#fffbeb", color: "#78350f", width: 46 }}
                                    >
                                      {[2,3,4,5,6].map((n) => <option key={n} value={n}>K={n}</option>)}
                                    </select>
                                  )}
                                </div>
                              )}

                              {/* Detect button */}
                              <button
                                style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: edgeDetecting ? "rgba(180,130,0,0.3)" : "linear-gradient(135deg,#ca8a04,#a16207)", fontSize: 12, fontWeight: 700, color: edgeDetecting ? "#78350f" : "#fff", cursor: edgeDetecting ? "default" : "pointer" }}
                                disabled={edgeDetecting}
                                onClick={async () => {
                                  if (!photoImg || !active) return;
                                  setEdgeDetecting(true);
                                  setErasedSegIds(new Set());
                                  setUserAddedSegs([]);
                                  setPlaneSuggs([]);
                                  try {
                                    let segs = await detectEdges(photoImg, w, h, {
                                      sensitivity: edgeSensitivity,
                                      detailSuppression: edgeDetailSuppression,
                                      minLineFraction: edgeMinLine,
                                      mode: edgeMode,
                                      roofRegionFraction: edgeRoofRegionFraction,
                                      ignoreVertical: edgeIgnoreVertical,
                                      skyBoundaryBias: edgeSkyBoundaryBias,
                                      edgeContrastThreshold: edgeContrastThreshold,
                                      perDirectionCap: edgePerDirectionCap,
                                      dominantOnly: edgeDominantOnly,
                                      numDirections: edgeNumDirections,
                                      directionTolDeg: 10,
                                    });
                                    // Apply spatial erase mask: remove segs near previously-erased positions
                                    if (edgeErasedMask.length > 0) {
                                      const MASK_RADIUS = 30;
                                      segs = segs.filter((s) => {
                                        const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
                                        return !edgeErasedMask.some((m) => (mx-m.x)**2 + (my-m.y)**2 < MASK_RADIUS**2);
                                      });
                                    }
                                    setDetectedSegs(segs);
                                  } finally {
                                    setEdgeDetecting(false);
                                  }
                                }}
                              >
                                {edgeDetecting ? "Detecting…" : detectedSegs.length > 0 ? "Re-detect" : "Detect Edges"}
                              </button>

                              {/* Edge count + show/hide + max lines */}
                              {visibleSegs.length > 0 && (
                                <>
                                  {/* Count row + show/hide */}
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                    <div style={{ fontSize: 11, color: "#78350f" }}>
                                      {displaySegs.length}{visibleSegs.length > edgeMaxLines ? `/${visibleSegs.length}` : ""} segments
                                      {edgeErasedMask.length > 0 ? ` (${edgeErasedMask.length} masked)` : ""}
                                    </div>
                                    <button
                                      style={{ ...smallBtn, fontSize: 10, padding: "3px 8px",
                                        background: showDetectedLayer ? "#e0f2fe" : undefined,
                                        borderColor: showDetectedLayer ? "#7dd3fc" : undefined,
                                        color: showDetectedLayer ? "#0284c7" : "#64748b",
                                      }}
                                      onClick={() => setShowDetectedLayer((v) => !v)}
                                    >
                                      {showDetectedLayer ? "◉ Hide" : "◎ Show"}
                                    </button>
                                  </div>

                                  {/* Max lines slider */}
                                  <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                      <span style={{ fontSize: 11, color: "#78350f", fontWeight: 600 }}>Max Lines</span>
                                      <span style={{ fontSize: 10, color: "#92400e" }}>{edgeMaxLines}</span>
                                    </div>
                                    <input
                                      type="range" min={10} max={200} step={5}
                                      value={edgeMaxLines}
                                      onChange={(e) => setEdgeMaxLines(parseInt(e.target.value))}
                                      style={{ width: "100%", accentColor: "#ca8a04" }}
                                    />
                                  </div>

                                  {/* Label color legend */}
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
                                    {([
                                      { label: "ridgeCandidate",       color: "#f97316", name: "Ridge" },
                                      { label: "eaveCandidate",        color: "#3b82f6", name: "Eave" },
                                      { label: "rakeCandidateLeft",    color: "#14b8a6", name: "Rake←" },
                                      { label: "rakeCandidateRight",   color: "#84cc16", name: "Rake→" },
                                      { label: "rakeCandidate",        color: "#10b981", name: "Rake" },
                                      { label: "valleyCandidate",      color: "#a855f7", name: "Valley" },
                                      { label: "unknown",              color: "#facc15", name: "Other" },
                                    ] as const).map(({ label, color, name }) => {
                                      const cnt = displaySegs.filter((s) => s.label === label).length;
                                      if (cnt === 0) return null;
                                      return (
                                        <div key={label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                          <div style={{ width: 10, height: 3, background: color, borderRadius: 2 }} />
                                          <span style={{ fontSize: 9, color: "#78350f" }}>{name} {cnt}</span>
                                        </div>
                                      );
                                    })}
                                  </div>

                                  {/* Add to Model button */}
                                  <button
                                    style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#059669,#047857)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer" }}
                                    onClick={() => {
                                      patchActiveRoof((r) => {
                                        const newLines = displaySegs.map((s) => {
                                          const kind: LineKind =
                                            s.label === "eaveCandidate"        ? "EAVE"   :
                                            s.label === "ridgeCandidate"       ? "RIDGE"  :
                                            s.label === "valleyCandidate"      ? "VALLEY" :
                                            s.label === "rakeCandidate"        ? "RAKE"   :
                                            s.label === "rakeCandidateLeft"    ? "RAKE"   :
                                            s.label === "rakeCandidateRight"   ? "RAKE"   : "EAVE";
                                          return {
                                            id: Math.random().toString(16).slice(2),
                                            kind,
                                            points: [s.x1, s.y1, s.x2, s.y2],
                                          } as Polyline;
                                        });
                                        return { ...r, lines: [...r.lines, ...newLines] };
                                      });
                                      setEdgePanel(false);
                                      setEdgeTool("NONE");
                                      setEdgeAddDraft(null);
                                      setDetectedSegs([]);
                                      setErasedSegIds(new Set());
                                      setEdgeErasedMask([]);
                                      setUserAddedSegs([]);
                                      setPlaneSuggs([]);
                                    }}
                                  >
                                    ↳ Add {displaySegs.length} Lines to Model
                                  </button>

                                  {/* Tool selector */}
                                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
                                    {(["NONE", "ERASE_EDGE", "ADD_EDGE"] as const).map((t) => (
                                      <button
                                        key={t}
                                        style={{ ...smallBtn, fontSize: 10, padding: "5px 4px",
                                          background: edgeTool === t ? (t === "ERASE_EDGE" ? "#fee2e2" : t === "ADD_EDGE" ? "#dcfce7" : "#e0f2fe") : undefined,
                                          borderColor: edgeTool === t ? (t === "ERASE_EDGE" ? "#fca5a5" : t === "ADD_EDGE" ? "#86efac" : "#7dd3fc") : undefined,
                                          color: edgeTool === t ? (t === "ERASE_EDGE" ? "#dc2626" : t === "ADD_EDGE" ? "#16a34a" : "#0284c7") : undefined,
                                        }}
                                        onClick={() => { setEdgeTool(t); setEdgeAddDraft(null); }}
                                      >
                                        {t === "NONE" ? "↖ Select" : t === "ERASE_EDGE" ? "✕ Erase" : "+ Add"}
                                      </button>
                                    ))}
                                  </div>
                                  {edgeTool !== "NONE" && (
                                    <div style={{ fontSize: 10, color: "#92400e", fontStyle: "italic", lineHeight: 1.4, textAlign: "center" }}>
                                      {edgeTool === "ERASE_EDGE"
                                        ? "Click colored lines to erase. Erased positions are remembered on re-detect."
                                        : "Click two points on the canvas to draw an edge."}
                                    </div>
                                  )}
                                  {edgeErasedMask.length > 0 && (
                                    <button
                                      style={{ ...smallBtn, fontSize: 10, color: "#b45309", borderColor: "rgba(180,83,9,0.25)" }}
                                      onClick={() => { setEdgeErasedMask([]); setErasedSegIds(new Set()); }}
                                    >
                                      ↺ Reset erase mask ({edgeErasedMask.length})
                                    </button>
                                  )}
                                </>
                              )}

                              {/* Plane suggestion (top-down only) / facade notice */}
                              {edgeMode === "facade" ? (
                                visibleSegs.length > 0 && (
                                  <div style={{ fontSize: 10, color: "#0369a1", background: "#e0f2fe", borderRadius: 6, padding: "6px 8px", lineHeight: 1.5 }}>
                                    Plane detection requires top-down imagery. Use "Add Lines to Model" above to capture detected edges, then trace the outline manually.
                                  </div>
                                )
                              ) : (
                                <>
                                  {visibleSegs.length >= 3 && (
                                    <button
                                      style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: suggestingPlanes ? "rgba(59,130,246,0.3)" : "linear-gradient(135deg,#2563eb,#1d4ed8)", fontSize: 12, fontWeight: 700, color: suggestingPlanes ? "#1e40af" : "#fff", cursor: suggestingPlanes ? "default" : "pointer" }}
                                      disabled={suggestingPlanes}
                                      onClick={() => {
                                        setSuggestingPlanes(true);
                                        setPlaneSuggs([]);
                                        setTimeout(() => {
                                          try {
                                            const suggs = suggestPlanes(visibleSegs, w, h, { maxPlanes: 8, minArea: 2000 });
                                            setPlaneSuggs(suggs);
                                          } finally {
                                            setSuggestingPlanes(false);
                                          }
                                        }, 30);
                                      }}
                                    >
                                      {suggestingPlanes ? "Analyzing…" : planeSuggs.length > 0 ? "Re-suggest Planes" : "Suggest Roof Planes"}
                                    </button>
                                  )}
                                  {planeSuggs.length > 0 && (
                                    <div style={{ display: "grid", gap: 4 }}>
                                      <div style={{ fontSize: 11, fontWeight: 600, color: "#1e40af" }}>
                                        {planeSuggs.length} plane{planeSuggs.length > 1 ? "s" : ""} — hover to preview, click to adopt
                                      </div>
                                      {planeSuggs.map((ps, i) => (
                                        <button
                                          key={ps.id}
                                          style={{ ...smallBtn, justifyContent: "space-between", display: "flex", gap: 6,
                                            background: ps.id === hoveredSuggId ? "linear-gradient(135deg,#eff6ff,#dbeafe)" : undefined,
                                            borderColor: ps.id === hoveredSuggId ? "#93c5fd" : undefined,
                                          }}
                                          onMouseEnter={() => setHoveredSuggId(ps.id)}
                                          onMouseLeave={() => setHoveredSuggId(null)}
                                          onClick={() => {
                                            patchActiveRoof((r) => ({ ...r, outline: ps.polygon, closed: true }));
                                            setPlaneSuggs([]); setEdgePanel(false); setEdgeTool("NONE");
                                            setDetectedSegs([]); setErasedSegIds(new Set()); setEdgeErasedMask([]); setUserAddedSegs([]);
                                          }}
                                        >
                                          <span style={{ fontSize: 11, color: "#1e40af", fontWeight: 700 }}>Plane {i + 1}</span>
                                          <span style={{ fontSize: 10, color: "#64748b" }}>{Math.round(ps.area / 1000)}k px²</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {planeSuggs.length === 0 && visibleSegs.length >= 3 && !suggestingPlanes && detectedSegs.length > 0 && (
                                    <div style={{ fontSize: 10, color: "#92400e", fontStyle: "italic", lineHeight: 1.4 }}>
                                      No closed planes found. Try erasing noisy edges or increasing K directions.
                                    </div>
                                  )}
                                </>
                              )}
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

                  {/* Advanced options */}
                  {activeRoof && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(15,23,42,0.07)" }}>
                      <button
                        style={{ ...smallBtn, width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                        onClick={() => setAdvancedOpen((v) => !v)}
                      >
                        <span>Advanced Options</span>
                        <span style={{
                          transform: advancedOpen ? "rotate(180deg)" : "none",
                          transition: "transform 0.2s",
                          display: "inline-block",
                          opacity: 0.45,
                          fontSize: 11,
                        }}>▾</span>
                      </button>

                      {advancedOpen && (
                        <div style={{ marginTop: 14, display: "grid", gap: 16 }}>

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
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        </>)}
      </aside>

      {/* ── CANVAS ── */}
      <main ref={containerRef} style={{
        background: screen === "CUSTOMER_VIEW" ? "#e8edf2" : "#0c1524",
        backgroundImage: screen === "CUSTOMER_VIEW" ? "none" : "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
        position: "relative",
        overflow: "hidden",
        ...(screen === "CUSTOMER_VIEW" ? { order: 1, flex: "1 1 0", minWidth: 0 } : {}),
      }}>
        <Stage
          ref={stageRef}
          width={w}
          height={h}
          onMouseDown={screen !== "CUSTOMER_VIEW" ? onStageDown : undefined}
          onTouchStart={screen !== "CUSTOMER_VIEW" ? onStageDown : undefined}
          onWheel={screen !== "CUSTOMER_VIEW" ? onWheel : undefined}
          draggable={!!active && screen !== "CUSTOMER_VIEW"}
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
            {/* Customer view: light background covers entire world space */}
            {screen === "CUSTOMER_VIEW" && (
              <Rect x={-50000} y={-50000} width={200000} height={200000} fill="#e8edf2" />
            )}

            {!photoImg && liveStep !== "START" && screen !== "CUSTOMER_VIEW" && (
              <>
                <Text
                  text="Upload a photo to begin"
                  x={0}
                  y={h / 2 - 22}
                  width={w}
                  align="center"
                  fill="rgba(255,255,255,0.55)"
                  fontSize={17}
                  fontStyle="600"
                />
                <Text
                  text="Use the Photo panel on the left"
                  x={0}
                  y={h / 2 + 6}
                  width={w}
                  align="center"
                  fill="rgba(255,255,255,0.28)"
                  fontSize={13}
                />
              </>
            )}

            {photoImg && <KonvaImage
              image={photoImg}
              width={screen === "CUSTOMER_VIEW" ? ((active as any)?._customerCanvasW || w) : w}
              height={screen === "CUSTOMER_VIEW" ? ((active as any)?._customerCanvasH || h) : h}
            />}

            {/* Draft visuals */}
            {active?.step === "TRACE" && draftLine && (
              <Line points={draftLine.points} stroke="rgba(255,255,255,0.9)" strokeWidth={3} dash={[8, 6]} lineCap="round" lineJoin="round" />
            )}
            {active?.step === "TRACE" && draftHole && draftHole.length >= 2 && (
              <Line points={draftHole} stroke="rgba(255,255,255,0.9)" strokeWidth={3} dash={[6, 6]} lineCap="round" lineJoin="round" />
            )}

            {/* Guide lines — dimmed when cleanup preview is active */}
            {active && showGuides && active.roofs.flatMap((r) => {
              const all = [...r.lines];
              if (r.id === activeRoof?.id && draftLine && draftLine.points.length >= 4) all.push({ ...draftLine, id: "draft" });
              const baseOpacity = cleanupPreview ? 0.18 : (active.step === "TRACE" ? 0.95 : 0.45);
              return all.map((l) => (
                <Line
                  key={`guide-${r.id}-${l.id}`}
                  points={l.points}
                  stroke={kindColor(l.kind)}
                  strokeWidth={3}
                  dash={[10, 7]}
                  lineCap="round"
                  lineJoin="round"
                  opacity={baseOpacity}
                />
              ));
            })}

            {/* Roof outlines — dimmed when cleanup preview is active */}
            {active && (active.step === "TRACE" || active.showGuidesDuringInstall) && active.roofs.map((r) =>
              r.outline.length >= 2 ? (
                <Line
                  key={`outline-${r.id}`}
                  points={r.outline}
                  closed={r.closed}
                  stroke={r.id === active.activeRoofId ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)"}
                  strokeWidth={r.id === active.activeRoofId ? 2.5 : 2}
                  opacity={cleanupPreview && r.id === active.activeRoofId ? 0.18 : 1}
                />
              ) : null
            )}

            {/* ── Facade roof region mask ── */}
            {active?.step === "TRACE" && edgePanel && edgeMode === "facade" && (
              <>
                {/* Dimmed band below the roof region */}
                <Rect
                  x={0} y={Math.round(h * edgeRoofRegionFraction)}
                  width={w} height={h - Math.round(h * edgeRoofRegionFraction)}
                  fill="rgba(0,0,0,0.35)"
                  listening={false}
                />
                {/* Dashed boundary line */}
                <Line
                  points={[0, Math.round(h * edgeRoofRegionFraction), w, Math.round(h * edgeRoofRegionFraction)]}
                  stroke="rgba(56,189,248,0.9)"
                  strokeWidth={2}
                  dash={[10, 6]}
                  lineCap="round"
                  listening={false}
                />
              </>
            )}

            {/* ── Edge Detection overlays ── */}
            {active?.step === "TRACE" && edgePanel && showDetectedLayer && displaySegs.length > 0 && (
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
            {/* Edge-add draft line */}
            {active?.step === "TRACE" && edgeTool === "ADD_EDGE" && edgeAddDraft && (
              <Circle x={edgeAddDraft[0]} y={edgeAddDraft[1]} radius={5} fill="rgba(250,204,21,0.9)" />
            )}
            {/* Plane suggestion polygons */}
            {active?.step === "TRACE" && planeSuggs.map((ps) => {
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

            {/* ── Cleanup preview overlay ── */}
            {/* "Before" ghost: current geometry shown faded                          */}
            {/* "After"  clean: cleaned geometry shown in green at full opacity       */}
            {cleanupPreview && activeRoof && active?.step === "TRACE" && (
              <>
                {/* After: cleaned outline */}
                {cleanupPreview.outline.length >= 4 && (
                  <Line
                    points={cleanupPreview.outline}
                    closed={cleanupPreview.closed}
                    stroke="rgba(74,222,128,0.95)"
                    strokeWidth={2.5}
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
                    lineCap="round"
                    lineJoin="round"
                  />
                ))}
              </>
            )}

            {/* Hole outlines */}
            {active && (active.step === "TRACE" || active.showGuidesDuringInstall) && active.roofs.flatMap((r) =>
              r.holes.map((holePts, i) => (
                <Line
                  key={`hole-${r.id}-${i}`}
                  points={holePts}
                  closed={holePts.length >= 6}
                  stroke="rgba(255,255,255,0.82)"
                  dash={[8, 6]}
                  strokeWidth={2}
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

              return (
                <Group key={`install-${r.id}`} clipFunc={(ctx) => clipPolygonPath(ctx, r.outline)}>
                  {/* Tearoff (decking) */}
{atLeast(currentStep, "TEAROFF") && deckingImg && (
  <KonvaImage image={deckingImg} x={0} y={0} width={w} height={h} opacity={0.92} />
)}

{/* Subtle structure guides — faint valley/hip/ridge lines visible during install */}
{atLeast(currentStep, "TEAROFF") && !atLeast(currentStep, "SHINGLES") && (
  <>
    {valleys.map((l) => (
      <Line key={`guide-v-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.13)" strokeWidth={3} dash={[10, 8]} lineCap="round" lineJoin="round" />
    ))}
    {ridges.map((l) => (
      <Line key={`guide-r-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.10)" strokeWidth={2} dash={[8, 7]} lineCap="round" lineJoin="round" />
    ))}
    {hips.map((l) => (
      <Line key={`guide-h-${r.id}-${l.id}`} points={l.points} stroke="rgba(255,255,255,0.11)" strokeWidth={2} dash={[9, 7]} lineCap="round" lineJoin="round" />
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
    <KonvaImage image={syntheticImg} x={0} y={0} width={w} height={h} opacity={0.86} />
  )}

{/* Ice & water — always visible once reached */}
{atLeast(currentStep, "ICE_WATER") && (
  <>
    {eaves.map((l) => (
      <Line
        key={`iwe-${r.id}-${l.id}`}
        points={l.points}
        stroke="rgba(18,23,38,0.92)"
        strokeWidth={r.iceWaterEaveW}
        lineCap="round"
        lineJoin="round"
        opacity={0.92}
      />
    ))}
    {valleys.map((l) => (
      <Line
        key={`iwv-${r.id}-${l.id}`}
        points={l.points}
        stroke="rgba(18,23,38,0.92)"
        strokeWidth={r.iceWaterValleyW}
        lineCap="round"
        lineJoin="round"
        opacity={0.92}
      />
    ))}
  </>
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
                  {atLeast(currentStep, "SHINGLES") && shinglesImg && (() => {
                    // Compute the average Y of all eave points so shingle courses align
                    // parallel to the eave (courses run level with the gutter line).
                    const eaveYs = eaves.flatMap((l) => l.points.filter((_, i) => i % 2 === 1));
                    const eaveY = eaveYs.length > 0
                      ? eaveYs.reduce((a, b) => a + b, 0) / eaveYs.length
                      : 0;
                    // courseH in texture pixels must match makeShingleTexture (11px).
                    const courseH = 11;
                    // Shift the pattern so a course boundary lands exactly on eaveY.
                    const shingleOffsetY = ((-(eaveY + 5000) / r.shingleScale % courseH) + courseH) % courseH;
                    return (
                      <>
                        <Rect
                          x={-5000}
                          y={-5000}
                          width={12000}
                          height={12000}
                          opacity={0.98}
                          fillPatternImage={shinglesImg}
                          fillPatternRepeat="repeat"
                          fillPatternScaleX={r.shingleScale}
                          fillPatternScaleY={r.shingleScale}
                          fillPatternOffsetY={shingleOffsetY}
                          fillPatternRotation={r.shingleRotation ?? 0}
                        />
                        <Rect x={0} y={0} width={w} height={h} fill="rgba(0,0,0,0.06)" />
                      </>
                    );
                  })()}

                  {/* RIDGE VENT */}
                  {atLeast(currentStep, "RIDGE_VENT") && ridges.map((l) => (
                    <RidgeVentStroke key={`rv-${r.id}-${l.id}`} points={l.points} width={r.ridgeVentW} />
                  ))}

                  {/* CAP SHINGLES */}
                  {atLeast(currentStep, "CAP_SHINGLES") && shinglesImg && ridges.map((l) => (
                    <CapBand key={`cap-${r.id}-${l.id}`} points={l.points} width={r.capW} shinglesImg={shinglesImg} patternScale={r.shingleScale} />
                  ))}

                  {/* Valley seam / W-Valley on top of shingles */}
                  {atLeast(currentStep, "SHINGLES") && valleys.map((l) =>
                    r.valleyMetalColor === "Galvanized" ? (
                      /* Galvanized open valley: subtle crease visible through shingles */
                      <Group key={`vline-${r.id}-${l.id}`}>
                        <Line points={l.points} stroke="rgba(0,0,0,0.12)"      strokeWidth={5}   lineCap="round" lineJoin="round" />
                        <Line points={l.points} stroke="rgba(220,225,230,0.28)" strokeWidth={2.5} lineCap="round" lineJoin="round" />
                        <Line points={l.points} stroke="rgba(255,255,255,0.12)" strokeWidth={1}   lineCap="round" lineJoin="round" />
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
                      <Line points={l.points} stroke="rgba(0,0,0,0.30)"      strokeWidth={5}   lineCap="round" lineJoin="round" />
                      <Line points={l.points} stroke="rgba(210,215,220,0.55)" strokeWidth={2.5} lineCap="round" lineJoin="round" />
                    </Group>
                  ))}

                  {/* Ridge fold — crease tinted to match shingle color so it blends naturally */}
                  {atLeast(currentStep, "SHINGLES") && !atLeast(currentStep, "CAP_SHINGLES") && (() => {
                    const [rr, rg, rb] = shingleRGB(active.shingleColor);
                    return ridges.map((l) => (
                      <Group key={`ridgefold-${r.id}-${l.id}`}>
                        <Line points={l.points} stroke="rgba(0,0,0,0.22)"                    strokeWidth={5}   lineCap="round" lineJoin="round" />
                        <Line points={l.points} stroke={`rgba(${rr},${rg},${rb},0.55)`}      strokeWidth={2.5} lineCap="round" lineJoin="round" />
                        <Line points={l.points} stroke={`rgba(${rr+30},${rg+30},${rb+30},0.22)`} strokeWidth={1} lineCap="round" lineJoin="round" />
                      </Group>
                    ));
                  })()}

                  {/* dormer holes reveal original photo */}
                  {photoImg && r.holes.map((holePts, idx) => (
                    <Group key={`hole-reveal-${r.id}-${idx}`} clipFunc={(ctx) => clipPolygonPath(ctx, holePts)}>
                      <KonvaImage image={photoImg} width={w} height={h} />
                    </Group>
                  ))}
                </Group>
              );
            })}

            {/* edit handles */}
            {active &&
              active.step === "TRACE" &&
              active.showEditHandles &&
              activeRoof?.closed &&
              activeRoof.outline.length >= 6 &&
              Array.from({ length: activeRoof.outline.length / 2 }).map((_, idx) => (
                <Circle
                  key={`pt-${idx}`}
                  x={activeRoof.outline[idx * 2]}
                  y={activeRoof.outline[idx * 2 + 1]}
                  radius={10}
                  fill="rgba(255,255,255,0.90)"
                  stroke="rgba(15,23,42,0.45)"
                  strokeWidth={2}
                  draggable
                  onDragMove={(e) => updateOutlinePoint(idx, e.target.x(), e.target.y())}
                />
              ))}

            {/* Auto-detect overlay — shown as amber suggestion before the user commits */}
            {autoSuggest && active?.step === "TRACE" && (
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
      </main>
    </div>
  );
}