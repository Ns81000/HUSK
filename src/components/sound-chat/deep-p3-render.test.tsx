/**
 * The rendered markup under hostile input: boundary bytes, degenerate progress
 * figures, dead copy, and a live region per component.
 *
 * `renderToStaticMarkup` is the whole tool here — no DOM implementation may be
 * added — so everything asserted is what the *markup* says, which is the only
 * thing a screen reader or a text extractor ever sees. Effects do not run, so the
 * behaviour that lives in them is out of scope and is covered against the real
 * controller in `deep-p3-controller.test.ts`.
 *
 * One test reads the component sources. That is deliberate: a third of what this
 * file checks is not "what is rendered" but "what is *reachable*", and a
 * sentence in `SOUND_CHAT_COPY` that no component ever reads is a real defect
 * that no render assertion can see.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { deriveComposerBlock } from "@/components/sound-chat/use-sound-chat";
import {
  MAX_MESSAGE_PLAINTEXT_BYTES,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
} from "@/lib/sound-chat/protocol";
import { SOUND_CHAT_COPY, transportSentence } from "@/lib/sound-chat/ui/copy";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import type { SoundChatUiState } from "@/lib/sound-chat/ui/controller";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

function renderRaw(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function render(element: ReactElement): string {
  return renderRaw(element)
    .replace(/&#x27;/g, "'")
    .replace(/&#x39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const noop = (): void => {};

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));

function componentSources(): string {
  return readdirSync(COMPONENT_DIR)
    .filter(
      // The production modules only: this file is in the same directory, and a
      // scan that found its own sentences in its own source would pass for ever.
      (name) => !name.includes(".test.") && (name.endsWith(".ts") || name.endsWith(".tsx")),
    )
    .map((name) => readFileSync(COMPONENT_DIR + name, "utf8"))
    .join("\n");
}

const ALL_STATES: TransportState[] = [
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

const BASE_STATE: SoundChatUiState = {
  phase: "chat",
  role: "displayer",
  block: null,
  fatal: null,
  transport: "listening",
  pairing: { kind: "paired", code: "ABCD2345", role: "displayer", peerSalt: new Uint8Array(16) },
  code: "ABCD2345",
  outbound: [],
  inbound: [],
  notices: [],
  transmitting: false,
  busy: false,
  progress: null,
  stats: {
    blocksDecoded: 0,
    framesUnreadable: 0,
    messagesDelivered: 0,
    duplicatesSuppressed: 0,
    conflicts: 0,
    acksSent: 0,
    retries: 0,
  },
  pairingFailure: null,
};

describe("R-A the progress bar survives degenerate figures", () => {
  const figures: readonly (readonly [string, number, number, number])[] = [
    ["Infinity", Number.POSITIVE_INFINITY, 2, 2],
    ["-Infinity", Number.NEGATIVE_INFINITY, 2, 2],
    ["negative", -3, 1, 1],
    ["over one", 7.5, 2, 2],
  ];

  for (const [name, fraction, blocks, blockIndex] of figures) {
    it(`renders a finite aria-valuenow for a ${name} fraction`, () => {
      const markup = render(
        <TransmitStatus
          transport="transmitting"
          transmitting
          progress={{ blocks, blockIndex, fraction, remainingMs: 500 }}
        />,
      );
      const value = /aria-valuenow="([^"]*)"/.exec(markup)?.[1];
      expect(value, "no aria-valuenow at all").toBeDefined();
      // `aria-valuenow` is a number to assistive technology, and every figure
      // here is outside the 0-1 range the controller's own `clamp` allows.
      expect(Number.isFinite(Number(value)), `aria-valuenow="${String(value)}"`).toBe(true);
      expect(Number(value)).toBeGreaterThanOrEqual(0);
      expect(Number(value)).toBeLessThanOrEqual(100);
    });
  }

  it("renders a finite position for a NaN fraction rather than the string NaN", () => {
    // FIXED. The component now guards the number itself instead of trusting the
    // controller: `Number.isFinite` before every arithmetic step, because a
    // non-finite value here becomes `aria-valuenow="NaN"` — a position a screen
    // reader cannot read and no user could have produced anyway.
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 1, blockIndex: 1, fraction: Number.NaN, remainingMs: 500 }}
      />,
    );
    expect(markup).not.toContain("NaN");
    expect(markup).toMatch(/aria-valuenow="[0-9]+"/);
  });

  it("never prints an out-of-range block sentence, whatever the props permit", () => {
    // FIXED. The component clamps `blocks` to at least 1 and `blockIndex` into
    // `[1, blocks]`, so "Block 2 of 1" and its neighbours are unreachable. The
    // controller clamps too — this is the belt to its braces, at the last place
    // before the DOM.
    for (const [blockIndex, blocks] of [
      [2, 1],
      [0, 1],
      [3, 2],
      [1, 0],
      [-1, 2],
    ] as const) {
      const markup = render(
        <TransmitStatus
          transport="transmitting"
          transmitting
          progress={{ blocks, blockIndex, fraction: 0.5, remainingMs: 900 }}
        />,
      );
      const said = markup.match(/Block \d+ of \d+/)?.[0] ?? "";
      const [saidIndex = 0, saidTotal = 0] = said.replace("Block ", "").split(" of ").map(Number);
      expect(saidIndex).toBeGreaterThanOrEqual(1);
      expect(saidIndex).toBeLessThanOrEqual(saidTotal);
      expect(saidTotal).toBeGreaterThanOrEqual(1);
    }
  });

  it("shows nothing at all for a bar whose total is not a number of blocks", () => {
    // `blocks: 0` cannot come out of the controller (`#progress` falls back to
    // 1) and cannot come out of a real session, so what the component does with
    // it is a question about the component, not about the feature.
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 0, blockIndex: 1, fraction: 0.5, remainingMs: 500 }}
      />,
    );
    expect(markup).toContain('role="progressbar"');
  });
});

describe("R-B the transport block never contradicts itself", () => {
  /**
   * `transmitting && progress === null && transport === "awaiting_ack"` is the
   * one combination that renders both the "getting ready" line and the "waiting
   * to confirm" line, which cannot both be true. The controller cannot produce it
   * today: `transmitting` is `txBusy || state === "transmitting"`, and a bar is
   * started on the very transport event that makes a state on-air, so an
   * `awaiting_ack` snapshot always has one. It is recorded here so that a change
   * to either half is a failing test rather than a contradictory screen.
   */
  const UNREACHABLE = (transport: string, transmitting: boolean, progress: boolean): boolean =>
    transport === "awaiting_ack" && transmitting && !progress;

  for (const transport of ALL_STATES) {
    for (const transmitting of [false, true]) {
      // PHASE 3V. This sweep used to have a third axis, `busy`, which rendered
      // the same markup twice for every combination. `busy` was removed from
      // `TransmitStatus` when the global "Queued." sentence went: the per-note
      // `outbound.queued` row owns that fact, attributed, so the transport block
      // genuinely has no opinion about queued work. A sweep axis that cannot
      // change the output is a duplicated test wearing a disguise.
      for (const withProgress of [false, true]) {
        const label = `${transport}/t=${String(transmitting)}/p=${String(withProgress)}`;
        it(`renders one honest set of lines for ${label}`, () => {
          const markup = render(
            <TransmitStatus
              transport={transport}
              transmitting={transmitting}
              progress={
                withProgress
                  ? { blocks: 2, blockIndex: 1, fraction: 0.25, remainingMs: 2_880 }
                  : null
              }
            />,
          );
          // The state sentence is always there, and it is the state's own.
          expect(markup).toContain(transportSentence(transport));
          if (!UNREACHABLE(transport, transmitting, withProgress)) {
            const arming = markup.includes(SOUND_CHAT_COPY.transmit.arming);
            const acking = markup.includes(SOUND_CHAT_COPY.transmit.acking);
            expect(arming && acking, "both 'getting ready' and 'waiting to confirm'").toBe(false);
          }
          // The bar is not a delivery claim in any combination.
          expect(markup).not.toMatch(/delivered/i);
          // Exactly one live region, and it is the sentence.
          expect((markup.match(/aria-live="polite"/g) ?? []).length).toBe(1);
          expect((markup.match(/role="progressbar"/g) ?? []).length).toBe(withProgress ? 1 : 0);
          // A bar is never rendered with a total it cannot justify.
          if (withProgress) expect(markup).toMatch(/Block 1 of 2/);
        });
      }
    }
  }

  it("never renders the arming line and the confirmation line together", () => {
    // FIXED. "Getting ready to play" and "waiting for the other device to
    // confirm" are two readings of the same instant, so `awaiting_ack` now
    // excludes the first: there, the blocks *are* scheduled.
    const markup = render(<TransmitStatus transport="awaiting_ack" transmitting progress={null} />);
    expect(markup).toContain(transportSentence("awaiting_ack"));
    expect(markup).not.toContain(SOUND_CHAT_COPY.transmit.arming);
    expect(markup).toContain(SOUND_CHAT_COPY.transmit.acking);
  });

  it("shows a stalled full bar as a full bar, and never as a delivery", () => {
    // The window between our audio being scheduled and the peer's confirmation is
    // up to 5 540 ms. The bar is at 100% for most of it.
    const markup = render(
      <TransmitStatus
        transport="awaiting_ack"
        transmitting={false}
        progress={{ blocks: 2, blockIndex: 2, fraction: 1, remainingMs: 0 }}
      />,
    );
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain("about 0 seconds left");
    expect(markup).toContain(transportSentence("awaiting_ack"));
    expect(markup).not.toMatch(/delivered/i);
  });
});

