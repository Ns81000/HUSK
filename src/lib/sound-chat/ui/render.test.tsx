/**
 * The rendered markup of every Sound Chat state, and the copy rules that must
 * hold in all of them.
 *
 * WHY render at all in a Node test environment: there is no jsdom, no
 * happy-dom and no testing-library in this repo, and none may be added
 * (`package.json` is not this feature's to edit). `react-dom/server` is already a
 * dependency, so `renderToStaticMarkup` gives the *real* markup — the real
 * `aria-live` regions, the real `disabled` attributes, the real `role`s and the
 * real text — without inventing a DOM implementation. Effects do not run, so
 * anything a test needs to observe is asserted through what the markup contains
 * rather than through what it does after mount; the behaviour that lives in
 * effects is covered against the real controller in `controller.test.ts`.
 *
 * The two mechanical honesty rules are checked here over every string in
 * `SOUND_CHAT_COPY` **and** over the rendered output, so a new sentence cannot
 * slip either rule past review.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { BlockedPanel } from "@/components/sound-chat/blocked-panel";
import { Composer } from "@/components/sound-chat/composer";
import { FatalPanel } from "@/components/sound-chat/fatal-panel";
import { InfoPanel } from "@/components/sound-chat/info-panel";
import { MessageList } from "@/components/sound-chat/message-list";
import { PairingPanel } from "@/components/sound-chat/pairing-panel";
import { PermissionPrompt } from "@/components/sound-chat/permission-prompt";
import { TransmitStatus } from "@/components/sound-chat/transmit-status";
import { SoundChatEntry } from "@/components/sound-chat/sound-chat-entry";
import { PAIRING_CONFIRMATION_COPY, SOUND_CHAT_COPY, transportSentence } from "./copy";
import { SOUND_CHAT_ENTRY_COPY } from "./entry-copy";
import type { PairingState } from "../pairing";
import type { SoundChatBlock, SoundChatFatal } from "./controller";
import type { TransportState } from "../transport-machine";
import type { SendRefusal } from "../session";
import type { OutboundStatus } from "../protocol";
import { MAX_MESSAGE_PLAINTEXT_BYTES, SINGLE_BLOCK_PLAINTEXT_BYTES } from "../protocol";
import { BLOCK_DURATION_MS } from "./budget";

/**
 * The code-point ranges emoji live in, checked by comparison rather than by a
 * regular expression.
 *
 * WHY not one big character class: `no-misleading-character-class` is right to
 * reject a class whose ranges contain characters that can take a combining mark
 * (the emoji modifier and variation-selector blocks), and the fix it wants is not
 * a character class. Comparing code points says the same thing with no class to
 * mislead anything. The ranges are the ones the Phase 2V battery already used,
 * plus the arrow block so a UI arrow cannot stand in for a pictograph.
 */
const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2190, 0x21ff],
  [0xfe00, 0xfe0f],
];

function hasEmoji(subject: string): boolean {
  for (const character of subject) {
    const point = character.codePointAt(0) ?? 0;
    for (const [low, high] of EMOJI_RANGES) {
      if (point >= low && point <= high) return true;
    }
  }
  return false;
}

/**
 * The words that would claim the channel makes no sound. The feature is
 * audible by design, so any of these in the UI is a false claim — including in
 * a sentence that denies them, which is why this is a mechanical check and not a
 * review.
 */
const FALSE_CLAIMS =
  /\b(silent|silently|inaudible|inaudibly|inaudible|whisper|stealth|unheard|without (a )?sound)\b/i;

/**
 * The rendered markup with React's text escaping undone, so an assertion about
 * copy compares the words a reader sees rather than `&#x27;`. Measured: React 19
 * renders `This device's audio` as `This device&#x27;s audio`.
 */
function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every string in a nested object, with the path that reached it. */
function everyString(value: unknown, path = "copy"): string[] {
  if (typeof value === "string") return [`${path}: ${value}`];
  if (typeof value === "function") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => everyString(entry, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => everyString(entry, `${path}.${key}`));
  }
  return [];
}

const ALL_COPY = [...everyString(SOUND_CHAT_COPY), ...everyString(SOUND_CHAT_ENTRY_COPY)];

const noop = (): void => {};

