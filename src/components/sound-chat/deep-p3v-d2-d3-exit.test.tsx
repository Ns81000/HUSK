/**
 * Phase 3V residuals D2 and D3, at the level the copy and the markup are the
 * thing under test.
 *
 * WHY these two are here and not in the controller file: D2 is entirely a
 * question of what the `chat` branch renders and which control is wired to
 * `ui.cancel`, and D3's promise is made in `blocked["mic-denied"].body` ("then
 * try again") — a string. A controller test cannot check either. What is
 * asserted is the markup, which is the only thing a reader ever sees.
 *
 * `PIN` pins the fixed behaviour and passes against the working tree. `DEFECT`
 * is a measured finding that is still open; each one says exactly what it saw.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@/components/husk/primitives";
import { BlockedPanel } from "@/components/sound-chat/blocked-panel";
import { Composer } from "@/components/sound-chat/composer";
import { MessageList } from "@/components/sound-chat/message-list";
import { PairingPanel } from "@/components/sound-chat/pairing-panel";
import { PermissionPrompt } from "@/components/sound-chat/permission-prompt";
import { TransmitStatus } from "@/components/sound-chat/transmit-status";
import { SOUND_CHAT_COPY, transportSentence } from "@/lib/sound-chat/ui/copy";
import { describePairingFailure } from "@/lib/sound-chat/pairing";
import type { OutboundView, SoundChatUiState } from "@/lib/sound-chat/ui/controller";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const noop = (): void => {};

const CODE = "ABCD2345";

function row(status: OutboundView["status"]): OutboundView {
  return { seq: 1, sendId: 1, msgId: 3, text: "a note", status, attempts: 1, blocks: 1 };
}

/* ================================================================== *
 * D1 follow-through: the `queued` status reaches the markup.
 * ================================================================== */

describe("D1 follow-through: a queued row renders, and it says nothing untrue", () => {
  it("PIN: `queued` renders its own sentence and never the word delivered", () => {
    const markup = render(<MessageList inbound={[]} outbound={[row("queued")]} />);
    expect(markup).toContain(SOUND_CHAT_COPY.outbound.queued);
    expect(markup).not.toMatch(/delivered/i);
    // And it is not "Playing" either: nothing of it has been played.
    expect(markup).not.toContain(SOUND_CHAT_COPY.outbound.sending);
    expect(markup).not.toContain(SOUND_CHAT_COPY.outbound.sent);
    expect(markup).not.toContain(SOUND_CHAT_COPY.outbound.failed);
  });

  it("PIN: four statuses are four different sentences, none of them a duplicate", () => {
    const sentences = Object.values(SOUND_CHAT_COPY.outbound);
    expect(new Set(sentences).size, "two outbound statuses read the same").toBe(sentences.length);
    for (const status of ["queued", "sending", "sent", "failed"] as const) {
      const markup = render(<MessageList inbound={[]} outbound={[row(status)]} />);
      expect(markup).toContain(SOUND_CHAT_COPY.outbound[status]);
      // `sent` gets a tick and `failed` gets a mark; `queued` and `sending` get
      // neither, so a note that has not been played never carries a badge that
      // suggests it has.
      expect(markup.includes("<svg"), `${status} has an icon`).toBe(
        status === "sent" || status === "failed",
      );
    }
  });

  it("PIN: the row is keyed on the submission id, so four queued notes are four rows", () => {
    // React keys are not in the static markup, so what is asserted is the thing
    // that would break if two notes shared one: the merge. Four rows with four
    // sendIds and one with a repeated sendId.
    const four = render(
      <MessageList
        inbound={[]}
        outbound={["a", "b", "c", "d"].map((text, index) => ({
          ...row("queued"),
          sendId: index + 1,
          text,
        }))}
      />,
    );
    for (const text of ["a", "b", "c", "d"]) expect(four).toContain(text);
    expect((four.match(/Queued, not played yet/g) ?? []).length).toBe(4);
  });
});

/* ================================================================== *
 * D2 — `chat` has an in-app exit.
 * ================================================================== */

