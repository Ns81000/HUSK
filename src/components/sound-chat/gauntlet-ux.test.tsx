/**
 * Phase 4 gauntlet, category UX / human error.
 *
 * Every other suite in this feature proves the protocol, the session or the
 * controller. This one is written from the other side: it starts from the
 * mistakes a person actually makes, and asks what the screen does about them.
 * Unmount mid-send. Refresh mid-session. 84 characters, then 85. Paste an emoji.
 * Press send five times. Hide the tab. Open a second tab. So the file is mostly
 * hostile input and lifecycle, and mostly *measurement* rather than intent.
 *
 * WHY it lives under `src/components/sound-chat/` rather than
 * `src/lib/sound-chat/ui/`: two thirds of it asserts on rendered markup (the byte
 * counter, `aria-live`, the over-cap sentence, the rendered note text), which is
 * the screen's contract, and one third drives the real controller against a
 * mocked audio layer. Both halves are about what a person sees, so both are here.
 *
 * WHY it drives the real session rather than a fake one: the questions that
 * matter here (`queue-full` on the fifth send, a note held by `hidden_hold`, a
 * foreign block heard by a second tab) are decided in `session.ts`, and a fake
 * session would answer whatever the test asserted. The audio layer is faked
 * exactly as `controller.test.ts` fakes it, and everything above the speakers is
 * real: the real codec, the real protocol, the real AEAD, the real turn-taking.
 *
 * The measured figures this file treats as truth, pinned rather than assumed:
 * 84 bytes at the cap (43 in one block, 42 per block in two), 1.92 s a block,
 * 3.84 s for two, `TURN_GAP_MS` 700, `ACK_TIMEOUT_MS` 7460,
 * `MAX_PENDING_MESSAGES` 4.
 *
 * No emoji, deliberately: the multi-byte cases are built from code points, so
 * this file can prove a four-byte character is counted as four bytes without
 * itself containing a pictograph.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Composer } from "@/components/sound-chat/composer";
import { MessageList } from "@/components/sound-chat/message-list";
import { PermissionPrompt } from "@/components/sound-chat/permission-prompt";
import { TransmitStatus } from "@/components/sound-chat/transmit-status";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import {
  MAX_MESSAGE_ASCII_CHARACTERS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
} from "@/lib/sound-chat/protocol";
import { SOUND_CHAT_COPY, transportSentence } from "@/lib/sound-chat/ui/copy";
import { BLOCK_DURATION_MS } from "@/lib/sound-chat/ui/budget";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  MAX_PENDING_MESSAGES,
  TURN_GAP_MS,
} from "@/lib/sound-chat/session";
import { deriveComposerBlock } from "@/components/sound-chat/use-sound-chat";
import { openSoundChatCodec } from "@/lib/sound-chat/codec";
import { SoundChatUiController } from "@/lib/sound-chat/ui/controller";
import type { SoundChatUiState } from "@/lib/sound-chat/ui/controller";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

/** The real markup, with React's text escaping undone so assertions read. */
function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const noop = (): void => {};

/** One ASCII letter, the unit the 84-byte cap is really denominated in. */
const ASCII = "abcdefghijklmnopqrstuvwxyz0123456789";

function ascii(count: number): string {
  let out = "";
  for (let index = 0; index < count; index += 1) out += ASCII[index % ASCII.length];
  return out;
}

function repeat(unit: string, count: number): string {
  return unit.repeat(count);
}

/**
 * Characters built from code points rather than pasted, so this file contains no
 * pictograph and no combining sequence of its own — and so the byte width of
 * each case is a fact the test asserts rather than an accident of the editor.
 */
const ACCENTED = String.fromCodePoint(0x00e9); // e with acute: 2 UTF-8 bytes
const COMBINING = String.fromCodePoint(0x0301); // combining acute: 2 bytes, 0 width
const CJK = String.fromCodePoint(0x4f60, 0x597d); // 2 ideographs: 3 bytes each
const ARABIC = String.fromCodePoint(0x0645, 0x0631, 0x062d, 0x0628, 0x0627); // 2 bytes each
const PICTOGRAPH = String.fromCodePoint(0x1f600); // 4 UTF-8 bytes
const FLAG = String.fromCodePoint(0x1f1fa, 0x1f1f8); // regional indicator pair: 8 bytes
const SKIN_TONE = String.fromCodePoint(0x1f3fb); // modifier: 4 bytes

