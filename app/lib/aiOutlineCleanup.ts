/**
 * aiOutlineCleanup.ts  (v2)
 *
 * Post-processing cleanup for AI-generated roof outline polygons.
 * Runs entirely client-side (no network calls).
 *
 * Pipeline:
 *   1. Coarse RDP              — remove zig-zags (epsilon = diag × 0.013)
 *   2. Extended downward snap  — pull vertices onto the visible roof edge
 *                                (scan 15–18 % of image height, adaptive threshold)
 *   3. Peak consolidation      — merge micro-peaks that are too close horizontally
 *   4. Breakpoint straightening— fit best-fit line between sharp corners, project wobble
 *   5. Horizontal flattening   — make near-horizontal segments (±12°) exactly flat
 *   6. Final light RDP         — remove any leftover micro-wobble (epsilon = diag × 0.008)
 *   7. Auto-close              — snap start/end if within 5 % of image width
 *
 * All coordinates are in world space (natural image pixel coords).
 */

// ── Internal geometry ─────────────────────────────────────────────────────────

function rdp(pts: [number, number][], epsilon: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [x1, y1] = pts[0], [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
  let maxDist = 0, maxIdx = 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const d = len > 0
      ? Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len
      : Math.hypot(px - x1, py - y1);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    return [
      ...rdp(pts.slice(0, maxIdx + 1), epsilon).slice(0, -1),
      ...rdp(pts.slice(maxIdx), epsilon),
    ];
  }
  return [pts[0], pts[pts.length - 1]];
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++)
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return g;
}

/** Sobel vertical gradient magnitude — highlights horizontal edges. */
function sobelGy(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const tl = gray[(y - 1) * w + Math.max(0, x - 1)];
      const tc = gray[(y - 1) * w + x];
      const tr = gray[(y - 1) * w + Math.min(w - 1, x + 1)];
      const bl = gray[(y + 1) * w + Math.max(0, x - 1)];
      const bc = gray[(y + 1) * w + x];
      const br = gray[(y + 1) * w + Math.min(w - 1, x + 1)];
      out[y * w + x] = Math.abs(tl + 2 * tc + tr - bl - 2 * bc - br);
    }
  }
  return out;
}

/** Fit a best-fit line through a set of 2D points (PCA). */
function fitLine(pts: [number, number][]): { cx: number; cy: number; dx: number; dy: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dxx = x - cx, dyy = y - cy;
    sxx += dxx * dxx; sxy += dxx * dyy; syy += dyy * dyy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { cx, cy, dx: Math.cos(theta), dy: Math.sin(theta) };
}

function project(
  pt: [number, number],
  fit: { cx: number; cy: number; dx: number; dy: number },
): [number, number] {
  const t = (pt[0] - fit.cx) * fit.dx + (pt[1] - fit.cy) * fit.dy;
  return [fit.cx + t * fit.dx, fit.cy + t * fit.dy];
}

