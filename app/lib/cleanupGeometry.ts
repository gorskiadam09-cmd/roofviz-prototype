/**
 * cleanupGeometry.ts
 *
 * Deterministic geometry cleanup for RoofViz drawn polylines and outlines.
 * All algorithms are purely mathematical — no external AI or services.
 *
 * Designed as a standalone module so future "auto roof detection" can import
 * and build on these primitives.
 *
 * Coordinate system: 2D canvas pixel space (same as Konva world coords).
 */

// ── Structural types (minimal subset the algorithms need) ─────────────────────

/** Mirrors the Polyline type in page.tsx (id + kind + flat point array). */
export interface CleanPolyline {
  id: string;
  kind: string;
  points: number[]; // flat [x1,y1, x2,y2, …]
}

/** Mirrors the subset of Roof used by cleanup (extra fields are spread-preserved). */
export interface CleanRoof {
  outline: number[];  // flat [x1,y1, x2,y2, …]
  closed: boolean;
  holes: number[][];  // array of flat polygon point arrays
  lines: CleanPolyline[];
}

// ── Cleanup options ───────────────────────────────────────────────────────────

export interface CleanupOptions {
  /** Endpoints within this distance (px) are merged to their cluster centroid. */
  snapRadius: number;
  /** Whether to apply least-squares line straightening to multi-point lines. */
  straighten: boolean;
  /** Blend factor: 0 = no change, 1 = fully projected onto best-fit line. */
  straightenAmount: number;
  /** Snap each segment direction to the nearest 0°, 45°, or 90° screen angle. */
  snapAngles: boolean;
  /** Close an open outline whose endpoints are within snapRadius. */
  autoClose: boolean;
  /** IDs of lines that must not be modified. */
  lockedLineIds: ReadonlySet<string>;
}

/**
 * Derive concrete CleanupOptions from a normalised 0–1 strength value.
 *   0 → conservative (small snap radius, gentle blend toward best-fit line)
 *   1 → aggressive   (large snap radius, full projection onto best-fit line)
 */
export function strengthToOptions(
  strength: number,
  snapAngles: boolean,
  lockedLineIds: ReadonlySet<string> = new Set(),
): CleanupOptions {
  const s = Math.max(0, Math.min(1, strength));
  return {
    snapRadius:      8 + s * 40,        // 8 px → 48 px
    straighten:      true,
    straightenAmount: 0.35 + s * 0.65,  // 0.35 → 1.0
    snapAngles,
    autoClose:       true,
    lockedLineIds,
  };
}

// ── Internal geometry helpers ─────────────────────────────────────────────────

function euclidean(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

// ── 1. Least-squares line straightening ──────────────────────────────────────

interface LineFit {
  cx: number; cy: number; // centroid of the input point set
  dx: number; dy: number; // unit direction vector of best-fit line
}

/**
 * Fit an infinite straight line through all points using PCA / least squares.
 * Returns null for degenerate cases (< 2 points, or all identical).
 */
function fitLine(pts: number[]): LineFit | null {
  const n = pts.length / 2;
  if (n < 2) return null;

  // Centroid
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cy += pts[i + 1]; }
  cx /= n; cy /= n;

  // Covariance matrix (symmetric 2×2)
  let Sxx = 0, Sxy = 0, Syy = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - cx, dy = pts[i + 1] - cy;
    Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy;
  }

  // Principal direction via eigenvalue formula: θ = ½ · atan2(2·Sxy, Sxx − Syy)
  const theta = 0.5 * Math.atan2(2 * Sxy, Sxx - Syy);
  return { cx, cy, dx: Math.cos(theta), dy: Math.sin(theta) };
}

/** Project every point in a flat array onto the given infinite line. */
function projectPoints(pts: number[], fit: LineFit): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i] - fit.cx, py = pts[i + 1] - fit.cy;
    const t = px * fit.dx + py * fit.dy;
    out.push(fit.cx + t * fit.dx, fit.cy + t * fit.dy);
  }
  return out;
}

/** Linear interpolation between two same-length flat point arrays. */
function blendPoints(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v * (1 - t) + b[i] * t);
}

/**
 * Fit a best-fit straight line through a polyline's points and blend
 * them toward it by `amount` (0 = no change, 1 = fully on the line).
 *
 * No-op for 2-point lines (already straight by definition).
 */
