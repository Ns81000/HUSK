/**
 * Axe smoke specs: landing screen and the room screen — in both themes —
 * with zero violations.
 *
 * These run against the real production build served by wrangler/workerd
 * (see playwright.config.ts). Run with `pnpm test:a11y`.
 *
 * The room screen is rendered without a relay, so it shows the
 * "This link has no key" closed screen — the only room state reachable
 * server-side without a live relay. The interactive room + modal flow is
 * covered by modal.spec.ts via route interception.
 */

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const THEMES = ["light", "dark"] as const;

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

function useTheme(page: Page, theme: (typeof THEMES)[number]): void {
  // The pre-paint bootstrap reads this exact key (src/lib/husk/theme.ts).
  void page.addInitScript((value) => {
    window.localStorage.setItem("husk-theme", value);
  }, theme);
}

for (const theme of THEMES) {
  test(`landing screen — zero axe violations, ${theme} theme`, async ({ page }) => {
    useTheme(page, theme);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "HUSK", level: 1 })).toBeVisible();
    // Let the staggered entrance animations settle before measuring contrast.
    await page.waitForTimeout(700);
    expect(await axeViolations(page)).toEqual([]);
  });

  test(`room screen — zero axe violations, ${theme} theme`, async ({ page }) => {
    useTheme(page, theme);
    await page.goto("/r/ab3xk9m2");
    await expect(page.getByRole("heading", { name: "This link has no key" })).toBeVisible();
    await page.waitForTimeout(700);
    expect(await axeViolations(page)).toEqual([]);
  });
}
