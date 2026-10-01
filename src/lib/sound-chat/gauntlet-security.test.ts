/**
 * Phase 4 gauntlet — subagent 4, **SECURITY / CRYPTO**.
 *
 * Every `it` here is an attack against master plan Section 10.2 P1-P9, not a
 * feature check. The scope is the security surface only: the pairing code, the
 * key schedule, the nonce space, frame authentication, replay, the pairing
 * handshake's failure modes, and the "nothing secret leaves the device" rule.
 * Timing/capacity/a11y belong to other gauntlet subagents.
 *
 * Method: the product's own `derivePairingKeys`, `FrameCodec`, `InboundAssembler`,
 * `MessageIdAllocator` and `SoundChatSession` are used unmodified, with real
 * `crypto.subtle`. Only the *waveform* is stubbed (a loop codec whose `decode()`
 * hands over a chosen 64-byte block), because the measured truth this file
 * depends on is that a recording replays perfectly — so the interesting
 * question is never "does the tone arrive", it is "what does the receiver decide
 * once the bytes have".
 *
 * Known coverage NOT duplicated: `crypto.test.ts`, `deep-crypto-replay.test.ts`,
 * `deep-wire-hostile.test.ts`, `deep-verify-pair-challenge.test.ts`,
 * `deep-session-bounds.test.ts`, `protocol.test.ts`, `pairing.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import {
  AEAD_TAG_BYTES,
  buildNonce,
  derivePairingKeys,
  openBlock,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingCodeError,
  SESSION_SALT_BYTES,
  validatePairingCode,
  type PairingKeys,
  type RandomSource,
} from "./crypto";
import {
  FrameCodec,
  FRAME_KIND,
  HEADER_BYTES,
  InboundAssembler,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MessageIdAllocator,
  MessageIdExhaustedError,
  MULTI_BLOCK_PLAINTEXT_BYTES,
  MULTI_HEADER_BYTES,
  PAIR_BODY_BYTES,
  PAIR_KEY_CHECK_OFFSET,
  WIRE_BLOCK_BYTES,
  frameAad,
  type FrameRejection,
} from "./protocol";
import { SoundChatSession, TURN_GAP_MS, type SessionEvent } from "./session";
import { drainAsync } from "./drain.ts";

const CODE = "ABCD2345";
const OTHER_CODE = "ABCD2346";
const SAMPLE_FRAME = 1024;
const TEST_CHALLENGE = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);

const keys = await derivePairingKeys(CODE);
const otherKeys = await derivePairingKeys(OTHER_CODE);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function salt(byte: number): Uint8Array {
  return new Uint8Array(SESSION_SALT_BYTES).fill(byte);
}

function pad(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x41);
}

function flipped(source: Uint8Array, index: number, mask = 0x01): Uint8Array {
  const copy = Uint8Array.from(source);
  copy[index] = (copy[index] ?? 0) ^ mask;
  return copy;
}

/** One session's two codecs, paired the way the handshake pairs them. */
async function codecPair(
  selfByte: number,
  peerByte: number,
  schedule: PairingKeys = keys,
): Promise<{ a: FrameCodec; b: FrameCodec }> {
  const a = new FrameCodec({ keys: schedule, selfId: 0, sendSalt: salt(selfByte) });
  const b = new FrameCodec({ keys: schedule, selfId: 1, sendSalt: salt(peerByte) });
  a.adoptPeerSalt(salt(peerByte));
  b.adoptPeerSalt(salt(selfByte));
  return { a, b };
}

/* ------------------------------------------------------------------ harness */

type LoopCodec = {
  state: string;
  readonly txLog: Uint8Array[];
  readonly rxQueue: Uint8Array[];
  encode(payload: Uint8Array): Float32Array;
  decode(): Uint8Array | null;
};

function loopCodec(): LoopCodec {
  const txLog: Uint8Array[] = [];
  const rxQueue: Uint8Array[] = [];
  const audio = new Float32Array(SAMPLE_FRAME);
  return {
    state: "ready",
    txLog,
    rxQueue,
    encode(payload: Uint8Array): Float32Array {
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      txLog.push(Uint8Array.from(payload));
      return audio;
    },
    decode(): Uint8Array | null {
      return rxQueue.length > 0 ? (rxQueue.shift() as Uint8Array) : null;
    },
  };
}

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];

  get currentTime(): number {
    return roomClock;
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: (): void => {}, disconnect: (): void => {} };
  }

  createScriptProcessor(size: number): FakeProcessor {
    if (size !== SAMPLE_FRAME) throw new Error(`unexpected processor shape ${size}`);
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): {
    gain: { value: number };
    connect: (node: unknown) => void;
    disconnect: () => void;
  } {
    return { gain: { value: 0 }, connect: (): void => {}, disconnect: (): void => {} };
  }

  createBuffer(): { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } {
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
      buffer: null as { copied: Float32Array[] } | null,
      connect: () => source,
      start: (): void => {},
    };
    return source;
  };
}

function mockStream(): MediaStream {
  const track = { stop: (): void => {}, label: "fake-mic" };
  const tracks = [track];
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly codec: LoopCodec;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  takeAir: () => Uint8Array[];
  texts: () => string[];
  outboundStatus: (sendId: number) => string[];
  outboundEvents: () => Extract<SessionEvent, { type: "outbound" }>[];
  pairingKindCopy: () => string;
  unreadable: () => UnreadableReason[];
};

/** What a `heard-unreadable` event can name, exactly as the product types it. */
type UnreadableReason = FrameRejection | "conflicting-block";

const createdPeers: Peer[] = [];

async function createPeer(options: {
  label: string;
  role: "displayer" | "enterer";
  pairingCode?: string;
  random?: RandomSource;
}): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = loopCodec();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
    },
    ...(options.random === undefined ? {} : { random: options.random }),
  };
  const session = await SoundChatSession.create(
    options.pairingCode === undefined ? base : { ...base, pairingCode: options.pairingCode },
  );
  const peer: Peer = {
    label: options.label,
    context,
    codec,
    session,
    events,
    moduleErrors,
    listenerErrors,
    takeAir: () => codec.txLog.splice(0, codec.txLog.length),
    texts: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message" }> => event.type === "message",
        )
        .map((event) => event.text),
    outboundStatus: (sendId: number) =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "outbound" }> =>
            event.type === "outbound" && event.sendId === sendId,
        )
        .map((event) => event.status),
    outboundEvents: () =>
      events.filter(
        (event): event is Extract<SessionEvent, { type: "outbound" }> => event.type === "outbound",
      ),
    pairingKindCopy: () => session.pairingFailureMessage ?? "",
    unreadable: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "heard-unreadable" }> =>
            event.type === "heard-unreadable",
        )
        .map((event) => event.reason),
  };
  createdPeers.push(peer);
  return peer;
}

let roomClock = 10;
const MAX_FLUSH_TURNS = 16_000;
const SETTLE_FLOOR_TURNS = 512;

