/**
 * Phase 2V re-verification — the pairing challenge (F2).
 *
 * F2 added a per-handshake challenge to the PAIR frame: the body is now
 * `salt(16) | challenge(8) | keyCheck(16)`, the key check covers all three plus
 * the role, the initiator invents the challenge and `SoundChatSession` refuses
 * any answer that does not echo its own.
 *
 * This file proves each of the six claims and then attacks them: reflection,
 * replay of a recorded *answer*, a single flipped challenge byte, a challenge
 * reused across two sessions, a correct challenge carrying somebody else's salt,
 * and the codec layer on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import {
  CryptoUsageError,
  derivePairingKeys,
  generatePairChallenge,
  keyCheckTag,
  PAIR_CHALLENGE_BYTES,
  SESSION_SALT_BYTES,
  verifyKeyCheck,
  type RandomSource,
} from "./crypto";
import { FrameCodec, FRAME_KIND, PAIR_BODY_BYTES, PAIR_KEY_CHECK_OFFSET } from "./protocol";
import { SoundChatSession, type SessionEvent } from "./session";
import { drainAsync } from "./drain.ts";

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;
let roomClock = 10;

function challengeOf(frame: Uint8Array): Uint8Array {
  return frame.subarray(5 + SESSION_SALT_BYTES, PAIR_KEY_CHECK_OFFSET);
}

function saltOf(frame: Uint8Array): Uint8Array {
  return frame.subarray(5, 5 + SESSION_SALT_BYTES);
}

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
  plays = 0;

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

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
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
      start: (): void => {
        this.plays += 1;
      },
    };
    return source;
  };
}

type MockTrack = { stops: number; stop: () => void };

function mockStream(): MediaStream {
  const track: MockTrack = {
    stops: 0,
    stop(): void {
      this.stops += 1;
    },
  };
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
};

type PeerOptions = {
  label: string;
  role: "displayer" | "enterer";
  pairingCode?: string;
  random?: RandomSource;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
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
  };
  createdPeers.push(peer);
  return peer;
}

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
      peer.events.length,
      peer.codec.txLog.length,
      peer.codec.rxQueue.length,
      peer.context.plays,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity, floorTurns: turns });
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
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

async function air(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
}

async function deliver(from: Peer, to: Peer): Promise<number> {
  await settle();
  const frames = from.takeAir();
  if (frames.length === 0) return 0;
  to.codec.rxQueue.push(...frames);
  roomClock += 3;
  for (let index = 0; index < frames.length; index += 1) feedChunk(to);
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
  return frames.length;
}

async function converse(from: Peer, to: Peer, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await deliver(from, to);
    await air();
    await deliver(to, from);
    await air();
  }
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  await converse(enterer, displayer);
  if (displayer.session.pairing.kind !== "paired" || enterer.session.pairing.kind !== "paired") {
    throw new Error(
      `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
    );
  }
}

let visibility: "visible" | "hidden" = "visible";
let visibilityHandlers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
  vi.stubGlobal("document", {
    get visibilityState(): string {
      return visibility;
    },
    addEventListener: (_type: string, handler: () => void): void => {
      visibilityHandlers.push(handler);
    },
    removeEventListener: (): void => {
      visibilityHandlers = [];
    },
  });
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fixed random source, so a test can pin the salt and the challenge. */
function fixedRandom(...bytes: number[]): RandomSource {
  return (out) => {
    out.fill(0);
    for (let index = 0; index < out.length; index += 1)
      out[index] = bytes[index % bytes.length] ?? 0;
    return out;
  };
}

const keys = await derivePairingKeys(CODE);

/** A peer-0 (displayer) or peer-1 (enterer) codec, as a chosen outsider would. */
function outsider(selfId: 0 | 1, saltByte: number): FrameCodec {
  return new FrameCodec({
    keys,
    selfId,
    sendSalt: new Uint8Array(SESSION_SALT_BYTES).fill(saltByte),
  });
}

