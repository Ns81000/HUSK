/**
 * WCAG AA contrast gate for the Husk token palettes.
 *
 * The oklch tokens in src/styles.css are parsed and converted to linear sRGB
 * (oklab → LMS → linear RGB), then every foreground/background pair the app
 * actually renders as body or caption text is asserted to clear 4.5:1 in both
 * themes. Editing a token to a failing value breaks this test in CI.
 *
 * Disabled-state text (e.g. `disabled:text-ink-faint`) is intentionally not
 * asserted: WCAG 1.4.3 exempts inactive user interface components.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Oklch = readonly [lightness: number, chroma: number, hue: number];

function oklchToLinearSrgb([L, C, H]: Oklch): readonly [number, number, number] {
  const radians = (H * Math.PI) / 180;
  const a = C * Math.cos(radians);
  const b = C * Math.sin(radians);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function relativeLuminance(token: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(token);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio; 4.5 is the AA threshold for normal-size text. */
export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function parseOklchBlock(block: string): Map<string, Oklch> {
  const tokens = new Map<string, Oklch>();
  const pattern = /--([a-z-]+):\s*oklch\(([^)]+)\)/g;
  for (const match of block.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) {
      continue;
    }
    // Alpha (e.g. the scrim) does not affect opaque text pairs; drop it.
    const parts = value.split("/")[0]?.trim().split(/\s+/) ?? [];
    if (parts.length !== 3) {
      continue;
    }
    const [l, c, h] = parts.map(Number) as [number, number, number];
    tokens.set(name, [l, c, h]);
  }
  return tokens;
}

function themeBlock(css: string, selector: ":root" | ".dark"): Map<string, Oklch> {
  const match = new RegExp(`${selector.replace(".", "\\.")} \\{([\\s\\S]*?)\\n\\}`).exec(css);
  expect(match, `${selector} block not found in styles.css`).not.toBeNull();
  const tokens = parseOklchBlock(match?.[1] ?? "");
  expect(tokens.size).toBeGreaterThan(10);
  return tokens;
}

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const light = themeBlock(css, ":root");
const dark = themeBlock(css, ".dark");

/** Foregrounds rendered as body/caption text, on every surface they sit on. */
const textOnSurfaces = ["ink", "ink-muted", "ink-faint", "warn", "danger", "ok", "info"] as const;
const surfaces = ["canvas", "surface", "surface-raised", "surface-sunken"] as const;

describe("Husk token palette WCAG AA contrast (4.5:1, both themes)", () => {
  for (const [themeName, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`text tokens clear AA on all surfaces — ${themeName} theme`, () => {
      const failures: string[] = [];
      for (const foreground of textOnSurfaces) {
        const fg = tokens.get(foreground);
        expect(fg, `token --${foreground} missing (${themeName})`).toBeDefined();
        if (fg === undefined) {
          continue;
        }
        for (const background of surfaces) {
          const bg = tokens.get(background);
          expect(bg, `token --${background} missing (${themeName})`).toBeDefined();
          if (bg === undefined) {
            continue;
          }
          const ratio = contrastRatio(fg, bg);
          if (ratio < 4.5) {
            failures.push(`--${foreground} on --${background}: ${ratio.toFixed(2)}:1`);
          }
        }
      }
      expect(failures, failures.join("; ")).toEqual([]);
    });

    it(`accent-ink clears AA on accent and accent-hover — ${themeName} theme`, () => {
      const accentInk = tokens.get("accent-ink");
      expect(accentInk).toBeDefined();
      if (accentInk === undefined) {
        return;
      }
      for (const bubble of ["accent", "accent-hover"] as const) {
        const bg = tokens.get(bubble);
        expect(bg).toBeDefined();
        if (bg === undefined) {
          continue;
        }
        expect(contrastRatio(accentInk, bg)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("the phase-5 audit's originally failing pairs are pinned at their fixed values", () => {
    // Guards against an accidental revert to the pre-Phase-5 tokens.
    expect(light.get("warn")).toEqual([0.5, 0.09, 78]);
    expect(light.get("ink-faint")).toEqual([0.535, 0.006, 250]);
    expect(dark.get("ink-faint")).toEqual([0.64, 0.005, 250]);
  });
});