function activity(): string {
  let signature = "";
  for (const peer of createdPeers) {
    signature += [
      peer.session.state,
      peer.session.pairing.kind,
      peer.session.stats.blocksDecoded,
      peer.session.stats.messagesDelivered,
      peer.session.stats.duplicatesSuppressed,
      peer.events.length,
      peer.codec.txLog.length,
      peer.codec.rxQueue.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity, floorTurns: turns });
}

/**
 * A wall-clock ceiling, not only a turn count.
 *
 * `setImmediate` turns are not time: under CPU contention (this repo's suites
 * are load-sensitive and the full run executes them concurrently) 16000 turns
 * can elapse well before the async chain - which hands work to `crypto.subtle`
 * and libuv's threadpool - has finished. Measured: the sibling sound-chat
 * suites passed 6/6 in isolation and failed inside 1 of 4 full-suite runs, on
 * exactly that symptom. `MAX_FLUSH_TURNS` stays as a backstop so a spinning
 * loop still terminates; the deadline is what makes the wait mean what it says.
 */
const MAX_WAIT_MS = 20_000;

async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function feedChunk(peer: Peer): void {
  roomClock += SAMPLE_FRAME / 48_000;
  peer.context.processors[0]?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
  });
}

/** Feeds chosen blocks straight into a session's Rx path, one per chunk. */
async function deliverRaw(to: Peer, frames: Uint8Array[]): Promise<void> {
  if (frames.length === 0) return;
  to.codec.rxQueue.push(...frames.map((frame) => Uint8Array.from(frame)));
  roomClock += 3;
  for (let index = 0; index < frames.length; index += 1) feedChunk(to);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

async function air(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/**
 * Waits out the air window an unacknowledged transmission of ours holds open: one
 * block plus the measured tail.
 *
 * Separate from `air()` on purpose. `air()` moves exactly one turn gap, because
 * the pairing fixture's own `PAIR_CONFIRM_TIMEOUT_MS` (5840 ms) is close enough
 * to two of them that a larger step would expire the enterer's confirmation and
 * fail a handshake that is supposed to succeed. This helper is for the places
 * that genuinely need the longer window — a session that has just transmitted
 * something nobody acknowledged cannot take its next turn until its speaker is
 * silent again, and both clocks have to move for that.
 */
async function ownAir(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(3_000);
  await settle();
}

async function deliver(from: Peer, to: Peer): Promise<void> {
  await settle();
  const frames = from.takeAir();
  await deliverRaw(to, frames);
  await air();
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  await deliver(enterer, displayer);
  await air();
  // The displayer's answer only goes out on the quiet turn after it has heard the
  // request, so the second leg is the handshake, not a courtesy.
  await deliver(displayer, enterer);
  await air();
  if (displayer.session.pairing.kind !== "paired" || enterer.session.pairing.kind !== "paired") {
    throw new Error(
      `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
    );
  }
  displayer.takeAir();
  enterer.takeAir();
}

/**
 * A displayer paired with a `FrameCodec` this test controls completely, because
 * the code is in scope. Everything hostile afterwards — arbitrary msgIds, forged
 * ACKs, a second PAIR frame, an unknown kind — is one `build*` call away, and no
 * second 600k-iteration derivation is needed to get there.
 */
async function displayerWithHostilePeer(options?: {
  label?: string;
  random?: RandomSource;
  peerSaltByte?: number;
}): Promise<{ peer: Peer; peerCodec: FrameCodec }> {
  const peer = await createPeer({
    label: options?.label ?? "displayer",
    role: "displayer",
    pairingCode: CODE,
    ...(options?.random === undefined ? {} : { random: options.random }),
  });
  peer.session.start();
  await settle();
  const peerCodec = new FrameCodec({
    keys,
    selfId: 1,
    sendSalt: salt(options?.peerSaltByte ?? 0x31),
  });
  await deliverRaw(peer, [await peerCodec.buildPairFrame(TEST_CHALLENGE)]);
  expect(peer.session.pairing.kind, "the fixture must be paired").toBe("paired");
  peer.takeAir();
  return { peer, peerCodec };
}

function fixedRandom(value: number): RandomSource {
  return (out) => {
    out.fill(value);
    return out;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  vi.stubGlobal("document", undefined);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------- 1. the pairing code (P8) */

describe("P8 — a wrong, mistyped or wrong-role code fails closed", () => {
  it("refuses every shape that cannot be a code, and never echoes what was typed", () => {
    const refused: string[] = [
      "",
      "A",
      "ABCD234",
      "ABCD23456",
      "ABCD2345678901234",
      // The four characters deliberately absent from the alphabet, each of which
      // a human plausibly types for a visible one.
      "ABCD2340",
      "ABCD2341",
      "ABCDO345",
      "ABCDI345",
      // Homoglyphs: a Cyrillic A, a full-width A, and a Greek omicron.
      "АBCD2345",
      "ＡBCD2345",
      "ABСD2345",
      // A `ß` uppercases to two characters, so the length check has to happen
      // after normalisation, not before.
      "ßBCD2345ß",
      "AB CD2345X",
    ];
    for (const typed of refused) {
      let message = "";
      try {
        validatePairingCode(typed);
      } catch (error) {
        expect(error, `typing ${JSON.stringify(typed)} must not validate`).toBeInstanceOf(
          PairingCodeError,
        );
        message = error instanceof Error ? error.message : String(error);
      }
      // Either it threw, or the guard above already failed. The message must
      // never quote the code the user is holding (P9).
      expect(message, `no message for ${JSON.stringify(typed)}`).not.toBe("");
      expect(message).not.toContain(CODE);
      const normalised = typed.replace(/[\s-]/g, "");
      // Only a fragment long enough to identify a code is checked: "A" is a
      // substring of the sentence the length error is written in, and a
      // one-character fragment identifies nothing anyway.
      if (normalised.length >= 4 && normalised !== CODE) {
        expect(message, `${JSON.stringify(typed)} is echoed back`).not.toContain(normalised);
      }
    }
    // The one control: the canonical form validates and comes back normalised.
    expect(validatePairingCode("abcd 2345")).toBe(CODE);
    expect(validatePairingCode("ab-cd-2345")).toBe(CODE);
    expect(validatePairingCode("  abcd2345  ")).toBe(CODE);
  });

  it("gives a different key for one changed character at every position", async () => {
    // PBKDF2 at 600000 iterations is ~150 ms a derivation, so the whole
    // 8 x 32 substitution space cannot be swept; what is swept is one
    // substitution at each of the eight positions, which is the "one character
    // off" case Section 10.3 asks for. Each gets its own real derivation.
    const base = keys.directionKey;
    for (let position = 0; position < PAIRING_CODE_LENGTH; position += 1) {
      const replacement = CODE[position] === "A" ? "B" : "A";
      const mistyped = CODE.slice(0, position) + replacement + CODE.slice(position + 1);
      const mistypedKeys = await derivePairingKeys(mistyped);
      const nonce = buildNonce({ salt: salt(0x51), frameKind: 1, msgId: 11, seq: 0 });
      const aad = new Uint8Array([1, 0, 11, 0, 2]);
      const sealed = await sealForTest(await base(0), nonce, aad);
      expect(await openBlock(await mistypedKeys.directionKey(0), nonce, aad, sealed)).toEqual({
        ok: false,
        reason: "tag",
      });
    }
    // The control: two spellings of the same code are the same key.
    const spaced = await derivePairingKeys("ab cd 23 45");
    const nonce = buildNonce({ salt: salt(0x52), frameKind: 1, msgId: 12, seq: 0 });
    const aad = new Uint8Array([1, 0, 12, 0, 2]);
    const sealed = await sealForTest(await base(0), nonce, aad);
    expect(await openBlock(await spaced.directionKey(0), nonce, aad, sealed)).toMatchObject({
      ok: true,
    });
  }, 60_000);

  it("binds the role inside the tag, so a frame cannot claim the other role", async () => {
    const { a, b } = await codecPair(0x61, 0x62);
    // The displayer (peer 0) mints an answer; the enterer (peer 1) is the one
    // that must accept it, and does.
    const answer = await a.buildPairFrame(TEST_CHALLENGE);
    expect((await b.parse(answer)).ok).toBe(true);
    // The enterer's own request, reflected with its header rewritten to claim
    // peer 0, is structurally acceptable and still refused: the key check is
    // over `senderId`, so the role in the header and the role in the tag cannot
    // disagree.
    const request = await b.buildPairFrame(TEST_CHALLENGE);
    const lying = Uint8Array.from(request);
    lying[3] = 0;
    // A PAIR frame that reaches the key check and fails it reports the narrower
    // reason, so a wrong code stays diagnosable while ordinary noise does not.
    expect(await b.parse(lying)).toEqual({ ok: false, reason: "pair-key-failed" });
    // And the reverse reflection is refused one step earlier, structurally.
    expect(await b.parse(Uint8Array.from(request))).toEqual({ ok: false, reason: "bad-peer" });
  });
});

/** A two-byte body sealed with the real AEAD. */
async function sealForTest(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  // SAFETY: `Uint8Array.from` allocates a fresh, plain-`ArrayBuffer`-backed view,
  // which is a `BufferSource`; the parameters' generic `ArrayBufferLike` is what
  // TypeScript refuses to narrow, and nothing here is shared memory.
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(nonce),
      additionalData: Uint8Array.from(aad),
      tagLength: AEAD_TAG_BYTES * 8,
    },
    key,
    new Uint8Array([0x7a, 0x7b]),
  );
  return new Uint8Array(sealed);
}

/* ------------------------------------------------------- 2. tampering (P3) */

describe("P3 — no byte of a frame moves without failing the tag", () => {
  it("fails the tag for every header byte of every AEAD frame kind", async () => {
    const { a, b } = await codecPair(0x71, 0x72);
    const [single] = await a.buildMessageFrames(bytes("tamper"), 0x0301);
    const multi = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0302);
    const ack = await a.buildAckFrame(0x0303, 0b11);
    const samples: { name: string; frame: Uint8Array; header: number }[] = [
      { name: "MESSAGE", frame: single as Uint8Array, header: HEADER_BYTES },
      { name: "MULTI[0]", frame: multi[0] as Uint8Array, header: MULTI_HEADER_BYTES },
      { name: "MULTI[1]", frame: multi[1] as Uint8Array, header: MULTI_HEADER_BYTES },
      { name: "ACK", frame: ack, header: HEADER_BYTES },
    ];
    for (const { name, frame, header } of samples) {
      for (let index = 0; index < header; index += 1) {
        for (const mask of [0x01, 0x80]) {
          expect(
            (await b.parse(flipped(frame, index, mask))).ok,
            `${name}: header byte ${index} mask ${mask.toString(16)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("fails the tag for every ciphertext byte and every tag byte", async () => {
    const { a, b } = await codecPair(0x73, 0x74);
    const [single] = await a.buildMessageFrames(pad(43), 0x0401);
    const frame = single as Uint8Array;
    const len = frame[4] ?? 0;
    for (let index = HEADER_BYTES; index < HEADER_BYTES + len + AEAD_TAG_BYTES; index += 1) {
      const outcome = await b.parse(flipped(frame, index));
      expect(outcome, `body byte ${index}`).toEqual({ ok: false, reason: "auth-failed" });
    }
  });

  it("treats a re-pointed frame as a refusal, never as a different message", async () => {
    const { a, b } = await codecPair(0x75, 0x76);
    const [single] = await a.buildMessageFrames(pad(43), 0x0500);
    const multi = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0501);
    const first = multi[0] as Uint8Array;
    const second = multi[1] as Uint8Array;
    const block = single as Uint8Array;
    expect((await b.parse(block)).ok).toBe(true);
    expect((await b.parse(first)).ok).toBe(true);
    expect((await b.parse(second)).ok).toBe(true);
    // Re-addressed to the *other* block of the same message: `seq` is in the AAD
    // and in the nonce, so this is not "a duplicate of block 0".
    expect(await b.parse(flipped(second, 5, 0x10))).toEqual({
      ok: false,
      reason: "auth-failed",
    });
    // Both blocks re-sealed under a new msgId: impossible without the key, and
    // the AAD is what says so.
    expect(await b.parse(flipped(first, 2, 0x01))).toEqual({
      ok: false,
      reason: "auth-failed",
    });
    // A declared length one byte short moves the body end into the tag, so the
    // padding check refuses it before the key is touched.
    expect(await b.parse(flipped(block, 4, 0x01))).toEqual({
      ok: false,
      reason: "nonzero-padding",
    });
    // ...and one byte over is outside the capacity of the kind, refused
    // structurally. A 2-block frame is at its ceiling, so *any* change to its
    // `len` lands in the same bucket.
    for (const mask of [0x01, 0x80, 0x40]) {
      expect((await b.parse(flipped(first, 4, mask))).ok, `multi len ${mask}`).toBe(false);
    }
    // The frame kind is inside the AAD too: re-typing a multi-block block as a
    // single-block message is refused, not silently re-read at another offset.
    expect((await b.parse(flipped(first, 0, 0x02))).ok).toBe(false);
  });
});

/* ------------------------------------------- 3. cross-direction confusion (P1) */

describe("P1 — a Tx-direction key never opens the other direction", () => {
  it("refuses a frame sealed with the receiver's own send key, on identical bytes", async () => {
    const { a, b } = await codecPair(0x81, 0x82);
    const [genuine] = await a.buildMessageFrames(bytes("direction"), 0x0601);
    // `a` is peer 0; its own frame is refused structurally by itself.
    expect(await a.parse(genuine as Uint8Array)).toEqual({ ok: false, reason: "bad-peer" });
    // The same plaintext and msgId from the other direction is different bytes,
    // so a one-key design would have made these identical.
    const [theirs] = await b.buildMessageFrames(bytes("direction"), 0x0601);
    expect(Array.from(genuine as Uint8Array)).not.toEqual(Array.from(theirs as Uint8Array));

    // Now the decisive one. An envelope that claims to come from peer 1 — the
    // only peer this receiver will ever accept — built twice from the *same*
    // header, the same nonce and the same plaintext, and differing only in which
    // direction's key sealed it. Exactly one of them may open.
    const header = [FRAME_KIND.MESSAGE, 0x06, 0x01, 1, 2] as const;
    const fromDirection0 = await forgedFrame(
      header,
      await keys.directionKey(0),
      salt(0x82),
      0x0601,
    );
    const fromDirection1 = await forgedFrame(
      header,
      await keys.directionKey(1),
      salt(0x82),
      0x0601,
    );
    expect(Array.from(fromDirection0.subarray(HEADER_BYTES, HEADER_BYTES + 2))).not.toEqual(
      Array.from(fromDirection1.subarray(HEADER_BYTES, HEADER_BYTES + 2)),
    );
    expect((await a.parse(fromDirection1)).ok, "the peer's own key opens it").toBe(true);
    expect(await a.parse(fromDirection0)).toEqual({ ok: false, reason: "auth-failed" });
  });
});

/**
 * A complete, correctly shaped frame built from raw fields under a chosen key.
 * A test that holds the code can do this; an attacker who does not hold it
 * cannot, and every "it is just bytes" claim below is measured against exactly
 * this construction rather than a hand-edited copy.
 */
async function forgedFrame(
  header: readonly [number, number, number, number, number],
  key: CryptoKey,
  peerSalt: Uint8Array,
  msgId: number,
): Promise<Uint8Array> {
  const len = header[4];
  const paddingBytes = WIRE_BLOCK_BYTES - HEADER_BYTES - len - AEAD_TAG_BYTES;
  const aad = new Uint8Array(HEADER_BYTES + paddingBytes);
  aad.set(header, 0);
  const sealed = await sealForTest(
    key,
    buildNonce({ salt: peerSalt, frameKind: FRAME_KIND.MESSAGE, msgId, seq: 0 }),
    aad,
  );
  const frame = new Uint8Array(WIRE_BLOCK_BYTES);
  frame.set(header, 0);
  frame.set(sealed, HEADER_BYTES);
  return frame;
}

/* --------------------------------------- 4. nonce freshness across sessions (P2) */

describe("P2 — no key+nonce reuse across reload, restart and re-pairing", () => {
  it("draws a different salt, and so a different first msgId, for every session", async () => {
    // Three sessions on the *same* code, as a reload and a re-pairing would be.
    const sessions: SoundChatSession[] = [];
    for (let index = 0; index < 3; index += 1) {
      const peer = await createPeer({ label: `s${index}`, role: "displayer", pairingCode: CODE });
      sessions.push(peer.session);
    }
    const salts = sessions.map((session) => Array.from(session.sessionSalt));
    for (let left = 0; left < salts.length; left += 1) {
      for (let right = left + 1; right < salts.length; right += 1) {
        expect(salts[left], `salts ${left}/${right}`).not.toEqual(salts[right]);
      }
    }
    // The observable form of "the nonce moved": the same code, the same msgId and
    // the same plaintext produce different ciphertext in every session.
    const bodies = await Promise.all(
      sessions.map(async (session, index) => {
        const codec = new FrameCodec({ keys, selfId: 0, sendSalt: session.sessionSalt });
        const [frame] = await codec.buildMessageFrames(bytes("same message"), 0x0701);
        return Array.from((frame as Uint8Array).subarray(HEADER_BYTES, HEADER_BYTES + 8));
      }),
    );
    expect(bodies[0]).not.toEqual(bodies[1]);
    expect(bodies[0]).not.toEqual(bodies[2]);
    expect(bodies[1]).not.toEqual(bodies[2]);
  }, 30_000);

  it("cannot be made to cancel out: a fresh salt kills the two-time pad", async () => {
    // The catastrophic AES-GCM failure is same key + same nonce + different
    // plaintext. One changed session salt removes it, and that is the entire
    // defence P2 rests on.
    const first = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x91) });
    const second = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x92) });
    const [one] = await first.buildMessageFrames(bytes("AAAAAAAA"), 4242);
    const [two] = await second.buildMessageFrames(bytes("BBBBBBBB"), 4242);
    const bodyOne = (one as Uint8Array).subarray(HEADER_BYTES, HEADER_BYTES + 8);
    const bodyTwo = (two as Uint8Array).subarray(HEADER_BYTES, HEADER_BYTES + 8);
    const cancelled = bodyOne.map((byte, index) => byte ^ (bodyTwo[index] ?? 0));
    expect(cancelled).not.toEqual(new Uint8Array(8).fill(0x41 ^ 0x42));
  });

  it("aliases a truncated salt, which is why the session salt is 16 bytes", () => {
    // `buildNonce` accepts any salt of 8 bytes or more and only reads the first
    // 8, so an 8-byte and a 16-byte salt that agree on those 8 bytes produce the
    // *same* nonce. Reachable only by a direct caller: `FrameCodec` refuses
    // anything but 16. Recorded so the invariant is visible, not to fail.
    const eight = buildNonce({
      salt: new Uint8Array(8).fill(0x5a),
      frameKind: 1,
      msgId: 1,
      seq: 0,
    });
    const sixteen = buildNonce({ salt: salt(0x5a), frameKind: 1, msgId: 1, seq: 0 });
    expect(Array.from(eight)).toEqual(Array.from(sixteen));
    expect(() => new FrameCodec({ keys, selfId: 0, sendSalt: new Uint8Array(8) })).toThrowError(
      /session salt of 8 bytes/,
    );
  });
});