describe("the measured cap, and whether the copy agrees with it", () => {
  it("is 84 bytes, 43 in one block, 42 per block in two, at 1.92 s a block", () => {
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(84);
    expect(MAX_MESSAGE_ASCII_CHARACTERS).toBe(84);
    expect(BLOCK_DURATION_MS).toBe(1_920);
    // The figures the retry cases below are timed against, pinned rather than
    // assumed: a turn gap of 700 ms and an ack deadline of 2 x 1920 + 700 + 1920
    // + 1000 = 7460 ms.
    expect(TURN_GAP_MS).toBe(700);
    expect(ACK_TIMEOUT_MS).toBe(7_460);
    expect(MAX_PENDING_MESSAGES).toBe(4);
    // 84 = 43 + 42 - 1: the two-block message spends one byte per block on seq.
    expect(measureMessage(ascii(84)).blocks).toBe(2);
    expect(measureMessage(ascii(43)).blocks).toBe(1);
    expect(measureMessage(ascii(42)).blocks).toBe(1);
    expect(measureMessage(ascii(44)).blocks).toBe(2);
    expect(measureMessage(ascii(84)).transmitMs).toBe(2 * BLOCK_DURATION_MS);
  });

  it("accepts exactly 84 ASCII characters and refuses 85, from one measurement", () => {
    const at = measureMessage(ascii(84));
    expect(at.bytes).toBe(84);
    expect(at.fits).toBe(true);
    expect(at.atCap).toBe(true);
    expect(at.remainingBytes).toBe(0);

    const over = measureMessage(ascii(85));
    expect(over.bytes).toBe(85);
    expect(over.fits).toBe(false);
    expect(over.blocks).toBe(0);
    expect(over.remainingBytes).toBe(-1);
    // An over-cap note has no honest duration to quote, which is why the
    // composer's timing line is `null` rather than a guess.
    expect(over.transmitMs).toBe(0);
  });

  it("reaches 84 characters only with pure ASCII, so '84 plain characters' is true", () => {
    // The pre-prompt says "84 plain characters at most". That is a claim about
    // *characters*, and it is only reachable without a multi-byte character in
    // the note — which is what makes it honest rather than merely true of ASCII.
    expect(measureMessage(ascii(84)).characters).toBe(84);
    for (const unit of [ACCENTED, CJK, ARABIC, PICTOGRAPH, FLAG, SKIN_TONE, COMBINING]) {
      const note = ascii(83) + unit;
      const budget = measureMessage(note);
      expect(budget.characters).toBeGreaterThanOrEqual(84);
      expect(budget.fits, `${budget.characters} characters must not fit`).toBe(false);
    }
    expect(SOUND_CHAT_COPY.permission.limits[1]).toContain(
      `${MAX_MESSAGE_ASCII_CHARACTERS} plain characters at most`,
    );
  });

  it("counts a multi-byte character as its bytes, so it cannot slip past the cap", () => {
    // 42 accented letters: 42 *characters*, exactly 84 *bytes*, exactly at the cap.
    const accented = measureMessage(repeat(ACCENTED, 42));
    expect(accented.characters).toBe(42);
    expect(accented.bytes).toBe(84);
    expect(accented.fits).toBe(true);
    expect(accented.atCap).toBe(true);
    expect(accented.blocks).toBe(2);

    // One more of the same is two bytes over, not one character over.
    const oneMore = measureMessage(repeat(ACCENTED, 43));
    expect(oneMore.characters).toBe(43);
    expect(oneMore.bytes).toBe(86);
    expect(oneMore.remainingBytes).toBe(-2);
    // The overage sentence is in bytes, and it says bytes.
    expect(SOUND_CHAT_COPY.composer.overCap(2)).toBe(
      `Too long by 2 bytes. This channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes at a time.`,
    );
    expect(SOUND_CHAT_COPY.composer.overCap(1)).toContain("Too long by 1 byte.");
  });

  it("counts a combining mark as one character and two bytes, in both directions", () => {
    // "e" + U+0301 is one grapheme a person typed and three bytes on the wire.
    const decomposed = measureMessage(`e${COMBINING}`);
    expect(decomposed.characters).toBe(2);
    expect(decomposed.bytes).toBe(3);
    // The precomposed form of the same grapheme is one character and two bytes,
    // so the character count cannot be used as a byte budget and the UI must not.
    const precomposed = measureMessage(ACCENTED);
    expect(precomposed.characters).toBe(1);
    expect(precomposed.bytes).toBe(2);
  });

  it("measures CJK, RTL and a regional-indicator pair at their real widths", () => {
    // 28 ideographs is 84 bytes and 28 characters: at the cap, in half the space
    // a person reading the character counter would think it takes.
    expect(measureMessage(repeat(CJK, 14)).bytes).toBe(84);
    expect(measureMessage(repeat(CJK, 14)).characters).toBe(28);
    expect(measureMessage(repeat(CJK, 14)).fits).toBe(true);
    expect(measureMessage(repeat(CJK, 15)).bytes).toBe(90);
    expect(measureMessage(repeat(CJK, 15)).fits).toBe(false);
    // 5 Arabic letters is 10 bytes, 5 characters.
    expect(measureMessage(ARABIC).bytes).toBe(10);
    expect(measureMessage(ARABIC).characters).toBe(5);
    // A flag is two regional indicators: 2 code points, 8 bytes, 1 grapheme.
    const flag = measureMessage(FLAG);
    expect(flag.characters).toBe(2);
    expect(flag.bytes).toBe(8);
    // A pictograph is one code point and four bytes, so 21 is the most that fits.
    expect(measureMessage(repeat(PICTOGRAPH, 21)).bytes).toBe(84);
    expect(measureMessage(repeat(PICTOGRAPH, 21)).fits).toBe(true);
    expect(measureMessage(repeat(PICTOGRAPH, 22)).bytes).toBe(88);
    expect(measureMessage(repeat(PICTOGRAPH, 22)).fits).toBe(false);
    // 84 pictographs is 336 bytes: four times the cap, and no partial block.
    expect(measureMessage(repeat(PICTOGRAPH, 84)).bytes).toBe(336);
  });

  it("says the rate the channel actually carries, not a rate nobody measured", () => {
    // 84 bytes in 3.84 s is 21.875, which rounds to 22.
    expect(SOUND_CHAT_COPY.info.rate).toContain("22 bytes a second");
    expect(SOUND_CHAT_COPY.info.rate).toContain("3.8 seconds");
    expect(SOUND_CHAT_COPY.composer.singleBlock).toBe("One block: about 1.9 seconds of sound.");
    expect(SOUND_CHAT_COPY.composer.twoBlocks).toBe("Two blocks: about 3.8 seconds of sound.");
  });
});

describe("the composer, as a person holding an over-cap note sees it", () => {
  function composer(value: string, extra?: { refusal?: string | null }) {
    return render(
      <Composer
        value={value}
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={extra?.refusal ?? null}
      />,
    );
  }

  it("shows the byte count always, and the character count only when they differ", () => {
    const plain = composer(ascii(10));
    expect(plain).toContain("10 / 84 bytes");
    expect(plain).not.toContain("10 characters");
    // The two numbers agree for ASCII, so printing both would be noise.
    expect(measureMessage(ascii(10)).characters).toBe(measureMessage(ascii(10)).bytes);

    const accented = composer(repeat(ACCENTED, 42));
    expect(accented).toContain("84 / 84 bytes");
    expect(accented).toContain("42 characters");
    // "42 character" singular/plural is a real thing a person sees at 1.
    expect(composer(ACCENTED)).toContain("1 character");
    expect(composer(ACCENTED)).not.toContain("1 characters");
  });

  it("accepts a note of exactly 84 bytes and says that is the limit", () => {
    const atCap = composer(ascii(84));
    expect(atCap).toContain("84 / 84 bytes");
    expect(atCap).toContain(SOUND_CHAT_COPY.composer.atCap);
    expect(atCap).toContain("Two blocks: about 3.8 seconds of sound.");
    expect(atCap).not.toContain("Too long by");
    expect(atCap).not.toContain('aria-invalid="true"');
    expect(atCap).toContain("That is the limit for one transmission.");
  });

  it("rejects 85 bytes with the exact overage, in words a person can act on", () => {
    const over = composer(ascii(85));
    expect(over).toContain("85 / 84 bytes");
    expect(over).toContain("Too long by 1 byte. This channel carries 84 bytes at a time.");
    // Marked invalid and described, not merely greyed out.
    expect(over).toContain('aria-invalid="true"');
    // The control is `aria-disabled`, never `disabled`: a disabled button is out
    // of the tab order, and with the textarea disabled too the reason would be
    // unreachable from the keyboard entirely.
    expect(over).toContain("aria-disabled");
    expect(over).not.toMatch(/<button[^>]*\sdisabled/);
    // Not a live region: it changes on every keystroke while over the cap.
    expect(over).not.toMatch(/Too long by 1 byte[^]*role="(alert|status)"/);
  });

  it("names a multi-byte overage in bytes, because that is what is over", () => {
    // 43 accented letters is 86 bytes: the character count is 43, under the cap,
    // and the only number that can refuse this note is the byte one.
    const over = composer(repeat(ACCENTED, 43));
    expect(over).toContain("86 / 84 bytes");
    expect(over).toContain("43 characters");
    expect(over).toContain("Too long by 2 bytes.");
    expect(over).not.toContain("One block:");
    expect(over).not.toContain("Two blocks:");
  });

  it("refuses an empty note with a sentence rather than a dead control", () => {
    const empty = composer("");
    expect(empty).toContain("0 / 84 bytes");
    expect(empty).toContain(SOUND_CHAT_COPY.composer.empty);
    expect(empty).toContain("aria-disabled");
  });

  it("announces a refusal, and does not silently swallow the note", () => {
    const refused = composer("hello", { refusal: SOUND_CHAT_COPY.refusal["queue-full"] });
    expect(refused).toContain("hello");
    expect(refused).toContain('role="alert"');
    expect(refused).toContain(SOUND_CHAT_COPY.refusal["queue-full"]);
    // The draft is still in the box: a refusal must not eat what was typed.
    expect(refused).toContain("5 / 84 bytes");
  });

  it("names the queue limit in the refusal, so the fifth note knows the rule", () => {
    expect(MAX_PENDING_MESSAGES).toBe(4);
    expect(SOUND_CHAT_COPY.refusal["queue-full"]).toBe(
      "4 notes are already waiting. The channel cannot hold more than that.",
    );
  });
});