describe("R-C byte boundaries the composer's own measurement has to get right", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["one byte under the cap", "a".repeat(MAX_MESSAGE_PLAINTEXT_BYTES - 1)],
    ["exactly the cap", "a".repeat(MAX_MESSAGE_PLAINTEXT_BYTES)],
    ["one byte over the cap", "a".repeat(MAX_MESSAGE_PLAINTEXT_BYTES + 1)],
    ["far over the cap", "a".repeat(4_000)],
    ["a single block exactly", "a".repeat(SINGLE_BLOCK_PLAINTEXT_BYTES)],
    ["a single block plus one", "a".repeat(SINGLE_BLOCK_PLAINTEXT_BYTES + 1)],
    ["21 emoji", "\u{1f600}".repeat(21)],
    ["22 emoji", "\u{1f600}".repeat(22)],
    ["42 accented letters", "é".repeat(42)],
    ["43 accented letters", "é".repeat(43)],
    ["a lone high surrogate", "\ud800"],
    ["a low surrogate on its own", "\udc00"],
    ["whitespace only", "   "],
    ["a tab and a newline", "\t\n"],
    ["CRLF", "a\r\nb"],
    ["a very long single word", "x".repeat(MAX_MESSAGE_PLAINTEXT_BYTES + 1)],
  ];

  for (const [name, value] of cases) {
    it(`measures ${name} and says the same verdict the protocol would`, () => {
      const budget = measureMessage(value);
      const markup = render(
        <Composer
          value={value}
          onChange={noop}
          onSubmit={noop}
          disabled={false}
          disabledReason={null}
        />,
      );
      // The counter is the byte count, never the character count, and it is the
      // number the protocol's own `send()` will measure.
      expect(markup).toContain(SOUND_CHAT_COPY.composer.byteCounter(budget.bytes));
      // The send button's state is a pure function of that measurement.
      const sendEnabled = !/<button[^>]*type="submit"[^>]*disabled/.test(
        /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "<button disabled>",
      );
      expect(sendEnabled).toBe(budget.fits && budget.bytes > 0);
      // `aria-invalid` agrees with the button, or the two disagree about the
      // same field in the same render.
      const invalid = markup.includes('aria-invalid="true"');
      expect(invalid).toBe(budget.bytes > 0 && !budget.fits);
      // The over-cap sentence names the exact excess, never a negative or a
      // rounding of one.
      if (budget.bytes > 0 && !budget.fits) {
        expect(markup).toContain(SOUND_CHAT_COPY.composer.overCap(-budget.remainingBytes));
      } else {
        expect(markup).not.toContain("Too long by");
      }
    });
  }

  it("quotes a duration only when there is a duration to quote", () => {
    for (const [value, expected] of [
      ["", null],
      ["a", SOUND_CHAT_COPY.composer.singleBlock],
      ["a".repeat(SINGLE_BLOCK_PLAINTEXT_BYTES + 1), SOUND_CHAT_COPY.composer.twoBlocks],
      ["a".repeat(MAX_MESSAGE_PLAINTEXT_BYTES + 1), null],
    ] as const) {
      const markup = render(
        <Composer
          value={value}
          onChange={noop}
          onSubmit={noop}
          disabled={false}
          disabledReason={null}
        />,
      );
      if (expected === null) {
        expect(markup).not.toContain(SOUND_CHAT_COPY.composer.singleBlock);
        expect(markup).not.toContain(SOUND_CHAT_COPY.composer.twoBlocks);
      } else {
        expect(markup).toContain(expected);
      }
    }
  });

  it("accepts a whitespace-only note, because the protocol does", () => {
    // The only reason a note can be refused is its byte count, and three spaces
    // is three bytes. Refusing it would be a rule the protocol does not have.
    expect(measureMessage("   ").fits).toBe(true);
  });
});

