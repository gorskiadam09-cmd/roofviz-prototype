/**
 * edgeDetection.ts  (v5 — facade-quality heuristics)
 *
 * Facade mode pipeline (street-level photos):
 *   1. Double bilateral + CLAHE + median (strong texture kill)
 *   2. autoCanny on roof region only (top roofRegionFraction%)
 *   3. findSkyBoundaryY — strongest horizontal edge in top 40% → ridge y-anchor
 *   4. CC + PCA → raw segments
 *   5. mergeSegments (collinear cluster)
 *   6. facadeOrientationFilter — drop near-verticals (windows/doors)
 *   7. contrastConsistencyFilter — drop low-contrast lines (window glass)
 *   8. extendRakeToBounds — extend diagonal slopes to roof region bounds
 *   9. facadeSelectBestLines — directional cap + relabel (ridge/eave/left-rake/right-rake)
 *  10. applyHorizonBias — confidence boost near sky boundary and eave line
 *
 * Top-down mode pipeline (aerial photos) is unchanged from v4.
 *
 * New exports (v5):
 *   findSkyBoundaryY()          — row-wise gradient scan → ridge y anchor
 *   contrastConsistencyFilter() — discard low-contrast segments (window/door noise)
 *   facadeSelectBestLines()     — directional cluster cap + left/right rake relabeling
 *
 * Label types added:
 *   "rakeCandidateLeft"  — diagonal slope on the left side of the roof
 *   "rakeCandidateRight" — diagonal slope on the right side of the roof
 *
 * Coordinate contract: photo at (0,0) size imgW×imgH in Konva world space.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EdgeSegment {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;   // principal angle [0, PI)
  length: number;  // pixels in world space
}

export type DetectedLineLabel =
  | "eaveCandidate"
  | "ridgeCandidate"
  | "valleyCandidate"
  | "rakeCandidate"
  | "rakeCandidateLeft"
  | "rakeCandidateRight"
  | "unknown";

export interface LabeledSegment extends EdgeSegment {
  label: DetectedLineLabel;
  confidence: number; // 0–1
  source: "auto-detect";
}

export interface DetectEdgesOptions {
  /** 0–1: auto-Canny sensitivity — higher = more edges (default 0.5). */
  sensitivity?: number;
  /** 0–1: bilateral+median texture suppression strength (default 0.5). */
  detailSuppression?: number;
  /** Min segment as fraction of image width (default 0.06 = 6%). */
  minLineFraction?: number;
  /** Dominant-direction filter on (top-down only, default true). */
  dominantOnly?: boolean;
  /** How many dominant peaks to keep (default 3). */
  numDirections?: number;
  /** Tolerance around each peak in degrees (default 10). */
  directionTolDeg?: number;
  /** Processing width; image is downscaled to this (default 800). */
  maxProcessWidth?: number;

  // ── Facade mode ──────────────────────────────────────────────────────────
  /** Detection mode — auto-detected from sky heuristic if omitted. */
  mode?: "topDown" | "facade";
  /** Facade: fraction of image height to process (0.25–0.80, default 0.50). */
  roofRegionFraction?: number;
  /** Facade: discard near-vertical lines when true (default true). */
  ignoreVertical?: boolean;
  /** Max angle from horizontal for a line to be kept (default 75°). */
  maxVerticalAngleDeg?: number;
  /** Facade: boost confidence for lines near the sky/roof boundary (default true). */
  skyBoundaryBias?: boolean;
  /**
   * Facade: discard segments whose average cross-line contrast (0–1 fraction
   * of 255) is below this value.  Default 0.06 ≈ 15/255 — removes window
   * glass, thin trim, and low-contrast yard lines.
   */
  edgeContrastThreshold?: number;
  /**
   * Facade: max lines to keep per directional cluster (horizontal, left-rake,
   * right-rake).  Default 2 — produces at most 6 lines total.
   */
  perDirectionCap?: number;
}

// ── Grayscale ─────────────────────────────────────────────────────────────────

function toGrayscale(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return g;
}

// ── Auto mode detection ────────────────────────────────────────────────────────

export async function autoDetectMode(
  img: HTMLImageElement,
  imgW: number,
  imgH: number,
): Promise<"facade" | "topDown"> {
  const maxW = 160;
  const scale = Math.min(1, maxW / imgW);
  const pw = Math.round(imgW * scale);
  const ph = Math.round(imgH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = pw; canvas.height = ph;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, pw, ph);
  const data = ctx.getImageData(0, 0, pw, ph).data;
  const gray = toGrayscale(data, pw, ph);
  return skyScore(gray, pw, ph) >= 0.55 ? "facade" : "topDown";
}

function skyScore(gray: Float32Array, w: number, h: number): number {
  const topRows = Math.max(2, Math.floor(h * 0.15));
  const n = topRows * w;
  let sum = 0, sum2 = 0;
  for (let y = 0; y < topRows; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      sum += v; sum2 += v * v;
    }
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  if (mean > 150 && stddev < 35) return 1.0;
  if (mean > 130 && stddev < 45) return 0.75;
  if (mean > 110 && stddev < 55) return 0.45;
  return 0.0;
}

// ── Bilateral filter ──────────────────────────────────────────────────────────

export function bilateralFilter(
  gray: Float32Array, w: number, h: number,
  diameter = 9, sigmaColor = 75, sigmaSpace = 75,
): Float32Array {
  const r = (diameter - 1) >> 1;
  const D = diameter;
  const sigC2 = 2 * sigmaColor * sigmaColor;
  const sigS2 = 2 * sigmaSpace * sigmaSpace;
  const spatialW = new Float32Array(D * D);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      spatialW[(dy + r) * D + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / sigS2);
  const rangeW = new Float32Array(256);
  for (let d = 0; d < 256; d++) rangeW[d] = Math.exp(-(d * d) / sigC2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const centerVal = gray[y * w + x] | 0;
      let sum = 0, wSum = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = Math.max(0, Math.min(h - 1, y + dy));
        const sRow = (dy + r) * D;
        for (let dx = -r; dx <= r; dx++) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          const nVal = gray[ny * w + nx];
          const diff = Math.min(255, Math.abs(centerVal - (nVal | 0)));
          const wt = spatialW[sRow + (dx + r)] * rangeW[diff];
          sum += nVal * wt; wSum += wt;
        }
      }
      out[y * w + x] = wSum > 0 ? sum / wSum : gray[y * w + x];
    }
  }
  return out;
}