/* ---------------------------------------- 5. message id exhaustion (P2, P12) */

describe("the 16-bit message id space refuses to wrap", () => {
  it("hands out the last id and then refuses, never returning to zero", () => {
    const allocator = new MessageIdAllocator(0xffff);
    expect(allocator.next()).toBe(0xffff);
    expect(allocator.remaining).toBe(0);
    expect(() => allocator.next()).toThrowError(MessageIdExhaustedError);
    expect(() => new MessageIdAllocator(0x10000)).toThrowError(/16-bit/);
  });

  it("is reachable in the product: a session whose salt starts 0xffff has one id", async () => {
    // `MessageIdAllocator` is seeded from `salt[0] * 256 + salt[1]`, so a session
    // salt of ff ff ff ... starts the space at its very top. Reachable with an
    // injected `RandomSource`, which is a public option on the session.
    const { peer } = await displayerWithHostilePeer({
      label: "exhausted",
      random: fixedRandom(0xff),
    });
    const first = peer.session.send("the only id");
    expect(first.ok).toBe(true);
    const sendId = first.ok ? first.sendId : -1;
    await until("the first note to be sealed", () =>
      peer.outboundStatus(sendId).includes("sending"),
    );
    // The displayer's PAIR answer is still on the speaker — its Rx pause is armed
    // and its 1.92 s of audio has not finished — so the note is queued behind it
    // and goes out when that turn reopens. That is the behaviour: one
    // transmission of ours at a time, or the two sum at the speaker and neither
    // decodes. Both clocks must move for the re-armed quiet timer to fire.
    await ownAir();
    await until("the first note to reach the air", () => peer.codec.txLog.length > 0);
    const sealedMsgId = peer
      .outboundEvents()
      .find((event) => event.sendId === sendId && event.msgId !== null)?.msgId;
    expect(sealedMsgId).toBe(0xffff);
    // The second note is accepted by `send` and then retired by the pump, which
    // cannot allocate an id. It must be `failed` and reported on the consumer's
    // own channel — never a codec death, never a wrap to 0.
    const second = peer.session.send("no id left");
    expect(second.ok).toBe(true);
    // Free the first note honestly: the hostile peer acknowledges it, which is
    // the only thing that lets the queue move on to the exhausted allocation.
    const peerCodec = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x31) });
    await deliverRaw(peer, [await peerCodec.buildAckFrame(0xffff, 0b1)]);
    await until("the second note to be retired", () =>
      peer.outboundStatus(second.ok ? second.sendId : -1).includes("failed"),
    );
    const seenIds = peer
      .outboundEvents()
      .map((event) => event.msgId ?? -1)
      .filter((id) => id !== -1);
    expect(
      seenIds.every((id) => id === 0xffff),
      `ids used: ${seenIds.join(",")}`,
    ).toBe(true);
    expect(peer.session.stats.messagesDelivered).toBe(0);
    expect(peer.moduleErrors, "not a codec death").toEqual([]);
    expect(peer.listenerErrors.length, "the refusal is reported").toBeGreaterThan(0);
    expect(peer.session.state).toBe("listening");
  }, 30_000);
});