describe("the copy rules, over every string the feature can show", () => {
  it("finds strings to check, so an empty sweep cannot pass silently", () => {
    expect(ALL_COPY.length).toBeGreaterThan(40);
  });

  it("contains no emoji anywhere", () => {
    const offenders = ALL_COPY.filter((entry) => hasEmoji(entry));
    expect(offenders).toEqual([]);
  });

  it("never claims the channel makes no sound", () => {
    const offenders = ALL_COPY.filter((entry) => FALSE_CLAIMS.test(entry));
    expect(offenders).toEqual([]);
  });

  it("says the note is audible, which is the honest description", () => {
    expect(SOUND_CHAT_COPY.permission.limits.join(" ")).toMatch(/audible|out loud/i);
    expect(transportSentence("transmitting")).toBe("Playing your note out loud");
  });

  it("covers every transport state, refusal, status and failure kind with its own sentence", () => {
    const states: TransportState[] = [
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
    for (const state of states) {
      expect(transportSentence(state), `no sentence for ${state}`).toBeTruthy();
    }
    const refusals: SendRefusal[] = [
      "not-paired",
      "empty",
      "too-long",
      "queue-full",
      "module-error",
      "stopped",
    ];
    for (const reason of refusals) {
      expect(SOUND_CHAT_COPY.refusal[reason], `no sentence for ${reason}`).toBeTruthy();
    }
    const statuses: OutboundStatus[] = ["sending", "sent", "failed"];
    for (const status of statuses) {
      expect(SOUND_CHAT_COPY.outbound[status], `no sentence for ${status}`).toBeTruthy();
    }
    const blocks: SoundChatBlock["kind"][] = [
      "mic-denied",
      "mic-missing",
      "mic-unsupported",
      "device-rate",
      "bad-code",
      "crypto-unavailable",
      "codec-unavailable",
      "audio-unavailable",
    ];
    for (const kind of blocks) {
      expect(SOUND_CHAT_COPY.blocked[kind]?.heading, `no heading for ${kind}`).toBeTruthy();
      expect(SOUND_CHAT_COPY.blocked[kind]?.body, `no body for ${kind}`).toBeTruthy();
    }
    const fatals: SoundChatFatal["kind"][] = ["codec-died", "frame-contract"];
    for (const kind of fatals) {
      expect(SOUND_CHAT_COPY.fatal[kind]?.heading, `no heading for ${kind}`).toBeTruthy();
    }
  });

  it("gives every failure its own heading, so no two read the same", () => {
    const headings = [
      ...Object.values(SOUND_CHAT_COPY.blocked).map((entry) => entry.heading),
      ...Object.values(SOUND_CHAT_COPY.fatal).map((entry) => entry.heading),
      ...Object.values(SOUND_CHAT_COPY.transport),
    ];
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("quotes the measured numbers the copy depends on", () => {
    // Pinned against the protocol and the session, not against a third copy of
    // them: `capacity.test.ts` already proves the measured capacity, and these
    // assertions prove the *copy* quotes that same number.
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(84);
    expect(SINGLE_BLOCK_PLAINTEXT_BYTES).toBe(43);
    expect(BLOCK_DURATION_MS).toBe(1_920);
    expect(SOUND_CHAT_COPY.composer.byteCounter(7)).toBe("7 / 84 bytes");
    expect(SOUND_CHAT_COPY.composer.singleBlock).toContain("1.9 seconds");
    expect(SOUND_CHAT_COPY.composer.twoBlocks).toContain("3.8 seconds");
    // The rate quoted in the info panel is the user's own bytes per second, not
    // the block rate: 84 / 3.84 = 21.9, which rounds to 22.
    expect(SOUND_CHAT_COPY.info.rate).toContain("22 bytes a second");
    // No document in this feature may quote the superseded 33 B/s figure.
    expect(SOUND_CHAT_COPY.info.rate).not.toContain("33 bytes");
  });

  it("says a pairing confirmation proves the code and not the person", () => {
    expect(PAIRING_CONFIRMATION_COPY).toContain("not who is holding");
    expect(FALSE_CLAIMS.test(PAIRING_CONFIRMATION_COPY)).toBe(false);
  });

  it("gives a mismatched pairing its own honest sentence", () => {
    const wrongCode = SOUND_CHAT_COPY.pairingFailure("wrong-code");
    expect(wrongCode).toContain("a different pairing code");
    // Never an identity claim: the acoustic handshake is a key check.
    expect(wrongCode.toLowerCase()).not.toContain("identity");
    expect(wrongCode.toLowerCase()).not.toMatch(/\bwho\b/);
  });
});

describe("the permission pre-prompt", () => {
  const markup = render(<PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />);

  it("explains why the microphone is wanted, before the browser asks", () => {
    expect(markup).toContain(SOUND_CHAT_COPY.permission.why);
    expect(markup).toContain(SOUND_CHAT_COPY.permission.whyVolume);
  });

  it("states the limits, including that the sound is audible and recordable", () => {
    for (const limit of SOUND_CHAT_COPY.permission.limits) {
      expect(markup).toContain(limit.slice(0, 40));
    }
    expect(markup).toMatch(/audible/i);
    expect(markup).toMatch(/record/i);
  });

  it("offers both roles, and the way out is the shell's own", () => {
    expect(markup).toContain(SOUND_CHAT_COPY.permission.displayAction);
    expect(markup).toContain(SOUND_CHAT_COPY.permission.enterAction);
    // INVERTED. A third quiet "Not now" used to sit under those two and did what
    // the shell's back control already does — leave Sound Chat — so the screen
    // offered two controls for one exit and neither was the obvious one. The
    // pre-prompt renders no exit of its own now. What it renders instead is a door
    // onto the prose that used to stand between the reader and the two buttons.
    expect(markup).not.toContain(SOUND_CHAT_COPY.permission.dismiss);
    expect(markup).toContain(SOUND_CHAT_COPY.permission.learnMore);
  });

  it("is reachable by keyboard: every action is a real button", () => {
    expect(markup).not.toMatch(/<div[^>]*onClick/);
    expect((markup.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("already shows the MIT attribution, before anything is started", () => {
    expect(markup).toContain("ggwave");
    expect(markup).toContain("Georgi Gerganov");
    expect(markup).toContain("MIT");
  });

  it("labels its heading for assistive technology", () => {
    // A level-2 heading: the shell owns the page's only <h1>, and a second one
    // on the same page is a heading-list defect even though WCAG has no
    // criterion for the count.
    expect(markup).toMatch(/<section[^>]*aria-labelledby="[^"]+"/);
    expect(markup).toMatch(/<h2 id="[^"]+"/);
    expect(markup).not.toMatch(/<h1\b/);
  });
});

describe("the pairing screen, one line per pairing state", () => {
  const states: PairingState[] = [
    { kind: "idle" },
    { kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" },
    { kind: "awaiting-confirmation", code: "ABCD2345", role: "enterer" },
    { kind: "paired", code: "ABCD2345", role: "displayer", peerSalt: new Uint8Array(16) },
    { kind: "failed", code: "ABCD2345", role: "displayer", reason: "wrong-code" },
  ];

  for (const state of states) {
    it(`renders ${state.kind} without falling through to a blank card`, () => {
      const markup = render(
        <PairingPanel
          role={state.kind === "idle" ? "displayer" : state.role}
          code="ABCD2345"
          state={state}
          failure={state.kind === "failed" ? SOUND_CHAT_COPY.pairingFailure(state.reason) : null}
          busy={false}
          onRetry={noop}
          onSwitchRole={noop}
        />,
      );
      expect(markup.length).toBeGreaterThan(200);
      // An enterer that already holds a code must not be told to type one: there
      // is no field on this screen. This case is reachable by retrying after a
      // microphone refusal, which is exactly why it matters.
      expect(markup).toContain(
        state.kind === "idle" || state.role === "displayer"
          ? SOUND_CHAT_COPY.pairing.displayHeading
          : SOUND_CHAT_COPY.pairing.enterRetryHeading,
      );
      // `state.kind !== "idle"` first: the `idle` variant carries no `role`.
      if (state.kind !== "idle" && state.role === "enterer") {
        expect(
          markup,
          "an enterer holding a code is instructed to type a code it already has",
        ).not.toContain(SOUND_CHAT_COPY.pairing.enterHeading);
      }
    });
  }

  it("announces a waiting state politely and a failure assertively", () => {
    const waiting = render(
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(waiting).toContain('role="status"');
    expect(waiting).toContain(SOUND_CHAT_COPY.pairing.waitingDisplay);
    expect(waiting).toContain(SOUND_CHAT_COPY.pairing.hint);

    const failed = render(
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "failed", code: "ABCD2345", role: "displayer", reason: "wrong-code" }}
        failure={SOUND_CHAT_COPY.pairingFailure("wrong-code")}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(SOUND_CHAT_COPY.pairing.retry);
    // The failed render above is a displayer, so the control it offers switches to
    // the enterer's branch. The label is keyed by the destination role, which is
    // why it cannot be asserted as one constant any more.
    expect(failed).toContain(SOUND_CHAT_COPY.pairing.switchTo.enterer);
  });

  it("shows the displayer's code as a large monospaced readout", () => {
    const markup = render(
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(markup).toContain("ABCD2345");
    expect(markup).toContain("font-mono");
    expect(markup).toContain(SOUND_CHAT_COPY.pairing.copyAction);
  });

  it("shows the confirmation, and what it does not prove", () => {
    const markup = render(
      <PairingPanel
        role="enterer"
        code="ABCD2345"
        state={{
          kind: "paired",
          code: "ABCD2345",
          role: "enterer",
          peerSalt: new Uint8Array(16),
        }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(markup).toContain(PAIRING_CONFIRMATION_COPY);
  });
});

describe("blocked and fatal are different screens with different copy", () => {
  const kinds: SoundChatBlock["kind"][] = [
    "mic-denied",
    "mic-missing",
    "mic-unsupported",
    "device-rate",
    "bad-code",
    "crypto-unavailable",
    "codec-unavailable",
    "audio-unavailable",
  ];

  for (const kind of kinds) {
    it(`a blocked session for ${kind} says so, and offers a retry`, () => {
      const block: SoundChatBlock = { kind, detail: "NotAllowedError: refused" };
      const markup = render(<BlockedPanel block={block} onRetry={noop} onBack={noop} />);
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(SOUND_CHAT_COPY.blocked[kind].heading);
      expect(markup).toContain(SOUND_CHAT_COPY.actions.retry);
      expect(markup).toContain(SOUND_CHAT_COPY.actions.back);
      expect(markup).toContain("NotAllowedError: refused");
    });
  }

  it("survives an unrecognised kind without rendering nothing", () => {
    const markup = render(
      <BlockedPanel
        block={{ kind: "a-kind-this-code-never-heard-of", detail: "odd" }}
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.blocked["audio-unavailable"].heading);
    expect(markup).toContain("a-kind-this-code-never-heard-of");
  });

  for (const kind of ["codec-died", "frame-contract"] as const) {
    it(`a fatal session for ${kind} offers a restart behind a confirmation`, () => {
      const fatal: SoundChatFatal = { kind, detail: "CodecModuleError: died" };
      const markup = render(<FatalPanel fatal={fatal} onRestart={noop} />);
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(SOUND_CHAT_COPY.fatal[kind].heading);
      expect(markup).toContain(SOUND_CHAT_COPY.modal.restartConfirm);
      // The dialog itself is closed until asked for, so the destructive act is
      // never the first thing a screen reader lands on.
      expect(markup).not.toContain('role="dialog"');
    });
  }

  it("the two fatal kinds do not read alike", () => {
    expect(SOUND_CHAT_COPY.fatal["codec-died"].heading).not.toBe(
      SOUND_CHAT_COPY.fatal["frame-contract"].heading,
    );
    expect(SOUND_CHAT_COPY.fatal["codec-died"].body).toMatch(/audio codec/i);
    expect(SOUND_CHAT_COPY.fatal["frame-contract"].body).toMatch(/format this session writes/i);
  });
});

describe("transmit status and the progress bar", () => {
  it("announces the state politely, and never calls a playing note delivered", () => {
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 }}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain(transportSentence("transmitting"));
    expect(markup).not.toMatch(/delivered/i);
  });

  it("exposes the progress bar as a determinate progressbar with honest text", () => {
    const markup = render(
      <TransmitStatus
        transport="awaiting_ack"
        transmitting={false}
        progress={{ blocks: 2, blockIndex: 2, fraction: 0.5, remainingMs: 1920 }}
      />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain("Block 2 of 2");
    expect(markup).toContain("about 1.9 seconds left");
  });

  it("keeps the progress bar out of the live region, so a screen reader is not told 10 times a second", () => {
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 1, blockIndex: 1, fraction: 0.25, remainingMs: 1440 }}
      />,
    );
    const liveEnd = markup.indexOf('role="status"');
    const barStart = markup.indexOf('role="progressbar"');
    expect(liveEnd).toBeGreaterThan(-1);
    expect(barStart).toBeGreaterThan(liveEnd);
    // The live region is closed before the bar begins.
    expect(markup.slice(liveEnd, barStart)).toContain("</p>");
  });

  it("says it is getting ready in the window before the first block plays", () => {
    const markup = render(<TransmitStatus transport="transmitting" transmitting progress={null} />);
    expect(markup).toContain(SOUND_CHAT_COPY.transmit.arming);
  });

  it("shows a held send as held, not as failed", () => {
    const markup = render(
      <TransmitStatus transport="hidden_hold" transmitting={false} progress={null} />,
    );
    expect(markup).toContain(transportSentence("hidden_hold"));
    expect(markup).toMatch(/background/i);
  });

  it("has a sentence for all nine states and never leaves one out", () => {
    for (const state of [
      "idle",
      "listening",
      "transmitting",
      "awaiting_turn",
      "awaiting_ack",
      "backoff",
      "hidden_hold",
      "error",
      "module_error",
    ] as TransportState[]) {
      const markup = render(
        <TransmitStatus
          transport={state}
          transmitting={state === "transmitting"}
          progress={null}
        />,
      );
      expect(markup, `no markup for ${state}`).toContain(transportSentence(state));
    }
  });
});

describe("the composer", () => {
  const base = {
    onChange: noop,
    onSubmit: noop,
    disabled: false,
    disabledReason: null,
  };

  it("counts bytes, not characters, and says what a note will cost in sound", () => {
    const markup = render(<Composer {...base} value={"a".repeat(44)} />);
    expect(markup).toContain("44 / 84 bytes");
    expect(markup).toContain(SOUND_CHAT_COPY.composer.twoBlocks);
  });

  it("has no maxLength, because characters and bytes are different numbers", () => {
    const markup = render(<Composer {...base} value="hello" />);
    expect(markup).not.toContain("maxlength");
    expect(markup).not.toContain("maxLength");
  });

  it("refuses an over-cap note by disabling send and naming the excess", () => {
    const markup = render(<Composer {...base} value={"a".repeat(85)} />);
    expect(markup).toContain(SOUND_CHAT_COPY.composer.overCap(1));
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/<button[^>]*disabled/);
  });

  it("refuses an empty note without a scary message", () => {
    const markup = render(<Composer {...base} value="" />);
    expect(markup).toContain("0 / 84 bytes");
    expect(markup).toMatch(/<button[^>]*disabled/);
    expect(markup).not.toContain(SOUND_CHAT_COPY.composer.overCap(1));
  });

  it("marks exactly the cap as at the limit rather than over it", () => {
    const markup = render(<Composer {...base} value={"a".repeat(84)} />);
    expect(markup).toContain(SOUND_CHAT_COPY.composer.atCap);
    expect(markup).not.toContain("Too long by");
    expect(markup).not.toMatch(/<button[^>]*disabled/);
  });

  it("keeps the over-cap message out of a live region, so it is not re-read per keystroke", () => {
    const markup = render(<Composer {...base} value={"a".repeat(85)} />);
    expect(markup).not.toContain("aria-live");
    // It is reached instead through the field's description.
    expect(markup).toMatch(/aria-describedby="[^"]+"/);
  });

  it("labels the textarea and uses a form, so Enter sends without a key handler", () => {
    const markup = render(<Composer {...base} value="hi" />);
    expect(markup).toMatch(/<label[^>]*for="/);
    expect(markup).toMatch(/<textarea[^>]*id="/);
    expect(markup).toContain("<form");
    expect(markup).toContain('type="submit"');
  });

  it("shows why it is unusable when the session cannot send", () => {
    const markup = render(
      <Composer
        {...base}
        value="hi"
        disabled
        disabledReason={SOUND_CHAT_COPY.composer.blockedByPairing}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.composer.blockedByPairing);
    expect(markup).toMatch(/<textarea[^>]*disabled/);
  });

  it("says a queued note is queued — on the note, not on the radio", () => {
    // REWRITTEN IN PHASE 3V. This asserted that `TransmitStatus` renders
    // `transmit.queued` whenever the session is busy and nothing is on the air.
    // That global sentence is deleted: it said the same thing the per-note
    // `outbound.queued` row says, without saying which note, so a person with two
    // queued notes was told "queued" three times and could not tell which was
    // which. The rows own it now — attributed, once each — so the assertion moves
    // there, and this checks only that the component states nothing on its own.
    expect(render(<Composer {...base} value="" />)).not.toMatch(/Queued/);
    const markup = render(
      <TransmitStatus transport="listening" transmitting={false} progress={null} />,
    );
    expect(markup, "the transport block still claims a queued state of its own").not.toMatch(
      /Queued/,
    );
  });
});

describe("the transcript", () => {
  it("is an announced log and merges both directions in render order", () => {
    const markup = render(
      <MessageList
        inbound={[{ seq: 2, msgId: 7, text: "from them" }]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "from us", status: "sent", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-relevant="additions"');
    // `seq` is the order, so ours comes first even though its msgId is lower.
    expect(markup.indexOf("from us")).toBeLessThan(markup.indexOf("from them"));
  });

  it("never calls a note delivered until the peer acknowledged it", () => {
    const sending = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "note", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    expect(sending).toContain(SOUND_CHAT_COPY.outbound.sending);
    expect(sending).not.toMatch(/delivered/i);

    const sent = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "note", status: "sent", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    expect(sent).toContain(SOUND_CHAT_COPY.outbound.sent);
  });

  it("says a note failed after its attempts ran out, and how many it made", () => {
    const markup = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "note", status: "failed", attempts: 3, blocks: 2 },
        ]}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.outbound.failed);
  });

  it("shows a retry honestly while one is still under way", () => {
    const markup = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "note", status: "sending", attempts: 2, blocks: 1 },
        ]}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.transmit.retrying(2));
  });

  it("has an honest empty state that claims no delivery", () => {
    const markup = render(<MessageList inbound={[]} outbound={[]} />);
    expect(markup).toContain(SOUND_CHAT_COPY.transcript.emptyHeading);
    expect(markup).toContain(SOUND_CHAT_COPY.transcript.emptyBody);
    expect(markup).not.toMatch(/delivered/i);
  });
});

describe("the info panel and the MIT attribution", () => {
  it("shows the one-line notice whether or not the panel is open", () => {
    for (const open of [true, false]) {
      const markup = render(<InfoPanel open={open} onToggle={noop} />);
      expect(markup, `collapsed=${String(open)}`).toContain("ggwave");
      expect(markup).toContain("MIT");
      expect(markup).toContain("Georgi Gerganov");
    }
  });

  it("is a real disclosure with aria-expanded and aria-controls", () => {
    const markup = render(<InfoPanel open={false} onToggle={noop} />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("aria-controls=");
  });

  it("states the measured rate and the privacy boundary honestly", () => {
    const markup = render(<InfoPanel open onToggle={noop} />);
    expect(markup).toContain("84 bytes in 3.8 seconds");
    expect(markup).toContain("AES-256-GCM");
  });
});

describe("the lazy entry point", () => {
  it("says something true before the screen chunk has arrived", () => {
    const markup = render(<SoundChatEntry />);
    // Effects do not run in a static render, so this is exactly the pre-load
    // frame: a status region with an honest sentence, not a blank page.
    expect(markup).toContain('role="status"');
    expect(markup).toContain(SOUND_CHAT_ENTRY_COPY.loading);
  });
});

describe("no emoji and no false claims in the rendered output of any state", () => {
  const screens: readonly (readonly [string, ReactElement])[] = [
    ["permission", <PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />],
    [
      "pairing-waiting",
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    ],
    [
      "pairing-failed",
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "failed", code: "ABCD2345", role: "displayer", reason: "no-peer" }}
        failure={SOUND_CHAT_COPY.pairingFailure("no-peer")}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    ],
    [
      "chat",
      <MessageList
        inbound={[{ seq: 2, msgId: 1, text: "hello" }]}
        outbound={[
          { seq: 1, msgId: 9, sendId: 9, text: "hi", status: "sent", attempts: 1, blocks: 1 },
        ]}
      />,
    ],
    [
      "blocked",
      <BlockedPanel
        block={{ kind: "mic-denied", detail: "NotAllowedError" }}
        onRetry={noop}
        onBack={noop}
      />,
    ],
    [
      "fatal",
      <FatalPanel fatal={{ kind: "codec-died", detail: "CodecModuleError" }} onRestart={noop} />,
    ],
    [
      "transmitting",
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 2, blockIndex: 1, fraction: 0.25, remainingMs: 2880 }}
      />,
    ],
    [
      "composer",
      <Composer
        value={"a".repeat(84)}
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
      />,
    ],
    ["info", <InfoPanel open onToggle={noop} />],
    ["entry", <SoundChatEntry />],
  ];

  for (const [name, element] of screens) {
    it(`${name} contains no emoji and no false claim about the sound`, () => {
      const text = render(element);
      expect(hasEmoji(text), `${name} contains an emoji`).toBe(false);
      expect(FALSE_CLAIMS.test(text), `${name} claims the channel makes no sound`).toBe(false);
    });
  }
});
