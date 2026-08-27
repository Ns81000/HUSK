/**
 * Render-contract test: a chat message can never execute script content.
 * The message body is XSS-tokenized (see linkify.test.ts); this pins the
 * other string channel — the file name — to plain-text rendering.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileCard } from "./chat";

const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "room-notes<script>alert(1)</script>.pdf",
];

const baseBody = {
  kind: "file" as const,
  size: 1024,
  mime: "application/pdf",
  fileId: "00000000-0000-4000-8000-000000000000",
  chunks: 1,
  ivs: [],
  lengths: [],
  exp: 0,
  sig: "",
  sentAt: 0,
};

describe("file name rendering", () => {
  for (const payload of PAYLOADS) {
    it(`renders ${JSON.stringify(payload)} inertly`, () => {
      const html = renderToStaticMarkup(
        <FileCard body={{ ...baseBody, name: payload }} onDownload={() => Promise.resolve()} />,
      );
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      // The payload still renders, but strictly as escaped text.
      expect(html).toContain("&lt;");
    });
  }
});