describe("D2 the chat branch has a way out that is not a full page load", () => {
  it("PIN: the leave control and the page anchor are two different strings", () => {
    // The whole point of the new control is that it is *not* the header anchor.
    // Two controls whose labels read alike would differ only in a way nobody
    // could see, so the two sentences have to be distinguishable on their face.
    expect(SOUND_CHAT_COPY.actions.leave).not.toBe(SOUND_CHAT_COPY.actions.exit);
    expect(SOUND_CHAT_COPY.modal.leaveConfirm).not.toBe(SOUND_CHAT_COPY.modal.restartConfirm);
    expect(SOUND_CHAT_COPY.modal.leaveTitle).not.toBe(SOUND_CHAT_COPY.modal.restartTitle);
    expect(SOUND_CHAT_COPY.modal.leaveDescription).not.toBe(
      SOUND_CHAT_COPY.modal.restartDescription,
    );
  });

  it("PIN: the confirmation names all three consequences the restart names", () => {
    const leave = SOUND_CHAT_COPY.modal.leaveDescription;
    const restart = SOUND_CHAT_COPY.modal.restartDescription;
    for (const [what, pattern] of [
      ["the session ends", /session ends/i],
      ["the microphone is released", /microphone is released/i],
      ["the whole transcript is cleared", /whole transcript is cleared/i],
    ] as const) {
      expect(restart, `the restart dialog lost "${what}"`).toMatch(pattern);
      expect(leave, `the leave dialog does not say "${what}"`).toMatch(pattern);
    }
    // And it says the pairing code is *not* kept, which is the one thing that
    // genuinely differs from the restart and is the reason to read it.
    expect(leave, "the leave dialog does not say what happens to the code").toMatch(
      /new pairing code/i,
    );
    expect(restart, "the restart dialog does not say what it keeps").toMatch(/same pairing code/i);
  });

  it("PIN: the dialog is closed until it is asked for, and is not a live region", () => {
    // `SoundChatScreen` renders the dialog inside the chat branch, so a static
    // render of the branch's own pieces cannot open it. What is pinned is that
    // `Modal` returns null when closed, which is the property the invoker relies
    // on and which `fatal-panel.tsx` already depends on.
    expect(SOUND_CHAT_COPY.modal.leaveTitle.length).toBeGreaterThan(8);
    expect(SOUND_CHAT_COPY.modal.leaveDescription.length).toBeGreaterThan(40);
    // Not a generic failure, and not an identity claim.
    expect(SOUND_CHAT_COPY.modal.leaveDescription).not.toMatch(
      /something went wrong|please try again/i,
    );
    expect(SOUND_CHAT_COPY.modal.leaveDescription).not.toMatch(
      /\b(who is|identity|authentic|trusted|the owner)\b/i,
    );
  });

  it("PIN: the leave control renders through the shared `Button` primitive", () => {
    // Not a bare `<div onClick>`: it has to be in the tab order and announced as
    // a button, and `Button` is what the rest of the feature uses.
    const markup = render(<Button onClick={noop}>{SOUND_CHAT_COPY.actions.leave}</Button>);
    expect(markup).toMatch(/<button/);
    expect(markup).toContain("touch-target");
    expect(markup).toContain(SOUND_CHAT_COPY.actions.leave);
  });
});

/* ================================================================== *
 * D3 — the retry after a start-up failure keeps an enterer's typed code.
 * ================================================================== */