/* ------------------------------------------ 6. replay is the dedupe window (P4) */

describe("P4 — a captured transmission renders once, and only the dedupe window stops it", () => {
  it("decodes every replay, and the receiver is what refuses the second one", async () => {
    const { peer, peerCodec } = await displayerWithHostilePeer({ label: "replay" });
    const [captured] = await peerCodec.buildMessageFrames(bytes("recorded once"), 7);
    // The measured truth: the frame is authentic, so a recording of it *does*
    // decrypt. Nothing in the AEAD can tell it from a live transmission.
    expect((await peer.session.pairing.kind) === "paired").toBe(true);
    await deliverRaw(peer, [captured as Uint8Array]);
    expect(peer.texts()).toEqual(["recorded once"]);
    await deliverRaw(peer, [
      captured as Uint8Array,
      captured as Uint8Array,
      captured as Uint8Array,
    ]);
    // Rendered once. Everything after the first is a bounded, counted duplicate.
    expect(peer.texts()).toEqual(["recorded once"]);
    expect(peer.session.stats.duplicatesSuppressed).toBe(3);
    expect(peer.session.stats.messagesDelivered).toBe(1);
    // A replay of an *older* message is stale, not rendered, and not re-acked.
    const [older] = await peerCodec.buildMessageFrames(bytes("older"), 3);
    await deliverRaw(peer, [older as Uint8Array]);
    expect(peer.texts()).toEqual(["recorded once"]);
    expect(peer.session.stats.messagesDelivered).toBe(1);
  }, 30_000);

  it("fails the tag on a rewritten envelope, so a recording cannot be re-addressed", async () => {
    const { peer, peerCodec } = await displayerWithHostilePeer({ label: "envelope" });
    const multi = await peerCodec.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 9);
    // Rewrite the envelope in every way that keeps the ciphertext identical.
    const rewritten: { name: string; frame: Uint8Array }[] = [
      { name: "new msgId", frame: flipped(multi[1] as Uint8Array, 2, 0x7f) },
      { name: "new seq", frame: flipped(multi[1] as Uint8Array, 5, 0x10) },
      { name: "widened len", frame: flipped(multi[1] as Uint8Array, 4, 0x01) },
      { name: "narrowed len", frame: flipped(multi[1] as Uint8Array, 4, 0x80) },
      { name: "own salt", frame: flipped(multi[0] as Uint8Array, 0, 0x02) },
    ];
    await deliverRaw(
      peer,
      rewritten.map((entry) => entry.frame),
    );
    // Nothing at all was rendered, and nothing was acknowledged: an attacker
    // cannot make this device emit a frame in reply to a re-pointed recording.
    expect(peer.texts()).toEqual([]);
    expect(peer.session.stats.messagesDelivered).toBe(0);
    expect(peer.takeAir().length, "no acknowledgement was sent").toBe(0);
    for (const { name } of rewritten) {
      expect(peer.unreadable().length, `${name} must be reported unreadable`).toBeGreaterThan(0);
    }
    // And the genuine frame still works, so nothing above poisoned the session.
    await deliverRaw(peer, [multi[0] as Uint8Array, multi[1] as Uint8Array]);
    expect(peer.session.stats.messagesDelivered).toBe(1);
  }, 30_000);

  it("cannot be made to re-render a two-block message from its own halves", async () => {
    const assembler = new InboundAssembler();
    const { a } = await codecPair(0xa1, 0xa2);
    const frames = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 21);
    const half = (index: number, msgId: number) => ({
      msgId,
      blockIndex: index,
      blockCount: MAX_MESSAGE_BLOCKS,
      plaintext: (frames[index] as Uint8Array).subarray(
        MULTI_HEADER_BYTES,
        MULTI_HEADER_BYTES + MULTI_BLOCK_PLAINTEXT_BYTES,
      ),
    });
    // Block 1 alone never renders anything: the missing half is not guessed.
    expect(assembler.accept(half(1, 21)).status).toBe("partial");
    expect(assembler.partialCount).toBe(1);
    expect(assembler.accept(half(0, 21)).status).toBe("delivered");
    // A replay of both halves renders nothing a second time.
    for (let round = 0; round < 5; round += 1) {
      expect(assembler.accept(half(0, 21)).status).toBe("duplicate");
      expect(assembler.accept(half(1, 21)).status).toBe("duplicate");
    }
    // ...and the same halves re-addressed to a fresh id are a *different*
    // message, refused at the tag before they ever reach the assembler.
    const moved = flipped(frames[0] as Uint8Array, 2, 0x01);
    expect((await a.parse(moved)).ok).toBe(false);
  });
});