function straightenPolyline(line: CleanPolyline, amount: number): CleanPolyline {
  if (line.points.length < 6) return line; // need ≥ 3 points for wobble removal
  const fit = fitLine(line.points);
  if (!fit) return line;
  const projected = projectPoints(line.points, fit);
  return { ...line, points: blendPoints(line.points, projected, amount) };
}

// ── 2. Endpoint snapping via union-find clustering ───────────────────────────

/** Path-compressed union-find (disjoint-set) for O(α·n²) clustering. */
class UnionFind {
  private p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number {
    while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; }
    return i;
  }
  union(a: number, b: number) {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.p[b] = a;
  }
}

/**
 * Merge nearby endpoints by clustering them and replacing each cluster with
 * its centroid.
 *
 * Snap candidates:
 *   • Every outline vertex (supports outline simplification via vertex merging)
 *   • The first and last point of each non-locked polyline
 *
 * Interior points of multi-point lines are intentionally excluded so that
 * straightening results (step 1) are not disrupted.
 */
function applyEndpointSnap<T extends CleanRoof>(roof: T, opts: CleanupOptions): T {
  const r = opts.snapRadius;

  // ── Build the candidate list ───────────────────────────────────────────────
  const xs: number[] = [];
  const ys: number[] = [];

  // All outline vertices
  const nOutlineVerts = roof.outline.length / 2;
  for (let i = 0; i + 1 < roof.outline.length; i += 2) {
    xs.push(roof.outline[i]);
    ys.push(roof.outline[i + 1]);
  }

  // Start and end of each non-locked line
  const lineStartIdx: number[] = [];
  const lineEndIdx:   number[] = [];
  for (const line of roof.lines) {
    if (opts.lockedLineIds.has(line.id) || line.points.length < 4) continue;
    lineStartIdx.push(xs.length);
    xs.push(line.points[0], );
    ys.push(line.points[1]);
    lineEndIdx.push(xs.length);
    xs.push(line.points[line.points.length - 2]);
    ys.push(line.points[line.points.length - 1]);
  }

  // ── Cluster by proximity ──────────────────────────────────────────────────
  const N = xs.length;
  const uf = new UnionFind(N);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (euclidean(xs[i], ys[i], xs[j], ys[j]) <= r) uf.union(i, j);
    }
  }

  // Compute centroid for each cluster root
  const sumX = new Map<number, number>();
  const sumY = new Map<number, number>();
  const cnt  = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const root = uf.find(i);
    sumX.set(root, (sumX.get(root) ?? 0) + xs[i]);
    sumY.set(root, (sumY.get(root) ?? 0) + ys[i]);
    cnt .set(root, (cnt .get(root) ?? 0) + 1);
  }
  const centX = new Map<number, number>();
  const centY = new Map<number, number>();
  sumX.forEach((v, k) => centX.set(k, v / cnt.get(k)!));
  sumY.forEach((v, k) => centY.set(k, v / cnt.get(k)!));

  function snapped(i: number): [number, number] {
    const root = uf.find(i);
    return [centX.get(root)!, centY.get(root)!];
  }

  // ── Apply to outline ──────────────────────────────────────────────────────
  const rawOutline: number[] = [];
  for (let i = 0; i < nOutlineVerts; i++) {
    const [nx, ny] = snapped(i);
    rawOutline.push(nx, ny);
  }
  // Remove consecutive duplicate vertices (created when nearby verts merge)
  const newOutline = deduplicatePoly(rawOutline);

  // ── Apply snapped positions to line endpoints ─────────────────────────────
  let li = 0;
  const newLines = roof.lines.map((line) => {
    if (opts.lockedLineIds.has(line.id) || line.points.length < 4) return line;
    const si = lineStartIdx[li];
    const ei = lineEndIdx[li];
    li++;
    const newPts = [...line.points];
    const [sx, sy] = snapped(si);
    const [ex, ey] = snapped(ei);
    newPts[0] = sx; newPts[1] = sy;
    newPts[newPts.length - 2] = ex;
    newPts[newPts.length - 1] = ey;
    return { ...line, points: newPts };
  });

  return { ...roof, outline: newOutline, lines: newLines };
}

/** Remove consecutive near-duplicate vertices from a flat polygon array. */
function deduplicatePoly(pts: number[]): number[] {
  if (pts.length < 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (
      Math.abs(x - out[out.length - 2]) > 0.5 ||
      Math.abs(y - out[out.length - 1]) > 0.5
    ) {
      out.push(x, y);
    }
  }
  return out;
}