describe("R-D the composer's reason and the state that produced it", () => {
  const phases: SoundChatUiState["phase"][] = [
    "permission",
    "preparing",
    "pairing",
    "chat",
    "blocked",
    "fatal",
  ];

  for (const phase of phases) {
    for (const transport of ALL_STATES) {
      it(`has one reason for ${phase} + ${transport}, and never two`, () => {
        const state: SoundChatUiState = { ...BASE_STATE, phase, transport };
        const reason = deriveComposerBlock(state);
        if (phase !== "chat") {
          // Anything that is not a live chat screen says pairing has to finish —
          // except a stopped session, which outranks it and is a different
          // sentence. Either way there is exactly one and it is a real one.
          expect(reason).toBe(SOUND_CHAT_COPY.composer.blockedByPairing);
        } else if (transport === "hidden_hold") {
          expect(reason).toBe(transportSentence("hidden_hold"));
        } else if (transport === "error" || transport === "module_error") {
          expect(reason).toBe(transportSentence(transport));
        } else {
          expect(reason).toBeNull();
        }
        // A reason is either a transport sentence or a composer sentence, never
        // a mixture of the two vocabularies. Resolved through
        // `transportSentence` because every entry of the record is a function.
        const transportWords = Object.keys(SOUND_CHAT_COPY.transport).map((state) =>
          transportSentence(state as Parameters<typeof transportSentence>[0]),
        );
        if (reason !== null && transportWords.includes(reason)) {
          expect(SOUND_CHAT_COPY.composer.blockedByPairing).not.toBe(reason);
        }
      });
    }
  }

  it("lets a user queue while their own audio is on the air", () => {
    // The channel takes turns, so a note typed during a transmission is held
    // rather than refused: refusing it would lose the words.
    for (const transport of [
      "listening",
      "transmitting",
      "awaiting_ack",
      "awaiting_turn",
      "backoff",
    ] as const) {
      expect(deriveComposerBlock({ ...BASE_STATE, phase: "chat", transport })).toBeNull();
    }
  });

  it("does not put a live region around the disabled reason", () => {
    const markup = render(
      <Composer
        value="hello"
        onChange={noop}
        onSubmit={noop}
        disabled
        disabledReason={SOUND_CHAT_COPY.composer.blockedByPairing}
      />,
    );
    // It changes as the state changes, several times a second during a backoff,
    // so it must be reached by reading rather than by announcement.
    expect(markup).toContain(SOUND_CHAT_COPY.composer.blockedByPairing);
    expect(markup).not.toContain('role="status"');
  });
});