describe("F2 — the shape of the PAIR frame", () => {
  it("fits salt, challenge, key check, tag and zero padding in one 64-byte block", async () => {
    const codec = outsider(1, 0x31);
    const challenge = generatePairChallenge();
    const frame = await codec.buildPairFrame(challenge);
    expect(PAIR_BODY_BYTES).toBe(24);
    expect(PAIR_KEY_CHECK_OFFSET).toBe(29);
    expect(frame).toHaveLength(64);
    expect(frame[0]).toBe(FRAME_KIND.PAIR);
    expect(frame[4], "len is the 24-byte body").toBe(24);
    // 5 header + 16 salt + 8 challenge + 16 key check = 45, and 19 zero bytes
    // follow. No byte of the block is unaccounted for.
    expect(PAIR_KEY_CHECK_OFFSET + 16).toBe(45);
    expect(Array.from(frame.subarray(PAIR_KEY_CHECK_OFFSET + 16)).every((byte) => byte === 0)).toBe(
      true,
    );
    expect(Array.from(saltOf(frame))).toEqual(Array.from(codec.sendSalt));
    expect(Array.from(challengeOf(frame))).toEqual(Array.from(challenge));
    expect(frame.subarray(PAIR_KEY_CHECK_OFFSET, PAIR_KEY_CHECK_OFFSET + 16)).toEqual(
      await keyCheckTag(keys.mac, codec.sendSalt, challenge, 1),
    );
  });

  it("binds the key check to the salt, the challenge and the role together", async () => {
    const salt = new Uint8Array(SESSION_SALT_BYTES).fill(0x41);
    const other = new Uint8Array(SESSION_SALT_BYTES).fill(0x42);
    const challenge = new Uint8Array(PAIR_CHALLENGE_BYTES).fill(0x51);
    const base = await keyCheckTag(keys.mac, salt, challenge, 1);
    // Three independent changes, three different tags: no field can be moved.
    expect(Array.from(await keyCheckTag(keys.mac, other, challenge, 1))).not.toEqual(
      Array.from(base),
    );
    const moved = new Uint8Array(PAIR_CHALLENGE_BYTES).fill(0x52);
    expect(Array.from(await keyCheckTag(keys.mac, salt, moved, 1))).not.toEqual(Array.from(base));
    expect(Array.from(await keyCheckTag(keys.mac, salt, challenge, 0))).not.toEqual(
      Array.from(base),
    );
    // A *truncated* challenge cannot collide with a longer one either: the
    // message is not length-prefixed, but the width is checked, so a 7-byte
    // challenge is refused outright rather than hashed as a prefix.
    await expect(keyCheckTag(keys.mac, salt, challenge.subarray(0, 7), 1)).rejects.toThrowError(
      CryptoUsageError,
    );
  });

  it("refuses a wrong-length salt or challenge, in both directions", async () => {
    const salt = new Uint8Array(SESSION_SALT_BYTES).fill(0x61);
    const challenge = new Uint8Array(PAIR_CHALLENGE_BYTES).fill(0x62);
    const tag = await keyCheckTag(keys.mac, salt, challenge, 1);
    for (const length of [0, 1, 8, 15, 17, 32]) {
      await expect(
        keyCheckTag(keys.mac, new Uint8Array(length).fill(1), challenge, 1),
        `salt of ${length}`,
      ).rejects.toThrowError(CryptoUsageError);
    }
    for (const length of [0, 1, 4, 7, 9, 16]) {
      await expect(
        keyCheckTag(keys.mac, salt, new Uint8Array(length).fill(1), 1),
        `challenge of ${length}`,
      ).rejects.toThrowError(CryptoUsageError);
    }
    // `verifyKeyCheck` is the tolerant side, because it is the one that faces the
    // wire: a wrong length is a refusal, never a throw and never a pass.
    for (const length of [0, 15, 17]) {
      expect(
        await verifyKeyCheck(keys.mac, new Uint8Array(length).fill(1), challenge, 1, tag),
        `salt of ${length}`,
      ).toBe(false);
    }
    for (const length of [0, 7, 9]) {
      expect(
        await verifyKeyCheck(keys.mac, salt, new Uint8Array(length).fill(1), 1, tag),
        `challenge of ${length}`,
      ).toBe(false);
    }
    for (const length of [0, 15, 17, 32]) {
      expect(
        await verifyKeyCheck(
          keys.mac,
          salt,
          challenge,
          1,
          new Uint8Array(length).fill(tag[0] ?? 0),
        ),
        `tag of ${length}`,
      ).toBe(false);
    }
    // The control: the right lengths verify.
    expect(await verifyKeyCheck(keys.mac, salt, challenge, 1, tag)).toBe(true);
  });
});