/* ----------------------------------- 7. nothing on the air moves after pairing */

describe("a second pairing attempt cannot move a running conversation", () => {
  it("ignores a valid PAIR frame with a new salt, and a wrong-code one, once paired", async () => {
    const { peer, peerCodec } = await displayerWithHostilePeer({ label: "re-pair" });
    const paired = peer.session.pairing;
    if (paired.kind !== "paired") throw new Error("fixture is not paired");
    const adopted = Array.from(paired.peerSalt);

    // A *valid* PAIR frame under the same code, with a different salt: this is
    // exactly what a re-pairing looks like on the air.
    const impostor = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x77) });
    await deliverRaw(peer, [await impostor.buildPairFrame(TEST_CHALLENGE)]);
    // A PAIR frame under a different code, and one claiming our own role.
    const stranger = new FrameCodec({ keys: otherKeys, selfId: 1, sendSalt: salt(0x78) });
    const wrongCode = await stranger.buildPairFrame(TEST_CHALLENGE);
    const wrongRole = flipped(await peerCodec.buildPairFrame(TEST_CHALLENGE), 3, 0x01);
    await deliverRaw(peer, [wrongCode, wrongRole]);

    const after = peer.session.pairing;
    if (after.kind !== "paired") throw new Error(`pairing moved: ${after.kind}`);
    expect(Array.from(after.peerSalt), "the nonce space did not move").toEqual(adopted);
    // Not a codec failure either: a second salt is our own misuse, and the
    // guard above exists so it never reaches the codec.
    expect(peer.moduleErrors).toEqual([]);
    // The conversation still works in both directions.
    const [fromPeer] = await peerCodec.buildMessageFrames(bytes("still here"), 40);
    await deliverRaw(peer, [fromPeer as Uint8Array]);
    expect(peer.texts()).toEqual(["still here"]);
  }, 30_000);
});

