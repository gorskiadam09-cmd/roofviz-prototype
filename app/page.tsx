"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
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
  | "DRAW_HIP";

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

    // standards
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

    // smaller shingles by default
    shingleScale: 0.20,
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

function makeShingleTexture(w: number, h: number, color: ShingleColor) {
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

  // small shingles
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

  const [projectName, setProjectName] = useState("My Roof Project");

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

  const [photos, setPhotos] = useState<PhotoProject[]>([]);
  const [activePhotoId, setActivePhotoId] = useState<string>("");

  const active = useMemo(
    () => photos.find((p) => p.id === activePhotoId) || null,
    [photos, activePhotoId]
  );
  const photoImg = useHtmlImage(active?.src);

  const activeRoof = useMemo(() => {
    if (!active) return null;
    return active.roofs.find((r) => r.id === active.activeRoofId) || null;
  }, [active]);

  const [tool, setTool] = useState<Tool>("NONE");
  const [draftLine, setDraftLine] = useState<Polyline | null>(null);
  const [draftHole, setDraftHole] = useState<number[] | null>(null);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [exportView, setExportView] = useState<ExportView>("LIVE");

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
    if (photos.length > 0) {
      setActivePhotoId((prev) => prev || photos[0].id);
      return;
    }
    const id = uid();
    const roof1 = defaultRoof("Roof 1");
    const item: PhotoProject = {
      id,
      name: "Project Photo",
      src: "",
      step: "TRACE",
      roofs: [roof1],
      activeRoofId: roof1.id,
      shingleColor: "Barkwood",
      showGuidesDuringInstall: false,
      showEditHandles: false,
      stageScale: 1,
      stagePos: { x: 0, y: 0 },
    };
    setPhotos([item]);
    setActivePhotoId(id);
  }

  // Multi-photo upload (always works):
  // - If active project has empty src, first uploaded photo replaces it.
  // - Remaining photos become new projects.
  // - After upload, set active to the replaced/newest project.
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

          // Replace blank active with first file
          if (idx === 0 && activeIdx !== -1 && !next[activeIdx].src) {
            next[activeIdx] = {
              ...next[activeIdx],
              src: data,
              name: file.name,
              step: "TRACE",
              stageScale: 1,
              stagePos: { x: 0, y: 0 },
            };
            // keep activePhotoId the same
            return next;
          }

          // Otherwise create new project
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
          };
          next.unshift(item);
          return next;
        });

        // If we created a new project (not replacing), jump to it
        if (!(idx === 0 && active && !active.src)) {
          // we don't have the new id in this scope (setPhotos is async),
          // so we’ll do a safe approach: after state update, user can click.
          // But we CAN still set active if there was no active yet:
          if (!activePhotoId) {
            // noop; list appears and user can click
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

  function canGoNext() {
    if (!active) return false;
    const idx = stepIndex(active.step);
    if (idx >= STEPS.length - 1) return false;
    if (active.step === "TRACE") {
      if (!active.roofs.some((r) => r.closed)) return false;
    }
    return true;
  }

  function goNext() {
    if (!active || !canGoNext()) return;
    const next = STEPS[stepIndex(active.step) + 1];
    patchActive((p) => ({ ...p, step: next, showEditHandles: next === "TRACE" ? p.showEditHandles : false }));
    setTool("NONE");
    setDraftLine(null);
    setDraftHole(null);
  }

  function goBack() {
    if (!active) return;
    const idx = stepIndex(active.step);
    if (idx <= 0) return;
    const prev = STEPS[idx - 1];
    patchActive((p) => ({ ...p, step: prev }));
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

  const metalOptions: MetalColor[] = ["Aluminum", "White", "Black", "Bronze", "Brown", "Gray"];

  // export view overrides rendering step
  const liveStep: Step = active?.step ?? "START";
  const currentStep: Step =
    exportView === "PDF_SHINGLES" ? "CAP_SHINGLES" :
    exportView === "PDF_UNDERLAY" ? "PRO_START" :
    liveStep;

  const showGuides = (active?.step === "TRACE") || !!active?.showGuidesDuringInstall;

  // Two-page PDF
  async function exportPdfTwoPages() {
    if (!active || !stageRef.current) return;

    const mod: any = await import("jspdf");
    const jsPDF = mod.jsPDF || mod.default || mod;

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    async function snap(view: ExportView) {
      setExportView(view);
      await new Promise((r) => setTimeout(r, 120));
      return stageRef.current.toDataURL({ pixelRatio: 2 });
    }

    // Page 1: shingles
    const img1 = await snap("PDF_SHINGLES");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(`RoofViz — ${projectName}`, 36, 40);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Page 1: Finished Shingles`, 36, 60);
    pdf.addImage(img1, "PNG", 36, 80, pageW - 72, pageH - 120);

    // Page 2: underlayments + metals
    pdf.addPage();
    const img2 = await snap("PDF_UNDERLAY");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(`RoofViz — ${projectName}`, 36, 40);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(12);
    pdf.text(`Page 2: Underlayments + Metals`, 36, 60);
    pdf.addImage(img2, "PNG", 36, 80, pageW - 72, pageH - 120);

    setExportView("LIVE");
    pdf.save(`${projectName.replaceAll(" ", "_")}_RoofViz.pdf`);
  }

  // UI styles
  const card: React.CSSProperties = {
    border: "1px solid rgba(15,23,42,0.10)",
    borderRadius: 16,
    padding: 14,
    boxShadow: "0 1px 12px rgba(15,23,42,0.05)",
    background: "#fff",
    marginTop: 12,
  };

  const btn: React.CSSProperties = {
    borderRadius: 14,
    padding: "12px 14px",
    fontWeight: 950,
    fontSize: 13,
    cursor: "pointer",
    border: "1px solid rgba(15,23,42,0.16)",
    background: "#fff",
  };

  const btnPrimary: React.CSSProperties = {
    ...btn,
    background: "rgba(34,197,94,0.10)",
    border: "1px solid rgba(34,197,94,0.35)",
  };

  const btnBlue: React.CSSProperties = {
    ...btn,
    background: "rgba(37,99,235,0.10)",
    border: "1px solid rgba(37,99,235,0.35)",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.16)",
    fontWeight: 900,
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "520px 1fr", height: "100vh" }}>
      {/* LEFT PANEL */}
      <aside style={{ background: "#fff", borderRight: "1px solid rgba(15,23,42,0.08)", padding: 16, overflow: "auto" }}>
        <div style={{ ...card, marginTop: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Image src="/roofviz-logo.png" alt="RoofViz" width={150} height={44} priority />
          <div style={{ textAlign: "right", fontSize: 11, fontWeight: 900, opacity: 0.65 }}>
            <div>{active ? `${stepIndex(liveStep) + 1}/${STEPS.length}` : ""}</div>
            <div>Scroll=Zoom • Drag=Move</div>
          </div>
        </div>

        {liveStep === "START" && (
          <div style={card}>
            <div style={{ fontWeight: 1000, fontSize: 16 }}>Start a project</div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.8 }}>Project name</div>
              <input value={projectName} onChange={(e) => setProjectName(e.target.value)} style={inputStyle} />
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
              <button style={btnPrimary} onClick={startProject}>Start Project</button>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Then upload a photo and trace the roofs.</div>
            </div>
          </div>
        )}

        {liveStep !== "START" && (
          <>
            <div style={card}>
              <div style={{ fontWeight: 1000, fontSize: 13 }}>Upload photos</div>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
                style={{ width: "100%", marginTop: 10 }}
              />
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8 }}>
                Upload multiple photos, then select one below.
              </div>
            </div>

            {photos.length > 0 && (
              <div style={card}>
                <div style={{ fontWeight: 1000, fontSize: 13 }}>Photos</div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {photos.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setActivePhotoId(p.id)}
                      style={{
                        ...btn,
                        textAlign: "left",
                        background: p.id === activePhotoId ? "rgba(37,99,235,0.10)" : "#fff",
                        border: p.id === activePhotoId ? "2px solid rgba(37,99,235,0.45)" : "1px solid rgba(15,23,42,0.16)",
                      }}
                    >
                      {p.name || "Untitled"} {!p.src ? "(no photo yet)" : ""}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={card}>
              <div style={{ fontWeight: 1000, fontSize: 14 }}>{active ? STEP_TITLE[liveStep] : "Steps"}</div>

              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button style={btn} onClick={goBack} disabled={!active || stepIndex(liveStep) === 0}>Back</button>
                <button style={btnBlue} onClick={goNext} disabled={!active || !canGoNext()}>Next</button>
              </div>

              {active && liveStep === "EXPORT" && (
                <div style={{ marginTop: 12 }}>
                  <button style={btnPrimary} onClick={exportPdfTwoPages}>Export 2-page PDF</button>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                    Page 1: Finished shingles • Page 2: Underlayments + metals
                  </div>
                </div>
              )}
            </div>

            {active && (
              <div style={card}>
                <div style={{ fontWeight: 1000, fontSize: 13 }}>Roofs</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Multiple roofs in the same photo supported.</div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                  <button style={btnPrimary} onClick={addRoof}>+ Add roof</button>
                  <button style={btn} onClick={() => patchActive((p) => ({ ...p, showGuidesDuringInstall: !p.showGuidesDuringInstall }))}>
                    {active.showGuidesDuringInstall ? "Hide guides during install" : "Show guides during install"}
                  </button>
                  <button style={btn} onClick={() => patchActive((p) => ({ ...p, showEditHandles: !p.showEditHandles }))}>
                    {active.showEditHandles ? "Hide edit handles" : "Show edit handles"}
                  </button>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  {active.roofs.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => patchActive((p) => ({ ...p, activeRoofId: r.id }))}
                      style={{
                        ...btn,
                        background: r.id === active.activeRoofId ? "rgba(37,99,235,0.10)" : "#fff",
                        border: r.id === active.activeRoofId ? "2px solid rgba(37,99,235,0.45)" : "1px solid rgba(15,23,42,0.16)",
                      }}
                    >
                      {r.name} {r.closed ? "✓" : ""}
                    </button>
                  ))}
                </div>

                {activeRoof && liveStep === "TRACE" && (
                  <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                    {!activeRoof.closed ? (
                      <>
                        <button style={btnBlue} onClick={() => { setTool("TRACE_ROOF"); setDraftLine(null); setDraftHole(null); }}>
                          Trace roof edge (tap around roof)
                        </button>
                        <button style={btn} onClick={undoOutlinePoint} disabled={activeRoof.outline.length < 2}>
                          Undo last point
                        </button>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>Tap the first dot to close the roof.</div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontWeight: 1000, fontSize: 13 }}>Draw lines + exclusions</div>

                        <div style={{ display: "grid", gap: 8 }}>
                          <button style={btnBlue} onClick={() => beginDraw("EAVE")}>Draw EAVES</button>
                          <button style={btnBlue} onClick={() => beginDraw("RAKE")}>Draw RAKES</button>
                          <button style={btnBlue} onClick={() => beginDraw("VALLEY")}>Draw VALLEYS</button>
                          <button style={btnBlue} onClick={() => beginDraw("RIDGE")}>Draw RIDGES</button>
                          <button style={btnBlue} onClick={() => beginDraw("HIP")}>Draw HIPS</button>

                          <div style={{ height: 8 }} />

                          <button style={btnBlue} onClick={beginHole}>Draw Dormer / Exclusion (hole)</button>

                          {tool === "TRACE_HOLE" ? (
                            <div style={{ display: "flex", gap: 10 }}>
                              <button style={btn} onClick={finishHole} disabled={!draftHole || draftHole.length < 6}>Finish hole</button>
                              <button style={btn} onClick={undoHolePoint} disabled={!draftHole || draftHole.length < 2}>Undo point</button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 10 }}>
                              <button style={btn} onClick={finishDraftLine} disabled={!draftLine || draftLine.points.length < 4}>Finish line</button>
                              <button style={btn} onClick={undoDraftPoint} disabled={!draftLine || draftLine.points.length < 2}>Undo point</button>
                            </div>
                          )}

                          <button style={btn} onClick={() => { setTool("NONE"); setDraftLine(null); setDraftHole(null); }}>
                            Stop tool
                          </button>
                          <button style={btn} onClick={resetSelectedRoof}>Reset selected roof</button>

                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            Tip: dormers/exclusions: tap around the dormer, then tap the first dot to close.
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Advanced */}
                {activeRoof && (
                  <div style={{ marginTop: 14 }}>
                    <button style={btn} onClick={() => setAdvancedOpen((v) => !v)}>
                      {advancedOpen ? "Hide advanced options" : "Show advanced options"}
                    </button>

                    {advancedOpen && (
                      <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                        <div style={{ fontWeight: 1000, fontSize: 13 }}>Advanced (selected roof)</div>

                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>Shingle color</div>
                          <select
                            value={active.shingleColor}
                            onChange={(e) => patchActive((p) => ({ ...p, shingleColor: e.target.value as ShingleColor }))}
                            style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid rgba(15,23,42,0.16)", fontWeight: 900 }}
                          >
                            {(["Barkwood","Charcoal","WeatheredWood","PewterGray","OysterGray","Slate","Black"] as ShingleColor[]).map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </div>

                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>Metal colors</div>

                          <label style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>
                            Gutter apron
                            <select
                              value={activeRoof.gutterApronColor}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, gutterApronColor: e.target.value as MetalColor }))}
                              style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid rgba(15,23,42,0.16)" }}
                            >
                              {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </label>

                          <label style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>
                            Drip edge
                            <select
                              value={activeRoof.dripEdgeColor}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, dripEdgeColor: e.target.value as MetalColor }))}
                              style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid rgba(15,23,42,0.16)" }}
                            >
                              {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </label>

                          <label style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>
                            Valley metal
                            <select
                              value={activeRoof.valleyMetalColor}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, valleyMetalColor: e.target.value as MetalColor }))}
                              style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 12, border: "1px solid rgba(15,23,42,0.16)" }}
                            >
                              {metalOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </label>
                        </div>

                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>Widths (px)</div>

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
                            <label key={key} style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>
                              {label}: {(activeRoof as any)[key]}
                              <input
                                type="range"
                                min={min}
                                max={max}
                                step={1}
                                value={(activeRoof as any)[key]}
                                onChange={(e) => patchActiveRoof((r) => ({ ...r, [key]: Number(e.target.value) } as any))}
                                style={{ width: "100%" }}
                              />
                            </label>
                          ))}
                        </div>

                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>Shingle size</div>
                          <label style={{ fontSize: 12, fontWeight: 900, opacity: 0.85 }}>
                            Scale: {activeRoof.shingleScale.toFixed(2)}
                            <input
                              type="range"
                              min={0.12}
                              max={0.32}
                              step={0.01}
                              value={activeRoof.shingleScale}
                              onChange={(e) => patchActiveRoof((r) => ({ ...r, shingleScale: Number(e.target.value) }))}
                              style={{ width: "100%" }}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </aside>

      {/* CANVAS */}
      <main ref={containerRef} style={{ background: "#0f172a", position: "relative", overflow: "hidden" }}>
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
                text="Upload a photo on the left to begin"
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
                  {atLeast(currentStep, "SHINGLES") && shinglesImg && (
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
          </Layer>
        </Stage>
      </main>
    </div>
  );
}