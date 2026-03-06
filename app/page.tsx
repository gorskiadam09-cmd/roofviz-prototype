"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
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
 * REQUIRED:
 * 1) Put logo at: /public/roofviz-logo.png
 * 2) npm i react-konva konva jspdf framer-motion
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

const QUICK_STEPS: Step[] = ["START", "TRACE", "SHINGLES", "EXPORT"];

const STEP_TITLE: Record<Step, string> = {
  START: "Start a project",
  TRACE: "Step 1 — Map Your Roof",
  TEAROFF: "Step 2 — Existing roof tear-off (decking exposed)",
  GUTTER_APRON: "Step 3 — Gutter apron (eaves)",
  ICE_WATER: "Step 4 — Ice & water (eaves + valleys)",
  SYNTHETIC: "Step 5 — Synthetic underlayment (field)",
  DRIP_EDGE: "Step 6 — Drip edge (rakes)",
  VALLEY_METAL: "Step 7 — Galvanized valley metal (valleys)",
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
  | "SET_PLANE";

type PhotoPerspective = "TOP_DOWN" | "OBLIQUE";
type Point2D = { x: number; y: number };
type ObliquePlane = { tl: Point2D; tr: Point2D; br: Point2D; bl: Point2D };

type Polyline = { id: string; kind: LineKind; points: number[] };

type MetalColor = "Aluminum" | "White" | "Black" | "Bronze" | "Brown" | "Gray";
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

  gutterApronW: number;
  dripEdgeW: number;
  iceWaterEaveW: number;
  iceWaterValleyW: number;
  valleyMetalW: number;
  proStartW: number;
  ridgeVentW: number;
  capW: number;

  gutterApronColor: MetalColor;
  dripEdgeColor: MetalColor;
  valleyMetalColor: MetalColor;

  shingleScale: number;
};

type PhotoProject = {
  id: string;
  name: string;
  src: string;

  step: Step;

  roofs: Roof[];
  activeRoofId: string;

  shingleColor: ShingleColor;

  showGuidesDuringInstall: boolean;
  showEditHandles: boolean;

  stageScale: number;
  stagePos: { x: number; y: number };

  photoPerspective: PhotoPerspective;
  obliquePlane: ObliquePlane | null;
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
    case "Aluminum":
      return `rgba(198,205,211,${a})`;
    case "White":
      return `rgba(245,246,248,${a})`;
    case "Black":
      return `rgba(25,25,28,${a})`;
    case "Bronze":
      return `rgba(132,97,60,${a})`;
    case "Brown":
      return `rgba(92,64,45,${a})`;
    case "Gray":
      return `rgba(120,126,134,${a})`;
  }
}

function useHtmlImage(src?: string) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const i = new window.Image();
    i.crossOrigin = "anonymous";
    i.onload = () => setImg(i);
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

    gutterApronW: 8,
    dripEdgeW: 8,
    iceWaterEaveW: 40,
    iceWaterValleyW: 20,
    valleyMetalW: 10,
    proStartW: 12,
    ridgeVentW: 12,
    capW: 8,

    gutterApronColor: "Aluminum",
    dripEdgeColor: "Aluminum",
    valleyMetalColor: "Aluminum",

    shingleScale: 0.20,
  };
}

/* ---------- Perspective warp ---------- */
function lerp2d(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function bilinearQuad(plane: ObliquePlane, u: number, v: number): Point2D {
  const top = lerp2d(plane.tl, plane.tr, u);
  const bot = lerp2d(plane.bl, plane.br, u);
  return lerp2d(top, bot, v);
}

function generateWarpedTexture(
  srcCanvas: HTMLCanvasElement,
  plane: ObliquePlane,
  outW: number,
  outH: number,
  gridN = 16
): string {
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d")!;

  const sW = srcCanvas.width;
  const sH = srcCanvas.height;

  for (let row = 0; row < gridN; row++) {
    for (let col = 0; col < gridN; col++) {
      const u0 = col / gridN, u1 = (col + 1) / gridN;
      const v0 = row / gridN, v1 = (row + 1) / gridN;

      // Source rect corners (normalized to srcCanvas)
      const sx0 = u0 * sW, sx1 = u1 * sW;
      const sy0 = v0 * sH, sy1 = v1 * sH;

      // Destination corners via bilinear mapping
      const d00 = bilinearQuad(plane, u0, v0);
      const d10 = bilinearQuad(plane, u1, v0);
      const d01 = bilinearQuad(plane, u0, v1);
      const d11 = bilinearQuad(plane, u1, v1);

      // Triangle 1: top-left triangle (d00, d10, d01)
      drawTriangle(ctx, srcCanvas, sx0, sy0, sx1, sy0, sx0, sy1, d00.x, d00.y, d10.x, d10.y, d01.x, d01.y);
      // Triangle 2: bottom-right triangle (d10, d11, d01)
      drawTriangle(ctx, srcCanvas, sx1, sy0, sx1, sy1, sx0, sy1, d10.x, d10.y, d11.x, d11.y, d01.x, d01.y);
    }
  }

  return out.toDataURL("image/png");
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  // source triangle
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  // destination triangle
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();

  // Compute affine transform: source → destination
  // [sx0, sy0, 1] → [dx0, dy0]
  // [sx1, sy1, 1] → [dx1, dy1]
  // [sx2, sy2, 1] → [dx2, dy2]
  const denom = (sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1));
  if (Math.abs(denom) < 1e-10) { ctx.restore(); return; }

  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const eVal = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;

  const c = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;

  ctx.setTransform(a, c, b, d, eVal, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/* ---------- Procedural textures ---------- */
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

function makeDeckingCanvas(w: number, h: number): HTMLCanvasElement {
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
  return c;
}

function makeDeckingTexture(w: number, h: number) {
  return makeDeckingCanvas(w, h).toDataURL("image/png");
}

function makeSyntheticCanvas(w: number, h: number): HTMLCanvasElement {
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
  return c;
}

function makeSyntheticTexture(w: number, h: number) {
  return makeSyntheticCanvas(w, h).toDataURL("image/png");
}

function makeShingleCanvas(w: number, h: number, color: ShingleColor): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1400, Math.floor(w));
  c.height = Math.max(1400, Math.floor(h));
  const ctx = c.getContext("2d")!;
  const W = c.width,
    H = c.height;

  const pal = shinglePalette(color);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.top);
  g.addColorStop(1, pal.bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const courseH = 7;
  const tabW = 10;

  for (let row = 0; row * courseH < H + courseH; row++) {
    const y = row * courseH;
    const offset = (row % 2) * (tabW / 2);

    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = "rgba(0,0,0,0.46)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + 1.2);
    ctx.lineTo(W, y + 1.2);
    ctx.stroke();

    for (let x = -tabW; x < W + tabW; x += tabW) {
      const xx = x + offset;

      ctx.globalAlpha = 0.1;
      ctx.strokeStyle = "rgba(0,0,0,0.26)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, y);
      ctx.lineTo(xx, y + courseH);
      ctx.stroke();

      if (Math.random() > 0.55) {
        ctx.globalAlpha = 0.04 + Math.random() * 0.08;
        ctx.fillStyle = "rgba(0,0,0,0.9)";
        const bw = tabW * (0.7 + Math.random() * 0.8);
        const bh = courseH * (0.35 + Math.random() * 0.75);
        ctx.fillRect(
          xx + 1 + Math.random() * 2,
          y + 1 + Math.random() * 2,
          bw,
          bh
        );
      }
    }
  }

  ctx.globalAlpha = 1;
  addNoise(ctx, W, H, 420000, 0.003, 0.06);
  vignette(ctx, W, H, 0.09);
  return c;
}

