/**
 * planeSuggestion.ts
 *
 * Given a set of detected edge segments, suggest roof-plane polygons
 * by finding closed cycles in the arrangement of extended lines.
 *
 * Algorithm:
 *   1. Extend each segment to a full infinite line.
 *   2. Find all pairwise intersections within the image bounds.
 *   3. For each segment, collect intersection points along it (sorted by position).
 *   4. Build a planar graph: nodes = intersections, edges = segment spans between adjacent intersections.
 *   5. DFS cycle search (max 6 edges) returning candidate polygons.
 *   6. Score each polygon by area, convexity, and edge coverage.
 *   7. Return top-N deduplicated suggestions.
 */

import type { EdgeSegment } from "./edgeDetection";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlaneSuggestion {
  id: string;
  /** Flat [x,y,x,y,...] polygon in world coordinates. */
  polygon: number[];
  area: number;
  /** Fraction of input segments that run along a polygon edge (0–1). */
  edgeCoverage: number;
  score: number;
}

// ── Geometry utilities ────────────────────────────────────────────────────────

function lineIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): { x: number; y: number } | null {
  const dx1 = x2 - x1, dy1 = y2 - y1;
  const dx2 = x4 - x3, dy2 = y4 - y3;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / denom;
  return { x: x1 + t * dx1, y: y1 + t * dy1 };
}

function polygonArea(pts: number[]): number {
  const n = pts.length / 2;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i * 2] * pts[j * 2 + 1];
    area -= pts[j * 2] * pts[i * 2 + 1];
  }
  return Math.abs(area) / 2;
}

function isConvex(pts: number[]): boolean {
  const n = pts.length / 2;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1];
    const bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1];
    const cx = pts[((i + 2) % n) * 2], cy = pts[((i + 2) % n) * 2 + 1];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

// ── Main algorithm ────────────────────────────────────────────────────────────

/** Extend a segment to a "long line" that covers the entire image. */
function extendSegment(seg: EdgeSegment, imgW: number, imgH: number) {
  const mx = (seg.x1 + seg.x2) / 2;
  const my = (seg.y1 + seg.y2) / 2;
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len, uy = dy / len;
  const far = Math.max(imgW, imgH) * 2;
  return {
    x1: mx - ux * far, y1: my - uy * far,
    x2: mx + ux * far, y2: my + uy * far,
  };
}

interface Vertex { x: number; y: number; id: number }
interface GraphEdge { from: number; to: number; segIdx: number }

