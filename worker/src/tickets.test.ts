import { describe, expect, it } from "vitest";
import { signTicket, verifyTicket } from "./tickets";

const secret = "test-secret-value";
const now = 1_700_000_000_000;
const expiresAt = Math.floor(now / 1000) + 300;

describe("signed R2 tickets", () => {
  it("verifies a fresh ticket", async () => {
    const signature = await signTicket(secret, "put", "123456/object", expiresAt);
    expect(await verifyTicket(secret, "put", "123456/object", expiresAt, signature, now)).toBe(
      true,
    );
  });

  it("rejects a ticket used for the wrong operation", async () => {
    const signature = await signTicket(secret, "put", "123456/object", expiresAt);
    expect(await verifyTicket(secret, "get", "123456/object", expiresAt, signature, now)).toBe(
      false,
    );
  });

  it("rejects a ticket for a different object", async () => {
    const signature = await signTicket(secret, "get", "123456/a", expiresAt);
    expect(await verifyTicket(secret, "get", "123456/b", expiresAt, signature, now)).toBe(false);
  });

  it("rejects an expired ticket", async () => {
    const signature = await signTicket(secret, "get", "123456/a", expiresAt);
    expect(
      await verifyTicket(secret, "get", "123456/a", expiresAt, signature, now + 600_000),
    ).toBe(false);
  });

  it("rejects an unsigned request", async () => {
    expect(await verifyTicket(secret, "get", "123456/a", expiresAt, "", now)).toBe(false);
  });
});