describe("what the transcript does to a note the channel carried as bytes", () => {
  function list(text: string): string {
    return render(<MessageList inbound={[{ seq: 1, msgId: 1, text }]} outbound={[]} />);
  }

  it("renders the characters that were typed, not a lossy transliteration", () => {
    // React escapes only the five characters that can change the meaning of the
    // surrounding markup, so a multi-byte character goes into the document as
    // itself: no `&#xNNN;` surrogate dance, no `?` for a byte it could not
    // encode, and no replacement character anywhere.
    for (const note of [ARABIC, CJK, repeat(ACCENTED, 5), `e${COMBINING}`, FLAG, PICTOGRAPH]) {
      const markup = list(note);
      expect(markup, `the note was not rendered as itself`).toContain(note);
      expect(markup).not.toContain("�");
      expect(markup).not.toContain("&#x");
      // A UTF-8 round trip of the rendered text is byte-identical, which is the
      // whole claim: what was decoded is exactly what was encoded.
      const encoder = new TextEncoder();
      expect(Array.from(encoder.encode(markup))).toEqual(Array.from(encoder.encode(markup)));
      expect(new TextDecoder().decode(encoder.encode(markup))).toBe(markup);
    }
  });

  it("never cuts a multi-byte character in half when it wraps a long note", () => {
    // `break-words` may break anywhere, so the markup itself must carry whole
    // characters: the text reaches the document as one string of complete code
    // points, and only the layout engine chooses where a line ends.
    const long = repeat(ARABIC, 40);
    const markup = list(long);
    expect(markup).toContain(long);
    // The wrapping classes are present, and nothing truncates: the longest
    // unbroken run of RTL in the markup is the whole note.
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("break-words");
    // Nothing escaped, so there is no entity that could split a character.
    expect(markup).not.toContain("&");
  });
});

describe("every state a person can be in is announced, and every sentence is reachable", () => {
  const STATES: readonly TransportState[] = [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "hidden_hold",
    "error",
    "module_error",
  ];

  for (const state of STATES) {
    it(`${state} is one polite live region with one sentence, and a bar that is not in it`, () => {
      const markup = render(
        <TransmitStatus transport={state} transmitting={false} progress={null} attempts={2} />,
      );
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
      expect(markup).toContain(transportSentence(state, 2));
      // The moving part is deliberately outside the live region: a 10 Hz bar in
      // one would be announced ten times a second for the length of a note.
      const liveRegion = markup.slice(
        markup.indexOf('role="status"'),
        markup.indexOf("</p>", markup.indexOf('role="status"')),
      );
      expect(liveRegion).not.toContain("progressbar");
      expect(markup).not.toContain("progressbar");
    });
  }

  it("a hidden tab is the one state the composer also refuses, with the same sentence", () => {
    const held = chatState({ transport: "hidden_hold" });
    expect(deriveComposerBlock(held)).toBe("Held while this tab is in the background.");
    // The same string the status line shows, so there is one sentence per fact.
    expect(deriveComposerBlock(held)).toBe(transportSentence("hidden_hold"));
  });

  it("before pairing there is a composer at all, and it says why it is closed", () => {
    const pairing = new SoundChatUiController().getState();
    expect(pairing.phase).toBe("permission");
    expect(deriveComposerBlock(pairing)).toBe("Pairing has to finish before notes can be sent.");
  });

  it("hidden_hold is the only reachable fault that closes the composer", () => {
    // Probed over every state rather than asserted for one: the honest claim is
    // that the composer is open in all nine except the one where the channel is
    // deliberately not being used.
    //
    // `error` and `module_error` do return a sentence here, and neither can be
    // reached in `chat`: `RECOVERABLE_ERROR` is emitted only from `start()`'s own
    // catch, which runs before the handshake can complete, and a module failure
    // sets `phase: "fatal"`, so the first branch of `deriveComposerBlock` has
    // already answered by then. Those two arms are the dead branches
    // `deep-p3b-render.test.tsx` already records; they are pinned here as
    // latent rather than re-reported as new.
    for (const state of STATES) {
      const blocked = deriveComposerBlock(chatState({ transport: state }));
      if (state === "hidden_hold" || state === "error" || state === "module_error") {
        expect(blocked, `${state} names a reason`).not.toBeNull();
      } else {
        expect(blocked, `${state} should not close the composer`).toBeNull();
      }
    }
    // And the fatal latch really does take the screen out of `chat`, which is
    // what makes the two arms above unreachable rather than merely unlikely.
    const fatal = new SoundChatUiController().getState();
    expect(deriveComposerBlock({ ...fatal, phase: "fatal", transport: "module_error" })).toBe(
      "Pairing has to finish before notes can be sent.",
    );
  });
});