export function suggestPlanes(
  segments: EdgeSegment[],
  imgW: number,
  imgH: number,
  opts: { maxPlanes?: number; minArea?: number } = {},
): PlaneSuggestion[] {
  const { maxPlanes = 8, minArea = 2000 } = opts;

  if (segments.length < 3) return [];

  const PAD = 20; // px: clamp intersections to image + small padding

  // ── Step 1: find all pairwise intersections within image bounds ───────────
  const vertices: Vertex[] = [];
  // Per-segment: list of {vertexId, t (projection along segment direction)} for ordering
  const segVerts: Array<Array<{ vid: number; t: number }>> = segments.map(() => []);

  function addVertex(x: number, y: number, si: number, sj: number): number {
    // Snap to existing vertex within 6px
    for (let k = 0; k < vertices.length; k++) {
      if (dist2(vertices[k].x, vertices[k].y, x, y) < 36) return k;
    }
    const vid = vertices.length;
    vertices.push({ x, y, id: vid });
    return vid;
  }

  for (let i = 0; i < segments.length; i++) {
    const ei = extendSegment(segments[i], imgW, imgH);
    for (let j = i + 1; j < segments.length; j++) {
      // Skip nearly parallel pairs
      const dot = Math.abs(
        Math.cos(segments[i].angle) * Math.cos(segments[j].angle) +
        Math.sin(segments[i].angle) * Math.sin(segments[j].angle),
      );
      if (dot > 0.985) continue; // < ~10° angle difference
      const ej = extendSegment(segments[j], imgW, imgH);
      const pt = lineIntersect(ei.x1, ei.y1, ei.x2, ei.y2, ej.x1, ej.y1, ej.x2, ej.y2);
      if (!pt) continue;
      // Clamp to image + padding
      if (pt.x < -PAD || pt.x > imgW + PAD || pt.y < -PAD || pt.y > imgH + PAD) continue;
      const vid = addVertex(pt.x, pt.y, i, j);
      // Project onto each segment's direction for ordering
      const dxi = segments[i].x2 - segments[i].x1, dyi = segments[i].y2 - segments[i].y1;
      const ti = (pt.x - segments[i].x1) * dxi + (pt.y - segments[i].y1) * dyi;
      segVerts[i].push({ vid, t: ti });
      const dxj = segments[j].x2 - segments[j].x1, dyj = segments[j].y2 - segments[j].y1;
      const tj = (pt.x - segments[j].x1) * dxj + (pt.y - segments[j].y1) * dyj;
      segVerts[j].push({ vid, t: tj });
    }
  }

  if (vertices.length < 3) return [];

  // ── Step 2: build adjacency graph from segment spans ────────────────────
  // adjacency[vid] = list of {neighborVid, segIdx}
  const adj: Map<number, Array<{ to: number; segIdx: number }>> = new Map();
  const addEdge = (from: number, to: number, segIdx: number) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push({ to, segIdx });
  };

  for (let si = 0; si < segments.length; si++) {
    const verts = segVerts[si];
    if (verts.length < 2) continue;
    verts.sort((a, b) => a.t - b.t);
    for (let k = 0; k < verts.length - 1; k++) {
      addEdge(verts[k].vid, verts[k + 1].vid, si);
      addEdge(verts[k + 1].vid, verts[k].vid, si);
    }
  }

  // ── Step 3: DFS cycle search (max 6 vertices) ────────────────────────────
  const candidates: number[][] = []; // each = list of vertex ids forming a cycle
  const maxDepth = 6;

  function dfs(
    startVid: number,
    curVid: number,
    path: number[],
    usedSegs: Set<number>,
    lastSegIdx: number,
  ) {
    if (path.length >= 3) {
      // Check if we can close back to start
      const neighbors = adj.get(curVid);
      if (neighbors) {
        for (const { to, segIdx } of neighbors) {
          if (to === startVid && segIdx !== lastSegIdx && !usedSegs.has(segIdx)) {
            candidates.push([...path]);
            return; // one cycle per DFS path is enough
          }
        }
      }
    }
    if (path.length >= maxDepth) return;
    const neighbors = adj.get(curVid);
    if (!neighbors) return;
    for (const { to, segIdx } of neighbors) {
      if (path.includes(to)) continue;
      if (usedSegs.has(segIdx)) continue;
      if (segIdx === lastSegIdx) continue;
      path.push(to);
      usedSegs.add(segIdx);
      dfs(startVid, to, path, usedSegs, segIdx);
      path.pop();
      usedSegs.delete(segIdx);
    }
  }

  for (let vid = 0; vid < Math.min(vertices.length, 60); vid++) {
    dfs(vid, vid, [vid], new Set(), -1);
    if (candidates.length > 200) break; // limit computation
  }

  // ── Step 4: score and filter candidates ──────────────────────────────────
  const MIN_AREA = minArea;

  function candidateScore(vids: number[]): { poly: number[]; area: number; score: number; cov: number } | null {
    const poly: number[] = [];
    for (const vid of vids) {
      poly.push(vertices[vid].x, vertices[vid].y);
    }
    const area = polygonArea(poly);
    if (area < MIN_AREA) return null;
    // Convexity bonus
    const convex = isConvex(poly) ? 1.0 : 0.6;
    // Edge coverage: fraction of segments that lie near a polygon edge
    let covered = 0;
    for (const seg of segments) {
      const mx = (seg.x1 + seg.x2) / 2;
      const my = (seg.y1 + seg.y2) / 2;
      // Check if midpoint is inside the polygon (simple ray cast)
      let inside = false;
      const n = vids.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[i * 2], yi = poly[i * 2 + 1];
        const xj = poly[j * 2], yj = poly[j * 2 + 1];
        if ((yi > my) !== (yj > my) && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) covered++;
    }
    const cov = covered / segments.length;
    // Normalize area contribution (larger = better, but diminishing returns)
    const areaNorm = Math.min(1, area / (imgW * imgH * 0.35));
    const score = areaNorm * 0.5 + convex * 0.3 + cov * 0.2;
    return { poly, area, score, cov };
  }

  const results: PlaneSuggestion[] = [];
  const seenPolys = new Set<string>();

  for (const vids of candidates) {
    const scored = candidateScore(vids);
    if (!scored) continue;
    // Deduplicate by vertex id set
    const key = [...vids].sort().join(",");
    if (seenPolys.has(key)) continue;
    seenPolys.add(key);
    results.push({
      id: Math.random().toString(16).slice(2),
      polygon: scored.poly,
      area: scored.area,
      edgeCoverage: scored.cov,
      score: scored.score,
    });
  }

  // Sort by score descending, return top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxPlanes);
}
