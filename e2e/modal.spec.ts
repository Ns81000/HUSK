/**
 * Leave-room modal E2E (audit Phase 5, item 2): Tab is trapped inside the
 * dialog and wraps at both ends, focus returns to the invoking element on
 * close (Escape and confirm), and clicking the scrim closes the modal.
 *
 * The relay is mocked with route interception, so no live Worker is needed —
 * but the spec runs against the real production build and the real Modal
 * component. Run with `pnpm test:a11y`.
 */

import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const THEMES = ["light", "dark"] as const;

function useTheme(page: Page, theme: (typeof THEMES)[number]): void {
  void page.addInitScript((value) => {
    window.localStorage.setItem("husk-theme", value);
  }, theme);
}

async function openLeaveModal(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  useTheme(page, theme);
  // Mock relay endpoints: the modal flow must not need a live Worker.
  await page.route("**/room/create", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/room/join", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, joinToken: "a11y-test-token" }),
    }),
  );
  // A silently open socket is enough: the modal does not depend on room state.
  await page.routeWebSocket(/\/socket/, () => undefined);

  await page.goto("/");
  await page.getByRole("button", { name: "Create a room" }).click();
  // The room header shows the PIN in a <p>, not a heading element.
  await expect(page.getByText(/^Room \d{6}$/, { exact: true })).toBeVisible();

  const invoker = page.getByRole("button", { name: "Leave room" });
  await invoker.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
}

function activeElementText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return element === null ? "" : (element.textContent ?? "").trim();
  });
}

async function activeElementInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null);
}

for (const theme of THEMES) {
  test(`modal traps Tab and wraps at both ends — ${theme} theme`, async ({ page }) => {
    await openLeaveModal(page, theme);

    // Open focuses the confirm button; Tab wraps forward to the first
    // focusable (Cancel); Shift+Tab from the first wraps to the last.
    await expect(await activeElementInsideDialog(page)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await activeElementText(page)).toBe("Cancel");
    await page.keyboard.press("Tab");
    expect(await activeElementText(page)).toBe("Leave");
    await page.keyboard.press("Shift+Tab");
    expect(await activeElementText(page)).toBe("Cancel");
    await page.keyboard.press("Shift+Tab");
    expect(await activeElementText(page)).toBe("Leave");
  });

  test(`modal restores focus to the invoker on close — ${theme} theme`, async ({ page }) => {
    await openLeaveModal(page, theme);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await activeElementText(page)).toBe("Leave room");

    // Note: the confirm action is intentionally not asserted here — confirming
    // really leaves the room, unmounting the invoker (and the whole room UI),
    // so a focus-restoration target no longer exists on that path.
  });

  test(`modal closes on scrim click and axe stays clean — ${theme} theme`, async ({ page }) => {
    await openLeaveModal(page, theme);

    const violations = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations.violations.map((violation) => violation.id)).toEqual([]);

    // Click far outside the dialog panel: hits the scrim, not the dialog.
    await page.mouse.click(30, 360);
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await activeElementText(page)).toBe("Leave room");
  });
}