// ── CLAHE ─────────────────────────────────────────────────────────────────────

export function applyCLAHE(gray: Float32Array, w: number, h: number, clipLimit = 2.5): Float32Array {
  const TX = 8, TY = 8;
  const tw = Math.ceil(w / TX), th = Math.ceil(h / TY);
  const BINS = 256;
  const luts: Uint8Array[] = [];
  for (let ty = 0; ty < TY; ty++) {
    for (let tx = 0; tx < TX; tx++) {
      const x0 = tx * tw, x1 = Math.min(x0 + tw, w);
      const y0 = ty * th, y1 = Math.min(y0 + th, h);
      const hist = new Float32Array(BINS);
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) { hist[Math.min(255, Math.max(0, gray[y * w + x] | 0))]++; n++; }
      const clip = Math.ceil(clipLimit * n / BINS);
      let excess = 0;
      for (let i = 0; i < BINS; i++) { if (hist[i] > clip) { excess += hist[i] - clip; hist[i] = clip; } }
      const add = excess / BINS;
      for (let i = 0; i < BINS; i++) hist[i] += add;
      const lut = new Uint8Array(BINS);
      let cdf = 0, cdfMin = -1;
      for (let i = 0; i < BINS; i++) {
        cdf += hist[i];
        if (cdfMin < 0 && cdf > 0) cdfMin = cdf;
        lut[i] = Math.round(255 * (cdf - cdfMin) / Math.max(1, n - cdfMin));
      }
      luts.push(lut);
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.min(255, Math.max(0, gray[y * w + x] | 0));
      const ftx = (x + 0.5) / tw - 0.5, fty = (y + 0.5) / th - 0.5;
      const tx0 = Math.max(0, Math.min(TX - 1, Math.floor(ftx)));
      const ty0 = Math.max(0, Math.min(TY - 1, Math.floor(fty)));
      const tx1 = Math.min(TX - 1, tx0 + 1), ty1 = Math.min(TY - 1, ty0 + 1);
      const wx = Math.max(0, Math.min(1, ftx - tx0)), wy = Math.max(0, Math.min(1, fty - ty0));
      const m00 = luts[ty0*TX+tx0][v], m10 = luts[ty0*TX+tx1][v];
      const m01 = luts[ty1*TX+tx0][v], m11 = luts[ty1*TX+tx1][v];
      out[y * w + x] = m00*(1-wx)*(1-wy) + m10*wx*(1-wy) + m01*(1-wx)*wy + m11*wx*wy;
    }
  }
  return out;
}

// ── Median blur (3×3) ─────────────────────────────────────────────────────────

export function medianBlur3(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const buf = new Float32Array(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      buf[0]=gray[(y-1)*w+(x-1)]; buf[1]=gray[(y-1)*w+x]; buf[2]=gray[(y-1)*w+(x+1)];
      buf[3]=gray[y*w+(x-1)];     buf[4]=gray[y*w+x];     buf[5]=gray[y*w+(x+1)];
      buf[6]=gray[(y+1)*w+(x-1)]; buf[7]=gray[(y+1)*w+x]; buf[8]=gray[(y+1)*w+(x+1)];
      for (let i=1;i<9;i++){const k=buf[i];let j=i-1;while(j>=0&&buf[j]>k){buf[j+1]=buf[j];j--;}buf[j+1]=k;}
      out[y * w + x] = buf[4];
    }
  }
  for (let x=0;x<w;x++){out[x]=out[w+x];out[(h-1)*w+x]=out[(h-2)*w+x];}
  for (let y=0;y<h;y++){out[y*w]=out[y*w+1];out[y*w+w-1]=out[y*w+w-2];}
  return out;
}

// ── Variable-sigma Gaussian ───────────────────────────────────────────────────

export function gaussianBlurVar(g: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3), size = 2 * r + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i=0;i<size;i++){const d=i-r;k[i]=Math.exp(-(d*d)/(2*sigma*sigma));sum+=k[i];}
  for (let i=0;i<size;i++) k[i]/=sum;
  const tmp=new Float32Array(w*h), out=new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    let s=0; for (let di=-r;di<=r;di++) s+=k[di+r]*g[y*w+Math.max(0,Math.min(w-1,x+di))]; tmp[y*w+x]=s;
  }
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    let s=0; for (let dj=-r;dj<=r;dj++) s+=k[dj+r]*tmp[Math.max(0,Math.min(h-1,y+dj))*w+x]; out[y*w+x]=s;
  }
  return out;
}

// ── Preprocessing ─────────────────────────────────────────────────────────────

export function preprocessForRoofs(
  gray: Float32Array, w: number, h: number,
  suppression: number, isFacade = false,
): Float32Array {
  const suppressionAdj = isFacade ? Math.min(1, suppression + 0.15) : suppression;
  const sigColor = 30 + suppressionAdj * 70;
  const sigSpace = 30 + suppressionAdj * 45;
  let g = bilateralFilter(gray, w, h, 9, sigColor, sigSpace);
  if (isFacade) g = bilateralFilter(g, w, h, 7, sigColor * 0.7, sigSpace * 0.7);
  if (suppressionAdj > 0.15) g = applyCLAHE(g, w, h, 1.5 + suppressionAdj * 1.5);
  if (suppressionAdj > 0.25) g = medianBlur3(g, w, h);
  return g;
}

export const preprocess = preprocessForRoofs;

// ── Sky boundary detection ─────────────────────────────────────────────────────

/**
 * Find the y-coordinate of the strongest horizontal edge in the top portion
 * of the image — this is typically the sky/roof boundary (ridge anchor).
 *
 * Scans row-by-row computing average vertical gradient (|row[y+1] - row[y-1]|).
 * Returns the row index in PROCESSING coordinates.
 */
export function findSkyBoundaryY(
  preprocessed: Float32Array,
  pw: number,
  ph: number,
  roofRegionFraction: number,
): number {
  // Scan up to 40% of total image height, or 70% of roof region, whichever is smaller
  const maxRow = Math.round(Math.min(ph * 0.40, ph * roofRegionFraction * 0.70));
  const minRow = Math.max(2, Math.round(ph * 0.04)); // skip first 4% (pure sky)

  let bestRow = minRow;
  let bestStrength = -1;

  for (let y = minRow; y < maxRow; y++) {
    let rowStrength = 0;
    for (let x = 0; x < pw; x++) {
      rowStrength += Math.abs(preprocessed[(y + 1) * pw + x] - preprocessed[(y - 1) * pw + x]);
    }
    rowStrength /= pw;
    if (rowStrength > bestStrength) { bestStrength = rowStrength; bestRow = y; }
  }

  return bestRow; // processing coords
}

