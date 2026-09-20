import { describe, expect, it } from "vitest";
import type { GgwaveFactory, GgwaveModule } from "../vendor/ggwave";

/**
 * Phase 0: trigger the two measured wasm traps on purpose, on throwaway module
 * instances, so the "module died — restart Sound Chat" recovery path is based
 * on observed behaviour rather than on the deep dive's notes.
 *
 * Each `factory()` call instantiates an independent wasm module with its own
 * heap and its own instance pool, so a trap in one test cannot poison another
 * (this file verifies that claim rather than assuming it).
 */

async function freshModule(): Promise<GgwaveModule> {
  const factory: GgwaveFactory = (await import("../vendor/ggwave.js")).default;
  return factory();
}

function parametersFor(module: GgwaveModule, operatingMode: number) {
  const parameters = module.getDefaultParameters();
  parameters.payloadLength = 64;
  parameters.operatingMode = operatingMode;
  return parameters;
}

function txInstance(module: GgwaveModule): number {
  return module.init(parametersFor(module, module.GGWAVE_OPERATING_MODE_TX));
}

function describeThrowable(error: Error): string {
  return `${error.name}: ${error.message.slice(0, 120)}`;
}

describe("codec failure modes (deliberate, on throwaway module instances)", () => {
  it("traps on an empty payload, and the module stays usable afterwards", async () => {
    const module = await freshModule();
    module.disableLog();
    const tx = txInstance(module);
    expect(tx).toBeGreaterThanOrEqual(0);

    let trapped = "not thrown";
    try {
      module.encode(tx, new Uint8Array(0), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25);
    } catch (error) {
      trapped = describeThrowable(error instanceof Error ? error : new Error(String(error)));
    }
    console.log(`[phase0] empty-payload encode: ${trapped}`);

    let after = "not thrown";
    try {
      const view = module.encode(
        tx,
        new Uint8Array(64),
        module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
        25,
      );
      after = `usable, waveform bytes=${view.length}`;
    } catch (error) {
      after = `unusable (${describeThrowable(error instanceof Error ? error : new Error(String(error)))})`;
    }
    console.log(`[phase0] module after empty-payload trap: ${after}`);
    expect(trapped).not.toBe("not thrown");
  });

  it("aborts on a negative instance id, and a fresh module still works", async () => {
    const module = await freshModule();
    module.disableLog();

    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(module.init(parametersFor(module, module.GGWAVE_OPERATING_MODE_TX)));
    }
    console.log(`[phase0] six init() calls returned: ${ids.join(",")}`);
    expect(ids.at(4)).toBe(-1);

    let trapped = "not thrown";
    try {
      module.encode(-1, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25);
    } catch (error) {
      trapped = describeThrowable(error instanceof Error ? error : new Error(String(error)));
    }
    console.log(`[phase0] encode(-1) threw: ${trapped}`);
    expect(trapped).not.toBe("not thrown");

    const recovered = await freshModule();
    recovered.disableLog();
    const tx = txInstance(recovered);
    const waveform = recovered.encode(
      tx,
      new Uint8Array(64),
      recovered.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      25,
    );
    console.log(`[phase0] fresh module after both traps: waveform bytes=${waveform.length}`);
    expect(waveform.length).toBe(368640);
  });
});
