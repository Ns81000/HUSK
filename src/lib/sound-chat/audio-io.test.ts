import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioContextRateError,
  createAudioContext,
  ensureRunning,
  onVisibilityChange,
  requestMicrophoneAccess,
  RX_PAUSE_TAIL_SECONDS,
  startListening,
  teardownAudio,
  transmit,
  transmitAndPause,
} from "./audio-io";
import type { SoundChatCodec } from "./codec";

type MockTrack = { stop: ReturnType<typeof vi.fn>; label: string };
type MockStream = { getAudioTracks: () => MockTrack[]; getTracks: () => MockTrack[] };

function mockStream(): { stream: MockStream; track: MockTrack } {
  const track: MockTrack = { stop: vi.fn(), label: "fake-mic" };
  return { stream: { getAudioTracks: () => [track], getTracks: () => [track] }, track };
}

type MockProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

class MockAudioContext {
  readonly sampleRate: number;
  state = "running";
  currentTime = 10;
  closed = false;
  resumeCalls = 0;
  readonly destination = { kind: "destination" };
  readonly processors: MockProcessor[] = [];
  readonly buffers: { length: number; sampleRate: number; copied: Float32Array[] }[] = [];
  readonly startedSources: { connectedTo: unknown; started: boolean }[] = [];

  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
  }

  async resume(): Promise<AudioContext> {
    this.resumeCalls += 1;
    this.state = "running";
    return this as unknown as AudioContext;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  createMediaStreamSource(_stream: MediaStream) {
    return { connect: (node: unknown) => node, disconnect: () => {} };
  }

  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number) {
    if (bufferSize !== 1024 || inputChannels !== 1 || outputChannels !== 1) {
      throw new Error(
        `unexpected processor shape ${bufferSize}/${inputChannels}/${outputChannels}`,
      );
    }
    const processor: MockProcessor = {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const buffer: {
      length: number;
      sampleRate: number;
      copied: Float32Array[];
      copyToChannel: (samples: Float32Array) => void;
    } = { length, sampleRate, copied: [], copyToChannel: () => {} };
    buffer.copyToChannel = (samples: Float32Array) => {
      buffer.copied.push(samples);
    };
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource() {
    const source: {
      buffer: unknown;
      connectedTo: unknown;
      started: boolean;
      start: () => void;
      connect: (node: unknown) => unknown;
    } = {
      buffer: null,
      connectedTo: null,
      started: false,
      start: () => {},
      connect: () => source,
    };
    source.connect = (node: unknown) => {
      source.connectedTo = node;
      return source;
    };
    source.start = () => {
      source.started = true;
    };
    this.startedSources.push(source);
    return source;
  }
}

function stubNavigator(mediaDevices: unknown): void {
  vi.stubGlobal("navigator", { mediaDevices });
}

function stubDocument(visibilityState: string): { handler: () => void; removed: number } {
  const state = { handler: () => {}, removed: 0 };
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type: string, handler: () => void) => {
      state.handler = handler;
    },
    removeEventListener: () => {
      state.removed += 1;
    },
  });
  return state;
}

const constructorCalls: { sampleRate: number }[] = [];
const createdContexts: MockAudioContext[] = [];
let forcedRate: number | null = null;

beforeEach(() => {
  constructorCalls.length = 0;
  createdContexts.length = 0;
  forcedRate = null;
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor(options: { sampleRate: number }) {
        constructorCalls.push(options);
        const context = new MockAudioContext({ sampleRate: forcedRate ?? options.sampleRate });
        createdContexts.push(context);
        return context;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("microphone access", () => {
  it("grants with the clean capture constraints", async () => {
    const { stream } = mockStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    stubNavigator({ getUserMedia });
    const access = await requestMicrophoneAccess();
    expect(access).toEqual({ kind: "granted", stream });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  });

  it("maps a refused permission to denied", async () => {
    stubNavigator({
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("nope", "NotAllowedError")),
    });
    const access = await requestMicrophoneAccess();
    expect(access.kind).toBe("denied");
    expect(access.kind === "denied" && access.cause).toContain("NotAllowedError");
  });

  it("maps a missing device to missing", async () => {
    stubNavigator({
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("none", "NotFoundError")),
    });
    const access = await requestMicrophoneAccess();
    expect(access.kind).toBe("missing");
  });

  it("maps an absent mediaDevices to unsupported", async () => {
    stubNavigator(undefined);
    const access = await requestMicrophoneAccess();
    expect(access.kind).toBe("unsupported");
  });
});

describe("audio context", () => {
  it("is created at exactly 48000 Hz", () => {
    stubNavigator(undefined);
    const context = createAudioContext();
    expect(constructorCalls).toEqual([{ sampleRate: 48000 }]);
    expect(context.sampleRate).toBe(48000);
  });

  it("rejects a context the browser forced to another rate", () => {
    stubNavigator(undefined);
    forcedRate = 44100;
    expect(() => createAudioContext()).toThrowError(AudioContextRateError);
    expect(createdContexts.at(-1)?.closed).toBe(true);
  });

  it("resumes a suspended context on demand", async () => {
    stubNavigator(undefined);
    createAudioContext();
    const context = createdContexts.at(-1) as unknown as MockAudioContext;
    context.state = "suspended";
    const resumed = await ensureRunning(context as unknown as AudioContext);
    expect(resumed).toBe(context);
    expect(context.resumeCalls).toBe(1);
  });
});

function listeningSetup(options?: { sampleRate?: number; decode?: () => Uint8Array | null }) {
  const { stream } = mockStream();
  const context = new MockAudioContext({ sampleRate: options?.sampleRate ?? 48000 });
  const onDecoded = vi.fn();
  const onModuleError = vi.fn();
  const decode = vi.fn((chunk: Float32Array): Uint8Array | null =>
    options?.decode ? options.decode() : null,
  );
  const codec = { decode, encode: vi.fn() } as unknown as SoundChatCodec;
  const handle = startListening({
    context: context as unknown as AudioContext,
    stream: stream as unknown as MediaStream,
    codec,
    onDecoded,
    onModuleError,
  });
  return { context, codec, decode, onDecoded, onModuleError, handle, stream };
}

function fireChunk(processor: MockProcessor, length = 1024): void {
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(length) } });
}

