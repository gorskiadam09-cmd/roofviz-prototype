/**
 * Tests for RoofViz — app/page.tsx
 *
 * Move this file to __tests__/page.test.tsx inside your Next.js project.
 *
 * Setup (if not already done):
 *   npm i -D jest @types/jest jest-environment-jsdom ts-jest \
 *     @testing-library/react @testing-library/user-event @testing-library/jest-dom
 *
 * jest.config.ts (Next.js built-in):
 *   const nextJest = require('next/jest')
 *   const createJestConfig = nextJest({ dir: './' })
 *   module.exports = createJestConfig({
 *     testEnvironment: 'jsdom',
 *     setupFilesAfterFramework: ['<rootDir>/jest.setup.ts'],
 *   })
 *
 * jest.setup.ts:
 *   import '@testing-library/jest-dom'
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// ── External dependency mocks ─────────────────────────────────────────────

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));

jest.mock("react-konva", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require("react");
  const passthrough =
    (name: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      R.createElement("div", { "data-testid": name }, children);
  return {
    Stage: ({ children }: { children?: React.ReactNode }) =>
      R.createElement("div", { "data-testid": "Stage" }, children),
    Layer: passthrough("Layer"),
    Group: passthrough("Group"),
    Rect: () => R.createElement("div", { "data-testid": "Rect" }),
    Line: () => R.createElement("div", { "data-testid": "Line" }),
    Circle: () => R.createElement("div", { "data-testid": "Circle" }),
    Text: ({ text }: { text: string }) =>
      R.createElement("div", { "data-testid": "KonvaText" }, text),
    Image: () => R.createElement("div", { "data-testid": "KonvaImage" }),
  };
});

// ResizeObserver — fires callback immediately with a 1100×700 rect
global.ResizeObserver = class {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    this.cb(
      [{ contentRect: { width: 1100, height: 700 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
  unobserve = jest.fn();
  disconnect = jest.fn();
} as unknown as typeof ResizeObserver;

// Canvas — used by the procedural texture generators
HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  globalAlpha: 1,
  lineCap: "butt",
  lineJoin: "miter",
  beginPath: jest.fn(),
  moveTo: jest.fn(),
  lineTo: jest.fn(),
  closePath: jest.fn(),
  stroke: jest.fn(),
  fill: jest.fn(),
  fillRect: jest.fn(),
  save: jest.fn(),
  restore: jest.fn(),
  translate: jest.fn(),
  rotate: jest.fn(),
  createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
  createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
})) as jest.Mock;
HTMLCanvasElement.prototype.toDataURL = jest.fn(
  () => "data:image/png;base64,MOCK"
);

// HTMLImageElement — auto-fires onload so useHtmlImage resolves
class FakeHTMLImage {
  crossOrigin = "";
  onload: (() => void) | null = null;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    if (this.onload) setTimeout(this.onload, 0);
  }
}
(global as unknown as { Image: unknown }).Image = FakeHTMLImage;

// ── Pure utility logic tests ──────────────────────────────────────────────
// These mirror functions defined inside page.tsx.
// If you extract them to a utils file, swap in direct imports.

describe("clamp()", () => {
  const clamp = (n: number, min: number, max: number) =>
    Math.max(min, Math.min(max, n));

  it("returns value within range unchanged", () =>
    expect(clamp(5, 0, 10)).toBe(5));
  it("clamps below minimum to minimum", () =>
    expect(clamp(-3, 0, 10)).toBe(0));
  it("clamps above maximum to maximum", () =>
    expect(clamp(20, 0, 10)).toBe(10));
  it("handles equal min and max", () => expect(clamp(99, 3, 3)).toBe(3));
  it("handles exact boundary values", () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe("stepIndex() / atLeast()", () => {
  const STEPS = [
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
  ] as const;
  type Step = (typeof STEPS)[number];
  const stepIndex = (s: Step) => STEPS.indexOf(s);
  const atLeast = (cur: Step, target: Step) =>
    stepIndex(cur) >= stepIndex(target);

  it("START is index 0", () => expect(stepIndex("START")).toBe(0));
  it("EXPORT is the last index (12)", () =>
    expect(stepIndex("EXPORT")).toBe(12));
  it("SHINGLES is index 9", () => expect(stepIndex("SHINGLES")).toBe(9));

  it("atLeast is true when steps are equal", () =>
    expect(atLeast("TRACE", "TRACE")).toBe(true));
  it("atLeast is true when current step is ahead of target", () =>
    expect(atLeast("SHINGLES", "TEAROFF")).toBe(true));
  it("atLeast is false when current step is behind target", () =>
    expect(atLeast("TRACE", "SHINGLES")).toBe(false));
  it("atLeast is true for EXPORT vs START", () =>
    expect(atLeast("EXPORT", "START")).toBe(true));
});

describe("metalRGBA()", () => {
  // Mirrors the component's metalRGBA function
  const metalRGBA = (color: string, alpha: number): string => {
    const map: Record<string, string> = {
      Aluminum: `rgba(198,205,211,${alpha})`,
      White: `rgba(245,246,248,${alpha})`,
      Black: `rgba(25,25,28,${alpha})`,
      Bronze: `rgba(132,97,60,${alpha})`,
      Brown: `rgba(92,64,45,${alpha})`,
      Gray: `rgba(120,126,134,${alpha})`,
    };
    return map[color];
  };

  it("returns correct RGBA for Aluminum at alpha 1", () =>
    expect(metalRGBA("Aluminum", 1)).toBe("rgba(198,205,211,1)"));
  it("applies fractional alpha correctly", () =>
    expect(metalRGBA("Black", 0.5)).toBe("rgba(25,25,28,0.5)"));
  it("returns a valid rgba() string for every metal color", () => {
    ["Aluminum", "White", "Black", "Bronze", "Brown", "Gray"].forEach((c) =>
      expect(metalRGBA(c, 0.9)).toMatch(/^rgba\(\d+,\d+,\d+,0\.9\)$/)
    );
  });
});

describe("shinglePalette()", () => {
  // Mirrors the component's shinglePalette function
  const palette: Record<string, { top: string; bot: string }> = {
    Barkwood: { top: "#6f4f34", bot: "#24140e" },
    Charcoal: { top: "#4b4e55", bot: "#151619" },
    WeatheredWood: { top: "#6a6256", bot: "#231f1a" },
    PewterGray: { top: "#7a8087", bot: "#262b31" },
    OysterGray: { top: "#8d9092", bot: "#33373c" },
    Slate: { top: "#5d6a79", bot: "#1b2128" },
    Black: { top: "#2f3135", bot: "#070809" },
  };

  it("has correct top/bot hex values for Charcoal", () =>
    expect(palette["Charcoal"]).toEqual({ top: "#4b4e55", bot: "#151619" }));

  it("has correct top/bot hex values for Slate", () =>
    expect(palette["Slate"]).toEqual({ top: "#5d6a79", bot: "#1b2128" }));

  it("every color entry has a valid 6-digit hex top and bot", () => {
    Object.entries(palette).forEach(([, p]) => {
      expect(p.top).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.bot).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  it("covers all 7 shingle colors", () =>
    expect(Object.keys(palette)).toHaveLength(7));
});

// ── Component integration tests ───────────────────────────────────────────

// Adjust the import path to match your project layout:
import Page from "../app/page";

// Helper — renders and clicks "Start Project"
async function startProject() {
  const user = userEvent.setup();
  render(<Page />);
  await user.click(screen.getByRole("button", { name: "Start Project" }));
  return user;
}

// Helper — starts project and opens advanced options
async function openAdvanced() {
  const user = await startProject();
  await user.click(screen.getByRole("button", { name: "Show advanced options" }));
  return user;
}

describe("Page — initial (START) screen", () => {
  it("shows the start heading", () => {
    render(<Page />);
    expect(screen.getByText("Start a project")).toBeInTheDocument();
  });

  it("shows the project name input with default value", () => {
    render(<Page />);
    expect(screen.getByDisplayValue("My Roof Project")).toBeInTheDocument();
  });

  it("shows the Start Project button", () => {
    render(<Page />);
    expect(
      screen.getByRole("button", { name: "Start Project" })
    ).toBeInTheDocument();
  });

  it("does not show step navigation buttons before starting", () => {
    render(<Page />);
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("allows the user to change the project name", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const input = screen.getByDisplayValue("My Roof Project");
    await user.clear(input);
    await user.type(input, "Oak Street");
    expect(screen.getByDisplayValue("Oak Street")).toBeInTheDocument();
  });
});

describe("Page — after starting project", () => {
  it("advances to the TRACE step", async () => {
    await startProject();
    expect(
      screen.getByText(/Step 1 — Outline roofs/i)
    ).toBeInTheDocument();
  });

  it("renders the Konva stage", async () => {
    await startProject();
    expect(screen.getByTestId("Stage")).toBeInTheDocument();
  });

  it("shows placeholder text when no photo is loaded", async () => {
    await startProject();
    expect(
      screen.getByText("Upload a photo on the left to begin")
    ).toBeInTheDocument();
  });

  it("shows the file upload control", async () => {
    await startProject();
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("file input accepts multiple images", async () => {
    await startProject();
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
  });
});

describe("Page — step navigation", () => {
  it("Back button is enabled on the TRACE step (can return to START)", async () => {
    await startProject();
    // TRACE is step index 1, so goBack is allowed — button is enabled
    expect(screen.getByRole("button", { name: "Back" })).not.toBeDisabled();
  });

  it("Next button is disabled when no roof outline is closed", async () => {
    await startProject();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("Page — roof management", () => {
  it("starts with one roof (Roof 1)", async () => {
    await startProject();
    expect(screen.getByRole("button", { name: /Roof 1/i })).toBeInTheDocument();
  });

  it("adds a second roof when '+ Add roof' is clicked", async () => {
    const user = await startProject();
    await user.click(screen.getByRole("button", { name: "+ Add roof" }));
    expect(screen.getByRole("button", { name: /Roof 2/i })).toBeInTheDocument();
  });

  it("shows trace-roof button for unclosed roof", async () => {
    await startProject();
    expect(
      screen.getByRole("button", { name: /Trace roof edge/i })
    ).toBeInTheDocument();
  });

  it("can toggle edit handles on/off", async () => {
    const user = await startProject();
    await user.click(
      screen.getByRole("button", { name: "Show edit handles" })
    );
    expect(
      screen.getByRole("button", { name: "Hide edit handles" })
    ).toBeInTheDocument();
  });

  it("can toggle guides-during-install on/off", async () => {
    const user = await startProject();
    await user.click(
      screen.getByRole("button", { name: "Show guides during install" })
    );
    expect(
      screen.getByRole("button", { name: "Hide guides during install" })
    ).toBeInTheDocument();
  });
});

describe("Page — advanced options panel", () => {
  it("opens when toggled", async () => {
    await openAdvanced();
    expect(screen.getByText("Shingle color")).toBeInTheDocument();
    expect(screen.getByText("Metal colors")).toBeInTheDocument();
    expect(screen.getByText("Widths (px)")).toBeInTheDocument();
  });

  it("closes when toggled again", async () => {
    const user = await openAdvanced();
    await user.click(
      screen.getByRole("button", { name: "Hide advanced options" })
    );
    expect(screen.queryByText("Shingle color")).not.toBeInTheDocument();
  });

  it("shingle color dropdown has all 7 options", async () => {
    await openAdvanced();
    const select = screen.getByDisplayValue("Barkwood") as HTMLSelectElement;
    expect(select.options).toHaveLength(7);
  });

  it("shingle color dropdown contains expected values", async () => {
    await openAdvanced();
    const select = screen.getByDisplayValue("Barkwood") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual([
      "Barkwood",
      "Charcoal",
      "WeatheredWood",
      "PewterGray",
      "OysterGray",
      "Slate",
      "Black",
    ]);
  });

  it("metal color dropdowns are present for apron, drip edge, and valley", async () => {
    await openAdvanced();
    expect(screen.getByText("Gutter apron")).toBeInTheDocument();
    expect(screen.getByText("Drip edge")).toBeInTheDocument();
    expect(screen.getByText("Valley metal")).toBeInTheDocument();
  });
});

describe("Page — photo list", () => {
  it("shows the project in the photos list after starting", async () => {
    await startProject();
    // Initial project has no src yet
    expect(screen.getByText(/no photo yet/i)).toBeInTheDocument();
  });
});