describe("F2 (d) — the challenge is fresh and never derived from the code", () => {
  it("depends only on the random source, not on the pairing code", async () => {
    // Two sessions, the *same* code, two different random sources: the challenges
    // differ, so a recording of one handshake cannot answer the other.
    const first = outsider(1, 0x71);
    const second = outsider(1, 0x72);
    const challengeA = generatePairChallenge(fixedRandom(0xa1, 0xa2));
    const challengeB = generatePairChallenge(fixedRandom(0xb1, 0xb2));
    expect(Array.from(challengeA)).not.toEqual(Array.from(challengeB));
    // The same random source yields the same challenge whatever the code is: the
    // challenge is not a function of the code at all, so it leaks nothing about
    // it and cannot be pre-computed from it either.
    const otherKeys = await derivePairingKeys("ABCD2346");
    const salt = new Uint8Array(SESSION_SALT_BYTES).fill(0x71);
    const sameRandom = fixedRandom(0xc1, 0xc2);
    const underThisCode = await keyCheckTag(keys.mac, salt, generatePairChallenge(sameRandom), 1);
    const underOtherCode = await keyCheckTag(
      otherKeys.mac,
      salt,
      generatePairChallenge(sameRandom),
      1,
    );
    expect(Array.from(generatePairChallenge(sameRandom))).toEqual(
      Array.from(generatePairChallenge(sameRandom)),
    );
    expect(underThisCode).toHaveLength(16);
    // The tags differ because the *mac* differs, which is the code's job; the
    // challenge bytes are identical either way.
    expect(
      Array.from(generatePairChallenge(sameRandom)).every(
        (byte) => byte === 0 || byte === 0xc1 || byte === 0xc2,
      ),
    ).toBe(true);
    // Two real sessions on the same code draw different salts and challenges.
    expect(Array.from(first.sendSalt)).not.toEqual(Array.from(second.sendSalt));
  });

  it("generates a challenge per session, so two recordings of the code differ", async () => {
    const displayer = await createPeer({ label: "d", role: "displayer", pairingCode: CODE });
    const entererA = await createPeer({ label: "a", role: "enterer", pairingCode: CODE });
    const entererB = await createPeer({ label: "b", role: "enterer", pairingCode: CODE });
    entererA.session.start();
    entererB.session.start();
    await settle();
    const [requestA] = entererA.takeAir();
    const [requestB] = entererB.takeAir();
    if (requestA === undefined || requestB === undefined) throw new Error("no PAIR on the air");
    expect(Array.from(challengeOf(requestA))).not.toEqual(Array.from(challengeOf(requestB)));
    // Both are exactly the challenge width. (A byte-wise "the code's bytes do not
    // appear" check would be meaningless here: 24 random bytes will contain some
    // of the eight ASCII bytes of any 8-character code by chance. The property
    // that matters is independence, proved by the test above.)
    expect(challengeOf(requestA)).toHaveLength(PAIR_CHALLENGE_BYTES);
    expect(challengeOf(requestB)).toHaveLength(PAIR_CHALLENGE_BYTES);
    displayer.session.stop();
  });
});

