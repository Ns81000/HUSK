import { describe, expect, it } from "vitest";
import { tokenize } from "./linkify";

describe("linkify", () => {
  it("keeps plain text as one token", () => {
    expect(tokenize("just words")).toEqual([{ kind: "text", value: "just words" }]);
  });

  it("extracts http and https links", () => {
    const tokens = tokenize("see https://example.com/x now");
    expect(tokens[1]).toMatchObject({ kind: "link", href: "https://example.com/x" });
  });

  it("never produces a javascript scheme link", () => {
    const tokens = tokenize("javascript:alert(1) and data:text/html,<script>");
    expect(tokens.every((token) => token.kind === "text")).toBe(true);
  });

  it("treats an XSS payload as inert text", () => {
    const payload = '<img src=x onerror="alert(1)">';
    expect(tokenize(payload)).toEqual([{ kind: "text", value: payload }]);
  });
});