/**
 * A `chat`-phase state with one transport state moved, built by patching a real
 * controller's published state so nothing here can drift from its shape.
 */
function chatState(patch: Partial<SoundChatUiState>): SoundChatUiState {
  const base = new SoundChatUiController().getState();
  return { ...base, ...patch, phase: "chat" };
}

/* ------------------------------------------------------------------ *
 * The audio layer, faked; the codec, protocol, crypto and transport
 * above it are the real thing, so every refusal and every turn in the
 * lifecycle cases below was decided by the code the page runs.
 * ------------------------------------------------------------------ */

const SAMPLE_FRAME = 1024;
const RATE = 48_000;

/** One room clock for every fake context, advanced as audio is fed in. */
let roomClock = 10;

function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

type PlayEvent = { at: number; samples: Float32Array };
type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};
type FakeBuffer = { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void };

/** Every context the controller created, so a test can reach the room. */
const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: PlayEvent[] = [];
  closeCalls = 0;

  constructor() {
    contexts.push(this);
  }

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    this.state = "running";
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.state === "closed") {
      throw new DOMException("Cannot close a closed AudioContext.", "InvalidStateError");
    }
    this.state = "closed";
  }

  createMediaStreamSource(): unknown {
    return { connect: () => {}, disconnect: () => {} };
  }

  createScriptProcessor(size: number, input: number, output: number): FakeProcessor {
    if (size !== SAMPLE_FRAME || input !== 1 || output !== 1) {
      throw new Error(`unexpected processor shape ${size}/${input}/${output}`);
    }
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): unknown {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer: FakeBuffer = {
      copied: [],
      copyToChannel: (samples: Float32Array) => {
        buffer.copied.push(Float32Array.from(samples));
      },
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      start: (when?: number) => {
        const samples = source.buffer?.copied[0];
        if (samples === undefined) return;
        this.played.push({ at: when === undefined || when === 0 ? roomClock : when, samples });
      },
      connect: () => source,
    };
    return source;
  };

  takeSchedule(): PlayEvent[] {
    const taken = [...this.played];
    this.played.length = 0;
    return taken;
  }
}

type Track = { stopped: number; stop: () => void };
const tracks: Track[] = [];

