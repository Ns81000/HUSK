/**
 * Phase 4V deep dive — the two helpers the fix added or leaned on:
 * `drain.ts` (new in `090e149`, replacing fourteen local copies) and
 * `ListenHandle.pausedUntilSeconds` (the fact `#airIsOurs()` reads).
 *
 * Nothing here needs a session: the drain is a pure async helper and the
 * `pausedUntilSeconds` contract is a property of `startListening`'s pause
 * arithmetic. The room clock is a plain mutable number, because the pause is read
 * off `context.currentTime` and the tests need to sit exactly on its boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RX_PAUSE_TAIL_SECONDS, startListening, transmitAndPause } from "./audio-io";
import type { SoundChatCodec } from "./codec";
import { DRAIN_QUIET_MS, drainAsync } from "./drain";

const SAMPLE_FRAME = 1024;
const BLOCK_SAMPLES = 90 * SAMPLE_FRAME;

let roomClock = 0;

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

class FakeAudioContext {
  readonly sampleRate = 48_000;
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  /** Set by a test to make the next `createBuffer` throw. */
  breakOnCreateBuffer = false;

  get currentTime(): number {
    return roomClock;
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: (): void => {}, disconnect: (): void => {} };
  }

  createScriptProcessor(size: number): FakeProcessor {
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 0 }, connect: (): void => {}, disconnect: (): void => {} };
  }

  createBuffer(): { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } {
    if (this.breakOnCreateBuffer) {
      this.breakOnCreateBuffer = false;
      throw new Error("InvalidStateError: the AudioContext is closed");
    }
    const buffer: { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } = {
      copied: [],
      copyToChannel: (): void => {},
    };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as unknown,
      connect: (): unknown => source,
      start: (): void => {},
    };
    return source;
  };
}

function stubCodec(): SoundChatCodec {
  const audio = new Float32Array(BLOCK_SAMPLES);
  return {
    state: "ready",
    encode: (): Float32Array => audio,
    decode: (): Uint8Array | null => null,
  } as unknown as SoundChatCodec;
}