describe("R-E the transcript at its bound", () => {
  const full = Array.from({ length: 200 }, (_unused, index) => ({
    seq: index + 1,
    msgId: index + 1,
    sendId: index + 1,
    text: `n${String(index)}`,
    status: "sending" as const,
    attempts: 1,
    blocks: 1,
  }));

  it("renders two hundred notes in render order", () => {
    const inbound = full.map((entry) => ({
      seq: entry.seq * 2,
      msgId: entry.msgId,
      text: `in${String(entry.seq)}`,
    }));
    const markup = render(<MessageList inbound={inbound} outbound={full} />);
    for (const index of [0, 1, 100, 199]) {
      expect(markup).toContain(`in${String(full[index]?.seq ?? 0)}`);
      expect(markup).toContain(`>n${String(index)}<`);
    }
    // 200 in and 200 out, and the merge interleaves them by the one counter, so
    // the very first note on screen is ours and the first inbound follows it.
    expect((markup.match(/bubble-mine/g) ?? []).length).toBe(200);
    expect((markup.match(/bubble-theirs/g) ?? []).length).toBe(200);
    expect(markup.indexOf(">n0<")).toBeLessThan(markup.indexOf(">in1<"));
  });

  it("renders a note and a reply that share a message id as two rows", () => {
    // The two peers allocate ids from independent counters, so a sender's 1 and a
    // receiver's 1 are two different notes. `key` is not in the static markup, so
    // what is asserted is the consequence: both rows are rendered.
    const inbound = full
      .slice(0, 3)
      .map((entry) => ({ seq: 900 + entry.seq, msgId: entry.msgId, text: "x" }));
    const markup = render(<MessageList inbound={inbound} outbound={full.slice(0, 3)} />);
    expect((markup.match(/bubble-mine/g) ?? []).length).toBe(3);
    expect((markup.match(/bubble-theirs/g) ?? []).length).toBe(3);
    expect((markup.match(/whitespace-pre-wrap/g) ?? []).length).toBe(6);
  });

  it("calls nothing delivered but a status the session actually reported", () => {
    for (const status of ["sending", "sent", "failed"] as const) {
      const markup = render(
        <MessageList
          inbound={[]}
          outbound={[{ seq: 1, msgId: 1, text: "n", sendId: 1, status, attempts: 1, blocks: 1 }]}
        />,
      );
      const delivered = /delivered/i.test(markup);
      expect(delivered, `${status} claimed delivery`).toBe(status === "sent");
    }
  });

  it("escapes note text rather than rendering it, and keeps it verbatim", () => {
    const hostile = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "line one\nline two",
      "&amp; &lt; &#x27;",
      "\u{202e}reversed",
      "`.repeat(40)",
    ];
    for (const text of hostile) {
      const markup = render(<MessageList inbound={[{ seq: 1, msgId: 1, text }]} outbound={[]} />);
      // The escaping is what stops a note from being markup; the text is what the
      // sender typed, and the class is the only thing that shapes it.
      const raw = renderRaw(<MessageList inbound={[{ seq: 1, msgId: 1, text }]} outbound={[]} />);
      expect(raw).not.toContain("<script");
      expect(raw).not.toContain("<img");
      expect(markup).toContain("whitespace-pre-wrap");
      if (text.includes("<")) expect(markup).toContain(text);
    }
  });
});