/* ------------------------ 8. the unauthenticated pairing denial (now FIXED) */

describe("FIXED — one crafted block no longer kills a pairing handshake", () => {
  /**
   * The cheapest block the codec will carry: a legal MESSAGE header for the
   * peer's own id, and nothing else. It is not a PAIR frame, it is not a
   * recording, and it is not authenticated.
   *
   * This describe block was originally written as the *finding*: an unpaired
   * codec has no peer salt, so every AEAD frame is `auth-failed`, and the
   * driver read that as "the code is wrong". The assertions below are the
   * inverted pin — the attack is now refused, and these tests fail the moment
   * it works again. The asymmetry that makes this sound is a conclusion rather
   * than an absence is `protocol.ts`'s `pair-key-failed`, which only a
   * well-formed PAIR frame can produce.
   */
  function unauthenticatedBlock(fromPeerId: 0 | 1, kind: number, len: number): Uint8Array {
    const block = new Uint8Array(64);
    block[0] = kind;
    block[3] = fromPeerId;
    block[4] = len;
    return block;
  }

  it("leaves a waiting displayer pairing, and the genuine peer still gets in", async () => {
    const displayer = await createPeer({ label: "victim-d", role: "displayer", pairingCode: CODE });
    displayer.session.start();
    await settle();
    expect(displayer.session.pairing.kind).toBe("waiting-for-peer");
    const playsBefore = displayer.codec.txLog.length;

    // The attacker knows neither the code nor the salt, and guesses only which of
    // the two peer ids is "the other one". 1 is the displayer's peer.
    await deliverRaw(displayer, [unauthenticatedBlock(1, FRAME_KIND.MESSAGE, 43)]);

    // The handshake survives, and nothing is claimed about the other device.
    expect(displayer.session.pairing.kind).toBe("waiting-for-peer");
    expect(displayer.session.pairingFailureMessage).toBeNull();
    // It is still reported as "something was heard that we cannot read" (P5/P6)…
    expect(displayer.unreadable()).toEqual(["auth-failed"]);
    // …never as a codec death, and never answered with a transmission of its own.
    expect(displayer.moduleErrors).toEqual([]);
    expect(displayer.codec.txLog.length).toBe(playsBefore);

    // The genuine peer, arriving afterwards with a perfect PAIR frame, is let in —
    // this is the part the old behaviour destroyed.
    const enterer = await createPeer({ label: "victim-e", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await until(
      "the enterer's PAIR request to reach the air",
      () => enterer.codec.txLog.length > 0,
    );
    const genuine = enterer.takeAir();
    expect(genuine[0]?.[0]).toBe(FRAME_KIND.PAIR);
    await deliverRaw(displayer, genuine);
    expect(displayer.session.pairing.kind, "the real peer is admitted").toBe("paired");
  }, 30_000);

  it("leaves a waiting enterer pairing too, but a bad PAIR key check is still caught", async () => {
    const enterer = await createPeer({ label: "victim-e2", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await settle();
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    // fromPeerId 0 is the enterer's peer. A MESSAGE header is not enough any more.
    await deliverRaw(enterer, [unauthenticatedBlock(0, FRAME_KIND.MESSAGE, 43)]);
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    expect(enterer.session.pairingFailureMessage).toBeNull();

    // A PAIR frame with a garbage key check *is* the shape a real peer sends, and
    // that is a conclusion the UI may still report: this legitimate diagnosis
    // survives the fix. (Only an attacker who already holds the code can forge
    // one that verifies, which is the separate, documented Section 4 residual.)
    const second = await createPeer({ label: "victim-e3", role: "enterer", pairingCode: CODE });
    second.session.start();
    await settle();
    const frame = unauthenticatedBlock(0, FRAME_KIND.PAIR, PAIR_BODY_BYTES);
    frame[PAIR_KEY_CHECK_OFFSET] = 0xff;
    await deliverRaw(second, [frame]);
    expect(second.session.pairing.kind).toBe("failed");
    expect(second.session.pairingFailureMessage).toContain("different pairing code");

    // Precise: nothing refused earlier touches the handshake either.
    const third = await createPeer({ label: "victim-e4", role: "enterer", pairingCode: CODE });
    third.session.start();
    await settle();
    const harmless: { name: string; block: Uint8Array }[] = [
      { name: "all zero", block: new Uint8Array(64) },
      { name: "all ones", block: new Uint8Array(64).fill(0xff) },
      { name: "unknown kind 0", block: unauthenticatedBlock(0, 0, 0) },
      { name: "unknown kind 5", block: unauthenticatedBlock(0, 5, 43) },
      { name: "wrong peer", block: unauthenticatedBlock(1, FRAME_KIND.MESSAGE, 43) },
      { name: "illegal len", block: unauthenticatedBlock(0, FRAME_KIND.MESSAGE, 0) },
      { name: "pair with bad msgId", block: blockWithPairMsgId(1) },
    ];
    await deliverRaw(
      third,
      harmless.map((entry) => entry.block),
    );
    expect(third.session.pairing.kind, "noise alone does not kill a handshake").toBe(
      "awaiting-confirmation",
    );
  }, 30_000);

  it("does not touch a session that is already paired", async () => {
    const { peer } = await displayerWithHostilePeer({ label: "already-paired" });
    const playsBefore = peer.codec.txLog.length;
    for (let round = 0; round < 5; round += 1) {
      await deliverRaw(peer, [unauthenticatedBlock(1, FRAME_KIND.MESSAGE, 43)]);
    }
    expect(peer.session.pairing.kind).toBe("paired");
    expect(peer.session.state).toBe("listening");
    expect(peer.texts()).toEqual([]);
    expect(peer.moduleErrors).toEqual([]);
    // No acknowledgement, no re-acknowledgement: an unreadable block never puts
    // this device on the air.
    expect(peer.codec.txLog.length, "no transmission was triggered").toBe(playsBefore);
    expect(peer.session.stats.acksSent).toBe(0);
  }, 30_000);
});

function blockWithPairMsgId(fromPeerId: 0 | 1): Uint8Array {
  const block = new Uint8Array(64);
  block[0] = FRAME_KIND.PAIR;
  block[1] = 0;
  block[2] = 1; // a PAIR frame must carry msgId 0
  block[3] = fromPeerId;
  block[4] = PAIR_BODY_BYTES;
  return block;
}

/* ------------------------------------- 9. the documented responder-side residual */

describe("the Section 4 responder residual, measured", () => {
  it("is a denial the attacker can escalate into a forgery — 'nothing is forged' is false", async () => {
    // A real handshake, recorded exactly as it went on the air.
    const displayer1 = await createPeer({ label: "d1", role: "displayer", pairingCode: CODE });
    const enterer1 = await createPeer({ label: "e1", role: "enterer", pairingCode: CODE });
    await pairUp(displayer1, enterer1);
    enterer1.session.send("session one");
    await settle();
    const recorded = enterer1.takeAir();
    expect(recorded[0]?.[0]).toBe(FRAME_KIND.MESSAGE);
    // The *PAIR request* is the part an attacker re-uses, and a codec mints a
    // byte-identical one: the key check is not AEAD and carries no nonce.
    const recordedRequest = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0xb1) });
    const replayable = await recordedRequest.buildPairFrame(TEST_CHALLENGE);
    const staleSalt = Array.from(
      replayable.subarray(HEADER_BYTES, HEADER_BYTES + SESSION_SALT_BYTES),
    );

    // Session 2: a brand-new displayer, same code, waiting for a peer.
    const displayer2 = await createPeer({ label: "d2", role: "displayer", pairingCode: CODE });
    displayer2.session.start();
    await settle();
    await deliverRaw(displayer2, [replayable, replayable]);
    // (a) THE DOCUMENTED PART, unchanged: the responder adopts the recorded salt.
    const paired = displayer2.session.pairing;
    expect(paired.kind, "the residual is still exactly as documented").toBe("paired");
    if (paired.kind === "paired") expect(Array.from(paired.peerSalt)).toEqual(staleSalt);

    // (b) The genuine peer is refused rather than silently paired.
    const enterer2 = await createPeer({ label: "e2", role: "enterer", pairingCode: CODE });
    enterer2.session.start();
    await until("the genuine PAIR request to reach the air", () => enterer2.codec.txLog.length > 0);
    await deliverRaw(displayer2, enterer2.takeAir());
    const still = displayer2.session.pairing;
    if (still.kind !== "paired") throw new Error("pairing moved");
    expect(Array.from(still.peerSalt), "the real peer's salt was refused").toEqual(staleSalt);
    expect(displayer2.moduleErrors, "and it was refused quietly, not as a crash").toEqual([]);

    // (c) THE PART THE PLAN SAYS CANNOT HAPPEN. The attacker holds the code (the
    // documented prerequisite) and now holds the responder's Rx nonce space, so
    // it can mint frames the responder renders as authentic peer messages.
    const attacker = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0xb1) });
    const [forged] = await attacker.buildMessageFrames(
      bytes("the account details are in the usual place"),
      0x1234,
    );
    await deliverRaw(displayer2, [forged as Uint8Array]);
    expect(displayer2.texts(), "a forged message is rendered as the peer's").toEqual([
      "the account details are in the usual place",
    ]);
    // The forgery needs the code: without it the same envelope fails its tag, so
    // this is a 40-bit-gate, not an unauthenticated one.
    const withoutCode = new FrameCodec({ keys: otherKeys, selfId: 1, sendSalt: salt(0xb1) });
    const [blind] = await withoutCode.buildMessageFrames(bytes("guessed"), 0x1235);
    await deliverRaw(displayer2, [blind as Uint8Array]);
    expect(displayer2.texts()).toHaveLength(1);

    // (d) And the read side: what the fooled user *sends* is decryptable by the
    // same attacker, because the displayer's own salt went out in its answer and
    // its msgIds are derived from that same salt.
    const secret = "my code is 4419";
    displayer2.takeAir();
    displayer2.session.send(secret);
    await until("the note to reach the air", () => displayer2.codec.txLog.length > 0);
    const onTheAir = displayer2.takeAir();
    const first = onTheAir[0];
    if (first === undefined) throw new Error("nothing was transmitted");
    const msgId = ((first[1] ?? 0) << 8) | (first[2] ?? 0);
    // The seed is `salt[0] * 256 + salt[1]`, and this is the first message.
    expect(msgId).toBe(
      (displayer2.session.sessionSalt[0] ?? 0) * 256 + (displayer2.session.sessionSalt[1] ?? 0),
    );
    const len = first[4] ?? 0;
    const opened = await openBlock(
      await keys.directionKey(0),
      buildNonce({ salt: displayer2.session.sessionSalt, frameKind: 1, msgId, seq: 0 }),
      frameAad(first, HEADER_BYTES, len),
      first.subarray(HEADER_BYTES, HEADER_BYTES + len + AEAD_TAG_BYTES),
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(new TextDecoder().decode(opened.plaintext)).toBe(secret);
    }
    // Nothing in session 1 was touched: the attack is confined to session 2.
    expect(enterer1.texts()).toEqual([]);
  }, 60_000);
});