// ── Contrast consistency filter ────────────────────────────────────────────────

/**
 * Remove segments whose average perpendicular contrast is below `threshold`.
 *
 * For each segment, samples N evenly-spaced points along it, measures the
 * grayscale difference between pixels `normalOffsetProc` pixels to either side
 * in the perpendicular direction.
 *
 * Sky↔roof and wall↔roof edges have high contrast (30–120).
 * Window glass, thin trim, and yard lines tend to be low (5–20).
 *
 * @param segs           Segments in world coordinates
 * @param preprocessed   Grayscale at processing scale (after bilateral+CLAHE)
 * @param pw / ph        Processing dimensions
 * @param scale          processing coord = world coord × scale
 * @param threshold      Minimum average contrast (0–255)
 * @param sampleCount    Points to sample along each segment (default 9)
 * @param normalOffset   Perpendicular offset in processing pixels (default 5)
 */
export function contrastConsistencyFilter(
  segs: EdgeSegment[],
  preprocessed: Float32Array,
  pw: number, ph: number,
  scale: number,
  threshold: number,
  sampleCount = 9,
  normalOffset = 5,
): EdgeSegment[] {
  return segs.filter(seg => {
    const px1 = seg.x1 * scale, py1 = seg.y1 * scale;
    const px2 = seg.x2 * scale, py2 = seg.y2 * scale;
    const ddx = px2 - px1, ddy = py2 - py1;
    const len = Math.sqrt(ddx * ddx + ddy * ddy);
    if (len < 4) return true;
    const ux = ddx / len, uy = ddy / len;
    const nx = -uy, ny = ux; // perpendicular direction

    let totalContrast = 0, validSamples = 0;
    for (let i = 0; i < sampleCount; i++) {
      const t = (i + 0.5) / sampleCount;
      const qx = px1 + t * ddx, qy = py1 + t * ddy;
      // Sample at multiple offsets and take the max contrast seen at this point
      let pointContrast = 0, pointSamples = 0;
      for (const off of [normalOffset, normalOffset * 1.6 | 0]) {
        const ax = Math.round(qx + nx * off), ay = Math.round(qy + ny * off);
        const bx = Math.round(qx - nx * off), by = Math.round(qy - ny * off);
        if (ax < 0 || ax >= pw || ay < 0 || ay >= ph) continue;
        if (bx < 0 || bx >= pw || by < 0 || by >= ph) continue;
        pointContrast += Math.abs(preprocessed[ay * pw + ax] - preprocessed[by * pw + bx]);
        pointSamples++;
      }
      if (pointSamples > 0) { totalContrast += pointContrast / pointSamples; validSamples++; }
    }
    if (validSamples === 0) return true;
    return (totalContrast / validSamples) >= threshold;
  });
}

// ── Rake extension to roof region bounds ──────────────────────────────────────

/**
 * Extend a diagonal segment to the edges of the roof region.
 * Uses the line's midpoint and angle to compute where it crosses
 * x=0, x=imgW, y=0, y=roofBottom.
 */
function extendRakeToBounds(seg: EdgeSegment, imgW: number, roofBottom: number): EdgeSegment {
  const angDeg = (seg.angle * 180) / Math.PI;
  const normAng = angDeg > 90 ? 180 - angDeg : angDeg;
  if (normAng < 15 || normAng > 75) return seg;

  const mx = (seg.x1 + seg.x2) / 2;
  const my = (seg.y1 + seg.y2) / 2;
  const dx = Math.cos(seg.angle), dy = Math.sin(seg.angle);

  // Collect all t-values where the parametric line hits image bounds
  const candidates: number[] = [];
  if (Math.abs(dx) > 1e-6) {
    candidates.push(-mx / dx);
    candidates.push((imgW - mx) / dx);
  }
  if (Math.abs(dy) > 1e-6) {
    candidates.push(-my / dy);
    candidates.push((roofBottom - my) / dy);
    candidates.push((0 - my) / dy);
  }

  const negT = candidates.filter(t => t < -0.5);
  const posT = candidates.filter(t => t > 0.5);
  if (negT.length === 0 || posT.length === 0) return seg;

  const t1 = Math.max(...negT);
  const t2 = Math.min(...posT);

  const clampX = (v: number) => Math.max(0, Math.min(imgW, v));
  const clampY = (v: number) => Math.max(0, Math.min(roofBottom, v));

  const x1 = clampX(mx + t1 * dx), y1 = clampY(my + t1 * dy);
  const x2 = clampX(mx + t2 * dx), y2 = clampY(my + t2 * dy);
  const newLen = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

  return { ...seg, x1, y1, x2, y2, length: newLen };
}

// ── Facade directional cap + canonical relabeling ─────────────────────────────

/**
 * Cluster detected segments by direction, keep top `perDirectionCap` longest
 * per cluster, then assign precise labels.
 *
 * Clusters:
 *   horizontal  (normAng < 25°)     → ridgeCandidate or eaveCandidate
 *   rakeLeft    (25–75°, heading ↙) → rakeCandidateLeft
 *   rakeRight   (25–75°, heading ↘) → rakeCandidateRight
 *
 * The horizontal cluster produces:
 *   • The line closest to skyBoundaryY → ridgeCandidate
 *   • The line closest to roofBottom   → eaveCandidate (if distinct from ridge)
 */