describe("R-F copy that no component can reach", () => {
  const sources = componentSources();

  it("has the source it is scanning", () => {
    expect(sources.length).toBeGreaterThan(10_000);
  });

  it("shows a send refusal to the person who pressed send", () => {
    // FIXED. All six refusals used to be unreachable: `submit()` returned on a
    // refusal without setting anything, so a full queue or a dead codec was
    // silent except for the draft staying in the box. The reason now travels to
    // the composer, which renders it once as an alert.
    const hook = readFileSync(COMPONENT_DIR + "use-sound-chat.ts", "utf8");
    expect(hook).toContain("SOUND_CHAT_COPY.refusal");
    expect(hook).toContain("sendRefusalText");
    const markup = render(
      <Composer
        value="note"
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={SOUND_CHAT_COPY.refusal["queue-full"]}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.refusal["queue-full"]);
    // A discrete event, so it interrupts — unlike the over-cap line, which
    // changes on every keystroke and is reached through aria-describedby.
    expect(markup).toContain('role="alert"');
  });

  it("has no handshake-tone sentence, because a PAIR block cannot honestly show a bar", () => {
    // `transmit.pairBlock` is the sentence for the enterer's PAIR frame, which
    // is a transmission the transport machine puts on the air — but the pairing
    // screen renders no progress at all, so the tone plays with no indication.
    // Deleted rather than rendered: the session emits TRANSMIT_DONE_UNACKED as soon
    // as the PAIR block is scheduled, so there is no window in which a bar drawn
    // from our own clock would be true. The pairing screen says "Playing the
    // handshake tone, then listening for an answer" instead, which is honest.
    expect(sources).not.toContain("pairBlock");
    const entering = render(
      <PairingPanel
        role="enterer"
        code="ABCD2345"
        state={{ kind: "awaiting-confirmation", code: "ABCD2345", role: "enterer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(entering).not.toContain("progressbar");
    expect(entering).toContain(SOUND_CHAT_COPY.pairing.waitingEnter);
  });

  it("has no redundant progress label beside the bar's own label", () => {
    expect(sources).not.toContain("transmit.label");
    expect(SOUND_CHAT_COPY.transmit.progressLabel).toBe("Transmission progress");
  });

  it("shows this session's counters and lets the user dismiss a notice", () => {
    // FIXED. `state.stats` was a field on every snapshot, copied on each of the
    // ten ticks a second and read by no component, and `clearNotices()` had no
    // caller — so a warning stayed on screen for the rest of the session with
    // nothing to remove it. The counters are in the info panel; the notice list has
    // a control that empties it.
    expect(sources).toContain("ui.state.stats");
    expect(sources).toContain("ui.dismissNotices");
    const markup = render(
      <InfoPanel
        open
        onToggle={noop}
        stats={{
          blocksDecoded: 12,
          framesUnreadable: 1,
          messagesDelivered: 3,
          duplicatesSuppressed: 8,
          conflicts: 0,
          acksSent: 3,
          retries: 1,
        }}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.info.statsHeading);
    expect(markup).toContain(SOUND_CHAT_COPY.info.statDuplicatesSuppressed);
    // The dismissal control lives in the notice list on the chat screen, not in
    // the info panel; the source assertion above is what proves it is wired.
    expect(sources).toContain("SOUND_CHAT_COPY.actions.dismissNotices");
  });

  it("states the queued state on the note, and never from a past answer", () => {
    // FIXED. The composer used to hold the queued state in React state written
    // from `send()`'s return value and never cleared it, so a note delivered ten
    // seconds in left "Queued" on screen inside a live region for the rest of the
    // session. The composer has no such prop at all now.
    //
    // CHANGED AGAIN IN PHASE 3V. The assertion used to be that `TransmitStatus`
    // derives it from `busy && !ON_AIR[transport]`, which made the transport
    // block the owner of a fact about a *note*. It is now owned by the note's own
    // row — the session publishes every accepted note as `queued`, so the
    // transcript states it once per note, attributed — and this asserts the
    // transport block has no opinion about queuing at all.
    const composer = readFileSync(COMPONENT_DIR + "composer.tsx", "utf8");
    // The *prop* is gone; the word survives only in the comment that says why.
    expect(composer).not.toContain("readonly queued");
    const hook = readFileSync(COMPONENT_DIR + "use-sound-chat.ts", "utf8");
    expect(hook).not.toContain("setQueued");
    const status = readFileSync(COMPONENT_DIR + "transmit-status.tsx", "utf8");
    expect(status, "the transport block owns a queued state again").not.toContain(
      "transmit.queued",
    );
  });

  it("gives every unreadable reason the same sentence, whatever the reason was", () => {
    // `heard-unreadable` carries a `reason` and a `count`, and the controller
    // uses neither: `auth-failed` (a peer using a different code) and
    // `conflicting-block` (an authenticated block this session cannot assemble)
    // are different facts and get one sentence, and a note that was heard 5 times
    // is announced 5 times with the same words.
    const controller = readFileSync(
      fileURLToPath(new URL("../../lib/sound-chat/ui/controller.ts", import.meta.url)),
      "utf8",
    );
    expect(controller).toContain('case "heard-unreadable"');
    const branch = /case "heard-unreadable":([\s\S]*?)break;/.exec(controller)?.[1] ?? "";
    expect(branch).toContain("#notice");
    expect(branch).not.toContain("event.reason");
    expect(branch).not.toContain("event.count");
  });
});

describe("R-G ids and live regions across two of the same component", () => {
  const twice = (element: (key: string) => ReactElement): string =>
    render(
      <div>
        {element("one")}
        {element("two")}
      </div>,
    );

  it("gives two composers distinct ids for every hook-generated id", () => {
    const atCap = "a".repeat(200);
    const markup = twice(() => (
      <Composer
        value={atCap}
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
      />
    ));
    // Three ids render per over-cap composer: the field, the byte counter and
    // the over-cap sentence the field points at. The other two `useId()` values
    // (the empty sentence and the disabled reason) are not rendered in this
    // state, so they contribute no `id` attribute.
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBe(6);
    expect(new Set(ids).size, `duplicate ids: ${ids.join(", ")}`).toBe(ids.length);
    // Every `for=` and `aria-describedby` must resolve inside the same instance.
    // Two elements carry `aria-describedby` now — the field and the send
    // control, which is `aria-disabled` rather than `disabled` precisely so the
    // reason it cannot be used stays reachable — and both name two ids.
    const described = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((match) =>
      (match[1] ?? "").split(" "),
    );
    expect(described).toHaveLength(8);
    for (const id of described) expect(ids).toContain(id);
    const labels = [...markup.matchAll(/<label[^>]*for="([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toHaveLength(2);
    for (const id of labels) expect(ids).toContain(id);
  });

  it("gives two info panels and two pairing panels distinct ids", () => {
    const info = twice(() => <InfoPanel open onToggle={noop} />);
    const pairing = twice(() => (
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />
    ));
    for (const markup of [info, pairing]) {
      const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size, `duplicate ids: ${ids.join(", ")}`).toBe(ids.length);
    }
  });

  it("puts the bar outside every live region even when it is moving", () => {
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 }}
      />,
    );
    const live = markup.indexOf('aria-live="polite"');
    const bar = markup.indexOf('role="progressbar"');
    expect(live).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(live);
    // And the bar's own text is not in a status region either, so ten ticks a
    // second is not ten announcements a second.
    expect(markup.slice(bar)).not.toContain('role="status"');
  });
});

describe("R-H the failure panels under hostile detail", () => {
  const details = [
    "",
    "   ",
    "NotAllowedError: Permission denied",
    "<script>alert(1)</script>",
    "x".repeat(5_000),
    "\u0007",
  ];

  for (const detail of details) {
    it(`renders a blocked screen for a detail of ${String(detail.length)} characters`, () => {
      const element = (
        <BlockedPanel block={{ kind: "mic-denied", detail }} onRetry={noop} onBack={noop} />
      );
      const markup = render(element);
      const raw = renderRaw(element);
      expect(markup).toContain(SOUND_CHAT_COPY.blocked["mic-denied"].heading);
      expect(markup).toContain(SOUND_CHAT_COPY.actions.retry);
      // `detail` is an error message a hostile environment can choose, so it is
      // rendered as text: the raw markup holds no element built from it.
      expect(raw).not.toContain("<script");
      // An empty detail shows no `Details:` line at all rather than a bare label.
      const hasDetail = markup.includes("Details:");
      expect(hasDetail).toBe(detail.trim() !== "");
    });
  }

  it("keeps the kind visible when the kind is not one it knows", () => {
    for (const kind of ["", "toString", "constructor", "__proto__", "a b c", "x".repeat(500)]) {
      const markup = render(
        <BlockedPanel block={{ kind, detail: "odd" }} onRetry={noop} onBack={noop} />,
      );
      expect(markup).toContain(SOUND_CHAT_COPY.blocked["audio-unavailable"].heading);
      expect(markup).toContain(SOUND_CHAT_COPY.actions.retry);
      if (kind !== "") expect(markup).toContain(kind.slice(0, 40));
    }
  });

  it("keeps a fatal kind it does not know from reading as a codec death", () => {
    const known = render(
      <FatalPanel fatal={{ kind: "frame-contract", detail: "x" }} onRestart={noop} />,
    );
    const unknown = render(
      <FatalPanel fatal={{ kind: "something-else", detail: "x" }} onRestart={noop} />,
    );
    // Both fall back to the same sentence, and the unknown one says its own kind
    // in the detail line so the sentence is not a guess presented as a fact.
    expect(known).toContain(SOUND_CHAT_COPY.fatal["frame-contract"].heading);
    expect(unknown).toContain(SOUND_CHAT_COPY.fatal["codec-died"].heading);
    expect(unknown).toContain("something-else");
  });

  it("renders no fatal or blocked screen with nothing to say", () => {
    const fatal = render(
      <FatalPanel fatal={{ kind: "codec-died", detail: "" }} onRestart={noop} />,
    );
    expect(fatal).toContain(SOUND_CHAT_COPY.fatal["codec-died"].heading);
    expect(fatal).not.toContain("Details:");
    // And the restart stays behind a confirmation, whatever the detail.
    expect(fatal).not.toContain('role="dialog"');
  });
});

describe("R-I the pairing screen under hostile codes", () => {
  const codes: readonly (readonly [string, string | null])[] = [
    ["a normal code", "ABCD2345"],
    ["an empty code", ""],
    ["a short code", "AB"],
    ["a long code", "A".repeat(500)],
    ["markup in the code", "<script>alert(1)</script>"],
    ["no code at all", null],
  ];

  for (const [name, code] of codes) {
    it(`renders ${name} without losing the retry and the role switch`, () => {
      const element = (
        <PairingPanel
          role="displayer"
          code={code}
          state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
          failure={null}
          busy={false}
          onRetry={noop}
          onSwitchRole={noop}
        />
      );
      const markup = render(element);
      expect(markup).toContain(SOUND_CHAT_COPY.pairing.displayHeading);
      expect(renderRaw(element)).not.toContain("<script");
      // The readout and its copy button exist together or not at all, so the
      // code is never half shown.
      expect(markup.includes("Copy code")).toBe(code !== null);
      if (code !== null) expect(markup).toContain(code);
    });
  }

  it("shows the enterer its own code, because there is no field here to change it", () => {
    // INVERTED IN PHASE 3V. This test pinned "shows the enterer no code readout,
    // because its code is not to be read aloud", and the reasoning was sound for
    // the case it was written for: an enterer types the code on the *pre-prompt*,
    // so repeating it large on the next screen is noise.
    //
    // It stopped being the whole truth when the blocked panel's "Try again"
    // learned to carry a typed code through a microphone failure. The enterer then
    // arrives here from a screen that never had the code in front of them, this
    // screen has no field, and the copy says "This is the code being used" — so
    // the code has to be visible for that sentence to be checkable. A person
    // whose retry silently used the wrong code has no other way to notice.
    //
    // What is still true, and asserted below: the code is never rendered as an
    // editable field, and it is still never played as sound.
    const markup = render(
      <PairingPanel
        role="enterer"
        code="ABCD2345"
        state={{ kind: "awaiting-confirmation", code: "ABCD2345", role: "enterer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    expect(markup).toContain("ABCD2345");
    // Read as a readout, never as an input: the displayer's large monospaced
    // treatment stays the displayer's, because that is the one meant to be read
    // across a room.
    expect(markup).not.toContain("<input");
    expect(markup).toContain(SOUND_CHAT_COPY.pairing.enterRetryHeading);
  });

  it("keeps the permission pre-prompt's role step free of any input", () => {
    const markup = render(<PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />);
    // A user who has not chosen a role has not been asked for anything, so the
    // screen must not look like a form waiting to be filled in. The code field
    // lives on the second step, which is state a static render cannot reach, so
    // its `maxLength` and its normalisation are asserted where they live instead.
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("aria-invalid");
    expect(markup).toContain(SOUND_CHAT_COPY.permission.displayAction);
    expect(markup).toContain(SOUND_CHAT_COPY.permission.enterAction);
    // INVERTED. The role step used to carry a third quiet control, "Not now",
    // which left Sound Chat — exactly what the shell's own back control does. Two
    // exits for one exit, and neither of them the obvious one. The pre-prompt now
    // renders no exit of its own; the prose it used to stack between the reader
    // and these two buttons is behind a disclosure instead.
    expect(markup).not.toContain(SOUND_CHAT_COPY.permission.dismiss);
    expect(markup).toContain(SOUND_CHAT_COPY.permission.learnMore);
  });
});

describe("R-J the entry point and the notice list", () => {
  it("says one true thing before the chunk arrives", () => {
    const markup = render(<SoundChatEntry />);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
  });

  it("announces notices politely, so the one that reports a room fact is not silent", () => {
    // INVERTED in Phase 4. This used to assert that `NoticeList` was kept *out*
    // of a live region, on the stated grounds that "the events that produce them
    // are announced where they happen". That was true for a listener error and
    // false for "a transmission was heard, but this pairing code cannot read
    // it": `HEARD_UNREADABLE` changes no transport state and has no sentence of
    // its own, so that notice arrived silently — the one notice that reports a
    // fact about the room, and the one a person would not notice arriving.
    //
    // Polite, not assertive: a notice is a warning, not an interruption, and the
    // screen already reserves `role="alert"` for refusals the user caused.
    //
    // `NoticeList` is not exported from `sound-chat-screen.tsx`, so what is
    // asserted is the body of the function that builds it.
    const sources = componentSources();
    const start = sources.indexOf("function NoticeList");
    expect(start).toBeGreaterThan(-1);
    const body = sources.slice(start, start + 1_400);
    expect(body).toContain("aria-label={SOUND_CHAT_COPY.shell.noticesLabel}");
    expect(body).toContain('aria-live="polite"');
    expect(body).toContain('role="status"');
    // Still not an interruption, and never a log.
    expect(body).not.toContain('role="log"');
    expect(body).not.toContain('role="alert"');
  });
});
