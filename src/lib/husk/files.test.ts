import { describe, expect, it } from "vitest";
import { EmptyFileError, FileTooLargeError, assertFileSendable } from "./files";

describe("assertFileSendable", () => {
  it("rejects a 0-byte file before any network request", () => {
    expect(() => assertFileSendable(0)).toThrow(EmptyFileError);
  });

  it("rejects a file over the 25 MB cap", () => {
    expect(() => assertFileSendable(25 * 1024 * 1024 + 1)).toThrow(FileTooLargeError);
  });

  it("accepts a 1-byte file", () => {
    expect(() => assertFileSendable(1)).not.toThrow();
  });

  it("accepts exactly the 25 MB cap", () => {
    expect(() => assertFileSendable(25 * 1024 * 1024)).not.toThrow();
  });
});