function stubStream(): MediaStream {
  const track = { stops: 0, stop: (): void => undefined };
  const tracks = [track];
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

afterEach(() => {
  vi.useRealTimers();
  roomClock = 0;
});

describe("pausedUntilSeconds — the fact #airIsOurs() reads", () => {
  it("is 0 before any pause, and `paused` is false even at currentTime 0", () => {
    roomClock = 0;
    const listen = startListening({
      context: new FakeAudioContext() as unknown as AudioContext,
      stream: stubStream(),
      codec: stubCodec(),
      onDecoded: (): void => undefined,
    });
    // `0 < 0` is false, so a session that has never transmitted believes the air
    // is its own. A different sentinel (say -1 or Infinity) would be a second
    // truth; 0 is the only value `paused` is already defined against.
    expect(listen.pausedUntilSeconds).toBe(0);
    expect(listen.paused).toBe(false);
    listen.stop();
  });

  it("is the block plus the measured tail, read off the AudioContext clock", () => {
    roomClock = 7;
    const context = new FakeAudioContext();
    const listen = startListening({
      context: context as unknown as AudioContext,
      stream: stubStream(),
      codec: stubCodec(),
      onDecoded: (): void => undefined,
    });
    const played = transmitAndPause(
      listen,
      context as unknown as AudioContext,
      stubCodec(),
      new Uint8Array(64),
    );
    expect(played.durationMs).toBe(1_920);
    expect(listen.pausedUntilSeconds).toBe(7 + 1.92 + RX_PAUSE_TAIL_SECONDS);
    expect(listen.paused).toBe(true);
    // The instant it expires, `paused` is false — which is the whole contract
    // `#rearmQuietWhenOurSpeakerIsFree` computes its wall-clock delay against.
    roomClock = listen.pausedUntilSeconds;
    expect(listen.paused).toBe(false);
    roomClock = listen.pausedUntilSeconds - 0.001;
    expect(listen.paused).toBe(true);
    listen.stop();
  });

  it("a later, shorter pause never shortens an earlier one", () => {
    roomClock = 0;
    const context = new FakeAudioContext();
    const listen = startListening({
      context: context as unknown as AudioContext,
      stream: stubStream(),
      codec: stubCodec(),
      onDecoded: (): void => undefined,
    });
    listen.pause(4);
    const long = listen.pausedUntilSeconds;
    expect(long).toBe(4 + RX_PAUSE_TAIL_SECONDS);
    roomClock = 1;
    listen.pause(1);
    // `Math.max` in `pause()` is what makes this true, and it is the reason a
    // second block of a multi-block message can pass `pauseSeconds = 0` without
    // dropping the window the first block armed.
    expect(listen.pausedUntilSeconds).toBe(long);
    roomClock = 4.5;
    listen.pause(4);
    expect(listen.pausedUntilSeconds).toBe(4.5 + 4 + RX_PAUSE_TAIL_SECONDS);
    listen.stop();
  });

  it("leaves a stale value on the handle after stop(), which the session must not read", () => {
    roomClock = 0;
    const context = new FakeAudioContext();
    const listen = startListening({
      context: context as unknown as AudioContext,
      stream: stubStream(),
      codec: stubCodec(),
      onDecoded: (): void => undefined,
    });
    listen.pause(2);
    listen.stop();
    // Stale by design: the handle is a snapshot of the pause, not a live query.
    // `SoundChatSession.stop()` and `#moduleFailed` both null `#listen`, so
    // `#speakerBusy()`'s `?? false` is what makes this harmless — pinned in
    // `deep-p4v-turn.test.ts` ("F7"), where a restarted session transmits at once.
    expect(listen.pausedUntilSeconds).toBeGreaterThan(0);
  });
});

describe("drainAsync — the one shared drain", () => {
  it("waits the full turn floor with no activity signature, and no more", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      await drainAsync();
      // The `streak = activity === undefined ? 0` branch: with nothing to detect
      // change with, the floor is the whole condition. 256 turns, not 256+32.
      expect(immediate.mock.calls.length).toBe(256);
    } finally {
      immediate.mockRestore();
    }
  });

  it("a constant signature also stops at the floor", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      await drainAsync({ activity: () => "" });
      expect(immediate.mock.calls.length).toBe(256);
    } finally {
      immediate.mockRestore();
    }
  });

  it("still bounds a chain that never settles", async () => {
    let spin = 0;
    // A signature that changes on every observation: the streak can never reach
    // 32, so the turn cap is the only thing that ends this.
    await expect(drainAsync({ activity: () => String(spin++) })).rejects.toThrow(/never settled/);
  });

  it("the wall-clock floor is unreachable when `Date` is faked", async () => {
    // The second loop needs its own bounds, exactly like the first: a suite that
    // installs vitest's *default* fake timers fakes `Date`, so the floor is never
    // reached and an unbounded loop here would spin until the test's own timeout
    // — a hang reported as a timeout rather than as the clock problem it is. The
    // two current `quietMs` callers both use `toFake: ["setTimeout", "clearTimeout"]`,
    // so this is a trap for the next caller rather than a live failure; the turn
    // cap and deadline are what make it one that costs turns instead of hanging.
    //
    // FIXED IN PHASE 4V: the second loop originally had neither guard.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    let settled = false;
    const drain = drainAsync({ activity: () => "x", quietMs: DRAIN_QUIET_MS }).then(() => {
      settled = true;
    });
    // Generous enough for the drain's own turn floor (256), its quiet streak (32)
    // and then the floor loop's own cap (16 000) — the point is only that it
    // terminates, not that it is fast.
    for (let turn = 0; turn < 20_000 && !settled; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(settled, "the wall-clock floor loop is bounded even when its clock cannot move").toBe(
      true,
    );
    await drain;
  });

  it("with a real clock the wall-clock floor is honoured and then returns", async () => {
    const startedAt = Date.now();
    await drainAsync({ activity: () => "x", quietMs: DRAIN_QUIET_MS });
    // Costs real time on purpose (the header says ~25 ms a call).
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DRAIN_QUIET_MS - 5);
  });
});