function makeShingleTexture(w: number, h: number, color: ShingleColor) {
  return makeShingleCanvas(w, h, color).toDataURL("image/png");
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

/* ------------------- Main ------------------- */
export default function Page() {
  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [w, setW] = useState(1100);
  const [h, setH] = useState(700);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setW(Math.max(420, Math.floor(r.width)));
      setH(Math.max(420, Math.floor(r.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Core state ──────────────────────────── */
  const [photos, setPhotos] = useState<PhotoProject[]>([]);
  const [activePhotoId, setActivePhotoId] = useState<string>("");

  /* ── UI state ────────────────────────────── */
  const [screen, setScreen] = useState<"MENU" | "PROJECT">("MENU");
  const [activeTab, setActiveTab] = useState<"edit" | "settings">("edit");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [manufacturer, setManufacturer] = useState("gaf");
  const [presentationMode, setPresentationMode] = useState(false);
  const [sliderX, setSliderX] = useState<number | null>(null);
  const [sliderDragging, setSliderDragging] = useState(false);
  const [workflowMode, setWorkflowMode] = useState<"quick" | "advanced">("advanced");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  /* ── Derived ─────────────────────────────── */
  const active = useMemo(
    () => photos.find((p) => p.id === activePhotoId) || null,
    [photos, activePhotoId]
  );
  const photoImg = useHtmlImage(active?.src);

  const activeRoof = useMemo(() => {
    if (!active) return null;
    return active.roofs.find((r) => r.id === active.activeRoofId) || null;
  }, [active]);

  /* ── Tool state ──────────────────────────── */
  const [tool, setTool] = useState<Tool>("NONE");
  const [draftLine, setDraftLine] = useState<Polyline | null>(null);
  const [draftHole, setDraftHole] = useState<number[] | null>(null);
  const [exportView, setExportView] = useState<ExportView>("LIVE");
  const [planeDraftCorners, setPlaneDraftCorners] = useState<Point2D[]>([]);

  /* ── Helpers ─────────────────────────────── */
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

  const hasClosedRoof = active?.roofs.some((r) => r.closed) ?? false;

  function toggleSlider() {
    if (sliderX !== null) {
      setSliderX(null);
    } else {
      setSliderX(Math.round(w / 2));
    }
    setSliderDragging(false);
  }

  function onSliderPointerDown(e: React.PointerEvent) {
    setSliderDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onSliderPointerMove(e: React.PointerEvent) {
    if (!sliderDragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setSliderX(clamp(Math.round(e.clientX - rect.left), 0, w));
  }

  function onSliderPointerUp() {
    setSliderDragging(false);
  }

  // Convert screen-space sliderX to stage (world) coordinates for Konva clipping
  const stageSliderX = sliderX !== null && active
    ? (sliderX - (active.stagePos?.x ?? 0)) / (active.stageScale ?? 1)
    : null;

  function showToast(msg: string, type: "success" | "error" = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function startProject() {
    const id = uid();
    const roof1 = defaultRoof("Roof 1");
    const item: PhotoProject = {
      id,
      name: "New Project",
      src: "",
      step: "TRACE",
      roofs: [roof1],
      activeRoofId: roof1.id,
      shingleColor: "Barkwood",
      showGuidesDuringInstall: false,
      showEditHandles: false,
      stageScale: 1,
      stagePos: { x: 0, y: 0 },
      photoPerspective: "TOP_DOWN",
      obliquePlane: null,
    };
    setPhotos((prev) => [...prev, item]);
    setActivePhotoId(id);
    setScreen("PROJECT");
  }

  function openProject(id: string) {
    setActivePhotoId(id);
    setScreen("PROJECT");
  }

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);

    list.forEach((file, idx) => {
      const fr = new FileReader();
      fr.onload = () => {
        const data = String(fr.result);

        setPhotos((prev) => {
          const next = prev.slice();
          const activeIdx = next.findIndex((p) => p.id === activePhotoId);

          if (idx === 0 && activeIdx !== -1 && !next[activeIdx].src) {
            next[activeIdx] = {
              ...next[activeIdx],
              src: data,
              name: file.name,
              step: "TRACE",
              stageScale: 1,
              stagePos: { x: 0, y: 0 },
            };
            return next;
          }

          const id = uid();
          const roof1 = defaultRoof("Roof 1");
          const item: PhotoProject = {
            id,
            name: file.name,
            src: data,
            step: "TRACE",
            roofs: [roof1],
            activeRoofId: roof1.id,
            shingleColor: "Barkwood",
            showGuidesDuringInstall: false,
            showEditHandles: false,
            stageScale: 1,
            stagePos: { x: 0, y: 0 },
            photoPerspective: "TOP_DOWN",
            obliquePlane: null,
          };
          next.unshift(item);
          return next;
        });

        if (!(idx === 0 && active && !active.src)) {
          if (!activePhotoId) {
            // noop
          }
        }
      };
      fr.readAsDataURL(file);
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

  function resetSelectedRoof() {
    if (!activeRoof || !active) return;
    patchActiveRoof((r) => ({ ...r, outline: [], closed: false, lines: [], holes: [] }));
    patchActive((p) => ({ ...p, step: "TRACE" }));
    setTool("TRACE_ROOF");
    setDraftLine(null);
    setDraftHole(null);
  }

  const activeSteps = workflowMode === "quick" ? QUICK_STEPS : STEPS;

  function canGoNext() {
    if (!active) return false;
    const curIdx = activeSteps.indexOf(active.step);
    if (curIdx === -1 || curIdx >= activeSteps.length - 1) return false;
    if (active.step === "TRACE") {
      if (!active.roofs.some((r) => r.closed)) return false;
    }
    return true;
  }

  function goNext() {
    if (!active || !canGoNext()) return;
    const curIdx = activeSteps.indexOf(active.step);
    const next = activeSteps[curIdx + 1];
    patchActive((p) => ({ ...p, step: next, showEditHandles: next === "TRACE" ? p.showEditHandles : false }));
    setTool("NONE");
    setDraftLine(null);
    setDraftHole(null);
  }

  function goBack() {
    if (!active) return;
    const curIdx = activeSteps.indexOf(active.step);
    if (curIdx <= 0) return;
    const prev = activeSteps[curIdx - 1];
    patchActive((p) => ({ ...p, step: prev }));
    setTool("NONE");
    setDraftLine(null);
    setDraftHole(null);
  }

  function switchWorkflowMode(mode: "quick" | "advanced") {
    if (!active || mode === workflowMode) return;
    setWorkflowMode(mode);
    if (mode === "quick") {
      // Snap to nearest quick step >= current
      const curFull = stepIndex(active.step);
      const nearest = QUICK_STEPS.find((s) => stepIndex(s) >= curFull) || QUICK_STEPS[QUICK_STEPS.length - 1];
      if (nearest !== active.step) {
        patchActive((p) => ({ ...p, step: nearest }));
      }
    }
  }

  async function handleCopyLink() {
    if (!active) return;
    const shareUrl = `${window.location.origin}?project=${active.id}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Link copied to clipboard!", "success");
    } catch {
      showToast("Failed to copy link", "error");
    }
  }

  async function handleSendEmail() {
    if (!active || !emailTo.trim()) return;
    setEmailSending(true);
    try {
      const shareUrl = `${window.location.origin}?project=${active.id}`;
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: emailTo.trim(), shareUrl, projectName: active.name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to send email");
      }
      showToast("Email sent successfully!", "success");
      setShowEmailDialog(false);
      setEmailTo("");
    } catch (err: any) {
      showToast(err.message || "Failed to send email", "error");
    } finally {
      setEmailSending(false);
    }
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
    const pos = stage.getPointerPosition();
    if (!pos) return;

    if (active.step === "TRACE" && tool === "TRACE_ROOF" && !activeRoof.closed) {
      const pts = activeRoof.outline;
      if (pts.length >= 6) {
        const x0 = pts[0], y0 = pts[1];
        if (dist(pos.x, pos.y, x0, y0) <= CLOSE_DIST) {
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
        if (dist(pos.x, pos.y, x0, y0) <= CLOSE_DIST) {
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

    if (tool === "SET_PLANE") {
      const newCorners = [...planeDraftCorners, { x: pos.x, y: pos.y }];
      if (newCorners.length >= 4) {
        patchActive((p) => ({
          ...p,
          obliquePlane: { tl: newCorners[0], tr: newCorners[1], br: newCorners[2], bl: newCorners[3] },
        }));
        setPlaneDraftCorners([]);
        setTool("NONE");
      } else {
        setPlaneDraftCorners(newCorners);
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

  /* ── Textures ────────────────────────────── */
  const texW = Math.floor(w * 2.4);
  const texH = Math.floor(h * 2.4);

  const deckingSrc = useMemo(() => {
    if (!active || !active.src || typeof window === "undefined") return "";
    return makeDeckingTexture(texW, texH);
  }, [active?.id, active?.src, texW, texH]);
  const deckingImg = useHtmlImage(deckingSrc);

  const syntheticSrc = useMemo(() => {
    if (!active || !active.src || typeof window === "undefined") return "";
    return makeSyntheticTexture(texW, texH);
  }, [active?.id, active?.src, texW, texH]);
  const syntheticImg = useHtmlImage(syntheticSrc);

  const shingleSrc = useMemo(() => {
    if (!active || !active.src || typeof window === "undefined") return "";
    return makeShingleTexture(texW, texH, active.shingleColor);
  }, [active?.id, active?.src, active?.shingleColor, texW, texH]);
  const shinglesImg = useHtmlImage(shingleSrc);

  /* ── Warped textures (OBLIQUE perspective) ── */
  const isOblique = active?.photoPerspective === "OBLIQUE" && !!active?.obliquePlane;

  const warpedDeckingSrc = useMemo(() => {
    if (!active?.obliquePlane || active.photoPerspective !== "OBLIQUE" || !active.src || typeof window === "undefined") return "";
    const canvas = makeDeckingCanvas(texW, texH);
    return generateWarpedTexture(canvas, active.obliquePlane, w, h);
  }, [active?.id, active?.src, active?.photoPerspective, active?.obliquePlane, texW, texH, w, h]);
  const warpedDeckingImg = useHtmlImage(warpedDeckingSrc);

  const warpedSyntheticSrc = useMemo(() => {
    if (!active?.obliquePlane || active.photoPerspective !== "OBLIQUE" || !active.src || typeof window === "undefined") return "";
    const canvas = makeSyntheticCanvas(texW, texH);
    return generateWarpedTexture(canvas, active.obliquePlane, w, h);
  }, [active?.id, active?.src, active?.photoPerspective, active?.obliquePlane, texW, texH, w, h]);
  const warpedSyntheticImg = useHtmlImage(warpedSyntheticSrc);

  const warpedShinglesSrc = useMemo(() => {
    if (!active?.obliquePlane || active.photoPerspective !== "OBLIQUE" || !active.src || typeof window === "undefined") return "";
    const canvas = makeShingleCanvas(texW, texH, active.shingleColor);
    return generateWarpedTexture(canvas, active.obliquePlane, w, h);
  }, [active?.id, active?.src, active?.photoPerspective, active?.obliquePlane, active?.shingleColor, texW, texH, w, h]);
  const warpedShinglesImg = useHtmlImage(warpedShinglesSrc);

  const metalOptions: MetalColor[] = ["Aluminum", "White", "Black", "Bronze", "Brown", "Gray"];

  const liveStep: Step = active?.step ?? "START";
  const currentStep: Step =
    exportView === "PDF_SHINGLES" ? "CAP_SHINGLES" :
    exportView === "PDF_UNDERLAY" ? "PRO_START" :
    liveStep;

  const showGuides = (active?.step === "TRACE") || !!active?.showGuidesDuringInstall;

  /* ── PDF Export ──────────────────────────── */
  async function exportPdfTwoPages() {
    if (!active || !stageRef.current) return;

    const mod: any = await import("jspdf");
    const jsPDF = mod.jsPDF || mod.default || mod;

    const projName = active.name || "Project";
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    async function snap(view: ExportView) {
      setExportView(view);
      await new Promise((r) => setTimeout(r, 120));
      return stageRef.current.toDataURL({ pixelRatio: 2 });
    }

    const img1 = await snap("PDF_SHINGLES");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(`RoofViz — ${projName}`, 36, 40);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Page 1: Finished Shingles`, 36, 60);
    pdf.addImage(img1, "PNG", 36, 80, pageW - 72, pageH - 120);

    pdf.addPage();
    const img2 = await snap("PDF_UNDERLAY");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(`RoofViz — ${projName}`, 36, 40);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Page 2: Underlayments + Metals`, 36, 60);
    pdf.addImage(img2, "PNG", 36, 80, pageW - 72, pageH - 120);

    setExportView("LIVE");
    pdf.save(`${projName.replaceAll(" ", "_")}_RoofViz.pdf`);
  }

  /* ── localStorage persistence ────────────── */
  useEffect(() => {
    if (photos.length > 0) {
      localStorage.setItem("roofviz_projects", JSON.stringify(photos));
    }
  }, [photos]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("roofviz_projects");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const migrated = parsed.map((p: any) => ({
            ...p,
            photoPerspective: p.photoPerspective ?? "TOP_DOWN",
            obliquePlane: p.obliquePlane ?? null,
          }));
          setPhotos(migrated);
          setActivePhotoId(migrated[0].id);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  /* ── JSX ─────────────────────────────────── */

  const sectionCard = "bg-white rounded-2xl border border-slate-100 shadow-sm p-3.5 rv-section-card";
  const btnSmall = "rv-btn-small px-3 py-2 rounded-xl text-xs font-bold border border-slate-200 bg-white cursor-pointer";

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* ── Top bar ─────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-2.5 bg-white border-b border-slate-100 shadow-sm shrink-0 z-20">
        <button onClick={() => setScreen("MENU")} className="rv-logo-btn shrink-0">
          <Image src="/roofviz-logo.png" alt="RoofViz" width={120} height={35} priority />
        </button>

        {screen === "PROJECT" && active && (
          <div className="flex items-center gap-2 ml-2">
            <span className="text-xs font-black text-slate-400">
              {stepIndex(liveStep) + 1}/{STEPS.length}
            </span>
            <div className="hidden sm:flex items-center gap-1 ml-1">
              {activeSteps.map((s, i) => (
                <div
                  key={s}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i <= activeSteps.indexOf(liveStep) ? "bg-orange-500" : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {screen === "PROJECT" && active && (
          <div className="hidden sm:flex items-center rounded-lg border border-slate-200 overflow-hidden ml-2">
            <button
              onClick={() => switchWorkflowMode("quick")}
              className={`px-3 py-1 text-xs font-bold cursor-pointer transition-colors ${
                workflowMode === "quick"
                  ? "bg-orange-500 text-white"
                  : "bg-white text-slate-500 hover:bg-slate-50"
              }`}
            >
              Quick
            </button>
            <button
              onClick={() => switchWorkflowMode("advanced")}
              className={`px-3 py-1 text-xs font-bold cursor-pointer transition-colors ${
                workflowMode === "advanced"
                  ? "bg-orange-500 text-white"
                  : "bg-white text-slate-500 hover:bg-slate-50"
              }`}
            >
              Advanced
            </button>
          </div>
        )}

        <div className="flex-1" />

        {screen === "PROJECT" && (
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rv-topbar-btn sm:hidden px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold cursor-pointer"
          >
            {sidebarOpen ? "Hide Panel" : "Show Panel"}
          </button>
        )}

        {screen === "PROJECT" && hasClosedRoof && exportView === "LIVE" && (
          <>
            <button
              onClick={toggleSlider}
              className={`rv-topbar-btn px-3.5 py-1.5 rounded-xl border text-xs font-bold cursor-pointer ${
                sliderX !== null
                  ? "bg-orange-50 border-orange-300 text-orange-700"
                  : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
            >
              Before/After
            </button>
            <button
              onClick={() => setPresentationMode(true)}
              className="rv-topbar-btn px-3.5 py-1.5 rounded-xl border border-slate-200 text-xs font-bold cursor-pointer bg-white hover:bg-slate-50"
            >
              Present
            </button>
          </>
        )}

        <button
          onClick={startProject}
          className="rv-btn-primary px-4 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-orange-500 to-orange-600 shadow-md cursor-pointer"
        >
          New Roof
        </button>
      </header>

      {/* ── Body ────────────────────────────────── */}
      {screen === "MENU" ? (
        /* MENU screen */
        <div className="flex-1 overflow-auto">
          {photos.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="w-16 h-16 rounded-2xl bg-orange-50 flex items-center justify-center mb-5">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
              </div>
              <h2 className="text-xl font-black text-slate-800 mb-2">No presentations yet</h2>
              <p className="text-sm text-slate-500 mb-6 max-w-xs">Upload a photo of a house and create a step-by-step roofing presentation.</p>
              <button
                onClick={startProject}
                className="rv-btn-primary px-6 py-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-orange-500 to-orange-600 shadow-lg cursor-pointer"
              >
                Start New Presentation
              </button>
            </div>
          ) : (
            /* Project grid */
            <div className="p-6">
              <h2 className="text-lg font-black text-slate-800 mb-4">Your Presentations</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {photos.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => openProject(p.id)}
                    className="rv-project-card rv-fade-in-up text-left bg-white rounded-2xl border border-slate-100 shadow-sm p-4 cursor-pointer"
                  >
                    <div className="text-sm font-black text-slate-800 truncate">{p.name || "Untitled"}</div>
                    <div className="text-xs text-slate-400 mt-1">
                      {p.roofs.length} roof{p.roofs.length !== 1 ? "s" : ""} &middot; {STEP_TITLE[p.step]}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* PROJECT screen */
        <div className="flex flex-1 overflow-hidden">
          {/* ── Sidebar ─────────────────────────── */}
          <aside
            className={`${
              sidebarOpen ? "w-[420px]" : "w-0"
            } bg-white border-r border-slate-100 overflow-y-auto overflow-x-hidden transition-all shrink-0 max-sm:absolute max-sm:inset-y-0 max-sm:left-0 max-sm:z-30 max-sm:shadow-xl`}
          >
            {/* Tab bar */}
            <div className="flex border-b border-slate-100 sticky top-0 bg-white z-10">
              <button
                onClick={() => setActiveTab("edit")}
                className={`rv-tab-btn flex-1 py-2.5 text-sm font-bold cursor-pointer ${
                  activeTab === "edit"
                    ? "text-orange-600 shadow-[inset_0_-2px_0_#ea580c]"
                    : "text-slate-400 hover:text-slate-600"
                }`}
              >
                Edit
              </button>
              <button
                onClick={() => setActiveTab("settings")}
                className={`rv-tab-btn flex-1 py-2.5 text-sm font-bold cursor-pointer ${
                  activeTab === "settings"
                    ? "text-orange-600 shadow-[inset_0_-2px_0_#ea580c]"
                    : "text-slate-400 hover:text-slate-600"
                }`}
              >
                Settings
              </button>
            </div>

            {activeTab === "edit" ? (
              /* ── Edit tab ───────────────────────── */
              <div className="p-3.5 space-y-3">
                {/* Project name */}
                {active && (
                  <div className={sectionCard}>
                    <label className="block text-xs font-bold text-slate-500 mb-1.5">Project name</label>
                    <input
                      value={active.name}
                      onChange={(e) => patchActive((p) => ({ ...p, name: e.target.value }))}
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-200 font-black text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-orange-400"
                    />
                  </div>
                )}

                {/* Upload photos */}
                {active && (
                  <div className={sectionCard}>
                    <div className="text-sm font-black mb-2">Upload photos</div>
                    <div className="rv-upload-zone border-2 border-dashed border-slate-200 rounded-xl p-4 text-center">
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          addFiles(e.target.files);
                          e.currentTarget.value = "";
                        }}
                        className="block w-full text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-orange-50 file:text-orange-600 file:cursor-pointer"
                      />
                      <div className="text-xs text-slate-400 mt-2">PNG or JPG — drag &amp; drop or click</div>
                    </div>
                  </div>
                )}

                {/* Photos list */}
                {active && photos.length > 1 && (
                  <div className={sectionCard}>
                    <div className="text-sm font-black mb-2">Photos</div>
                    <div className="space-y-1.5">
                      {photos.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setActivePhotoId(p.id)}
                          className={`${btnSmall} w-full text-left ${
                            p.id === activePhotoId
                              ? "bg-blue-50 border-blue-400 text-blue-700"
                              : ""
                          }`}
                        >
                          {p.name || "Untitled"} {!p.src ? "(no photo yet)" : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Step + navigation */}
                {active && (
                  <div className={sectionCard}>
                    <div className="text-sm font-black">{STEP_TITLE[liveStep]}</div>

                    <div className="flex gap-2 mt-3">
                      <button
                        className="rv-btn-ghost flex-1 py-2.5 px-3 rounded-xl border border-slate-200 text-sm font-bold bg-white cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={goBack}
                        disabled={!active || stepIndex(liveStep) === 0}
                      >
                        &larr; Back
                      </button>
                      <button
                        className="rv-btn-primary flex-1 py-2.5 px-3 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-orange-500 to-orange-600 shadow-md cursor-pointer"
                        onClick={goNext}
                        disabled={!active || !canGoNext()}
                      >
                        Continue &rarr;
                      </button>
                    </div>

                    {active && liveStep === "EXPORT" && (
                      <div className="mt-3 space-y-2.5">
                        {/* Material summary */}
                        <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                          <div className="text-xs font-black text-slate-600 mb-2">Material Summary</div>
                          <div className="space-y-1 text-xs text-slate-500">
                            <div className="flex items-center gap-2">
                              <div
                                className="w-4 h-4 rounded border border-slate-200"
                                style={{ background: `linear-gradient(to bottom, ${shinglePalette(active.shingleColor).top}, ${shinglePalette(active.shingleColor).bot})` }}
                              />
                              <span className="font-bold">{active.shingleColor}</span>
                            </div>
                            <div>{active.roofs.filter((r) => r.closed).length} roof{active.roofs.filter((r) => r.closed).length !== 1 ? "s" : ""}</div>
                            {(() => {
                              const allLines = active.roofs.flatMap((r) => r.lines);
                              const counts: Record<string, number> = {};
                              allLines.forEach((l) => { counts[l.kind] = (counts[l.kind] || 0) + 1; });
                              return Object.entries(counts).map(([k, n]) => (
                                <div key={k}>{n} {k.toLowerCase()}{n !== 1 ? "s" : ""}</div>
                              ));
                            })()}
                            {active.roofs[0] && (
                              <div className="text-[10px] text-slate-400 mt-1">
                                Metal: {active.roofs[0].gutterApronColor} apron, {active.roofs[0].dripEdgeColor} drip, {active.roofs[0].valleyMetalColor} valley
                              </div>
                            )}
                          </div>
                        </div>

                        <button
                          className="rv-btn-green w-full py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-green-500 to-green-600 shadow-md cursor-pointer"
                          onClick={exportPdfTwoPages}
                        >
                          Export 2-Page PDF
                        </button>
                        <button
                          className="rv-btn-ghost w-full py-2.5 rounded-xl text-sm font-bold border border-slate-200 bg-white cursor-pointer"
                          onClick={handleCopyLink}
                        >
                          Copy Customer Link
                        </button>
                        <button
                          className="rv-btn-ghost w-full py-2.5 rounded-xl text-sm font-bold border border-slate-200 bg-white cursor-pointer"
                          onClick={() => setShowEmailDialog(true)}
                        >
                          Send Customer Link
                        </button>
                        <div className="text-xs text-slate-400">
                          Page 1: Finished shingles &middot; Page 2: Underlayments + metals
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Photo Type */}
                {active && active.src && (
                  <div className={`${sectionCard} ${!active.photoPerspective ? "ring-2 ring-orange-400" : ""}`}>
                    <div className="text-sm font-black mb-1">Photo Type</div>
                    <div className="text-xs text-slate-400 mb-3">Select how this photo was taken. Textures will render accordingly.</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => patchActive((p) => ({ ...p, photoPerspective: "TOP_DOWN", obliquePlane: null }))}
                        className={`py-3 px-2 rounded-xl text-xs font-bold cursor-pointer transition-all border-2 text-center ${
                          active.photoPerspective === "TOP_DOWN"
                            ? "bg-blue-50 border-blue-500 text-blue-700 shadow-md"
                            : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                        }`}
                      >
                        <div className="text-2xl mb-1">&#x1F6F0;&#xFE0F;</div>
                        <div className="font-black text-sm">On the Roof</div>
                        <div className="text-[10px] font-normal mt-1 opacity-70 leading-tight">Satellite, drone, or<br/>standing on the roof</div>
                      </button>
                      <button
                        onClick={() => patchActive((p) => ({ ...p, photoPerspective: "OBLIQUE" }))}
                        className={`py-3 px-2 rounded-xl text-xs font-bold cursor-pointer transition-all border-2 text-center ${
                          active.photoPerspective === "OBLIQUE"
                            ? "bg-blue-50 border-blue-500 text-blue-700 shadow-md"
                            : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                        }`}
                      >
                        <div className="text-2xl mb-1">&#x1F4F7;</div>
                        <div className="font-black text-sm">From the Ground</div>
                        <div className="text-[10px] font-normal mt-1 opacity-70 leading-tight">Standing on the ground<br/>looking up at the roof</div>
                      </button>
                    </div>

                    {active.photoPerspective === "OBLIQUE" && (
                      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                        <div className="text-xs text-slate-500 font-bold">Perspective Plane</div>
                        <div className="text-xs text-slate-400">
                          Define 4 corners on the roof so shingles and underlayments match the camera angle.
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="rv-btn-primary flex-1 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-purple-500 to-purple-600 cursor-pointer"
                            onClick={() => { setTool("SET_PLANE"); setPlaneDraftCorners([]); }}
                          >
                            Set Corners
                          </button>
                          <button
                            className={`${btnSmall} flex-1`}
                            onClick={() => patchActive((p) => ({ ...p, obliquePlane: null }))}
                          >
                            Clear
                          </button>
                        </div>
                        <button
                          className={`${btnSmall} w-full`}
                          onClick={() => {
                            if (!activeRoof?.closed || activeRoof.outline.length < 6) return;
                            const pts = activeRoof.outline;
                            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                            for (let i = 0; i < pts.length; i += 2) {
                              if (pts[i] < minX) minX = pts[i];
                              if (pts[i] > maxX) maxX = pts[i];
                              if (pts[i + 1] < minY) minY = pts[i + 1];
                              if (pts[i + 1] > maxY) maxY = pts[i + 1];
                            }
                            patchActive((p) => ({
                              ...p,
                              obliquePlane: {
                                tl: { x: minX, y: minY },
                                tr: { x: maxX, y: minY },
                                br: { x: maxX, y: maxY },
                                bl: { x: minX, y: maxY },
                              },
                            }));
                          }}
                        >
                          Auto-Fit to Roof Outline
                        </button>

                        {tool === "SET_PLANE" && (
                          <div className="text-xs text-purple-600 font-bold bg-purple-50 border border-purple-200 rounded-lg p-2">
                            Click on the canvas to place corner: {["Top-Left", "Top-Right", "Bottom-Right", "Bottom-Left"][planeDraftCorners.length] ?? "done"} ({planeDraftCorners.length}/4)
                          </div>
                        )}

                        {!active.obliquePlane && tool !== "SET_PLANE" && (
                          <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2">
                            Set 4 corners so textures warp to match the photo angle.
                          </div>
                        )}

                        {active.obliquePlane && (
                          <div className="text-xs text-green-600 bg-green-50 border border-green-200 rounded-lg p-2">
                            Plane set. Drag the purple handles on the canvas to fine-tune.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Roofs */}
                {active && (
                  <div className={sectionCard}>
                    <div className="text-sm font-black">Roofs</div>
                    <div className="text-xs text-slate-400 mt-1">Multiple roofs in the same photo supported.</div>

                    <div className="flex gap-2 flex-wrap mt-3">
                      <button
                        className="rv-btn-green px-3 py-2 rounded-xl text-xs font-bold text-green-700 bg-green-50 border border-green-200 cursor-pointer"
                        onClick={addRoof}
                      >
                        + Add Roof
                      </button>
                      <button
                        className={btnSmall}
                        onClick={() => patchActive((p) => ({ ...p, showGuidesDuringInstall: !p.showGuidesDuringInstall }))}
                      >
                        {active.showGuidesDuringInstall ? "Hide guides" : "Show guides"}
                      </button>
                      <button
                        className={btnSmall}
                        onClick={() => patchActive((p) => ({ ...p, showEditHandles: !p.showEditHandles }))}
                      >
                        {active.showEditHandles ? "Hide handles" : "Edit handles"}
                      </button>
                    </div>

                    {/* Roof list */}
                    <div className="flex gap-2 flex-wrap mt-3">
                      {active.roofs.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => patchActive((p) => ({ ...p, activeRoofId: r.id }))}
                          className={`${btnSmall} ${
                            r.id === active.activeRoofId
                              ? "bg-blue-50 border-blue-400 text-blue-700"
                              : ""
                          }`}
                        >
                          {r.name} {r.closed ? "\u2713" : ""}
                        </button>
                      ))}
                    </div>

                    {/* Drawing tools — TRACE step only */}
                    {activeRoof && liveStep === "TRACE" && (
                      <div className="mt-3 space-y-2">
                        {!activeRoof.closed ? (
                          <>
                            <button
                              className="rv-btn-primary w-full py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 shadow-md cursor-pointer"
                              onClick={() => { setTool("TRACE_ROOF"); setDraftLine(null); setDraftHole(null); }}
                            >
                              Start Tracing Roof Edge
                            </button>
                            <button
                              className={`${btnSmall} w-full`}
                              onClick={undoOutlinePoint}
                              disabled={activeRoof.outline.length < 2}
                            >
                              Undo last point
                            </button>
                            <div className="text-xs text-slate-400">Tap the first dot to close the roof.</div>
                          </>
                        ) : (
                          <>
                            <div className="text-xs font-black text-slate-700 mt-1">Draw lines + exclusions</div>

                            <div className="grid gap-1.5">
                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={() => beginDraw("EAVE")}>Draw EAVES</button>
                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={() => beginDraw("RAKE")}>Draw RAKES</button>
                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={() => beginDraw("VALLEY")}>Draw VALLEYS</button>
                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={() => beginDraw("RIDGE")}>Draw RIDGES</button>
                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={() => beginDraw("HIP")}>Draw HIPS</button>

                              <div className="h-1" />

                              <button className="rv-btn-primary py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-blue-600 cursor-pointer" onClick={beginHole}>Draw Dormer / Exclusion (hole)</button>

                              {tool === "TRACE_HOLE" ? (
                                <div className="flex gap-2">
                                  <button className={`${btnSmall} flex-1`} onClick={finishHole} disabled={!draftHole || draftHole.length < 6}>Finish hole</button>
                                  <button className={`${btnSmall} flex-1`} onClick={undoHolePoint} disabled={!draftHole || draftHole.length < 2}>Undo point</button>
                                </div>
                              ) : (
                                <div className="flex gap-2">
                                  <button className={`${btnSmall} flex-1`} onClick={finishDraftLine} disabled={!draftLine || draftLine.points.length < 4}>Finish line</button>
                                  <button className={`${btnSmall} flex-1`} onClick={undoDraftPoint} disabled={!draftLine || draftLine.points.length < 2}>Undo point</button>
                                </div>
                              )}

                              <button className={`${btnSmall} w-full`} onClick={() => { setTool("NONE"); setDraftLine(null); setDraftHole(null); }}>Stop tool</button>
                              <button className={`${btnSmall} w-full`} onClick={resetSelectedRoof}>Reset selected roof</button>

                              <div className="text-xs text-slate-400 mt-1">
                                Tip: dormers/exclusions: tap around the dormer, then tap the first dot to close.
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* ── Settings tab ───────────────────── */
              <div className="p-3.5 space-y-3">
                {active && activeRoof && (
                  <>
                    {/* Shingle section */}
                    <div className={sectionCard}>
                      <div className="text-sm font-black mb-3">Shingle</div>

                      <label className="block text-xs font-bold text-slate-500 mb-1">Manufacturer</label>
                      <select
                        value={manufacturer}
                        onChange={(e) => setManufacturer(e.target.value)}
                        className="w-full p-2.5 rounded-xl border border-slate-200 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                      >
                        <option value="gaf">GAF</option>
                        <option value="owens">Owens Corning</option>
                        <option value="certainteed">CertainTeed</option>
                        <option value="tamko">TAMKO</option>
                        <option value="iko">IKO</option>
                        <option value="atlas">Atlas</option>
                        <option value="malarkey">Malarkey</option>
                        <option value="pabco">PABCO</option>
                        <option value="generic">Generic</option>
                      </select>

                      <label className="block text-xs font-bold text-slate-500 mt-3 mb-1">Color</label>
                      <select
                        value={active.shingleColor}
                        onChange={(e) => patchActive((p) => ({ ...p, shingleColor: e.target.value as ShingleColor }))}
                        className="w-full p-2.5 rounded-xl border border-slate-200 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                      >
                        {(["Barkwood","Charcoal","WeatheredWood","PewterGray","OysterGray","Slate","Black"] as ShingleColor[]).map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>

                      <label className="block text-xs font-bold text-slate-500 mt-3 mb-1">
                        Scale: {activeRoof.shingleScale.toFixed(2)}
                      </label>
                      <input
                        type="range"
                        min={0.12}
                        max={0.32}
                        step={0.01}
                        value={activeRoof.shingleScale}
                        onChange={(e) => patchActiveRoof((r) => ({ ...r, shingleScale: Number(e.target.value) }))}
                        className="w-full"
                      />
                    </div>

                    {/* Metal Colors section */}
                    <div className={sectionCard}>
                      <div className="text-sm font-black mb-3">Metal Colors</div>

                      <div className="space-y-3">
                        <div>
                          <div className="text-xs font-bold text-slate-500 mb-1">Gutter Apron</div>
                          <select
                            value={activeRoof.gutterApronColor}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, gutterApronColor: e.target.value as MetalColor }))}
                            className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-orange-300"
                          >
                            {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>

                        <div>
                          <div className="text-xs font-bold text-slate-500 mb-1">Drip Edge</div>
                          <select
                            value={activeRoof.dripEdgeColor}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, dripEdgeColor: e.target.value as MetalColor }))}
                            className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-orange-300"
                          >
                            {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>

                        <div>
                          <div className="text-xs font-bold text-slate-500 mb-1">Valley Metal</div>
                          <select
                            value={activeRoof.valleyMetalColor}
                            onChange={(e) => patchActiveRoof((r) => ({ ...r, valleyMetalColor: e.target.value as MetalColor }))}
                            className="w-full p-2.5 rounded-xl border border-slate-200 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-orange-300"
                          >
                            {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Product Widths section */}
                    <div className={sectionCard}>
                      <div className="text-sm font-black mb-3">Product Widths</div>

                      <div className="space-y-2.5">
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
                          <label key={key} className="block text-xs font-bold text-slate-500">
                            {label}: {(activeRoof as any)[key]}
                            <input
                              type="range"
                              min={min}
                              max={max}
                              step={1}
                              value={(activeRoof as any)[key]}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, [key]: Number(e.target.value) } as any))}
                              className="w-full"
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                  </>
                )}
              </div>
            )}
          </aside>

          {/* ── Canvas ──────────────────────────── */}
          <main ref={containerRef} className="flex-1 bg-[#0f172a] relative overflow-hidden">
            <Stage
              ref={stageRef}
              width={w}
              height={h}
              onMouseDown={onStageDown}
              onTouchStart={onStageDown}
              onWheel={onWheel}
              draggable={!!active}
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
                {!photoImg && liveStep !== "START" && (
                  <Text
                    text="Upload a photo to begin"
                    x={0}
                    y={h / 2 - 12}
                    width={w}
                    align="center"
                    fill="rgba(255,255,255,0.68)"
                    fontSize={18}
                  />
                )}

                {photoImg && <KonvaImage image={photoImg} width={w} height={h} />}

                {/* Draft visuals */}
                {active?.step === "TRACE" && draftLine && (
                  <Line points={draftLine.points} stroke="rgba(255,255,255,0.9)" strokeWidth={3} dash={[8, 6]} lineCap="round" lineJoin="round" />
                )}
                {active?.step === "TRACE" && draftHole && draftHole.length >= 2 && (
                  <Line points={draftHole} stroke="rgba(255,255,255,0.9)" strokeWidth={3} dash={[6, 6]} lineCap="round" lineJoin="round" />
                )}

                {/* Guide lines */}
                {active && showGuides && active.roofs.flatMap((r) => {
                  const all = [...r.lines];
                  if (r.id === activeRoof?.id && draftLine && draftLine.points.length >= 4) all.push({ ...draftLine, id: "draft" });
                  return all.map((l) => (
                    <Line
                      key={`guide-${r.id}-${l.id}`}
                      points={l.points}
                      stroke={kindColor(l.kind)}
                      strokeWidth={3}
                      dash={[10, 7]}
                      lineCap="round"
                      lineJoin="round"
                      opacity={active.step === "TRACE" ? 0.95 : 0.45}
                    />
                  ));
                })}

                {/* Roof outlines */}
                {active && (active.step === "TRACE" || active.showGuidesDuringInstall) && active.roofs.map((r) =>
                  r.outline.length >= 2 ? (
                    <Line
                      key={`outline-${r.id}`}
                      points={r.outline}
                      closed={r.closed}
                      stroke={r.id === active.activeRoofId ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)"}
                      strokeWidth={r.id === active.activeRoofId ? 2.5 : 2}
                    />
                  ) : null
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

                {/* Install overlays per roof (clipped by slider when active) */}
                {active && active.roofs.map((r) => {
                  if (!r.closed || r.outline.length < 6) return null;

                  const eaves = r.lines.filter((l) => l.kind === "EAVE");
                  const rakes = r.lines.filter((l) => l.kind === "RAKE");
                  const valleys = r.lines.filter((l) => l.kind === "VALLEY");
                  const ridges = r.lines.filter((l) => l.kind === "RIDGE");
                  const hips = r.lines.filter((l) => l.kind === "HIP");

                  const roofClip = (ctx: any) => {
                    if (stageSliderX !== null) {
                      // Intersect roof outline clip with slider right-half
                      ctx.beginPath();
                      ctx.rect(stageSliderX, -10000, 20000, 20000);
                      ctx.clip();
                    }
                    clipPolygonPath(ctx, r.outline);
                  };

                  return (
                    <Group key={`install-${r.id}`} clipFunc={roofClip}>
                      {/* Tearoff (decking) */}
                      {atLeast(currentStep, "TEAROFF") && (
                        isOblique && warpedDeckingImg
                          ? <KonvaImage image={warpedDeckingImg} x={0} y={0} width={w} height={h} opacity={0.92} />
                          : deckingImg && <KonvaImage image={deckingImg} x={0} y={0} width={w} height={h} opacity={0.92} />
                      )}

                      {/* Synthetic (field) — only before shingles */}
                      {stepIndex(currentStep) >= stepIndex("SYNTHETIC") &&
                        stepIndex(currentStep) < stepIndex("SHINGLES") && (
                          isOblique && warpedSyntheticImg
                            ? <KonvaImage image={warpedSyntheticImg} x={0} y={0} width={w} height={h} opacity={0.86} />
                            : syntheticImg && <KonvaImage image={syntheticImg} x={0} y={0} width={w} height={h} opacity={0.86} />
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

                      {/* VALLEY METAL (valleys) */}
                      {atLeast(currentStep, "VALLEY_METAL") && valleys.map((l) => (
                        <ShinyMetalStroke key={`vm-${r.id}-${l.id}`} points={l.points} width={r.valleyMetalW} color={r.valleyMetalColor} opacity={0.995} />
                      ))}

                      {/* PRO-START (eaves + rakes ONLY) */}
                      {atLeast(currentStep, "PRO_START") && (
                        <>
                          {eaves.map((l) => (
                            <StarterStroke key={`ps-e-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />
                          ))}
                          {rakes.map((l) => (
                            <StarterStroke key={`ps-r-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />
                          ))}
                        </>
                      )}

                      {/* SHINGLES */}
                      {atLeast(currentStep, "SHINGLES") && (
                        isOblique && warpedShinglesImg
                          ? <>
                              <KonvaImage image={warpedShinglesImg} x={0} y={0} width={w} height={h} opacity={0.98} />
                              <Rect x={0} y={0} width={w} height={h} fill="rgba(0,0,0,0.06)" />
                            </>
                          : shinglesImg && <>
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
                              />
                              <Rect x={0} y={0} width={w} height={h} fill="rgba(0,0,0,0.06)" />
                            </>
                      )}

                      {/* RIDGE VENT */}
                      {atLeast(currentStep, "RIDGE_VENT") && ridges.map((l) => (
                        <RidgeVentStroke key={`rv-${r.id}-${l.id}`} points={l.points} width={r.ridgeVentW} />
                      ))}

                      {/* CAP SHINGLES */}
                      {atLeast(currentStep, "CAP_SHINGLES") && shinglesImg && ridges.map((l) => (
                        <CapBand key={`cap-${r.id}-${l.id}`} points={l.points} width={r.capW} shinglesImg={shinglesImg} patternScale={r.shingleScale} />
                      ))}

                      {/* keep valley line after shingles */}
                      {atLeast(currentStep, "SHINGLES") && valleys.map((l) => (
                        <Group key={`vline-${r.id}-${l.id}`}>
                          <Line points={l.points} stroke="rgba(255,255,255,0.70)" strokeWidth={2} lineCap="round" lineJoin="round" opacity={0.9} />
                          <Line points={l.points} stroke="rgba(0,0,0,0.45)" strokeWidth={1} lineCap="round" lineJoin="round" opacity={0.9} />
                        </Group>
                      ))}

                      {/* keep hip line after shingles */}
                      {atLeast(currentStep, "SHINGLES") && hips.map((l) => (
                        <Group key={`hline-${r.id}-${l.id}`}>
                          <Line points={l.points} stroke="rgba(255,255,255,0.70)" strokeWidth={2} lineCap="round" lineJoin="round" opacity={0.9} />
                          <Line points={l.points} stroke="rgba(0,0,0,0.45)" strokeWidth={1} lineCap="round" lineJoin="round" opacity={0.9} />
                        </Group>
                      ))}

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

                {/* Perspective plane corner handles */}
                {active?.obliquePlane && (
                  <>
                    {(["tl", "tr", "br", "bl"] as const).map((corner) => {
                      const pt = active.obliquePlane![corner];
                      return (
                        <React.Fragment key={`plane-${corner}`}>
                          <Circle
                            x={pt.x}
                            y={pt.y}
                            radius={8}
                            fill="rgba(147,51,234,0.85)"
                            stroke="rgba(255,255,255,0.9)"
                            strokeWidth={2}
                            draggable
                            onDragMove={(e) => {
                              const nx = e.target.x(), ny = e.target.y();
                              patchActive((p) => ({
                                ...p,
                                obliquePlane: p.obliquePlane ? { ...p.obliquePlane, [corner]: { x: nx, y: ny } } : null,
                              }));
                            }}
                          />
                          <Text
                            x={pt.x + 10}
                            y={pt.y - 6}
                            text={corner.toUpperCase()}
                            fontSize={11}
                            fontStyle="bold"
                            fill="rgba(147,51,234,0.95)"
                          />
                        </React.Fragment>
                      );
                    })}
                    {/* Connect plane corners with dashed outline */}
                    <Line
                      points={[
                        active.obliquePlane.tl.x, active.obliquePlane.tl.y,
                        active.obliquePlane.tr.x, active.obliquePlane.tr.y,
                        active.obliquePlane.br.x, active.obliquePlane.br.y,
                        active.obliquePlane.bl.x, active.obliquePlane.bl.y,
                      ]}
                      closed
                      stroke="rgba(147,51,234,0.5)"
                      strokeWidth={2}
                      dash={[6, 4]}
                    />
                  </>
                )}

                {/* Draft corners while placing plane */}
                {tool === "SET_PLANE" && planeDraftCorners.map((pt, i) => (
                  <Circle
                    key={`draft-plane-${i}`}
                    x={pt.x}
                    y={pt.y}
                    radius={7}
                    fill="rgba(147,51,234,0.7)"
                    stroke="white"
                    strokeWidth={2}
                  />
                ))}
              </Layer>
            </Stage>

            {/* Before/After slider divider */}
            {sliderX !== null && exportView === "LIVE" && (
              <div
                className="absolute top-0 bottom-0 z-10"
                style={{ left: sliderX - 16, width: 32, cursor: "ew-resize", touchAction: "none" }}
                onPointerDown={onSliderPointerDown}
                onPointerMove={onSliderPointerMove}
                onPointerUp={onSliderPointerUp}
              >
                {/* Vertical line */}
                <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white shadow-lg" style={{ transform: "translateX(-50%)" }} />
                {/* Knob */}
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center border-2 border-slate-200">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M4 3L1 7L4 11" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M10 3L13 7L10 11" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                {/* Labels */}
                <div className="absolute left-1/2 bottom-4 -translate-x-1/2 flex gap-10 text-[10px] font-bold whitespace-nowrap pointer-events-none">
                  <span className="text-white/70 -translate-x-3">Before</span>
                  <span className="text-white/70 translate-x-3">After</span>
                </div>
              </div>
            )}
          </main>
        </div>
      )}

      {/* ── Presentation Mode ──────────────────── */}
      <AnimatePresence>
        {presentationMode && active && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black flex flex-col"
          >
            {/* Canvas fills the screen */}
            <div ref={presentationMode ? containerRef : undefined} className="flex-1 relative overflow-hidden">
              <Stage
                ref={presentationMode ? stageRef : undefined}
                width={w}
                height={h}
                onWheel={onWheel}
                draggable
                scaleX={active.stageScale}
                scaleY={active.stageScale}
                x={active.stagePos.x}
                y={active.stagePos.y}
                onDragEnd={(e) => {
                  patchActive((p) => ({ ...p, stagePos: { x: e.target.x(), y: e.target.y() } }));
                }}
                style={{ touchAction: "none" }}
              >
                <Layer>
                  {photoImg && <KonvaImage image={photoImg} width={w} height={h} />}

                  {/* Reuse all roof rendering — same as main canvas */}
                  {active.roofs.map((r) => {
                    if (!r.closed || r.outline.length < 6) return null;
                    const eaves = r.lines.filter((l) => l.kind === "EAVE");
                    const rakes = r.lines.filter((l) => l.kind === "RAKE");
                    const valleys = r.lines.filter((l) => l.kind === "VALLEY");
                    const ridges = r.lines.filter((l) => l.kind === "RIDGE");
                    const hips = r.lines.filter((l) => l.kind === "HIP");

                    return (
                      <Group key={`pres-${r.id}`} clipFunc={(ctx) => clipPolygonPath(ctx, r.outline)}>
                        {atLeast(currentStep, "TEAROFF") && (
                          isOblique && warpedDeckingImg
                            ? <KonvaImage image={warpedDeckingImg} x={0} y={0} width={w} height={h} opacity={0.92} />
                            : deckingImg && <KonvaImage image={deckingImg} x={0} y={0} width={w} height={h} opacity={0.92} />
                        )}
                        {stepIndex(currentStep) >= stepIndex("SYNTHETIC") && stepIndex(currentStep) < stepIndex("SHINGLES") && (
                          isOblique && warpedSyntheticImg
                            ? <KonvaImage image={warpedSyntheticImg} x={0} y={0} width={w} height={h} opacity={0.86} />
                            : syntheticImg && <KonvaImage image={syntheticImg} x={0} y={0} width={w} height={h} opacity={0.86} />
                        )}
                        {atLeast(currentStep, "ICE_WATER") && (
                          <>
                            {eaves.map((l) => <Line key={`piwe-${r.id}-${l.id}`} points={l.points} stroke="rgba(18,23,38,0.92)" strokeWidth={r.iceWaterEaveW} lineCap="round" lineJoin="round" opacity={0.92} />)}
                            {valleys.map((l) => <Line key={`piwv-${r.id}-${l.id}`} points={l.points} stroke="rgba(18,23,38,0.92)" strokeWidth={r.iceWaterValleyW} lineCap="round" lineJoin="round" opacity={0.92} />)}
                          </>
                        )}
                        {atLeast(currentStep, "GUTTER_APRON") && eaves.map((l) => <ShinyMetalStroke key={`pa-${r.id}-${l.id}`} points={l.points} width={r.gutterApronW} color={r.gutterApronColor} />)}
                        {atLeast(currentStep, "DRIP_EDGE") && rakes.map((l) => <ShinyMetalStroke key={`pd-${r.id}-${l.id}`} points={l.points} width={r.dripEdgeW} color={r.dripEdgeColor} />)}
                        {atLeast(currentStep, "VALLEY_METAL") && valleys.map((l) => <ShinyMetalStroke key={`pvm-${r.id}-${l.id}`} points={l.points} width={r.valleyMetalW} color={r.valleyMetalColor} opacity={0.995} />)}
                        {atLeast(currentStep, "PRO_START") && (
                          <>
                            {eaves.map((l) => <StarterStroke key={`pps-e-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />)}
                            {rakes.map((l) => <StarterStroke key={`pps-r-${r.id}-${l.id}`} points={l.points} width={r.proStartW} />)}
                          </>
                        )}
                        {atLeast(currentStep, "SHINGLES") && (
                          isOblique && warpedShinglesImg
                            ? <>
                                <KonvaImage image={warpedShinglesImg} x={0} y={0} width={w} height={h} opacity={0.98} />
                                <Rect x={0} y={0} width={w} height={h} fill="rgba(0,0,0,0.06)" />
                              </>
                            : shinglesImg && <>
                                <Rect x={-5000} y={-5000} width={12000} height={12000} opacity={0.98} fillPatternImage={shinglesImg} fillPatternRepeat="repeat" fillPatternScaleX={r.shingleScale} fillPatternScaleY={r.shingleScale} />
                                <Rect x={0} y={0} width={w} height={h} fill="rgba(0,0,0,0.06)" />
                              </>
                        )}
                        {atLeast(currentStep, "RIDGE_VENT") && ridges.map((l) => <RidgeVentStroke key={`prv-${r.id}-${l.id}`} points={l.points} width={r.ridgeVentW} />)}
                        {atLeast(currentStep, "CAP_SHINGLES") && shinglesImg && ridges.map((l) => <CapBand key={`pcap-${r.id}-${l.id}`} points={l.points} width={r.capW} shinglesImg={shinglesImg} patternScale={r.shingleScale} />)}
                        {atLeast(currentStep, "SHINGLES") && valleys.map((l) => (
                          <Group key={`pvl-${r.id}-${l.id}`}>
                            <Line points={l.points} stroke="rgba(255,255,255,0.70)" strokeWidth={2} lineCap="round" lineJoin="round" opacity={0.9} />
                            <Line points={l.points} stroke="rgba(0,0,0,0.45)" strokeWidth={1} lineCap="round" lineJoin="round" opacity={0.9} />
                          </Group>
                        ))}
                        {atLeast(currentStep, "SHINGLES") && hips.map((l) => (
                          <Group key={`phl-${r.id}-${l.id}`}>
                            <Line points={l.points} stroke="rgba(255,255,255,0.70)" strokeWidth={2} lineCap="round" lineJoin="round" opacity={0.9} />
                            <Line points={l.points} stroke="rgba(0,0,0,0.45)" strokeWidth={1} lineCap="round" lineJoin="round" opacity={0.9} />
                          </Group>
                        ))}
                        {photoImg && r.holes.map((holePts, idx) => (
                          <Group key={`phr-${r.id}-${idx}`} clipFunc={(ctx) => clipPolygonPath(ctx, holePts)}>
                            <KonvaImage image={photoImg} width={w} height={h} />
                          </Group>
                        ))}
                      </Group>
                    );
                  })}
                </Layer>
              </Stage>
            </div>

            {/* Floating step title */}
            <AnimatePresence mode="wait">
              <motion.div
                key={liveStep}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="rv-float-ctrl absolute top-6 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-xl bg-black/70 backdrop-blur-sm text-white text-sm font-bold shadow-lg"
              >
                {STEP_TITLE[liveStep]}
              </motion.div>
            </AnimatePresence>

            {/* Exit button */}
            <button
              onClick={() => setPresentationMode(false)}
              className="rv-float-ctrl absolute top-5 right-5 px-4 py-2 rounded-xl bg-white/90 backdrop-blur-sm text-slate-800 text-xs font-bold shadow-lg cursor-pointer hover:bg-white"
            >
              Exit Presentation
            </button>

            {/* Navigation arrows */}
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4">
              <button
                onClick={goBack}
                disabled={stepIndex(liveStep) === 0}
                className="rv-float-ctrl px-5 py-3 rounded-xl bg-white/90 backdrop-blur-sm text-slate-800 font-bold shadow-lg cursor-pointer hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-lg"
              >
                &larr;
              </button>
              <span className="text-white/70 text-sm font-bold">
                {stepIndex(liveStep) + 1} / {STEPS.length}
              </span>
              <button
                onClick={goNext}
                disabled={!canGoNext()}
                className="rv-float-ctrl px-5 py-3 rounded-xl bg-white/90 backdrop-blur-sm text-slate-800 font-bold shadow-lg cursor-pointer hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed text-lg"
              >
                &rarr;
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Email Dialog ──────────────────────── */}
      <AnimatePresence>
        {showEmailDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => { if (!emailSending) setShowEmailDialog(false); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-black text-slate-800 mb-4">Send Customer Link</div>
              <label className="block text-xs font-bold text-slate-500 mb-1.5">Email address</label>
              <input
                type="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="customer@example.com"
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-orange-400"
                disabled={emailSending}
                autoFocus
              />
              <div className="flex gap-2 mt-4">
                <button
                  className="rv-btn-ghost flex-1 py-2.5 rounded-xl border border-slate-200 text-sm font-bold bg-white cursor-pointer"
                  onClick={() => { setShowEmailDialog(false); setEmailTo(""); }}
                  disabled={emailSending}
                >
                  Cancel
                </button>
                <button
                  className="rv-btn-primary flex-1 py-2.5 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-orange-500 to-orange-600 shadow-md cursor-pointer disabled:opacity-40"
                  onClick={handleSendEmail}
                  disabled={emailSending || !emailTo.trim()}
                >
                  {emailSending ? "Sending..." : "Send"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Toast ───────────────────────────────── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={`fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-lg text-sm font-bold z-50 ${
              toast.type === "success"
                ? "bg-green-600 text-white"
                : "bg-red-600 text-white"
            }`}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