// ── 3. Angle snapping ─────────────────────────────────────────────────────────

const SNAP_ANGLES_RAD = [0, 45, 90, 135, 180, 225, 270, 315].map(
  (d) => (d * Math.PI) / 180,
);

/**
 * Snap each segment in a polyline to the nearest 0° / 45° / 90° / 135° axis.
 * Anchors the first point of each segment; projects the second onto the
 * snapped direction while preserving segment length.
 */
function snapLineToAngles(line: CleanPolyline): CleanPolyline {
  if (line.points.length < 4) return line;
  const pts = [...line.points];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i],     y0 = pts[i + 1];
    const x1 = pts[i + 2], y1 = pts[i + 3];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) continue;

    const raw = Math.atan2(y1 - y0, x1 - x0);
    let bestAngle = SNAP_ANGLES_RAD[0], bestDiff = Infinity;
    for (const a of SNAP_ANGLES_RAD) {
      const diff = Math.abs(((raw - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff < bestDiff) { bestDiff = diff; bestAngle = a; }
    }
    pts[i + 2] = x0 + Math.cos(bestAngle) * len;
    pts[i + 3] = y0 + Math.sin(bestAngle) * len;
  }
  return { ...line, points: pts };
}

// ── 4. Auto-close outline ─────────────────────────────────────────────────────

/**
 * If an open outline's last vertex is within snapRadius of its first,
 * remove the near-duplicate endpoint and mark the outline as closed.
 */