/* --------------------------------------------------------- 10. P9, and P7 */

describe("P9 — no pairing material on the air, in a log, or in storage", () => {
  it("keeps the code out of every transmitted frame of every kind", async () => {
    const { a } = await codecPair(0xc1, 0xc2);
    const code = bytes(CODE);
    const frames: { name: string; frame: Uint8Array }[] = [
      { name: "MESSAGE", frame: (await a.buildMessageFrames(pad(43), 1))[0] as Uint8Array },
      {
        name: "MULTI[0]",
        frame: (await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 2))[0] as Uint8Array,
      },
      {
        name: "MULTI[1]",
        frame: (await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 3))[1] as Uint8Array,
      },
      { name: "ACK", frame: await a.buildAckFrame(4, 0xff) },
      { name: "PAIR", frame: await a.buildPairFrame(TEST_CHALLENGE) },
    ];
    for (const { name, frame } of frames) {
      // A *substring* search, not a byte-value search: 8 ASCII bytes inside 64
      // random ones collide by chance roughly 30% of the time, so a byte-wise
      // "no code byte appears" test is a coin flip, not a property. The 8-byte
      // sequence has a false-positive probability of about 57 * 2^-64.
      expect(containsBytes(frame, code), `${name} leaks the pairing code`).toBe(false);
      // Nor the normalised forms a user might have typed.
      expect(containsBytes(frame, bytes("ABCD 2345")), name).toBe(false);
      expect(containsBytes(frame, bytes("abcd2345")), name).toBe(false);
    }
    // And the key material is not extractable at all, so it cannot be logged.
    expect((await keys.directionKey(0)).extractable).toBe(false);
    expect(keys.mac.extractable).toBe(false);
  });

  it("touches no storage, logs nothing, and keeps the code in one place only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const touched: string[] = [];
    const hostile = (name: string) => ({
      getItem: (key: string) => {
        touched.push(`${name}.getItem(${key})`);
        return null;
      },
      setItem: (key: string) => {
        touched.push(`${name}.setItem(${key})`);
      },
      removeItem: (key: string) => {
        touched.push(`${name}.removeItem(${key})`);
      },
      clear: (): void => {},
      key: (): string => "",
      length: 0,
    });
    const cookies: string[] = [];
    const indexed: string[] = [];
    const indexedDb = {
      open: (name: string) => {
        indexed.push(`open(${name})`);
        return { addEventListener: (): void => {} };
      },
      deleteDatabase: (name: string) => {
        indexed.push(`delete(${name})`);
      },
    };
    vi.stubGlobal("localStorage", hostile("localStorage"));
    vi.stubGlobal("sessionStorage", hostile("sessionStorage"));
    vi.stubGlobal("indexedDB", indexedDb);
    vi.stubGlobal("document", {
      get cookie(): string {
        cookies.push("read");
        return "";
      },
      set cookie(value: string) {
        cookies.push(value);
      },
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      visibilityState: "visible",
    });
    try {
      const { peer, peerCodec } = await displayerWithHostilePeer({ label: "quiet" });
      const [message] = await peerCodec.buildMessageFrames(bytes("a secret worth keeping"), 3);
      await deliverRaw(peer, [message as Uint8Array]);
      expect(peer.texts()).toEqual(["a secret worth keeping"]);
      // A rejected frame too: the failure copy is the other place a code could
      // plausibly have been pasted into.
      await deliverRaw(peer, [new Uint8Array(64).fill(0xff)]);

      expect(touched, "no storage was written").toEqual([]);
      expect(cookies, "no cookie was written").toEqual([]);
      expect(indexed, "indexedDB was never touched").toEqual([]);
      const said = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(" ");
      expect(said).not.toContain(CODE);
      expect(said).not.toContain("a secret worth keeping");
      expect([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat()).toEqual([]);

      // The pairing code reaches the consumer through exactly one channel: the
      // `pairing` event, whose `PairingState` carries it because the UI has to
      // display it. Every *other* event — and every error report — is clean.
      const leaky = peer.events.filter(
        (event) => event.type !== "pairing" && JSON.stringify(event).includes(CODE),
      );
      expect(leaky, "only the pairing event may carry the code").toEqual([]);
      const reported = [...peer.moduleErrors, ...peer.listenerErrors].map((each) =>
        each instanceof Error ? each.message : String(each),
      );
      for (const message of reported) {
        expect(message).not.toContain(CODE);
        expect(message).not.toContain("a secret worth keeping");
      }
      expect(peer.session.pairingFailureMessage ?? "").not.toContain(CODE);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/* ------------------------------------------- 11. the rest of the hostile set */

describe("hostile frames against a paired session (Section 10.3)", () => {
  it("refuses zero-length, unknown-version, wrong-peer and short blocks with no state change", async () => {
    const { peer, peerCodec } = await displayerWithHostilePeer({ label: "hostile" });
    const [genuine] = await peerCodec.buildMessageFrames(bytes("anchor"), 1);
    await deliverRaw(peer, [genuine as Uint8Array]);
    expect(peer.texts()).toEqual(["anchor"]);

    const blocks: { name: string; block: Uint8Array }[] = [];
    for (const kind of [0, 5, 6, 127, 128, 255]) {
      const block = new Uint8Array(64);
      block[0] = kind;
      block[3] = 0;
      blocks.push({ name: `kind ${kind}`, block });
    }
    blocks.push({ name: "all ones", block: new Uint8Array(64).fill(0xff) });
    for (let length = 0; length < 64; length += 1)
      blocks.push({ name: `len ${length}`, block: new Uint8Array(length) });
    for (let length = 65; length < 200; length += 37) {
      blocks.push({ name: `len ${length}`, block: new Uint8Array(length).fill(1) });
    }
    // A MESSAGE frame that claims more ciphertext than the block can hold.
    const oversized = new Uint8Array(64);
    oversized[0] = FRAME_KIND.MESSAGE;
    oversized[3] = 0;
    oversized[4] = 255;
    blocks.push({ name: "oversized claim", block: oversized });

    for (const { block } of blocks) await deliverRaw(peer, [block]);

    expect(peer.texts(), "no hostile block rendered anything").toEqual(["anchor"]);
    expect(peer.moduleErrors).toEqual([]);
    expect(peer.listenerErrors).toEqual([]);
    expect(peer.session.pairing.kind).toBe("paired");
    // The session is still usable: an anchor at a higher id is delivered.
    const [after] = await peerCodec.buildMessageFrames(bytes("after the flood"), 900);
    await deliverRaw(peer, [after as Uint8Array]);
    expect(peer.texts()).toEqual(["anchor", "after the flood"]);
  }, 30_000);

  it("ignores an ACK for a msgId that was never sent, and a second copy of one that was", async () => {
    const { peer, peerCodec } = await displayerWithHostilePeer({ label: "acks" });
    const send = peer.session.send("waiting for proof");
    expect(send.ok).toBe(true);
    const sendId = send.ok ? send.sendId : -1;
    await until("the note to be sealed", () => peer.outboundStatus(sendId).includes("sending"));
    const outbound = peer
      .outboundEvents()
      .find((event) => event.sendId === sendId && event.msgId !== null);
    const msgId = outbound?.msgId;
    if (msgId === null || msgId === undefined) throw new Error("no msgId");

    // An ACK for a msgId that was never sent, from the real peer, with a real
    // tag: cryptographically perfect and semantically meaningless.
    await deliverRaw(peer, [
      await peerCodec.buildAckFrame(msgId + 1, 0b1),
      await peerCodec.buildAckFrame(0, 0b1),
    ]);
    expect(peer.outboundStatus(sendId), "an unknown msgId moved nothing").not.toContain("sent");

    // The genuine one, three times. The first resolves the message; the rest
    // find nothing in flight and are dropped rather than re-opening anything.
    const real = await peerCodec.buildAckFrame(msgId, 0b1);
    await deliverRaw(peer, [real, real, real]);
    expect(peer.outboundStatus(sendId)).toEqual(["queued", "sending", "sent"]);

    // A mask claiming blocks that were never sent. The note is one block, so
    // only bit 0 is real; the acknowledgement still resolves it, and nothing
    // phantom is put on the air.
    const second = peer.session.send("one block only");
    const secondId = second.ok ? second.sendId : -1;
    await until("the second note to be sealed", () =>
      peer.outboundStatus(secondId).includes("sending"),
    );
    const secondOutbound = peer
      .outboundEvents()
      .find((event) => event.sendId === secondId && event.msgId !== null);
    if (secondOutbound?.msgId === null || secondOutbound?.msgId === undefined) {
      throw new Error("no msgId for the second note");
    }
    peer.takeAir();
    await deliverRaw(peer, [await peerCodec.buildAckFrame(secondOutbound.msgId, 0b11)]);
    expect(peer.outboundStatus(secondId)).toEqual(["queued", "sending", "sent"]);
    expect(peer.moduleErrors).toEqual([]);
  }, 30_000);
});