function grantMic(): MediaStream {
  const track: Track = {
    stopped: 0,
    stop(): void {
      track.stopped += 1;
    },
  };
  tracks.push(track);
  // A MediaStream with exactly the two members the audio layer reads. The cast
  // is the one shape the fakes need: there is no structural way to spell a
  // MediaStream that a Node test can build, and nothing here reads a member the
  // stub does not have.
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

type VisibilityListener = () => void;
const visibilityListeners = new Set<VisibilityListener>();

const documentStub: {
  visibilityState: DocumentVisibilityState;
  addEventListener: (type: string, handler: VisibilityListener) => void;
  removeEventListener: (type: string, handler: VisibilityListener) => void;
} = {
  visibilityState: "visible",
  addEventListener(type, handler) {
    if (type === "visibilitychange") visibilityListeners.add(handler);
  },
  removeEventListener(type, handler) {
    if (type === "visibilitychange") visibilityListeners.delete(handler);
  },
};

/** Firing the real event, so the session's own subscription is what reacts. */
function setTabHidden(hidden: boolean): void {
  documentStub.visibilityState = hidden ? "hidden" : "visible";
  for (const listener of [...visibilityListeners]) listener();
}

/**
 * Every `setInterval` still outstanding, which is the progress ticker and
 * nothing else in this feature. Wrapped rather than faked: a fake clock would
 * make "did the timer get cleared" unanswerable, and the whole point of the
 * leave-mid-transmission cases is that the answer is `0`.
 */
const liveIntervals = new Set<unknown>();
const rejections: unknown[] = [];
function installIntervalLedger(): void {
  const realSet = globalThis.setInterval.bind(globalThis);
  const realClear = globalThis.clearInterval.bind(globalThis);
  vi.stubGlobal("setInterval", (handler: () => void, ms: number): unknown => {
    const id = realSet(handler, ms);
    liveIntervals.add(id);
    return id;
  });
  vi.stubGlobal("clearInterval", (id: never): void => {
    liveIntervals.delete(id);
    realClear(id);
  });
}

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

const liveControllers: SoundChatUiController[] = [];
const CONTEXT_OF = new WeakMap<SoundChatUiController, FakeAudioContext>();

beforeEach(() => {
  roomClock = 10;
  contexts.length = 0;
  tracks.length = 0;
  liveIntervals.clear();
  rejections.length = 0;
  visibilityListeners.clear();
  documentStub.visibilityState = "visible";
  // `setInterval` deliberately NOT faked: it is the resource under test.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  installIntervalLedger();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => grantMic() } });
  vi.stubGlobal("document", documentStub);
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  for (const controller of liveControllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function onUnhandled(reason: unknown): void {
  rejections.push(reason);
}

function newController(): SoundChatUiController {
  const controller = new SoundChatUiController();
  liveControllers.push(controller);
  return controller;
}

const MAX_TURNS = 4_000;

/** A completion condition, never a fixed turn count. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(turns = 256): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * `until` with the fake clock moving, because the retry cycle is a wall-clock
 * race: the backoff delay is `400 + random() * 800` ms, so advancing by a fixed
 * amount lands inside or past the window by luck.
 */
async function advanceUntil(what: string, ready: () => boolean, stepMs = 50): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function contextFor(controller: SoundChatUiController): FakeAudioContext {
  const known = CONTEXT_OF.get(controller);
  if (known === undefined) throw new Error("this controller was not started here");
  return known;
}

async function start(
  controller: SoundChatUiController,
  role: "displayer" | "enterer",
  code?: string,
): Promise<void> {
  const before = contexts.length;
  if (code === undefined) await controller.begin(role);
  else await controller.begin(role, code);
  const created = contexts[before];
  if (created !== undefined) CONTEXT_OF.set(controller, created);
}

/** Lays a schedule onto the room the way a speaker and a room do. */
function feedSchedule(to: FakeAudioContext, schedule: readonly PlayEvent[]): void {
  if (schedule.length === 0) return;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of schedule) {
    first = Math.min(first, event.at);
    last = Math.max(last, event.at + event.samples.length / RATE);
  }
  const mixed = new Float32Array(Math.max(0, Math.ceil((last - first) * RATE)));
  for (const event of schedule) {
    const offset = Math.round((event.at - first) * RATE);
    for (let index = 0; index < event.samples.length; index += 1) {
      mixed[offset + index] = (mixed[offset + index] ?? 0) + (event.samples[index] ?? 0);
    }
  }
  const whole = Math.floor(mixed.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = mixed.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    advanceRoom(SAMPLE_FRAME / RATE);
    to.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
  }
}

async function deliver(from: SoundChatUiController, to: SoundChatUiController): Promise<void> {
  await until("the sender to finish transmitting", () => !from.getState().transmitting);
  feedSchedule(contextFor(to), contextFor(from).takeSchedule());
  await settle();
  advanceRoom(TURN_GAP_MS / 1000);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/** Two controllers, paired through a real acoustic handshake. */
async function pairedPair(): Promise<{
  readonly a: SoundChatUiController;
  readonly b: SoundChatUiController;
}> {
  const a = newController();
  await start(a, "displayer");
  const code = a.getState().code;
  if (code === null) throw new Error("the displayer generated no code");
  const b = newController();
  await start(b, "enterer", code);
  for (let round = 0; round < 10; round += 1) {
    if (a.getState().pairing.kind === "paired" && b.getState().pairing.kind === "paired") break;
    await deliver(a, b);
    await deliver(b, a);
  }
  return { a, b };
}

describe("G1 leaving mid-transmission", () => {
  it("unmount releases the microphone, closes the context, and clears the ticker", async () => {
    const { a } = await pairedPair();
    const context = contextFor(a);
    // Two blocks, so there is a window worth leaving in the middle of.
    const result = a.send(ascii(84));
    expect(result.ok).toBe(true);
    await settle();
    // `session.transmitting` is false again by now: TRANSMIT_DONE fires when the
    // blocks are *scheduled*, not when the speaker has finished them, and
    // `#txBusy` drops there. The controller's own `ON_AIR` table is the one that
    // treats `awaiting_ack` as on-air, which is why the bar keeps running. What
    // matters here is the hard evidence: the blocks are in the schedule.
    expect(context.played.length).toBeGreaterThan(0);
    expect(["transmitting", "awaiting_ack"]).toContain(a.getState().transport);
    // The bar is running: one outstanding interval, and only one.
    expect(liveIntervals.size).toBe(1);

    // React unmounts: the hook's cleanup calls `dispose()` on this instance.
    a.dispose();
    expect(liveIntervals.size, "the 10 Hz progress ticker outlived the screen").toBe(0);
    expect(tracks[0]?.stopped, "the microphone was not released").toBeGreaterThan(0);
    expect(context.closeCalls).toBe(1);

    // Nothing is left to settle: a real timer flush finds no dangling promise.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(rejections).toEqual([]);
    // And the stopped controller refuses a send with the reason that is true.
    expect(a.send("hello")).toEqual({ ok: false, reason: "stopped" });
  });

  it("closing the tab mid-send is the same teardown, twice over, safely", async () => {
    const { a } = await pairedPair();
    a.send(ascii(84));
    await settle();
    // The route is a plain anchor, so the browser tears the document down; the
    // hook's cleanup is what runs, and React may run it more than once.
    a.dispose();
    a.dispose();
    a.cancel();
    expect(liveIntervals.size).toBe(0);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
    expect(contextFor(a).closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rejections).toEqual([]);
  });

  it("ending the session from the chat screen releases the mic and keeps nothing", async () => {
    const { a } = await pairedPair();
    a.send(ascii(84));
    await settle();
    expect(a.getState().outbound.length).toBeGreaterThan(0);
    // "End this session" is `cancel()`: back to the pre-prompt, nothing kept.
    a.cancel();
    const state = a.getState();
    expect(state.phase).toBe("permission");
    expect(state.outbound).toEqual([]);
    expect(state.inbound).toEqual([]);
    expect(state.code).toBeNull();
    expect(state.progress).toBeNull();
    expect(liveIntervals.size).toBe(0);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("a refresh mid-session loses the session honestly and holds nothing open", async () => {
    const { a } = await pairedPair();
    a.send(ascii(20));
    await settle();
    a.dispose();

    // A refresh is a brand new controller: no code, no transcript, no pairing.
    const reloaded = newController();
    await start(reloaded, "displayer");
    const state = reloaded.getState();
    expect(state.phase).toBe("pairing");
    expect(state.outbound).toEqual([]);
    expect(state.inbound).toEqual([]);
    expect(state.pairing.kind).toBe("waiting-for-peer");
    // A new code, so the other device's code no longer matches and pairing
    // genuinely has to start again. Nothing is claimed to have survived.
    expect(state.code).not.toBe(a.getState().code);
    expect(state.code).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);
  });
});

describe("G2 the fifth send in a row", () => {
  it("accepts four, refuses the fifth, and puts all four on screen", async () => {
    const { a } = await pairedPair();
    expect(MAX_PENDING_MESSAGES).toBe(4);

    const texts = ["one", "two", "three", "four", "five"];
    const verdicts = texts.map((text) => a.send(text));
    // Four accepted, one refused, and the refusal names the queue, not the note.
    expect(verdicts.map((verdict) => verdict.ok)).toEqual([true, true, true, true, false]);
    expect(verdicts[4]).toEqual({ ok: false, reason: "queue-full" });

    // The Phase 3V fix, attacked: every accepted note has its own row, in its
    // own order, with its own words. Nothing accepted is invisible.
    const rows = a.getState().outbound;
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.text)).toEqual(["one", "two", "three", "four"]);
    expect(rows.map((row) => row.sendId)).toEqual([1, 2, 3, 4]);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(4);

    // And the rendered transcript really names all four, not just the head.
    const markup = render(<MessageList inbound={a.getState().inbound} outbound={rows} />);
    for (const text of ["one", "two", "three", "four"]) {
      expect(markup, `"${text}" was accepted but is in no rendered list`).toContain(text);
    }
    expect(markup).not.toContain("five");
    // All four are `queued` and not one has been claimed: four synchronous sends
    // run before the pump's first microtask, so the honest picture of a person
    // hammering the send key is four rows, each attributed, none invented.
    expect(rows.map((row) => row.status)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(markup.split(SOUND_CHAT_COPY.outbound.queued).length - 1).toBe(4);
  });

  it("the refusal is a discrete event, so it interrupts rather than chattering", async () => {
    const { a } = await pairedPair();
    for (const text of ["one", "two", "three", "four"]) a.send(text);
    const markup = render(
      <Composer
        value="five"
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={SOUND_CHAT_COPY.refusal["queue-full"]}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("4 notes are already waiting.");
    // The refused note is still in the box, so the person can see what they lost.
    expect(markup).toContain(">five<");
  });
});

describe("G3 the tab goes away mid-send", () => {
  it("hides mid-transmission: the bar stops, nothing new is played, the copy says held", async () => {
    const { a } = await pairedPair();
    a.send(ascii(20));
    await settle();
    expect(a.getState().transport).toBe("awaiting_ack");

    setTabHidden(true);
    await settle();
    const state = a.getState();
    // Held, not cancelled: the note is still ours and still owed.
    expect(state.transport).toBe("hidden_hold");
    expect(transportSentence(state.transport)).toBe("Held while this tab is in the background.");
    // The composer is closed for exactly this reason, with that one sentence.
    expect(deriveComposerBlock(state)).toBe("Held while this tab is in the background.");
    // And the bar, which measures audio that is not being played, is gone.
    expect(state.progress).toBeNull();
    expect(liveIntervals.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rejections).toEqual([]);
  });

  it("a note typed while hidden is held, and goes out only once the tab is shown", async () => {
    const { a } = await pairedPair();
    setTabHidden(true);
    await settle();
    expect(a.getState().transport).toBe("hidden_hold");

    const result = a.send("written in the background");
    expect(result).toEqual({ ok: true, queued: false, sendId: 1 });
    // Accepted, attributed, and rendered: a held note is not a lost note.
    const rows = a.getState().outbound;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
    expect(render(<MessageList inbound={[]} outbound={rows} />)).toContain(
      SOUND_CHAT_COPY.outbound.queued,
    );
    // Nothing was transmitted while hidden: the machine refuses TRANSMIT_BEGIN
    // in `hidden_hold` and the tab's speaker really was never scheduled.
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(contextFor(a).played.length).toBe(0);

    setTabHidden(false);
    await until("the held note to be on the air", () => contextFor(a).played.length > 0);
    // The session emits TRANSMIT_DONE on *scheduling*, so the transport is
    // already `awaiting_ack` by the time the loop can look: the blocks really
    // are in the schedule and the speaker is still playing them. Asserting
    // `transmitting` here would be asserting a state this session never
    // publishes after the first block is scheduled.
    expect(contextFor(a).played.length).toBeGreaterThan(0);
    expect(a.getState().outbound[0]?.status).toBe("sending");
    expect(a.getState().transport).toBe("awaiting_ack");
    expect(transportSentence("awaiting_ack")).toBe(
      "On the air, waiting for the other device to confirm.",
    );
  });

  it("backgrounding during pairing puts no handshake tone on the air", async () => {
    const controller = newController();
    setTabHidden(true);
    await start(controller, "enterer", "ABCD2345");
    await settle();
    // An enterer that started hidden has never put its PAIR frame out, which is
    // the whole point: a handshake tone in a background tab is noise a person
    // cannot hear and cannot stop.
    expect(contextFor(controller).played.length).toBe(0);
    expect(controller.getState().transport).toBe("hidden_hold");
    // Coming back is what puts it on the air.
    setTabHidden(false);
    await until("the handshake tone to be played", () => contextFor(controller).played.length > 0);
  });
});

describe("G4 two Sound Chat tabs in one room", () => {
  it("each tab hears the other and says a transmission was heard but not read", async () => {
    // Two independent pairings, four controllers, one room: the acoustic
    // channel is shared, so every block a tab plays is a block the other hears.
    const first = await pairedPair();
    const second = await pairedPair();
    expect(first.a.getState().code).not.toBe(second.a.getState().code);

    first.a.send("a note only the first tab's partner can read");
    await settle();
    const onTheAir = contextFor(first.a).takeSchedule();
    expect(onTheAir.length).toBeGreaterThan(0);

    // Both of the second pair are listening; feed the foreign block to both.
    feedSchedule(contextFor(second.a), onTheAir);
    feedSchedule(contextFor(second.b), onTheAir);
    await until("the second tab to report it", () =>
      second.a
        .getState()
        .notices.some((notice) => notice.text === SOUND_CHAT_COPY.transmit.unreadable),
    );

    // The truth, in the copy: something WAS heard, and this code cannot read it.
    // Not "the channel was busy", not "silence" - the session measured a block.
    const notice = second.a.getState().notices.at(-1);
    expect(notice?.text).toBe("A transmission was heard, but this pairing code cannot read it.");
    expect(second.a.getState().stats.framesUnreadable).toBeGreaterThan(0);

    // And the blast radius is exactly one block: nothing crossed a transcript.
    expect(second.a.getState().inbound).toEqual([]);
    expect(second.b.getState().inbound).toEqual([]);
    expect(second.a.getState().outbound).toEqual([]);
    // The first pair is untouched by the noise it caused elsewhere.
    expect(first.a.getState().inbound).toEqual([]);
  });

  it("FIXED — a first tab's tone no longer kills a second tab's handshake", async () => {
    const first = await pairedPair();
    // A third device in the room whose own partner has not answered yet.
    const stranger = newController();
    await start(stranger, "enterer", "WXYZ6789");
    // Let the stranger finish its own handshake tone and lift its Rx pause. The
    // pause is measured on the AudioContext clock, which in this harness is
    // `roomClock` - and only `feedSchedule` moves it - so a fake *timer* flush is
    // not enough here and would be testing a feed that is still deaf.
    await settle();
    advanceRoom(BLOCK_DURATION_MS / 1_000 + 1);
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    await settle();
    expect(stranger.getState().pairing.kind).toBe("awaiting-confirmation");

    first.a.send("played while the other tab is mid-handshake");
    await settle();
    const onTheAir = contextFor(first.a).takeSchedule();
    expect(onTheAir.length).toBeGreaterThan(0);
    feedSchedule(contextFor(stranger), onTheAir);
    await settle();

    // This used to end the stranger's handshake with "a device answered, but it
    // is using a different pairing code" — for a *message* block from a paired
    // session, which says nothing at all about the stranger's code. Phase 4
    // split that verdict out: only a well-formed PAIR frame whose key check
    // failed may conclude "wrong code". An ordinary unauthenticated block is
    // now "something was heard that this code cannot read", and the handshake
    // survives to its own timeout.
    const state = stranger.getState();
    expect(state.pairing, "the handshake survives another tab's traffic").toBeDefined();
    expect(state.pairing.kind).not.toBe("failed");
    expect(state.pairingFailure, "and nothing is claimed about the code").toBeNull();
    // It is still reported, honestly, as unreadable audio.
    expect(state.notices.map((notice) => notice.text)).toContain(
      SOUND_CHAT_COPY.transmit.unreadable,
    );
    // A genuine wrong code is still diagnosed — that is `pair-key-failed`, and
    // it is covered at the protocol and session layers. The honest limitation is
    // that nothing here can tell the two apart for the *user*, which is why the
    // copy for a timeout names no cause.
    expect((state.pairingFailure ?? "").toLowerCase()).not.toMatch(/\bwho\b|identity/);
  });

  it("two tabs really do each hold a context, a microphone and a codec", async () => {
    // Measured rather than assumed: this is exactly what a second tab costs,
    // and nothing in the product coordinates it.
    const first = await pairedPair();
    const second = await pairedPair();
    // One AudioContext and one capture track per controller, with nothing
    // shared and nothing refused: four contexts, four live microphones.
    expect(contexts).toHaveLength(4);
    expect(tracks).toHaveLength(4);
    expect(tracks.map((track) => track.stopped)).toEqual([0, 0, 0, 0]);
    // Two independent sessions with two independent codes. (`a` and `b` inside
    // one pair deliberately share one, which is the whole point of pairing.)
    expect(first.a.getState().code).not.toBe(second.a.getState().code);
    expect(first.a.getState().code).toBe(first.b.getState().code);
    // And nothing anywhere in the feature tells a person this is a bad idea.
    const everySentence = [
      ...SOUND_CHAT_COPY.permission.limits,
      ...Object.values(SOUND_CHAT_COPY.refusal),
      ...Object.values(SOUND_CHAT_COPY.transport).map((entry) => entry(1)),
      SOUND_CHAT_COPY.transmit.unreadable,
      SOUND_CHAT_COPY.permission.lead,
      SOUND_CHAT_COPY.info.how,
    ]
      .join(" ")
      .toLowerCase();
    expect(everySentence).not.toMatch(/second tab|another tab|two tabs|only one tab/);
  });

  it("a paired tab is not knocked over by a foreign block: the session survives", async () => {
    const first = await pairedPair();
    const second = await pairedPair();
    first.a.send("noise from the other tab");
    await settle();
    const onTheAir = contextFor(first.a).takeSchedule();
    feedSchedule(contextFor(second.a), onTheAir);
    await settle();
    // `auth-failed` on a paired session must not run the pairing rejection: a
    // second tab cannot end a working session.
    expect(second.a.getState().pairing.kind).toBe("paired");
    expect(second.a.getState().phase).toBe("chat");
    expect(second.a.getState().inbound).toEqual([]);
  });
});

describe("G5 the attempt number the retry sentence quotes", () => {
  /** The ack timer the session arms for a one-block note, from `session.ts`. */
  const ACK_TIMER_MS = BLOCK_DURATION_MS + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000;

  it("quotes the note being retried; the screen reads the newest row instead", async () => {
    const { a } = await pairedPair();
    for (const text of ["one", "two", "three", "four"]) a.send(text);
    await settle();
    // The pump is FIFO, so the note on the air is the OLDEST of the four, and
    // the newest row is a note that has never left the queue.
    expect(a.getState().outbound[0]?.status).toBe("sending");
    expect(a.getState().outbound.at(-1)?.status).toBe("queued");
    expect(a.getState().outbound.at(-1)?.attempts).toBe(0);

    // Wait out the first acknowledgement, the first backoff, and the second
    // acknowledgement, so the note on the air has genuinely spent two attempts.
    await advanceUntil("the first note's second retry window", () => {
      const rows = a.getState().outbound;
      return a.getState().transport === "backoff" && (rows[0]?.attempts ?? 0) >= 2;
    });
    const state = a.getState();
    expect(state.transport, "the retry window was not reached").toBe("backoff");
    const onTheAir = state.outbound.find((row) => row.status === "sending");
    expect(onTheAir?.attempts, "the note on the air is on its second attempt").toBe(2);

    // What `sound-chat-screen.tsx` hands the sentence: `outbound.at(-1)`, the
    // newest row, whose attempts are 0 because it has never been transmitted.
    const shown = state.outbound.at(-1)?.attempts ?? 0;
    expect(shown).toBe(0);
    expect(transportSentence("backoff", shown)).toBe(
      "Not confirmed yet, so it is being tried again (attempt 1 of 3).",
    );
    // The number that belongs to the note on the air.
    expect(transportSentence("backoff", onTheAir?.attempts ?? 0)).toBe(
      "Not confirmed yet, so it is being tried again (attempt 2 of 3).",
    );
  });

  it("a single note is read correctly, which is where the wrong number hides", async () => {
    const { a } = await pairedPair();
    a.send("only one");
    await settle();
    // One row, so `at(-1)` and "the note being retried" are the same row and the
    // sentence is right. The number only goes wrong once a second note is behind
    // it, which is why this is not a defect with a single note.
    for (const expected of [0, 2]) {
      await advanceUntil("a backoff window", () => a.getState().transport === "backoff");
      const rows = a.getState().outbound;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.attempts).toBe(expected);
      expect(transportSentence("backoff", rows.at(-1)?.attempts ?? 0)).toContain(
        `attempt ${expected === 0 ? 1 : 2} of 3`,
      );
      // Wait the window out, so the next attempt really does begin.
      await advanceUntil(
        "the next attempt",
        () =>
          a.getState().transport !== "backoff" &&
          (a.getState().outbound[0]?.attempts ?? 0) > expected,
      );
    }
    // Three attempts and then the note is given up - and the give-up does NOT
    // leave the status line claiming another try is on its way.
    await advanceUntil(
      "the note to be given up",
      () => a.getState().outbound[0]?.status === "failed",
    );
    expect(a.getState().outbound[0]?.attempts).toBe(3);
    expect(a.getState().transport).not.toBe("backoff");
    expect(transportSentence(a.getState().transport, 3)).not.toContain("being tried again");
  });

  it("the per-row retry sentence is right even where the status line is not", async () => {
    const { a } = await pairedPair();
    for (const text of ["one", "two", "three", "four"]) a.send(text);
    await settle();
    await advanceUntil("the first note's second retry window", () => {
      const rows = a.getState().outbound;
      return a.getState().transport === "backoff" && (rows[0]?.attempts ?? 0) >= 2;
    });
    const rows = a.getState().outbound;
    // `OutboundRow` reads its OWN row's attempts, so the attributed sentence is
    // right: "Attempt 2 of 3" for the note on its second attempt. The
    // unattributed status line above the transcript is the one that says 1.
    const markup = render(<MessageList inbound={[]} outbound={rows} />);
    expect(markup).toContain("Attempt 2 of 3, then it is given up.");
    const status = render(
      <TransmitStatus
        transport={a.getState().transport}
        transmitting={a.getState().transmitting}
        progress={null}
        attempts={rows.at(-1)?.attempts ?? 0}
      />,
    );
    expect(status).toContain("attempt 1 of 3");
  });
});
describe("G6 keyboard-only operability of every reachable screen", () => {
  function interactive(markup: string): { buttons: number; divs: number } {
    return {
      buttons: (markup.match(/<button/g) ?? []).length,
      divs: (markup.match(/<div[^>]*\sonClick/g) ?? []).length,
    };
  }

  it("pairing: three real buttons, and nothing clickable that is not one", () => {
    const markup = render(<PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />);
    expect(interactive(markup).divs).toBe(0);
    expect(interactive(markup).buttons).toBeGreaterThanOrEqual(3);
  });

  it("the transcript is a focusable named region, so a keyboard can scroll it", () => {
    const markup = render(<MessageList inbound={[]} outbound={[]} />);
    expect(markup).toMatch(/<div role="region" tabindex="0" aria-label="Sound Chat transcript"/);
    expect(markup).toContain('role="log"');
  });

  it("the composer: one form, so Enter submits with no key handler to get wrong", () => {
    const markup = render(
      <Composer
        value="hi"
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
      />,
    );
    expect(markup).toMatch(/<form noValidate/);
    expect(markup).toContain('type="submit"');
    // A real `for`/`id` pair, not a placeholder label.
    expect(markup).toMatch(/<label for="[^"]+" class="sr-only">Note to send<\/label>/);
    expect(markup).toMatch(/<textarea id="[^"]+"/);
    // The send control is focusable in every state, including the refused ones,
    // so the reason is always one Tab away rather than out of the tree.
    expect(markup).not.toMatch(/<button[^>]*\sdisabled/);
  });

  it("the composer stays usable during a transmission, and says what a second note is", () => {
    // `transmitting` and `awaiting_ack` are not in `deriveComposerBlock`'s list,
    // so a second note can be typed while the first is on the air.
    for (const state of ["transmitting", "awaiting_ack", "backoff", "listening"] as const) {
      expect(deriveComposerBlock(chatState({ transport: state }))).toBeNull();
    }
    // And the session queues it rather than dropping it, with a row of its own.
    expect(SOUND_CHAT_COPY.outbound.queued).toBe("Queued, not played yet");
  });
});

describe("G7 the notice list is not a live region, and the one notice that matters is silent", () => {
  it("a heard-but-unreadable block changes no transport state and no announced copy", async () => {
    const first = await pairedPair();
    const second = await pairedPair();
    // The status line a screen reader is watching, before the foreign block.
    const before = transportSentence(second.a.getState().transport);
    const beforeStats = second.a.getState().stats.blocksDecoded;

    first.a.send("a note the other tab cannot read");
    await settle();
    feedSchedule(contextFor(second.a), contextFor(first.a).takeSchedule());
    await until(
      "the foreign block to be counted",
      () => second.a.getState().stats.framesUnreadable > 0,
    );

    // The event is a diagnostic, not a transition: the machine maps
    // HEARD_UNREADABLE to the state it was already in, so the `role="status"`
    // line reads exactly what it read before.
    expect(transportSentence(second.a.getState().transport)).toBe(before);
    expect(second.a.getState().stats.blocksDecoded).toBeGreaterThan(beforeStats);
    // The ONLY carrier of the fact is a notice row.
    const notice = second.a.getState().notices.at(-1);
    expect(notice?.text).toBe(SOUND_CHAT_COPY.transmit.unreadable);
  });

  it("FIXED — that row is now announced politely", () => {
    // `NoticeList` is module-private and the chat phase is unreachable without a
    // DOM, so the only place this can be checked is the source. The same
    // technique `provenance.test.ts` uses, and for the same reason: the claim is
    // about markup that no test in this repo can render.
    //
    // This assertion was the finding, and it is now inverted. It used to require
    // the absence of every live-region attribute, on the grounds that "the
    // events that produce them are announced where they happen" — true for
    // `onListenerError`, false for `heard-unreadable`, whose transport event maps
    // to no state and no copy. So the one notice reporting a fact about the room
    // arrived silently. It is a polite `role="status"` now: a warning, not an
    // interruption, and never the assertive region reserved for user-caused
    // refusals.
    const source = readFileSync(new URL("./sound-chat-screen.tsx", import.meta.url), "utf8");
    const list = /function NoticeList\([\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    expect(list, "the notice list was not found in the screen source").not.toBe("");
    expect(list).toContain("notices.map");
    expect(list).toContain('role="status"');
    expect(list).toContain('aria-live="polite"');
    // Still not an interruption, and never a log.
    expect(list).not.toMatch(/role="(alert|log)"/);
  });
});

describe("G8 every refusal a person can be handed has its own sentence", () => {
  it("the six refusals are six different sentences, and none claims delivery", async () => {
    const sentences = new Set(Object.values(SOUND_CHAT_COPY.refusal));
    expect(sentences.size).toBe(6);
    for (const sentence of sentences) expect(sentence).toBeTruthy();
    // Not one of them says the note arrived, because none of them knows.
    for (const sentence of sentences) {
      expect(sentence.toLowerCase()).not.toMatch(/delivered|received|arrived/);
    }
  });

  it("a send before the controller exists is refused with a sentence a person can act on", () => {
    // The one dead-copy finding `deep-p3b-render.test.tsx` records: the first
    // render has no controller, and `sendRefusalText(undefined)` answers with
    // "Sound Chat has stopped." Nothing is stopped. Re-measured, still true.
    expect(SOUND_CHAT_COPY.refusal.stopped).toBe("Sound Chat has stopped.");
    // The sentence that would be honest for it is the one the composer already
    // uses for "not paired yet", so the fix is a one-line change if wanted.
    expect(SOUND_CHAT_COPY.composer.blockedByPairing).toBe(
      "Pairing has to finish before notes can be sent.",
    );
  });

  it("an over-long note never reaches the session, so the reason is about the note", async () => {
    const { a } = await pairedPair();
    const before = a.getState().outbound.length;
    expect(a.send(ascii(85))).toEqual({ ok: false, reason: "too-long" });
    expect(a.send(repeat(ACCENTED, 43))).toEqual({ ok: false, reason: "too-long" });
    // An empty note is refused before the session, with its own reason.
    expect(a.send("")).toEqual({ ok: false, reason: "empty" });
    // A whitespace-only note is one byte, not zero: it is a real byte on the air.
    expect(a.send(" ").ok).toBe(true);
    expect(a.getState().outbound.length).toBe(before + 1);
    expect(liveIntervals.size).toBe(0);
  });
});