describe("listening", () => {
  function setupFor(options?: Parameters<typeof listeningSetup>[0]) {
    const setup = listeningSetup(options);
    const processor = setup.context.processors[0];
    if (processor === undefined) throw new Error("no processor created");
    return { ...setup, processor };
  }

  it("creates the locked 1024/1/1 processor and feeds one chunk per callback", () => {
    const { processor, decode, onDecoded, handle } = setupFor();
    fireChunk(processor);
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls.every((call) => (call[0] as Float32Array).length === 1024)).toBe(true);
    expect(handle.chunks).toBe(2);
    expect(onDecoded).not.toHaveBeenCalled();
  });

  it("delivers a decoded payload to the listener", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const { processor, onDecoded } = setupFor({ decode: () => payload });
    fireChunk(processor);
    expect(onDecoded).toHaveBeenCalledWith(payload);
  });

  it("pauses the Rx feed for the transmit window plus tail and resumes after", () => {
    const { context, processor, decode, handle } = setupFor();
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(1);

    handle.pause(1);
    expect(handle.paused).toBe(true);
    fireChunk(processor);
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(handle.skippedWhilePaused).toBe(2);

    context.currentTime = 10 + 1 + RX_PAUSE_TAIL_SECONDS + 0.01;
    expect(handle.paused).toBe(false);
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("reports the module dead once a codec call throws and stops feeding it", () => {
    const { processor, decode, onModuleError } = setupFor({
      decode: () => {
        throw new Error("wasm trap");
      },
    });
    fireChunk(processor);
    expect(onModuleError).toHaveBeenCalledTimes(1);
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("stops everything, including the media track, on stop()", () => {
    const { processor, decode, handle, stream } = setupFor();
    fireChunk(processor);
    handle.stop();
    expect(processor.onaudioprocess).toBeNull();
    expect(stream.getTracks().every((each) => each.stop.mock.calls.length > 0)).toBe(true);
    fireChunk(processor);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(handle.chunks).toBe(1);
  });
});

describe("transmit", () => {
  it("plays one encoded block through a 48000 Hz buffer", () => {
    const samples = new Float32Array(4800);
    const codec = { encode: vi.fn(() => samples) } as unknown as SoundChatCodec;
    const context = new MockAudioContext({ sampleRate: 48000 });
    const result = transmit(context as unknown as AudioContext, codec, new Uint8Array(64));
    expect(result).toEqual({ sampleCount: 4800, durationMs: 100 });
    expect(context.buffers[0]?.length).toBe(4800);
    // The buffer gets a fresh copy of the encoded samples, not the same view.
    expect(context.buffers[0]?.copied[0]).toEqual(samples);
    const source = context.startedSources[0];
    expect(source?.started).toBe(true);
    expect(source?.connectedTo).toBe(context.destination);
  });

  it("pauses the Rx feed before the sound starts, for the window plus tail", () => {
    const samples = new Float32Array(4800);
    const codec = { encode: vi.fn(() => samples) } as unknown as SoundChatCodec;
    const { handle } = listeningSetup();
    // Rebuild the context the handle captured so both sides share the clock.
    const context = new MockAudioContext({ sampleRate: 48000 });
    const result = transmitAndPause(
      handle,
      context as unknown as AudioContext,
      codec,
      new Uint8Array(64),
    );
    expect(result.durationMs).toBe(100);
    expect(handle.paused).toBe(true);
    expect(context.startedSources[0]?.started).toBe(true);
  });
});

describe("teardown and visibility", () => {
  it("tears down partially-built sessions safely", () => {
    const { handle, stream, context } = listeningSetup();
    teardownAudio(handle, context as unknown as AudioContext);
    expect(stream.getTracks().every((each) => each.stop.mock.calls.length > 0)).toBe(true);
    expect(context.closed).toBe(true);
    teardownAudio(undefined, undefined);
  });

  it("subscribes to visibility changes and unsubscribes", () => {
    const doc = stubDocument("visible");
    const seen: boolean[] = [];
    const unsubscribe = onVisibilityChange((hidden) => seen.push(hidden));
    doc.handler();
    expect(seen).toEqual([false]);
    unsubscribe();
    expect(doc.removed).toBe(1);
  });
});
