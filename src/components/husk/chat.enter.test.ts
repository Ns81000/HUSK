/** Composer Enter-contract: plain Enter submits, everything else does not. */

import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "./chat";

function keyEvent(
  key: string,
  opts: { shiftKey?: boolean; isComposing?: boolean } = {},
): {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean | undefined };
} {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
    nativeEvent: { isComposing: opts.isComposing },
  };
}

describe("composer Enter handling", () => {
  it("submits on a plain Enter", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter"))).toBe(true);
  });

  it("does not submit on Shift+Enter", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { shiftKey: true }))).toBe(false);
  });

  it("does not submit on other keys", () => {
    expect(shouldSubmitOnEnter(keyEvent("a"))).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { isComposing: true }))).toBe(false);
  });

  it("treats a missing isComposing flag as not composing (older engines)", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter"))).toBe(true);
  });
});
