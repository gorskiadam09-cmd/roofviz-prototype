# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server at http://localhost:3000
npm run build    # Production build
npm run lint     # ESLint
npm run test     # Run all Jest tests
npx jest --testPathPattern="page" --watch  # Run a single test file in watch mode
```

## Architecture

This is a **single-page Next.js app** — nearly all logic lives in `app/page.tsx` (~1600 lines). There are no API routes, no additional pages, and no shared component library.

### Core data model

```
PhotoProject            — one per uploaded photo
  ├── step: Step        — current workflow step (drives what renders)
  ├── roofs: Roof[]     — one or more traced roof polygons
  ├── activeRoofId      — which roof is being edited
  └── stageScale/Pos    — Konva zoom/pan state

Roof
  ├── outline: number[] — flat [x,y,x,y,...] polygon (screen coords)
  ├── holes: number[][] — exclusion polygons (dormers)
  ├── lines: Polyline[] — typed lines: EAVE | RAKE | VALLEY | RIDGE | HIP
  └── per-product widths & colors (gutterApronW, dripEdgeColor, etc.)
```

### Step-driven rendering

The workflow is a linear sequence of `Step` enum values defined in `STEPS[]`. The canvas renders whatever corresponds to `currentStep` using `atLeast(currentStep, "STEP_NAME")` guards. Key sequencing rules:

- **Synthetic** only shows between `SYNTHETIC` and `SHINGLES` steps (it disappears once shingles are placed).
- **Ice & Water** renders on top of synthetic and stays visible after.
- **Dormer holes** clip back to the original photo using a nested `Group clipFunc`.
- **Export view** (`exportView` state) temporarily overrides `currentStep` to `CAP_SHINGLES` (page 1) or `PRO_START` (page 2) during PDF generation.

### Canvas

The right-hand panel is a Konva `Stage`. The entire roof area is clipped by `clipPolygonPath(ctx, r.outline)` on a `Group`, and all product overlays (textures, metal strokes, shingle fills) are rendered inside that clipped group.

Procedural textures (`makeDeckingTexture`, `makeSyntheticTexture`, `makeShingleTexture`) generate large `canvas` elements client-side and are memoized by `active.id` + `active.shingleColor`.

### State management

All state is React `useState` in the root `Page` component. Two helpers centralize updates:
- `patchActive(updater)` — updates the active `PhotoProject`
- `patchActiveRoof(updater)` — updates the active `Roof` within the active project

### Testing

Tests are in `__tests__/page.test.tsx`. The test file mocks `react-konva` (renders divs with `data-testid`), `next/image`, `ResizeObserver`, `HTMLCanvasElement.getContext`, and `HTMLImageElement`. Pure utility functions (`clamp`, `stepIndex`, `atLeast`, `metalRGBA`, `shinglePalette`) are re-declared inline in the test file and tested independently from the component.

### Key dependencies

- **react-konva / konva** — canvas rendering
- **jspdf** — PDF export (dynamically imported in `exportPdfTwoPages`)
- **next-pwa** — PWA support
- React Compiler is enabled (`reactCompiler: true` in `next.config.ts`)

### Static asset

`/public/roofviz-logo.png` is required; the app references it via `next/image`.