export function facadeSelectBestLines(
  segs: LabeledSegment[],
  imgW: number,
  imgH: number,
  skyBoundaryY: number,
  roofRegionFraction: number,
  perDirectionCap: number,
): LabeledSegment[] {
  const roofBottom = roofRegionFraction * imgH;

  function normAng(s: EdgeSegment): number {
    const a = (s.angle * 180) / Math.PI;
    return a > 90 ? 180 - a : a;
  }

  // For a diagonal segment, determine if it slopes ↘ (right) or ↙ (left)
  // by looking at x-direction when travelling top-to-bottom (y increasing).
  function isRakeRight(s: EdgeSegment): boolean {
    let x1 = s.x1, y1 = s.y1, x2 = s.x2, y2 = s.y2;
    if (y1 > y2) { [x1, y1, x2, y2] = [x2, y2, x1, y1]; }
    return x2 >= x1;
  }

  const horizontal: LabeledSegment[] = [];
  const rakeLeft: LabeledSegment[]   = [];
  const rakeRight: LabeledSegment[]  = [];

  for (const s of segs) {
    const na = normAng(s);
    if (na < 25)         horizontal.push(s);
    else if (na <= 75)   (isRakeRight(s) ? rakeRight : rakeLeft).push(s);
    // near-vertical already filtered; skip
  }

  // Score = confidence × 0.55 + normalized-length × 0.45
  const score = (s: LabeledSegment) => s.confidence * 0.55 + (s.length / imgW) * 0.45;
  const pick  = (arr: LabeledSegment[], n: number) =>
    arr.sort((a, b) => score(b) - score(a)).slice(0, n);

  const bestHoriz = pick(horizontal, perDirectionCap * 2); // up to 2×cap: ridge + eave
  const bestLeft  = pick(rakeLeft,   perDirectionCap);
  const bestRight = pick(rakeRight,  perDirectionCap);

  // Label horizontals: closest to sky boundary → ridge; closest to roofBottom → eave
  const labeledHoriz = bestHoriz.map(s => {
    const midY = (s.y1 + s.y2) / 2;
    const toRidge = Math.abs(midY - skyBoundaryY);
    const toEave  = Math.abs(midY - roofBottom);
    const label: DetectedLineLabel = toRidge <= toEave ? "ridgeCandidate" : "eaveCandidate";
    const boost = label === "ridgeCandidate" ? 0.12 : 0.10;
    return { ...s, label, confidence: Math.min(1, s.confidence + boost) };
  });

  const labeledLeft  = bestLeft.map(s => ({ ...s, label: "rakeCandidateLeft"  as DetectedLineLabel, confidence: Math.min(1, s.confidence + 0.08) }));
  const labeledRight = bestRight.map(s => ({ ...s, label: "rakeCandidateRight" as DetectedLineLabel, confidence: Math.min(1, s.confidence + 0.08) }));

  return [...labeledHoriz, ...labeledLeft, ...labeledRight];
}

// ── Sobel + NMS + Hysteresis (internal) ───────────────────────────────────────

function sobelEdges(blur: Float32Array, w: number, h: number) {
  const mag=new Float32Array(w*h), gx=new Float32Array(w*h), gy=new Float32Array(w*h);
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++) {
    const tl=blur[(y-1)*w+(x-1)],tc=blur[(y-1)*w+x],tr=blur[(y-1)*w+(x+1)];
    const ml=blur[y*w+(x-1)],mr=blur[y*w+(x+1)];
    const bl=blur[(y+1)*w+(x-1)],bc=blur[(y+1)*w+x],br=blur[(y+1)*w+(x+1)];
    const sx=-tl-2*ml-bl+tr+2*mr+br, sy=tl+2*tc+tr-bl-2*bc-br;
    const i=y*w+x; gx[i]=sx; gy[i]=sy; mag[i]=Math.sqrt(sx*sx+sy*sy);
  }
  return { mag, gx, gy };
}

function nmsPass(mag: Float32Array, gx: Float32Array, gy: Float32Array, w: number, h: number): Float32Array {
  const out=new Float32Array(w*h);
  for (let y=1;y<h-1;y++) for (let x=1;x<w-1;x++) {
    const i=y*w+x, m=mag[i]; if(!m) continue;
    const deg=((Math.atan2(gy[i],gx[i])*180/Math.PI)+180)%180;
    let n1:number,n2:number;
    if(deg<22.5||deg>=157.5){n1=mag[i-1];n2=mag[i+1];}
    else if(deg<67.5){n1=mag[(y-1)*w+(x+1)];n2=mag[(y+1)*w+(x-1)];}
    else if(deg<112.5){n1=mag[(y-1)*w+x];n2=mag[(y+1)*w+x];}
    else{n1=mag[(y-1)*w+(x-1)];n2=mag[(y+1)*w+(x+1)];}
    if(m>=n1&&m>=n2) out[i]=m;
  }
  return out;
}

function hysteresis(nms: Float32Array, w: number, h: number, low: number, high: number): Uint8Array {
  const edges=new Uint8Array(w*h), queue:number[]=[];
  for(let i=0;i<w*h;i++){
    if(nms[i]>=high){edges[i]=255;queue.push(i);}
    else if(nms[i]>=low) edges[i]=128;
  }
  const dirs=[-w-1,-w,-w+1,-1,1,w-1,w,w+1];
  while(queue.length){
    const i=queue.pop()!;
    const cy=Math.floor(i/w),cx=i%w;
    for(const d of dirs){
      const ni=i+d,ny=Math.floor(ni/w),nx=ni%w;
      if(nx<0||nx>=w||ny<0||ny>=h) continue;
      if(edges[ni]===128){edges[ni]=255;queue.push(ni);}
    }
  }
  for(let i=0;i<w*h;i++) if(edges[i]===128) edges[i]=0;
  return edges;
}

// ── Auto-Canny ────────────────────────────────────────────────────────────────

export function autoCanny(
  preprocessed: Float32Array, w: number, h: number, sensitivity: number,
): { edgeMap: Uint8Array; lowThresh: number; highThresh: number; numEdgePixels: number } {
  const samples: number[] = [];
  for (let i = 0; i < preprocessed.length; i += 4) samples.push(preprocessed[i]);
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  const sigma = 0.10 + sensitivity * 0.45;
  const lowThresh  = Math.max(0,   Math.round((1 - sigma) * median));
  const highThresh = Math.min(255, Math.round((1 + sigma) * median));
  const { mag, gx, gy } = sobelEdges(preprocessed, w, h);
  const nmsResult = nmsPass(mag, gx, gy, w, h);
  const edgeMap = hysteresis(nmsResult, w, h, lowThresh, highThresh);
  let numEdgePixels = 0;
  for (let i = 0; i < edgeMap.length; i++) if (edgeMap[i]) numEdgePixels++;
  return { edgeMap, lowThresh, highThresh, numEdgePixels };
}

// ── Morphological close ───────────────────────────────────────────────────────

function morphDilate(em: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out=new Uint8Array(w*h);
  for(let y=r;y<h-r;y++) for(let x=r;x<w-r;x++) {
    outer:{for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++) if(em[(y+dy)*w+(x+dx)]){out[y*w+x]=255;break outer;}}
  }
  return out;
}
function morphErode(em: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out=new Uint8Array(w*h);
  for(let y=r;y<h-r;y++) for(let x=r;x<w-r;x++) {
    let all=true;
    outer:{for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++) if(!em[(y+dy)*w+(x+dx)]){all=false;break outer;}}
    out[y*w+x]=all?255:0;
  }
  return out;
}

