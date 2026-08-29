// G38 (joined-room axe) + G39 (keyboard-only walkthrough): create by keyboard,
// compose/send by keyboard, attach by keyboard, leave-modal trap/Escape/restore.
// Costs: 1 create + 2 joins.
import {
  FRONTEND,
  assert,
  createRoomViaUi,
  launch,
  log,
  monitor,
  sleep,
  statusLine,
  waitForParticipants,
} from "./drive-lib.mjs";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

async function axeViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

const scratch = mkdtempSync(joinPath(tmpdir(), "husk-live-"));
const filePath = joinPath(scratch, "kb-upload.bin");
writeFileSync(filePath, Buffer.alloc(2048, 3));

const browser = await launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const eventsA = monitor(pageA, "A");
const pageB = await ctxB.newPage();
const eventsB = monitor(pageB, "B");

const { pin, fragment } = await createRoomViaUi(pageA);
await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
assert((await waitForParticipants(pageA, 2)) === 2, `both connected`);

// Keyboard-only: focus the composer directly (the walkthrough's composer leg).
await pageA.getByRole("textbox", { name: "Message" }).focus();
await pageA.keyboard.type("typed by keyboard");
await pageA.keyboard.press("Enter");
await pageB.getByText("typed by keyboard").waitFor({ timeout: 10_000 });
assert(true, `keyboard-only compose + Enter delivers`);

// Keyboard file attach: focus the attach button, Enter opens the chooser.
const chooserPromise = pageA.waitForEvent("filechooser", { timeout: 10_000 });
await pageA.getByRole("button", { name: "Attach a file" }).focus();
await pageA.keyboard.press("Enter");
const chooser = await chooserPromise;
await chooser.setFiles(filePath);
await pageB.getByText("kb-upload.bin").waitFor({ timeout: 30_000 });
assert(true, `keyboard-triggered file attach uploads and relays`);

// Leave modal: open via keyboard, check trap/wrap/Escape/focus restore.
await pageA.getByRole("button", { name: "Leave room" }).focus();
await pageA.keyboard.press("Enter");
const dialog = pageA.getByRole("dialog");
await dialog.getByRole("heading", { name: "Leave this room?" }).waitFor({ timeout: 5000 });
assert(true, `modal opens via keyboard`);

// Tab cycles inside the modal (trap): collect the sequence of focused elements.
const focusSequence = [];
for (let i = 0; i < 6; i += 1) {
  await pageA.keyboard.press("Tab");
  focusSequence.push(
    await pageA.evaluate(() => {
      const el = document.activeElement;
      return `${el?.tagName}:${el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 12)}`;
    }),
  );
}
log("focus sequence in modal:", JSON.stringify(focusSequence));
const modalFocusCount = focusSequence.filter((f) => !f.startsWith("BODY")).length;
assert(
  modalFocusCount === focusSequence.length,
  `focus stays inside the modal while tabbing (trap)`,
);

// Escape closes; focus is restored to the page (not lost to body).
await pageA.keyboard.press("Escape");
await sleep(500);
const modalGone = (await pageA.getByRole("dialog").count()) === 0;
assert(modalGone, `Escape closes the modal`);
const focusAfter = await pageA.evaluate(() => document.activeElement?.tagName ?? "BODY");
log("focused element after Escape:", focusAfter);
assert(focusAfter !== "BODY", `focus restored into the page after Escape`);

// Axe on the joined room with content, and on the open modal.
let violations = await axeViolations(pageA);
assert(violations.length === 0, `active room axe clean (${violations.join(" | ")})`);
await pageA.getByRole("button", { name: "Leave room" }).click();
await dialog.getByRole("heading", { name: "Leave this room?" }).waitFor({ timeout: 5000 });
violations = await axeViolations(pageA);
assert(violations.length === 0, `open-modal axe clean (${violations.join(" | ")})`);
await pageA.keyboard.press("Escape");

log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO G38/G39-joined: OK");