function autoCloseOutline<T extends CleanRoof>(roof: T, opts: CleanupOptions): T {
  const n = roof.outline.length;
  if (n < 6 || roof.closed) return roof;
  const x0 = roof.outline[0], y0 = roof.outline[1];
  const xL = roof.outline[n - 2], yL = roof.outline[n - 1];
  if (euclidean(x0, y0, xL, yL) <= opts.snapRadius) {
    return { ...roof, outline: roof.outline.slice(0, -2), closed: true };
  }
  return roof;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Apply all enabled cleanup operations to a roof and return the cleaned copy.
 *
 * The input is never mutated. All extra fields on the roof object and on
 * individual lines (beyond what the algorithms need) are preserved via spread.
 *
 * Operation order:
 *   1. Straighten multi-point lines   — before snapping, so endpoints are
 *                                       already on the best-fit line
 *   2. Snap nearby endpoints together — merges near-duplicate vertices
 *   3. Snap segment angles (optional) — snaps to 0°/45°/90° axes
 *   4. Auto-close outline (optional)  — closes nearly-closed polygons
 */
export function cleanupGeometry<T extends CleanRoof>(roof: T, opts: CleanupOptions): T {
  // Deep-copy the mutable parts so we never touch the original
  let r: T = {
    ...roof,
    outline: [...roof.outline],
    lines: roof.lines.map((l) => ({ ...l, points: [...l.points] })),
    holes: roof.holes.map((h) => [...h]),
  };

  // Step 1 — straighten
  if (opts.straighten && opts.straightenAmount > 0) {
    r = {
      ...r,
      lines: r.lines.map((l) =>
        opts.lockedLineIds.has(l.id) ? l : straightenPolyline(l, opts.straightenAmount),
      ),
    };
  }

  // Step 2 — endpoint snap
  r = applyEndpointSnap(r, opts);

  // Step 3 — angle snap (optional)
  if (opts.snapAngles) {
    r = {
      ...r,
      lines: r.lines.map((l) =>
        opts.lockedLineIds.has(l.id) ? l : snapLineToAngles(l),
      ),
    };
  }

  // Step 4 — auto-close
  if (opts.autoClose) {
    r = autoCloseOutline(r, opts);
  }

  return r;
}

// ── Self-contained test harness ───────────────────────────────────────────────

/**
 * Minimal regression suite.  Run from a browser console:
 *
 *   import { runCleanupTests } from '@/app/lib/cleanupGeometry';
 *   runCleanupTests();
 *
 * Or from Node / Vitest:
 *   import { runCleanupTests } from './app/lib/cleanupGeometry';
 *   runCleanupTests();
 */
export function runCleanupTests(): void {
  console.group("cleanupGeometry tests");
  let pass = 0, fail = 0;

  function check(label: string, cond: boolean, detail = "") {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else       { console.error(`  ✗ ${label} ${detail}`); fail++; }
  }

  // 1. straightenPolyline — removes wobble from a 3-point near-horizontal line
  //    Points: (0,0), (50,5), (100,0).  Centroid y = 5/3 ≈ 1.67.
  //    After full projection all three y-values equal the centroid y — wobble gone.
  {
    const w: CleanPolyline = { id: "t1", kind: "EAVE", points: [0, 0, 50, 5, 100, 0] };
    const out = straightenPolyline(w, 1.0);
    const [y0, yMid, y2] = [out.points[1], out.points[3], out.points[5]];
    // All y-values should be equal (on the best-fit horizontal line through the centroid)
    check("straighten: all y equal (wobble removed)",
          Math.abs(y0 - yMid) < 0.01 && Math.abs(yMid - y2) < 0.01,
          `y0=${y0} yMid=${yMid} y2=${y2}`);
    // x-values should be unchanged (projection onto horizontal line preserves x)
    check("straighten: start x = 0",   out.points[0] === 0);
    check("straighten: end x = 100",   out.points[4] === 100);
    // Partial blend (0.5) should move midpoint halfway toward centroid y
    const half = straightenPolyline(w, 0.5);
    const expectedMidY = 5 * 0.5 + y0 * 0.5; // halfway between original 5 and projected centroid
    check("straighten: 50% blend midpoint",
          Math.abs(half.points[3] - expectedMidY) < 0.1,
          `got ${half.points[3]}, expected ≈ ${expectedMidY}`);
  }

  // 2. fitLine — horizontal point set
  {
    const fit = fitLine([0, 0, 100, 0, 200, 0])!;
    check("fitLine: horizontal dx ≈ ±1", Math.abs(Math.abs(fit.dx) - 1) < 0.01, `dx=${fit.dx}`);
    check("fitLine: horizontal dy ≈ 0",  Math.abs(fit.dy) < 0.01,               `dy=${fit.dy}`);
  }

  // 3. applyEndpointSnap — line endpoint snaps to outline corner
  {
    const roof: CleanRoof = {
      outline: [0, 0, 100, 0, 100, 100, 0, 100],
      closed: true, holes: [],
      lines: [{ id: "l1", kind: "EAVE", points: [4, 4, 96, 4] }],
    };
    const opts = strengthToOptions(0, false);
    opts.snapRadius = 10;
    const out = applyEndpointSnap(roof, opts);
    // (4,4) and outline corner (0,0) are ~5.7 px apart → same cluster; centroid = (2,2)
    check("snap: start x ≈ 2", Math.abs(out.lines[0].points[0] - 2) < 0.5,
          `got ${out.lines[0].points[0]}`);
  }

  // 4. deduplicatePoly — removes a consecutive near-duplicate vertex
  {
    const deduped = deduplicatePoly([0, 0, 1, 0, 1, 0, 100, 100]);
    check("deduplicate: 3 verts remain", deduped.length === 6, `got ${deduped.length / 2}`);
  }

  // 5. autoCloseOutline — closes a nearly-closed polygon
  {
    const roof: CleanRoof = {
      outline: [0, 0, 100, 0, 100, 100, 4, 4],
      closed: false, holes: [], lines: [],
    };
    const opts = strengthToOptions(0.5, false);
    opts.snapRadius = 10;
    const out = autoCloseOutline(roof, opts);
    check("autoClose: closed = true",           out.closed);
    check("autoClose: duplicate vertex removed", out.outline.length === 6);
  }

  // 6. cleanupGeometry — full pipeline smoke-test, extra fields preserved
  {
    const roof = {
      outline: [0, 0, 100, 0, 100, 100, 0, 100],
      closed: true, holes: [],
      lines: [{ id: "a", kind: "EAVE", points: [0, 0, 50, 4, 100, 0] }],
      gutterApronW: 8, // extra field that must survive
    };
    const opts = strengthToOptions(0.7, false);
    const out = cleanupGeometry(roof as CleanRoof & { gutterApronW: number }, opts);
    check("pipeline: id preserved",         out.lines[0].id === "a");
    check("pipeline: extra field preserved",(out as any).gutterApronW === 8);
    check("pipeline: wobble reduced",       Math.abs(out.lines[0].points[3]) < 2,
          `mid-y=${out.lines[0].points[3]}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.groupEnd();
}
