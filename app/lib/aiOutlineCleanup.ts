/**
 * aiOutlineCleanup.ts
 *
 * Post-processing cleanup for AI-generated roof outline polygons.
 * Runs entirely client-side (no network calls).
 *
 * Pipeline:
 *   1. RDP simplification    — remove zig-zags, reduce point count ~40–60%
 *   2. Downward edge snap    — pull floating vertices onto the visible roof edge
 *                              (scans vertically for strongest Sobel-Y gradient)
 *   3. Horizontal flattening — make near-horizontal segments exactly flat
 *   4. Collinear smoothing   — project wobbling intermediate vertices onto best-fit line
 *   5. Auto-close            — snap start/end if within tolerance
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

  // ── Step 1: RDP — remove zig-zags ─────────────────────────────────────────
  const raw: [number, number][] = [];
  for (let i = 0; i + 1 < polygon.length; i += 2) raw.push([polygon[i], polygon[i + 1]]);

  // Close polygon for RDP (treat as open polyline from first→last vertex)
  const rdpResult = rdp([...raw, raw[0]], diag * 0.013);
  let cur: [number, number][] = rdpResult.slice(0, -1); // remove closing duplicate
  if (cur.length < 3) cur = raw;

  // ── Step 2: build Sobel Gy map for edge snapping ──────────────────────────
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

  // ── Step 3: downward edge snap ─────────────────────────────────────────────
  // For each vertex: scan straight down up to SNAP_MAX_PX.
  // Snap to the row with the strongest horizontal edge (|Gy|), if above threshold.
  // Only snap downward (increases Y) to avoid pulling into sky.
  const SNAP_MAX_PROC = Math.round(imgNatH * 0.06 * sc); // 6% of image height
  const SNAP_THRESH   = 11;                               // minimum |Gy|

  let snapped: [number, number][] = cur.map(([wx, wy]) => {
    if (!gy) return [wx, wy];
    const px  = Math.max(0, Math.min(pw - 1, Math.round(wx * sc)));
    const py0 = Math.max(0, Math.min(ph - 1, Math.round(wy * sc)));
    const py1 = Math.min(ph - 1, py0 + SNAP_MAX_PROC);

    // Sample across a ±3px horizontal window for robustness to slight X offset
    const xs = [-3, -1, 0, 1, 3].map(d => Math.max(0, Math.min(pw - 1, px + d)));

    let bestGy = SNAP_THRESH - 1, bestRow = -1;
    for (let py = py0; py <= py1; py++) {
      const g = xs.reduce((s, x) => s + gy![py * pw + x], 0) / xs.length;
      if (g > bestGy) { bestGy = g; bestRow = py; }
    }
    // Only snap downward
    if (bestRow > py0) {
      return [wx, Math.min(imgNatH, bestRow / sc)];
    }
    return [wx, wy];
  });

  // ── Step 4: horizontal segment flattening ─────────────────────────────────
  // For each segment that is nearly horizontal, average the Y of both endpoints.
  // This makes ridge and eave lines crisp and level.
  const HORIZ_TOL_RAD = (14 * Math.PI) / 180; // ±14°
  const BLEND = 0.88;                          // how strongly to flatten
  const n = snapped.length;
  const flat: [number, number][] = snapped.map(p => [p[0], p[1]]);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, ay] = flat[i], [bx, by] = flat[j];
    const ang = Math.atan2(by - ay, bx - ax);
    const normAng = Math.abs(ang % Math.PI);
    const isHoriz = normAng < HORIZ_TOL_RAD || normAng > Math.PI - HORIZ_TOL_RAD;
    if (isHoriz) {
      const avgY = (ay + by) / 2;
      flat[i] = [ax, ay * (1 - BLEND) + avgY * BLEND];
      flat[j] = [bx, by * (1 - BLEND) + avgY * BLEND];
    }
  }

  // ── Step 5: collinear triple smoothing ────────────────────────────────────
  // If vertex B sits between A and C on approximately the same line,
  // project B onto the A→C line to remove remaining wobble.
  const ANG_TOL_RAD = (20 * Math.PI) / 180;

  function angDiff(a: number, b: number): number {
    let d = ((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return Math.abs(d > Math.PI / 2 ? Math.PI - d : d);
  }

  const smoothed: [number, number][] = flat.map(p => [p[0], p[1]]);
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n, i1 = i, i2 = (i + 1) % n;
    const ang01 = Math.atan2(flat[i1][1] - flat[i0][1], flat[i1][0] - flat[i0][0]);
    const ang12 = Math.atan2(flat[i2][1] - flat[i1][1], flat[i2][0] - flat[i1][0]);
    if (angDiff(ang01, ang12) < ANG_TOL_RAD) {
      const fit = fitLine([flat[i0], flat[i1], flat[i2]]);
      if (fit) smoothed[i1] = blend(flat[i1], project(flat[i1], fit), 0.82);
    }
  }

  // ── Step 6: auto-close ────────────────────────────────────────────────────
  const f0 = smoothed[0], fl = smoothed[smoothed.length - 1];
  const closeDist = Math.hypot(fl[0] - f0[0], fl[1] - f0[1]);
  let result = smoothed;
  if (closeDist > 0.5 && closeDist < imgNatW * 0.05) {
    // Snap last vertex to first and drop duplicate
    result = smoothed.slice(0, -1);
  }

  return result.flatMap(([x, y]) => [x, y]);
}