export function postProcessEdges(edgeMap: Uint8Array, w: number, h: number, kernelRadius = 1): Uint8Array {
  return morphErode(morphDilate(edgeMap, w, h, kernelRadius), w, h, kernelRadius);
}

// ── Connected components + PCA segment fitting ────────────────────────────────

interface RawSeg { cx:number;cy:number;dx:number;dy:number;t1:number;t2:number;length:number; }

function connectedComponents(edgeMap: Uint8Array, w: number, h: number): number[][] {
  const visited=new Uint8Array(w*h), comps:number[][]=[], dirs=[-w-1,-w,-w+1,-1,1,w-1,w,w+1];
  for(let start=0;start<w*h;start++){
    if(!edgeMap[start]||visited[start]) continue;
    const comp:number[]=[], stack=[start]; visited[start]=1;
    while(stack.length){
      const i=stack.pop()!; comp.push(i);
      const cy=Math.floor(i/w),cx=i%w;
      for(const d of dirs){
        const ni=i+d,ny=Math.floor(ni/w),nx=ni%w;
        if(nx<0||nx>=w||ny<0||ny>=h) continue;
        if(edgeMap[ni]&&!visited[ni]){visited[ni]=1;stack.push(ni);}
      }
    }
    comps.push(comp);
  }
  return comps;
}

function fitRawSeg(pixels: number[], w: number): RawSeg | null {
  const n=pixels.length; if(n<4) return null;
  let sx=0,sy=0;
  for(const i of pixels){sx+=i%w;sy+=Math.floor(i/w);}
  const cx=sx/n,cy=sy/n;
  let sxx=0,sxy=0,syy=0;
  for(const i of pixels){const dx=i%w-cx,dy=Math.floor(i/w)-cy;sxx+=dx*dx;sxy+=dx*dy;syy+=dy*dy;}
  const theta=0.5*Math.atan2(2*sxy,sxx-syy);
  const dx=Math.cos(theta),dy=Math.sin(theta);
  let t1=Infinity,t2=-Infinity;
  for(const i of pixels){const t=(i%w-cx)*dx+(Math.floor(i/w)-cy)*dy;if(t<t1)t1=t;if(t>t2)t2=t;}
  return {cx,cy,dx,dy,t1,t2,length:t2-t1};
}

function rawToEdge(s: RawSeg, scale: number): EdgeSegment {
  let angle=Math.atan2(s.dy,s.dx); if(angle<0) angle+=Math.PI;
  return {
    id: Math.random().toString(16).slice(2),
    x1:(s.cx+s.dx*s.t1)*scale, y1:(s.cy+s.dy*s.t1)*scale,
    x2:(s.cx+s.dx*s.t2)*scale, y2:(s.cy+s.dy*s.t2)*scale,
    angle, length:s.length*scale,
  };
}

// ── Segment merging ───────────────────────────────────────────────────────────

export function mergeSegments(segs: EdgeSegment[], angleThreshDeg=10, gapThreshPx=15, numPasses=2): EdgeSegment[] {
  let r=segs; for(let p=0;p<numPasses;p++) r=_mergePass(r,angleThreshDeg,gapThreshPx); return r;
}

function _mergePass(segs: EdgeSegment[], angleDeg: number, gap: number): EdgeSegment[] {
  if(!segs.length) return [];
  const angleRad=angleDeg*Math.PI/180, used=new Uint8Array(segs.length), out:EdgeSegment[]=[];
  for(let i=0;i<segs.length;i++){
    if(used[i]) continue;
    const a=segs[i];
    const dxi=a.x2-a.x1,dyi=a.y2-a.y1,lenA=Math.sqrt(dxi*dxi+dyi*dyi)||1;
    const ux=dxi/lenA,uy=dyi/lenA;
    const acx=(a.x1+a.x2)/2,acy=(a.y1+a.y2)/2;
    let tMin=-lenA/2,tMax=lenA/2; used[i]=1;
    for(let j=i+1;j<segs.length;j++){
      if(used[j]) continue;
      const b=segs[j];
      const dot=Math.abs(Math.cos(a.angle)*Math.cos(b.angle)+Math.sin(a.angle)*Math.sin(b.angle));
      if(dot<Math.cos(angleRad)) continue;
      const bmx=(b.x1+b.x2)/2,bmy=(b.y1+b.y2)/2;
      const perp=Math.abs(-uy*(bmx-acx)+ux*(bmy-acy));
      if(perp>gap) continue;
      const tb1=(b.x1-acx)*ux+(b.y1-acy)*uy,tb2=(b.x2-acx)*ux+(b.y2-acy)*uy;
      const bMin=Math.min(tb1,tb2),bMax=Math.max(tb1,tb2);
      if(bMax<tMin-gap||bMin>tMax+gap) continue;
      tMin=Math.min(tMin,bMin); tMax=Math.max(tMax,bMax); used[j]=1;
    }
    out.push({id:a.id,x1:acx+ux*tMin,y1:acy+uy*tMin,x2:acx+ux*tMax,y2:acy+uy*tMax,angle:a.angle,length:tMax-tMin});
  }
  return out;
}

// ── Dominant-direction filter (top-down) ──────────────────────────────────────

export function dominantDirectionFilter(segs: EdgeSegment[], numDirections: number, angleTolDeg: number): EdgeSegment[] {
  if(!segs.length||numDirections<=0) return segs;
  const BINS=180, hist=new Float32Array(BINS);
  for(const s of segs){const b=Math.min(BINS-1,Math.floor((s.angle/Math.PI)*BINS));hist[b]+=s.length;}
  const NMS=15, copy=hist.slice(), peaks:number[]=[];
  while(peaks.length<numDirections){
    let best=-1,bestV=0;
    for(let b=0;b<BINS;b++) if(copy[b]>bestV){bestV=copy[b];best=b;}
    if(best<0||bestV<1) break;
    peaks.push(best);
    for(let d=-NMS;d<=NMS;d++) copy[(best+d+BINS)%BINS]=0;
  }
  const tol=Math.round((angleTolDeg/180)*BINS);
  return segs.filter(s=>{
    const b=Math.min(BINS-1,Math.floor((s.angle/Math.PI)*BINS));
    return peaks.some(p=>Math.min(Math.abs(b-p),BINS-Math.abs(b-p))<=tol);
  });
}