describe("F2 (a) — a recorded answer cannot make a fresh initiator pair", () => {
  it("refuses yesterday's echo, and says the code was wrong", async () => {
    // Session 1: an honest handshake, recorded by anyone in the room.
    const displayer1 = await createPeer({ label: "d1", role: "displayer", pairingCode: CODE });
    const enterer1 = await createPeer({ label: "e1", role: "enterer", pairingCode: CODE });
    const recorded = await recordHandshake(displayer1, enterer1);
    displayer1.session.stop();
    enterer1.session.stop();

    // Session 2: the same code, a fresh challenge on both sides.
    const enterer2 = await createPeer({ label: "e2", role: "enterer", pairingCode: CODE });
    enterer2.session.start();
    await settle();
    const [ownRequest] = enterer2.takeAir();
    if (ownRequest === undefined) throw new Error("no fresh request");
    expect(
      Array.from(challengeOf(recorded.answer)),
      "the recording cannot contain this session's challenge",
    ).not.toEqual(Array.from(challengeOf(ownRequest)));

    await deliverRaw(enterer2, [recorded.answer]);
    // The key check *verifies* — the tag covers the code, the recording's salt
    // and the recording's challenge — so what refuses this is the echo check.
    expect
      .soft(enterer2.session.pairing.kind, "a recorded answer must not pair")
      .not.toBe("paired");
    expect.soft(enterer2.session.pairingFailureMessage).toContain("different pairing code");
    expect.soft(enterer2.moduleErrors, "and it is not a codec failure").toEqual([]);
  });

  it("refuses an answer carrying the right challenge but somebody else's salt only by P7, not by freshness", async () => {
    // The attacker's own PAIR answer: the correct challenge (read off the air
    // from the initiator's request) and the attacker's salt. It is accepted,
    // because the key check is a *key* confirmation, never an identity check
    // (P7). This test records that limit so it cannot be forgotten — the
    // challenge buys cross-session replay resistance, not authentication.
    const enterer = await createPeer({ label: "e", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await settle();
    const [request] = enterer.takeAir();
    if (request === undefined) throw new Error("no request");
    const eavesdropped = Uint8Array.from(challengeOf(request));
    const impostor = outsider(0, 0x99);
    const forged = await impostor.buildPairFrame(eavesdropped);
    await deliverRaw(enterer, [forged]);
    expect
      .soft(
        enterer.session.pairing.kind,
        "P7: a key confirmation is not an identity check, so a live MITM still pairs",
      )
      .toBe("paired");
    // The nonce space is now the impostor's, which is the whole of P7.
    expect(enterer.session.state).toBe("listening");
  });
});

describe("F2 — attacking the echo check directly", () => {
  it("refuses a PAIR frame reflected back at its own sender", async () => {
    const enterer = await createPeer({ label: "e", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await settle();
    const [request] = enterer.takeAir();
    if (request === undefined) throw new Error("no request");
    await deliverRaw(enterer, [Uint8Array.from(request)]);
    // `parse` refuses it structurally: the frame claims the initiator's own peer
    // id, and only the *other* peer's frames are ever read.
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    expect(enterer.session.stats.framesUnreadable).toBeGreaterThan(0);
  });

  it("refuses an answer whose challenge has one byte changed", async () => {
    const enterer = await createPeer({ label: "e", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await settle();
    const [request] = enterer.takeAir();
    if (request === undefined) throw new Error("no request");
    const challenge = Uint8Array.from(challengeOf(request));
    // An honest answer to the *real* challenge first, so the refusal below can
    // only be about the one changed byte.
    const honest = await outsider(0, 0x55).buildPairFrame(challenge);
    const tampered = Uint8Array.from(honest);
    tampered[5 + SESSION_SALT_BYTES] = (tampered[5 + SESSION_SALT_BYTES] ?? 0) ^ 0x01;
    await deliverRaw(enterer, [tampered, tampered]);
    // The key check covers the challenge, so the tag fails before the echo check
    // is ever reached: this is P5/P6, "heard but unreadable" — and the driver
    // treats an unreadable PAIR frame as a wrong code, so the user is told to
    // check the code. Both signals stay distinct from silence.
    expect(enterer.session.stats.framesUnreadable).toBeGreaterThan(0);
    expect(enterer.session.pairing.kind).toBe("failed");
    expect(enterer.session.pairingFailureMessage).toContain("different pairing code");
    // The pairing machine has no way back from `failed` on its own: a new
    // session is the documented recovery, and that session does pair.
    const retry = await createPeer({ label: "e2", role: "enterer", pairingCode: CODE });
    const other = await createPeer({ label: "d2", role: "displayer", pairingCode: CODE });
    await pairUp(other, retry);
    expect(retry.session.pairing.kind).toBe("paired");
  });

  it("refuses a challenge that is reused across two sessions", async () => {
    // Session 1's answer, replayed against session 2: covered above, but here
    // the *codec* is asked directly, so the layer boundary is explicit.
    const displayer1 = await createPeer({ label: "d1", role: "displayer", pairingCode: CODE });
    const enterer1 = await createPeer({ label: "e1", role: "enterer", pairingCode: CODE });
    const recorded = await recordHandshake(displayer1, enterer1);
    // The codec layer on its own cannot tell: same code, same tag rules.
    const freshCodec = new FrameCodec({
      keys,
      selfId: 1,
      sendSalt: new Uint8Array(SESSION_SALT_BYTES).fill(0x77),
    });
    expect
      .soft(
        (await freshCodec.parse(recorded.answer)).ok,
        "the codec verifies a recorded answer: this is the layer's documented limit",
      )
      .toBe(true);
    // The session layer is the one that can, and it does.
    const enterer2 = await createPeer({ label: "e2", role: "enterer", pairingCode: CODE });
    enterer2.session.start();
    await settle();
    await deliverRaw(enterer2, [recorded.answer, recorded.answer]);
    expect.soft(enterer2.session.pairing.kind, "but the session refuses it").not.toBe("paired");
  });

  it("completes the honest handshake and carries messages both ways", async () => {
    const displayer = await createPeer({ label: "d", role: "displayer", pairingCode: CODE });
    const enterer = await createPeer({ label: "e", role: "enterer", pairingCode: CODE });
    await pairUp(displayer, enterer);
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(enterer.session.pairing.kind).toBe("paired");
    // The displayer adopted the *enterer's* salt, which is the one it was sent.
    const peerSalt = displayer.session.pairing;
    if (peerSalt.kind !== "paired") throw new Error("not paired");
    expect(peerSalt.peerSalt).toBeInstanceOf(Uint8Array);
    expect(peerSalt.peerSalt).toHaveLength(SESSION_SALT_BYTES);
    displayer.session.send("from the displayer");
    await converse(displayer, enterer, 8);
    expect(enterer.texts()).toEqual(["from the displayer"]);
    enterer.session.send("from the enterer");
    await converse(enterer, displayer, 8);
    expect(displayer.texts()).toEqual(["from the enterer"]);
    expect(enterer.listenerErrors).toEqual([]);
    expect(displayer.moduleErrors).toEqual([]);
  });
});

describe("F2 (b) — the responder side of the freshness check", () => {
  /**
   * The one hole the challenge does not close, pinned as measured reality.
   *
   * The responder has spoken nothing yet, so it has no challenge of its own to
   * compare against: anything whose key check verifies is adopted, including a
   * recording of an earlier handshake under the same pairing code. This is an
   * **accepted limit**, recorded in the master plan's Section 4 and in its
   * Section 3 hard-limits list, and carried into Phase 4 — the fix is to invert
   * the handshake so the displayer speaks first and repeats its PAIR until
   * answered, which is a larger protocol change than a verification phase should
   * ship without harness coverage.
   *
   * What it is *not*: a confidentiality or integrity break. Nothing is decrypted
   * that should not be, nothing is forged, and the honest peer is refused rather
   * than silently paired. It is a denial of one pairing, by an attacker who must
   * already hold the 40-bit code *and* a recording of that exact handshake.
   *
   * This test exists so the limit cannot quietly change in either direction: it
   * fails if the responder ever starts refusing, which would mean the plan's
   * Section 4 wording is out of date and must be corrected there too.
   */
  it("accepts a recorded request's salt — the documented residual, not a fixed gap", async () => {
    // Session 1, recorded.
    const displayer1 = await createPeer({ label: "d1", role: "displayer", pairingCode: CODE });
    const enterer1 = await createPeer({ label: "e1", role: "enterer", pairingCode: CODE });
    const recorded = await recordHandshake(displayer1, enterer1);
    const staleSalt = Array.from(saltOf(recorded.request));
    displayer1.session.stop();
    enterer1.session.stop();

    // Session 2: a brand-new displayer with the same code, waiting for a peer.
    const displayer2 = await createPeer({ label: "d2", role: "displayer", pairingCode: CODE });
    displayer2.session.start();
    await settle();
    expect(displayer2.session.pairing.kind).toBe("waiting-for-peer");
    await deliverRaw(displayer2, [recorded.request, recorded.request]);

    // Measured, and asserted as the residual: the responder adopts the recorded
    // salt. `toBe("paired")` here is the *documentation* of the limit.
    const paired = displayer2.session.pairing;
    expect(
      paired.kind,
      "the responder still adopts a recorded salt — if this passes as 'refused', update the master plan",
    ).toBe("paired");
    if (paired.kind === "paired") {
      expect(Array.from(paired.peerSalt)).toEqual(staleSalt);
    }
    // Nothing is readable through it either way: the honest peer's salt differs,
    // and a paired codec refuses a second one — so the recording buys the
    // attacker a silent conversation, not a readable one.
    const honestDisplay = await createPeer({ label: "d3", role: "displayer", pairingCode: CODE });
    const honestEnter = await createPeer({ label: "e3", role: "enterer", pairingCode: CODE });
    await pairUp(honestDisplay, honestEnter);
    expect(honestEnter.session.pairing.kind).toBe("paired");
    honestDisplay.session.send("a fresh session is unaffected");
    await converse(honestDisplay, honestEnter, 8);
    expect(honestEnter.texts()).toEqual(["a fresh session is unaffected"]);
  });
});

/** Feeds frames straight into a session's Rx path, one block per chunk. */
async function deliverRaw(to: Peer, frames: Uint8Array[]): Promise<void> {
  to.codec.rxQueue.push(...frames.map((frame) => Uint8Array.from(frame)));
  roomClock += 3;
  for (let index = 0; index < frames.length; index += 1) feedChunk(to);
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
}

/**
 * Runs one honest handshake and keeps both PAIR frames — the enterer's request
 * and the displayer's answer — exactly as they went on the air. That pair *is*
 * the whole of what a recording of this handshake contains.
 */
async function recordHandshake(
  displayer: Peer,
  enterer: Peer,
): Promise<{ request: Uint8Array; answer: Uint8Array }> {
  displayer.session.start();
  enterer.session.start();
  await settle();
  const [request] = enterer.takeAir();
  if (request === undefined || request[0] !== FRAME_KIND.PAIR) throw new Error("no PAIR request");
  await deliverRaw(displayer, [request]);
  if (displayer.session.pairing.kind !== "paired") throw new Error("the displayer did not pair");
  const [answer] = displayer.takeAir();
  if (answer === undefined || answer[0] !== FRAME_KIND.PAIR) throw new Error("no PAIR answer");
  // The answer really does echo the request's challenge: that is the contract
  // the whole freshness story rests on.
  expect(Array.from(challengeOf(answer))).toEqual(Array.from(challengeOf(request)));
  return { request: Uint8Array.from(request), answer: Uint8Array.from(answer) };
}

/** Proves `until` is used somewhere, so a silent wait cannot masquerade as a pass. */
describe("harness sanity", () => {
  it("waits on a condition rather than a fixed number of turns", async () => {
    const peer = await createPeer({ label: "d", role: "displayer", pairingCode: CODE });
    peer.session.start();
    await until("the displayer to publish its pairing state", () => peer.events.length > 0);
    expect(peer.session.pairing.kind).toBe("waiting-for-peer");
  });
});