/** Blend two points: 0 = fully a, 1 = fully b. */
function blend(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Clean an AI-generated roof outline polygon.
 *
 * @param polygon   Flat [x,y,...] array in world coords (natural image pixels)
 * @param imgSrc    The photo data URL (used only for edge gradient computation)
 * @param imgNatW   Natural image width  (world coord max X)
 * @param imgNatH   Natural image height (world coord max Y)
 */
export async function cleanAiOutline(
  polygon: number[],
  imgSrc: string,
  imgNatW: number,
  imgNatH: number,
): Promise<number[]> {
  if (polygon.length < 6) return polygon;

  const diag = Math.hypot(imgNatW, imgNatH);

  // ── Step 1: Coarse RDP — remove zig-zags ──────────────────────────────────
  const raw: [number, number][] = [];
  for (let i = 0; i + 1 < polygon.length; i += 2) raw.push([polygon[i], polygon[i + 1]]);

  const rdpResult = rdp([...raw, raw[0]], diag * 0.013);
  let cur: [number, number][] = rdpResult.slice(0, -1);
  if (cur.length < 3) cur = raw;

  // ── Step 2: Build Sobel Gy map ────────────────────────────────────────────
  const MAX_PROC = 512;
  const sc = Math.min(1, MAX_PROC / imgNatW);
  const pw = Math.round(imgNatW * sc);
  const ph = Math.round(imgNatH * sc);

  let gy: Float32Array | null = null;
  try {
    gy = await new Promise<Float32Array>((resolve, reject) => {
      const img = document.createElement("img");
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = pw; cv.height = ph;
          cv.getContext("2d")!.drawImage(img, 0, 0, pw, ph);
          const gray = toGray(cv.getContext("2d")!.getImageData(0, 0, pw, ph).data, pw, ph);
          resolve(sobelGy(gray, pw, ph));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = imgSrc;
    });
  } catch { /* edge snap skipped — no gradient available */ }

  // ── Step 3: Extended downward edge snap ───────────────────────────────────
  // Scan 16% of image height downward from each vertex.
  // Use adaptive threshold: best gradient in the window (no fixed minimum).
  // Only snap if the best row is strictly below the starting row.
  const SNAP_WINDOW = Math.round(imgNatH * 0.16 * sc); // 16% of image height
  const H_SAMPLE_OFFSETS = [-4, -2, 0, 2, 4];           // ±4px horizontal window

  const snapped: [number, number][] = cur.map(([wx, wy]) => {
    if (!gy) return [wx, wy];
    const px  = Math.max(0, Math.min(pw - 1, Math.round(wx * sc)));
    const py0 = Math.max(0, Math.min(ph - 1, Math.round(wy * sc)));
    const py1 = Math.min(ph - 1, py0 + SNAP_WINDOW);

    const xs = H_SAMPLE_OFFSETS.map(d => Math.max(0, Math.min(pw - 1, px + d)));

    let bestGy = -1, bestRow = -1;
    for (let py = py0; py <= py1; py++) {
      const g = xs.reduce((s, x) => s + gy![py * pw + x], 0) / xs.length;
      if (g > bestGy) { bestGy = g; bestRow = py; }
    }
    // Only snap downward, and require at least 1px movement
    if (bestRow > py0 + 1) {
      return [wx, Math.min(imgNatH, bestRow / sc)];
    }
    return [wx, wy];
  });

  // ── Step 4: Gable peak consolidation ─────────────────────────────────────
  // A peak is a vertex that is a local Y minimum (smallest Y = highest on screen).
  // Merge pairs of peaks that are too close horizontally (< 9% of imgW).
  // Keep the more prominent (lower Y value) peak of each merged pair.
  // Run up to 3 merge passes.
  const PEAK_MERGE_DIST = imgNatW * 0.09;

  function isPeak(pts: [number, number][], i: number): boolean {
    const n = pts.length;
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    return pts[i][1] < prev[1] && pts[i][1] < next[1];
  }

  let consolidated = snapped.slice();
  for (let pass = 0; pass < 3; pass++) {
    let merged = false;
    const n = consolidated.length;
    const toRemove = new Set<number>();

    for (let i = 0; i < n; i++) {
      if (toRemove.has(i)) continue;
      if (!isPeak(consolidated, i)) continue;
      const j = (i + 1) % n;
      if (toRemove.has(j)) continue;
      if (!isPeak(consolidated, j)) continue;
      const dx = Math.abs(consolidated[i][0] - consolidated[j][0]);
      if (dx < PEAK_MERGE_DIST) {
        // Keep the vertex with lower Y (more prominent peak = higher on image)
        if (consolidated[i][1] <= consolidated[j][1]) {
          toRemove.add(j);
        } else {
          toRemove.add(i);
        }
        merged = true;
      }
    }
    consolidated = consolidated.filter((_, i) => !toRemove.has(i));
    if (!merged) break;
  }
  if (consolidated.length < 3) consolidated = snapped;

  // ── Step 5: Breakpoint-based slope straightening ──────────────────────────
  // Find vertices where consecutive segment directions change by > 35°.
  // These are "corners" (peaks, valley corners, eave corners).
  // Between consecutive corners, the intermediate vertices should lie on a straight line.
  // Project them 85% toward the best-fit line to remove slope wobble.
  const BREAKPOINT_ANGLE = (35 * Math.PI) / 180;
  const STRAIGHT_BLEND   = 0.85;

  const nn = consolidated.length;
  const breakpoints: number[] = [];

  for (let i = 0; i < nn; i++) {
    const prev = consolidated[(i - 1 + nn) % nn];
    const curr = consolidated[i];
    const next = consolidated[(i + 1) % nn];
    const ang0 = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]);
    const ang1 = Math.atan2(next[1] - curr[1], next[0] - curr[0]);
    let diff = Math.abs(ang1 - ang0);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > BREAKPOINT_ANGLE) breakpoints.push(i);
  }

  const straightened: [number, number][] = consolidated.map(p => [p[0], p[1]]);

  if (breakpoints.length >= 2) {
    const nb = breakpoints.length;
    for (let bi = 0; bi < nb; bi++) {
      const startIdx = breakpoints[bi];
      const endIdx   = breakpoints[(bi + 1) % nb];

      // Collect vertices in this run (exclusive of endpoints which are breakpoints)
      const runFull: { idx: number; pt: [number, number] }[] = [];
      let cur2 = startIdx;
      while (true) {
        runFull.push({ idx: cur2, pt: consolidated[cur2] });
        if (cur2 === endIdx) break;
        cur2 = (cur2 + 1) % nn;
        if (runFull.length > nn) break; // safety
      }

      if (runFull.length < 3) continue; // nothing to straighten between endpoints

      const fit = fitLine(runFull.map(r => r.pt));
      if (!fit) continue;

      // Project intermediate vertices (skip first and last = breakpoints)
      for (let k = 1; k < runFull.length - 1; k++) {
        const { idx, pt } = runFull[k];
        straightened[idx] = blend(pt, project(pt, fit), STRAIGHT_BLEND);
      }
    }
  }

  // ── Step 6: Horizontal segment flattening ─────────────────────────────────
  // Make near-horizontal segments (±12°) exactly flat (average Y of endpoints).
  const HORIZ_TOL_RAD = (12 * Math.PI) / 180;
  const HORIZ_BLEND   = 0.90;
  const ns = straightened.length;
  const flat: [number, number][] = straightened.map(p => [p[0], p[1]]);

  for (let i = 0; i < ns; i++) {
    const j = (i + 1) % ns;
    const [ax, ay] = flat[i], [bx, by] = flat[j];
    const ang = Math.atan2(by - ay, bx - ax);
    const normAng = Math.abs(ang % Math.PI);
    const isHoriz = normAng < HORIZ_TOL_RAD || normAng > Math.PI - HORIZ_TOL_RAD;
    if (isHoriz) {
      const avgY = (ay + by) / 2;
      flat[i] = [ax, ay * (1 - HORIZ_BLEND) + avgY * HORIZ_BLEND];
      flat[j] = [bx, by * (1 - HORIZ_BLEND) + avgY * HORIZ_BLEND];
    }
  }

  // ── Step 7: Final light RDP — remove micro-wobble ─────────────────────────
  const rdpFinal = rdp([...flat, flat[0]], diag * 0.008);
  let result: [number, number][] = rdpFinal.slice(0, -1);
  if (result.length < 3) result = flat;

  // ── Step 8: Auto-close ────────────────────────────────────────────────────
  const f0 = result[0], fl = result[result.length - 1];
  const closeDist = Math.hypot(fl[0] - f0[0], fl[1] - f0[1]);
  if (closeDist > 0.5 && closeDist < imgNatW * 0.05) {
    result = result.slice(0, -1);
  }

  return result.flatMap(([x, y]) => [x, y]);
}