// ── Facade orientation filter ─────────────────────────────────────────────────

export function facadeOrientationFilter(segs: EdgeSegment[], maxVerticalAngleDeg = 75): EdgeSegment[] {
  return segs.filter(s => {
    const angDeg = (s.angle * 180) / Math.PI;
    const normAng = angDeg > 90 ? 180 - angDeg : angDeg;
    return normAng <= maxVerticalAngleDeg;
  });
}

// ── Horizon bias ──────────────────────────────────────────────────────────────

function applyHorizonBias(
  segs: LabeledSegment[],
  imgH: number,
  roofRegionFraction: number,
  skyBoundaryY: number,  // world coords
): LabeledSegment[] {
  const eaveLine  = roofRegionFraction * imgH;
  const ridgeLine = skyBoundaryY;

  return segs.map(s => {
    const midY = (s.y1 + s.y2) / 2;
    const eaveBias  = Math.max(0, 1 - Math.abs(midY - eaveLine)  / (imgH * 0.12)) * 0.18;
    const ridgeBias = Math.max(0, 1 - Math.abs(midY - ridgeLine) / (imgH * 0.08)) * 0.14;
    const bias = Math.max(eaveBias, ridgeBias);
    return { ...s, confidence: Math.min(1, s.confidence + bias) };
  });
}

// ── Line labeling (top-down) ──────────────────────────────────────────────────

export function labelDetectedLines(
  segments: EdgeSegment[],
  imgW: number,
  imgH: number,
  mode: "topDown" | "facade" = "topDown",
  roofRegionFraction = 0.5,
): LabeledSegment[] {
  if (segments.length === 0) return [];
  if (mode === "facade") return labelFacadeLines(segments, imgW, imgH, roofRegionFraction, imgH * 0.15);

  const pts: [number, number][] = segments.flatMap(s => [[s.x1,s.y1],[s.x2,s.y2]] as [number,number][]);
  const hull = convexHull2D(pts);

  function distToHull(px: number, py: number): number {
    let min = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const [ax,ay]=hull[i],[bx,by]=hull[(i+1)%hull.length];
      const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;
      const t=len2>0?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/len2)):0;
      const d=Math.sqrt((px-ax-t*dx)**2+(py-ay-t*dy)**2);
      if(d<min) min=d;
    }
    return min;
  }

  const HULL_THRESH = Math.min(imgW, imgH) * 0.07;
  return segments.map(seg => {
    const midX=(seg.x1+seg.x2)/2, midY=(seg.y1+seg.y2)/2;
    const relX=midX/imgW, relY=midY/imgH;
    const angDeg=(seg.angle*180)/Math.PI, normAng=angDeg>90?180-angDeg:angDeg;
    const isHorizontal=normAng<22, isVertical=normAng>68, isDiagonal=!isHorizontal&&!isVertical;
    const nearHullEdge=distToHull(midX,midY)<HULL_THRESH;
    const nearImageEdge=relX<0.12||relX>0.88||relY<0.10||relY>0.90;
    const isLong=seg.length>imgW*0.12;
    let label:DetectedLineLabel="unknown", confidence=0.25;
    if(isHorizontal&&(nearImageEdge||nearHullEdge)){label="eaveCandidate";confidence=0.72;}
    else if(isHorizontal&&isLong&&relY<0.55){label="ridgeCandidate";confidence=0.50;}
    else if(isDiagonal&&!nearImageEdge&&relX>0.08&&relX<0.92){label="valleyCandidate";confidence=0.38;}
    else if((isVertical||isDiagonal)&&nearImageEdge){label="rakeCandidate";confidence=0.42;}
    return {...seg,label,confidence,source:"auto-detect" as const};
  });
}

// Initial (pre-cap) facade labeling — used before facadeSelectBestLines
function labelFacadeLines(
  segments: EdgeSegment[],
  imgW: number,
  imgH: number,
  roofRegionFraction: number,
  skyBoundaryY: number, // world coords
): LabeledSegment[] {
  const roofBottom = roofRegionFraction * imgH;

  return segments.map(seg => {
    const midX = (seg.x1 + seg.x2) / 2;
    const midY = (seg.y1 + seg.y2) / 2;
    const relX  = midX / imgW;
    const angDeg = (seg.angle * 180) / Math.PI;
    const normAng = angDeg > 90 ? 180 - angDeg : angDeg;

    const isHorizontal = normAng < 22;
    const isDiagonal   = normAng >= 22 && normAng <= 75;
    const nearSide     = relX < 0.30 || relX > 0.70;
    const nearSkyLine  = Math.abs(midY - skyBoundaryY) < imgH * 0.07;
    const nearEaveLine = Math.abs(midY - roofBottom) < imgH * 0.10;

    let label: DetectedLineLabel = "unknown";
    let confidence = 0.20;

    if (isHorizontal) {
      if (nearSkyLine) {
        label = "ridgeCandidate"; confidence = 0.70;
      } else if (nearEaveLine) {
        label = "eaveCandidate"; confidence = 0.75;
      } else if (midY < (skyBoundaryY + roofBottom) / 2) {
        label = "ridgeCandidate"; confidence = 0.45;
      } else {
        label = "eaveCandidate"; confidence = 0.45;
      }
    } else if (isDiagonal && nearSide) {
      label = "rakeCandidate"; confidence = 0.55;
    } else if (isDiagonal) {
      label = "rakeCandidate"; confidence = 0.32;
    }

    return { ...seg, label, confidence, source: "auto-detect" as const };
  });
}

// ── Convex hull ───────────────────────────────────────────────────────────────