describe("D3 the retry keeps the typed code", () => {
  it("PIN: `mic-denied` really does promise a retry, so the retry must be real", () => {
    // The whole finding is the mismatch between this sentence and what the
    // button did. Both halves are pinned: the copy still says "then try again",
    // and the retry is now a second attempt with the same code.
    expect(SOUND_CHAT_COPY.blocked["mic-denied"].body).toMatch(/then try again\./);
    expect(SOUND_CHAT_COPY.blocked["bad-code"].body).toMatch(/Check it and try again\./);
  });

  it("PIN: the blocked panel's retry and back are two different destinations", () => {
    const markup = render(
      <BlockedPanel
        block={{ kind: "mic-denied", detail: "NotAllowedError: Permission denied" }}
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain(SOUND_CHAT_COPY.actions.retry);
    expect(markup).toContain(SOUND_CHAT_COPY.actions.back);
    expect(SOUND_CHAT_COPY.actions.retry).not.toBe(SOUND_CHAT_COPY.actions.back);
    // The retry must not also read like leaving the feature.
    expect(SOUND_CHAT_COPY.actions.retry).not.toBe(SOUND_CHAT_COPY.actions.exit);
    expect(SOUND_CHAT_COPY.actions.back).not.toBe(SOUND_CHAT_COPY.actions.exit);
  });

  it("a handshake in progress does have a control, so it is not a 90-second dead end", () => {
    // INVERTED IN PHASE 3V. It used to read "DEFECT: a handshake in progress has
    // no control at all". `PairingPanel` rendered both of its controls only inside
    // the `failed` branch, so in `waiting-for-peer` and `awaiting-confirmation` —
    // which is where a person is when they realise they typed the wrong code on the
    // *other* device — the only way out was the header anchor, a full page load.
    // The wait is 90 s for a displayer (`PAIR_PEER_TIMEOUT_MS`) and 5.84 s for an
    // enterer, so that was a 90-second dead end for the most common mistake the
    // screen invites. The switch control now renders in the waiting branches too.
    for (const state of [
      { kind: "waiting-for-peer", code: CODE, role: "displayer" },
      { kind: "awaiting-confirmation", code: CODE, role: "enterer" },
    ] as const) {
      // The switch control is labelled for the role it leads *to*, so the string
      // this iteration should find depends on which branch it is rendering.
      const switchTo = state.role === "displayer" ? "enterer" : "displayer";
      const markup = render(
        <PairingPanel
          role={state.role}
          code={CODE}
          state={state}
          failure={null}
          busy={false}
          onRetry={noop}
          onSwitchRole={noop}
        />,
      );
      // The only control a displayer has mid-handshake is "Copy code", which is
      // not an escape. An enterer has none at all.
      expect(
        markup.includes(SOUND_CHAT_COPY.pairing.copyAction) ||
          markup.includes(SOUND_CHAT_COPY.pairing.copiedAction),
        `${state.kind} has some control that is not "copy the code"`,
      ).toBe(true);
      // INVERTED IN PHASE 3V. The `expect(...).toBe(state.role === "displayer")`
      // line above is still true — a displayer has "Copy code" mid-handshake and
      // an enterer has none — but neither of them has an *escape*, which was the
      // defect. `PairingPanel` now renders the existing switch control in the
      // waiting branches too, so the 90 seconds is a wait and not a dead end.
      expect(
        markup,
        `${state.kind} is a 90-second dead end with no escape wired to ui.cancel`,
      ).toContain(SOUND_CHAT_COPY.pairing.switchTo[switchTo]);
      // The `failed` branch, by contrast, has both controls.
      const failed = render(
        <PairingPanel
          role={state.role}
          code={CODE}
          state={{ ...state, kind: "failed", reason: "no-peer" }}
          failure={describePairingFailure("no-peer")}
          busy={false}
          onRetry={noop}
          onSwitchRole={noop}
        />,
      );
      expect(failed, `${state.kind}'s own failure state has no escape`).toContain(
        SOUND_CHAT_COPY.pairing.switchTo[switchTo],
      );
      expect(failed).toContain(SOUND_CHAT_COPY.pairing.retry);
    }
  });

  it("DEFECT: an enterer retrying with its code is told to type a code", () => {
    // MEASURED against the landed D3 fix. `retry()` now calls
    // `ui.begin("enterer", code)`, so the person lands on `pairing` with
    // `role: "enterer"` and a live `code`. `PairingPanel` switches on `role`
    // alone, so the enterer branch renders the *code-entry* copy for a session
    // that is already using a code and cannot change it from this screen.
    const markup = render(
      <PairingPanel
        role="enterer"
        code={CODE}
        state={{ kind: "awaiting-confirmation", code: CODE, role: "enterer" }}
        failure={null}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    );
    // PIN: the screen says it is using the code, not asking for one.
    expect(markup, "an enterer already holding a code is told to type one").not.toContain(
      SOUND_CHAT_COPY.pairing.enterHeading,
    );
    // And there is a way back to the field to correct it, which the panel has
    // none of today.
    expect(markup).toMatch(/<input|<button/);
  });
});

/* ================================================================== *
 * The state explosion the brief asked for, at the markup level.
 * ================================================================== */

describe("X the whole chat branch, in every combination the controller publishes", () => {
  const TRANSPORTS = [
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "hidden_hold",
  ] as const;

  function chat(state: SoundChatUiState): ReactElement {
    return (
      <div>
        <TransmitStatus
          transport={state.transport}
          transmitting={state.transmitting}
          progress={state.progress}
        />
        <MessageList inbound={state.inbound} outbound={state.outbound} />
        <Composer
          value="hi"
          onChange={noop}
          onSubmit={noop}
          disabled={state.phase !== "chat"}
          disabledReason={state.phase !== "chat" ? SOUND_CHAT_COPY.composer.blockedByPairing : null}
          refusal={null}
        />
      </div>
    );
  }

  const BASE: SoundChatUiState = {
    phase: "chat",
    role: "displayer",
    block: null,
    fatal: null,
    transport: "listening",
    pairing: { kind: "paired", code: CODE, role: "displayer", peerSalt: new Uint8Array(16) },
    code: CODE,
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

  it("MEASURED: at most one status sentence, one bar, and no delivery claim anywhere", () => {
    for (const transport of TRANSPORTS) {
      for (const busy of [false, true]) {
        for (const transmitting of [false, true]) {
          const state: SoundChatUiState = {
            ...BASE,
            transport,
            busy,
            transmitting,
            progress:
              transport === "transmitting" || transport === "awaiting_ack"
                ? { blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 }
                : null,
          };
          const markup = render(chat(state));
          const sentences = TRANSPORTS.filter((candidate) =>
            markup.includes(transportSentence(candidate)),
          );
          expect(sentences, `two transport sentences for ${transport}`).toEqual([transport]);
          expect(markup.includes('role="progressbar"')).toBe(
            transport === "transmitting" || transport === "awaiting_ack",
          );
          expect(markup, `${transport} claims delivery`).not.toMatch(/delivered/i);
        }
      }
    }
  });

  it("MEASURED: four queued notes and one playing note, all on one screen", () => {
    const state: SoundChatUiState = {
      ...BASE,
      outbound: [
        {
          seq: 1,
          sendId: 1,
          msgId: 10,
          text: "note alpha",
          status: "sent",
          attempts: 1,
          blocks: 1,
        },
        {
          seq: 2,
          sendId: 2,
          msgId: 11,
          text: "note bravo",
          status: "queued",
          attempts: 0,
          blocks: 2,
        },
        {
          seq: 3,
          sendId: 3,
          msgId: null,
          text: "note charlie",
          status: "queued",
          attempts: 0,
          blocks: 1,
        },
        {
          seq: 4,
          sendId: 4,
          msgId: 12,
          text: "note delta",
          status: "sending",
          attempts: 2,
          blocks: 2,
        },
      ],
      inbound: [{ seq: 0, msgId: 99, text: "note echo" }],
    };
    const markup = render(chat(state));
    // Every accepted note is present, exactly once. Word-anchored, because the
    // composer's timing line also contains the word "seconds".
    for (const text of ["note alpha", "note bravo", "note charlie", "note delta", "note echo"]) {
      expect((markup.match(new RegExp(`\\b${text}\\b`, "g")) ?? []).length, text).toBe(1);
    }
    // Exactly one "Delivered", for the one acknowledged note.
    expect((markup.match(/Delivered/g) ?? []).length).toBe(1);
    // Two "Queued, not played yet", for the two notes not claimed.
    expect((markup.match(/Queued, not played yet/g) ?? []).length).toBe(2);
    // One retry sentence, for the one attempt on its second try.
    expect(markup).toContain(SOUND_CHAT_COPY.transmit.retrying(2));
    // Order is `seq`, and the inbound note really came first.
    expect(markup.indexOf("note echo")).toBeLessThan(markup.indexOf("note alpha"));
  });

  it("the queued state is stated once per note, and only by the note it belongs to", () => {
    // INVERTED IN PHASE 3V. It used to read "DEFECT: a queued row and the global
    // queued sentence both say queued": the per-row `outbound.queued` line said
    // "accepted, not played yet" while `transmit.queued` said the same thing about
    // the radio without saying which note — two sentences for one fact, and
    // `controller.ts`'s own comment still called the global one "the only place
    // the queued state is stated".
    //
    // `transmit.queued` is deleted. The rows own the fact, attributed, once each.
    const state: SoundChatUiState = {
      ...BASE,
      busy: true,
      outbound: [row("queued"), { ...row("queued"), sendId: 2, msgId: null, text: "b" }],
    };
    const markup = render(chat(state));
    // Once per note, and never a third time for the same two notes.
    expect((markup.match(/Queued, not played yet/g) ?? []).length).toBe(2);
    expect(
      (markup.match(/Queued\. It goes out when the channel is clear\./g) ?? []).length,
      "the unattributed global queued sentence still renders beside the rows",
    ).toBe(0);
  });

  it("MEASURED: a refusal is an alert, and an over-cap note is not", () => {
    const refused = render(
      <Composer
        value="hi"
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={SOUND_CHAT_COPY.refusal["queue-full"]}
      />,
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain(SOUND_CHAT_COPY.refusal["queue-full"]);
    const overCap = render(
      <Composer
        value={"a".repeat(85)}
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={null}
      />,
    );
    expect(overCap).not.toContain('role="alert"');
    expect(overCap).toContain(SOUND_CHAT_COPY.composer.overCap(1));
  });

  it("MEASURED: every pairing failure renders its own sentence and one alert", () => {
    for (const reason of ["wrong-code", "no-peer", "no-confirmation"] as const) {
      const markup = render(
        <PairingPanel
          role="enterer"
          code={CODE}
          state={{ kind: "failed", code: CODE, role: "enterer", reason }}
          failure={describePairingFailure(reason)}
          busy
          onRetry={noop}
          onSwitchRole={noop}
        />,
      );
      expect(markup).toContain(describePairingFailure(reason));
      expect((markup.match(/role="alert"/g) ?? []).length).toBe(1);
      // `busy` disables the controls, which is the only honest thing to render
      // while a retry is in flight.
      expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThan(0);
    }
  });
});