function convexHull2D(pts: [number,number][]): [number,number][] {
  if(pts.length<3) return pts;
  const sorted=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(O:[number,number],A:[number,number],B:[number,number])=>(A[0]-O[0])*(B[1]-O[1])-(A[1]-O[1])*(B[0]-O[0]);
  const lower:[number,number][]=[], upper:[number,number][]=[];
  for(const p of sorted){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p);}
  for(const p of [...sorted].reverse()){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ── Main detectEdges ──────────────────────────────────────────────────────────

export async function detectEdges(
  img: HTMLImageElement,
  imgW: number,
  imgH: number,
  opts: DetectEdgesOptions = {},
): Promise<LabeledSegment[]> {
  const {
    sensitivity          = 0.5,
    detailSuppression    = 0.5,
    minLineFraction      = 0.06,
    dominantOnly         = true,
    numDirections        = 3,
    directionTolDeg      = 10,
    maxProcessWidth      = 800,
    roofRegionFraction   = 0.5,
    ignoreVertical       = true,
    maxVerticalAngleDeg  = 75,
    skyBoundaryBias      = true,
    edgeContrastThreshold = 0.06,   // 0–1 fraction of 255; ~15 raw
    perDirectionCap      = 2,
  } = opts;

  const scale  = Math.min(1, maxProcessWidth / imgW);
  const pw     = Math.round(imgW * scale);
  const ph     = Math.round(imgH * scale);
  const wScale = 1 / scale;
  const minPxProc = (minLineFraction * imgW) * scale;

  // ── Draw to offscreen canvas ──────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.width = pw; canvas.height = ph;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, pw, ph);
  const imageData = ctx.getImageData(0, 0, pw, ph);
  await new Promise<void>(r => setTimeout(r, 0));

  // ── Auto-detect mode ─────────────────────────────────────────────────
  const gray = toGrayscale(imageData.data, pw, ph);
  const mode: "topDown" | "facade" = opts.mode ??
    (skyScore(gray, pw, ph) >= 0.55 ? "facade" : "topDown");
  const isFacade = mode === "facade";
  console.info(`[EdgeDetect] mode=${mode} | ${pw}×${ph} | roofRegion=${Math.round(roofRegionFraction*100)}%`);

  // ── Stage 1: preprocess ──────────────────────────────────────────────
  const preprocessed = preprocessForRoofs(gray, pw, ph, detailSuppression, isFacade);
  await new Promise<void>(r => setTimeout(r, 0));

  // ── Stage 1b: find sky/roof boundary (facade) ─────────────────────────
  const skyBoundaryY_proc = (isFacade && skyBoundaryBias)
    ? findSkyBoundaryY(preprocessed, pw, ph, roofRegionFraction)
    : Math.round(ph * roofRegionFraction * 0.18);
  const skyBoundaryY_world = skyBoundaryY_proc * wScale;
  if (isFacade) console.info(`[EdgeDetect] skyBoundary y=${skyBoundaryY_proc}px (proc) → ${Math.round(skyBoundaryY_world)}px (world)`);

  // ── Stage 2: autoCanny ───────────────────────────────────────────────
  const { edgeMap: rawEdges, lowThresh, highThresh, numEdgePixels } =
    autoCanny(preprocessed, pw, ph, sensitivity);
  console.info(`[EdgeDetect] autoCanny ${numEdgePixels} px | thresh ${lowThresh}/${highThresh}`);

  // ── Stage 3: morphological close ─────────────────────────────────────
  const morphR = detailSuppression < 0.3 ? 1 : 2;
  const edgeMap = postProcessEdges(rawEdges, pw, ph, morphR);
  await new Promise<void>(r => setTimeout(r, 0));

  // ── Stage 3b: roof region mask (facade only) ──────────────────────────
  if (isFacade) {
    const maskRows = Math.round(ph * roofRegionFraction);
    for (let y = maskRows; y < ph; y++)
      for (let x = 0; x < pw; x++) edgeMap[y * pw + x] = 0;
  }

  // ── Stage 4: connected components + PCA ──────────────────────────────
  const comps = connectedComponents(edgeMap, pw, ph);
  const rawSegs: RawSeg[] = [];
  for (const comp of comps) {
    if (comp.length < 4) continue;
    const s = fitRawSeg(comp, pw);
    if (s && s.length >= minPxProc) rawSegs.push(s);
  }
  console.info(`[EdgeDetect] CC+PCA ${rawSegs.length} raw segs`);

  // ── Stage 5: world coords + merge ────────────────────────────────────
  let segs: EdgeSegment[] = rawSegs.map(s => rawToEdge(s, wScale));
  const gapPx = Math.max(10, 0.012 * imgW);
  segs = mergeSegments(segs, 10, gapPx, 2);
  segs = segs.filter(s => s.length >= minLineFraction * imgW);
  console.info(`[EdgeDetect] merge → ${segs.length} segs`);

  // ── Stage 6a: facade orientation filter ──────────────────────────────
  if (isFacade && ignoreVertical) {
    const before = segs.length;
    segs = facadeOrientationFilter(segs, maxVerticalAngleDeg);
    console.info(`[EdgeDetect] vert-filter ${before} → ${segs.length}`);
  }

  // ── Stage 6b: contrast consistency filter (facade only) ──────────────
  if (isFacade && edgeContrastThreshold > 0) {
    const rawThresh = edgeContrastThreshold * 255;
    const before = segs.length;
    segs = contrastConsistencyFilter(segs, preprocessed, pw, ph, scale, rawThresh);
    console.info(`[EdgeDetect] contrast-filter ${before} → ${segs.length} (thresh=${rawThresh.toFixed(1)})`);
  }

  // ── Stage 6c: extend rake lines to roof region bounds (facade only) ──
  if (isFacade) {
    const roofBottom = roofRegionFraction * imgH;
    segs = segs.map(s => extendRakeToBounds(s, imgW, roofBottom));
  }

  // ── Stage 6d: dominant direction filter (top-down only) ──────────────
  if (!isFacade && dominantOnly && numDirections > 0) {
    segs = dominantDirectionFilter(segs, numDirections, directionTolDeg);
  }
  console.info(`[EdgeDetect] after dir-filter ${segs.length} segs`);

  // ── Stage 7: initial label ────────────────────────────────────────────
  let labeled: LabeledSegment[];
  if (isFacade) {
    labeled = labelFacadeLines(segs, imgW, imgH, roofRegionFraction, skyBoundaryY_world);
    // Horizon bias before directional cap so cap scores are confidence-weighted
    labeled = applyHorizonBias(labeled, imgH, roofRegionFraction, skyBoundaryY_world);
    // Stage 8: directional cap + canonical relabeling
    labeled = facadeSelectBestLines(labeled, imgW, imgH, skyBoundaryY_world, roofRegionFraction, perDirectionCap);
  } else {
    labeled = labelDetectedLines(segs, imgW, imgH, "topDown");
  }

  const byLabel = labeled.reduce<Record<string,number>>((acc,s)=>{acc[s.label]=(acc[s.label]||0)+1;return acc;},{});
  console.info(`[EdgeDetect] final ${labeled.length} segs | labels:`, byLabel);

  return labeled;
}

// ── Dev test harness ──────────────────────────────────────────────────────────

export function runEdgeDetectionTests(): void {
  let pass = 0, fail = 0;
  const test = (name: string, ok: boolean, detail?: string) => {
    if (ok) { console.log(`  ✓ ${name}`); pass++; }
    else     { console.error(`  ✗ ${name}${detail ? ": " + detail : ""}`); fail++; }
  };
  console.group("[EdgeDetectionTests]");

  // bilateral: uniform input → near-uniform output
  { const N=64,g=new Float32Array(N*N).fill(100); const o=bilateralFilter(g,N,N,9,75,75);
    const diff=Math.max(...Array.from(o))-Math.min(...Array.from(o));
    test("bilateralFilter: uniform in → uniform out (diff<1)", diff<1, `diff=${diff.toFixed(3)}`); }

  // bilateral: step edge preserved
  { const W=20,H=1,g=new Float32Array(W);
    for(let x=0;x<W;x++) g[x]=x<10?50:200;
    const o=bilateralFilter(g,W,H,5,75,75);
    test("bilateralFilter: step edge preserved", o[9]<130&&o[10]>120, `o[9]=${o[9].toFixed(1)} o[10]=${o[10].toFixed(1)}`); }

  // autoCanny: more sensitivity → more edges
  { const W=20,H=20,g=new Float32Array(W*H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) g[y*W+x]=x<10?50:150;
    const bl=gaussianBlurVar(g,W,H,1.0);
    const {numEdgePixels:lo}=autoCanny(bl,W,H,0.1), {numEdgePixels:hi}=autoCanny(bl,W,H,0.9);
    test("autoCanny: higher sens → more edges", hi>=lo, `lo=${lo} hi=${hi}`); }

  // mergeSegments
  { const a:EdgeSegment={id:"a",x1:0,y1:0,x2:100,y2:0,angle:0,length:100};
    const b:EdgeSegment={id:"b",x1:80,y1:2,x2:200,y2:2,angle:0,length:120};
    const m=mergeSegments([a,b],10,15);
    test("mergeSegments: collinear pair → 1", m.length===1, `got ${m.length}`);
    test("mergeSegments: merged length ≥200", (m[0]?.length??0)>=200, `got ${m[0]?.length.toFixed(1)}`); }

  // dominantDirectionFilter
  { const mk=(angle:number,id:string):EdgeSegment=>({id,x1:0,y1:0,x2:100,y2:0,angle,length:100});
    const segs=[...Array.from({length:5},(_,i)=>mk(0.01*i,"h"+i)),
                ...Array.from({length:5},(_,i)=>mk(Math.PI/2+0.01*i,"v"+i)),
                mk(Math.PI/4,"diag")];
    const f=dominantDirectionFilter(segs,2,10);
    test("dominantDirectionFilter: diagonal removed (K=2)", !f.find(s=>s.id==="diag"), `kept=${f.length}`); }

  // facadeOrientationFilter
  { const mk=(angle:number,id:string):EdgeSegment=>({id,x1:0,y1:0,x2:100,y2:0,angle,length:100});
    const segs=[mk(0,"horiz"), mk(Math.PI/4,"diag"), mk(Math.PI/2,"vert")];
    const f=facadeOrientationFilter(segs,75);
    test("facadeOrientationFilter: vertical removed", !f.find(s=>s.id==="vert"), `kept=${f.map(s=>s.id)}`);
    test("facadeOrientationFilter: horizontal kept",  !!f.find(s=>s.id==="horiz")); }

  // contrastConsistencyFilter: high-contrast edge kept
  { const W=20,H=20,g=new Float32Array(W*H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) g[y*W+x]=x<10?30:180;
    const seg:EdgeSegment={id:"s",x1:0,y1:10,x2:20,y2:10,angle:0,length:20};
    const kept=contrastConsistencyFilter([seg],g,W,H,1.0,10,7,3);
    test("contrastConsistencyFilter: high-contrast edge kept", kept.length===1, `got ${kept.length}`); }

  // contrastConsistencyFilter: low-contrast noise removed
  { const W=20,H=20,g=new Float32Array(W*H).fill(128); // uniform = zero contrast
    const seg:EdgeSegment={id:"s",x1:0,y1:10,x2:20,y2:10,angle:0,length:20};
    const kept=contrastConsistencyFilter([seg],g,W,H,1.0,30,7,3);
    test("contrastConsistencyFilter: zero-contrast removed", kept.length===0, `got ${kept.length}`); }

  // findSkyBoundaryY: returns row in range
  { const W=40,H=40,g=new Float32Array(W*H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++) g[y*W+x]=y<10?200:50;
    const y=findSkyBoundaryY(g,W,H,0.6);
    test("findSkyBoundaryY: detects transition near row 10", y>=8&&y<=14, `got ${y}`); }

  // facadeSelectBestLines: left/right rake labeling
  { const mkL=(id:string,x1:number,y1:number,x2:number,y2:number):LabeledSegment=>({
      id,x1,y1,x2,y2,angle:Math.atan2(y2-y1,x2-x1)<0?Math.atan2(y2-y1,x2-x1)+Math.PI:Math.atan2(y2-y1,x2-x1),
      length:Math.sqrt((x2-x1)**2+(y2-y1)**2),label:"rakeCandidate",confidence:0.5,source:"auto-detect",
    });
    // Right rake: goes from top-left to bottom-right (x increases as y increases)
    const rightRake=mkL("r",50,50,200,250);
    // Left rake: goes from top-right to bottom-left (x decreases as y increases)
    const leftRake=mkL("l",200,50,50,250);
    const out=facadeSelectBestLines([rightRake,leftRake],300,400,50,0.7,2);
    const labels=out.map(s=>s.label).sort();
    test("facadeSelectBestLines: right rake labeled", labels.includes("rakeCandidateRight"), `labels=${labels}`);
    test("facadeSelectBestLines: left rake labeled",  labels.includes("rakeCandidateLeft"),  `labels=${labels}`); }

  // labelDetectedLines top-down: horizontal bottom → eaveCandidate
  { const s:EdgeSegment={id:"e",x1:100,y1:450,x2:500,y2:450,angle:0,length:400};
    const [l]=labelDetectedLines([s],600,500,"topDown");
    test("topDown: horiz bottom → eaveCandidate", l.label==="eaveCandidate", `got ${l.label}`); }

  console.groupEnd();
  console.log(`[EdgeDetectionTests] ${pass} passed, ${fail} failed`);
}
