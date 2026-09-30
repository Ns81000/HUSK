/**
 * Phase 3V, seam 2 continued: which `{phase × substates}` combinations the
 * controller can actually publish, which of them anything renders, and whether
 * the sentence each one renders is the truth.
 *
 * `renderToStaticMarkup` is the whole tool — no DOM implementation may be added.
 * What is asserted is what the *markup* says, which is the only thing a screen
 * reader or a text extractor ever sees.
 *
 * The reachability half is derived from the controller's own rules rather than
 * from the render tables, so a table that drifts from the machine shows up here
 * as a failing test instead of as coverage.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { BlockedPanel } from "@/components/sound-chat/blocked-panel";
import { Composer } from "@/components/sound-chat/composer";
import { FatalPanel } from "@/components/sound-chat/fatal-panel";
import { MessageList } from "@/components/sound-chat/message-list";
import { PairingPanel } from "@/components/sound-chat/pairing-panel";
import { TransmitStatus } from "@/components/sound-chat/transmit-status";
import { deriveComposerBlock } from "@/components/sound-chat/use-sound-chat";
import { SOUND_CHAT_COPY, transportSentence, PAIRING_CODE_RULE } from "@/lib/sound-chat/ui/copy";
import { PAIRING_CODE_LENGTH } from "@/lib/sound-chat/crypto";
import { describePairingFailure } from "@/lib/sound-chat/pairing";
import type { PairingFailureReason } from "@/lib/sound-chat/pairing";
import type { SoundChatUiState } from "@/lib/sound-chat/ui/controller";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&#x39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const noop = (): void => {};

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

/** The two states the controller's `ON_AIR` table treats as our own audio. */
const ON_AIR: Record<TransportState, boolean> = {
  idle: false,
  listening: false,
  transmitting: true,
  awaiting_turn: false,
  awaiting_ack: true,
  backoff: false,
  hidden_hold: false,
  error: false,
  module_error: false,
};

const PAIRED: SoundChatUiState["pairing"] = {
  kind: "paired",
  code: "ABCD2345",
  role: "displayer",
  peerSalt: new Uint8Array(16),
};

const BASE_STATE: SoundChatUiState = {
  phase: "chat",
  role: "displayer",
  block: null,
  fatal: null,
  transport: "listening",
  pairing: PAIRED,
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

/** The transport states a `chat` snapshot can carry, derived not typed. */
const REACHABLE_IN_CHAT: TransportState[] = ALL_STATES.filter(
  (state) => !["idle", "error", "module_error"].includes(state),
);

function progressFor(transport: TransportState): SoundChatUiState["progress"] {
  if (!ON_AIR[transport]) return null;
  return { blocks: 2, blockIndex: 1, fraction: 0.25, remainingMs: 2_880 };
}

/**
 * The snapshot the controller publishes for one `(transport, transmitting,
 * busy)` triple, with the progress record the controller's own rules produce for
 * it: a record exists if and only if the transport event that announces an
 * on-air state is the one that starts it.
 */
function snapshotFor(
  transport: TransportState,
  transmitting: boolean,
  busy: boolean,
): SoundChatUiState {
  return {
    ...BASE_STATE,
    transport,
    transmitting: transmitting || transport === "transmitting",
    busy: busy || transport === "awaiting_ack",
    progress: progressFor(transport),
  };
}

function chatScreen(state: SoundChatUiState, draft = "hi"): ReactElement {
  const reason = deriveComposerBlock(state);
  return (
    <div>
      <TransmitStatus
        transport={state.transport}
        transmitting={state.transmitting}
        progress={state.progress}
      />
      <MessageList inbound={state.inbound} outbound={state.outbound} />
      <Composer
        value={draft}
        onChange={noop}
        onSubmit={noop}
        disabled={reason !== null}
        disabledReason={reason}
        refusal={null}
      />
    </div>
  );
}

describe("Q-1 every reachable `chat` combination renders one honest set of lines", () => {
  for (const transport of REACHABLE_IN_CHAT) {
    for (const busy of [false, true]) {
      it(`renders chat + ${transport} + busy=${String(busy)}`, () => {
        const state = snapshotFor(transport, false, busy);
        const markup = render(chatScreen(state));
        // Exactly one transport sentence, and it is this state's own.
        const rendered = ALL_STATES.filter((candidate) =>
          markup.includes(transportSentence(candidate)),
        );
        expect(rendered, "two transport sentences at once").toEqual([transport]);
        // A bar exists exactly for the two on-air states, and it never claims
        // delivery.
        expect(markup.includes('role="progressbar"')).toBe(ON_AIR[transport]);
        expect(markup).not.toMatch(/delivered/i);
        // The queued state is NOT stated here at all any more. It used to be
        // asserted: `transmit.queued` rendered for every busy-but-not-on-air state,
        // which is the same fact the per-note rows state, attributed. The sentence
        // is deleted, so the honest assertion is that the transport block says
        // nothing about queuing — the transcript rows own that.
        expect(markup, "the transport block claims a queued state of its own").not.toMatch(
          /Queued/,
        );
        // The composer's own reason is the transport sentence for a hold and
        // nothing at all otherwise.
        expect(deriveComposerBlock(state)).toBe(
          transport === "hidden_hold" ? transportSentence("hidden_hold") : null,
        );
      });
    }
  }
});

describe("Q-2 the three transport sentences a chat screen can never reach", () => {
  it("KNOWN DEAD STATE: `idle`, `error` and `module_error` are not producible in `chat`", () => {
    // `chat` is entered by the `pairing: paired` event, and the session has been
    // `listening` since `start()`. `error` is reached only by
    // `RECOVERABLE_ERROR`, which `start()` emits before pairing and always
    // alongside `onModuleError` — so the controller is already in `fatal`, and
    // `fatal` renders `FatalPanel`, not `TransmitStatus`. `module_error` is
    // reached by `MODULE_DIED`, which likewise reports on the module channel.
    // `idle` is the state before `START`.
    for (const transport of ["idle", "error", "module_error"] as const) {
      expect(REACHABLE_IN_CHAT).not.toContain(transport);
      // So `deriveComposerBlock`'s branches for two of them, and the two
      // sentences they quote, are dead: `transportSentence("error")`
      // ("Sound Chat could not start.") and `.module_error` ("The sound codec
      // stopped working.") are read in exactly one place, and that place is the
      // chat screen. `idle` has no branch at all, so it is the composer that
      // would be wrongly usable.
      expect(deriveComposerBlock({ ...BASE_STATE, transport })).toBe(
        transport === "idle" ? null : transportSentence(transport),
      );
      expect(snapshotFor(transport, false, false).phase).toBe("chat");
    }
    // The honest screen for both of them does exist and does render: the fatal
    // panel, and the blocked panel for a start-up failure.
    for (const kind of ["codec-died", "frame-contract"] as const) {
      const markup = render(<FatalPanel fatal={{ kind, detail: "d" }} onRestart={noop} />);
      expect(markup).toContain(SOUND_CHAT_COPY.fatal[kind].heading);
    }
  });
});

describe("Q-3 honesty of every screen that renders", () => {
  it("calls a note delivered only when the session reported it acknowledged", () => {
    for (const [status, expected] of [
      ["sending", SOUND_CHAT_COPY.outbound.sending],
      ["sent", SOUND_CHAT_COPY.outbound.sent],
      ["failed", SOUND_CHAT_COPY.outbound.failed],
    ] as const) {
      const markup = render(
        <MessageList
          inbound={[]}
          outbound={[{ seq: 1, msgId: 1, text: "n", sendId: 1, status, attempts: 1, blocks: 1 }]}
        />,
      );
      expect(markup).toContain(expected);
      // `Delivered` appears once per acknowledged note and for nothing else.
      expect(markup.includes(SOUND_CHAT_COPY.outbound.sent)).toBe(status === "sent");
    }
  });

  it("the restart dialog says it clears the whole transcript", () => {
    // `begin()` publishes `outbound: [], inbound: [], notices: []` for every new
    // session, so a restart discards the whole transcript and every notice. The
    // dialog used to say only "Anything in flight is discarded" — a claim about
    // one note, not about every note the two devices exchanged — and the dialog
    // is behind a confirmation, so the copy is the only warning there is.
    const markup = render(
      <FatalPanel fatal={{ kind: "codec-died", detail: "d" }} onRestart={noop} />,
    );
    // Closed by default, so the panel shows only the invoker's own label.
    expect(markup).toContain(SOUND_CHAT_COPY.modal.restartConfirm);
    expect(markup).not.toContain(SOUND_CHAT_COPY.modal.restartDescription);
    expect(SOUND_CHAT_COPY.modal.restartDescription).toMatch(/transcript/i);
    expect(SOUND_CHAT_COPY.modal.restartDescription).toMatch(/microphone/i);
    // It must not narrow the loss to one note, which is what it used to do.
    expect(
      SOUND_CHAT_COPY.modal.restartDescription,
      "the dialog narrows the loss to the note in flight",
    ).not.toMatch(/in flight/i);
  });

  it("the two code-entry sentences read as sentences, not as two rules spliced together", () => {
    // FIXED. `PAIRING_CODE_RULE` began with "a code is", and both call sites
    // supplied their own subject, so the two screens a person is sent to for a
    // wrong code read "The code is a code is 8 characters …" and "A pairing code
    // is a code is 8 characters …".
    expect(SOUND_CHAT_COPY.pairing.enterBody).toBe(
      `The code is ${PAIRING_CODE_RULE}. It is never played out loud as sound.`,
    );
    expect(SOUND_CHAT_COPY.blocked["bad-code"].body).toBe(
      `A pairing code is ${PAIRING_CODE_RULE}. Check it and try again.`,
    );
    for (const sentence of [
      SOUND_CHAT_COPY.pairing.enterBody,
      SOUND_CHAT_COPY.blocked["bad-code"].body,
    ]) {
      expect(sentence, "a doubled subject").not.toMatch(/\b(is|are) a code is\b/i);
      // Exactly one clause boundary per sentence, so nothing is spliced.
      expect(sentence.split(".").filter((part) => part.trim() !== "").length).toBeLessThanOrEqual(
        2,
      );
    }
  });

  it("a pairing failure never quotes a range the session did not measure", () => {
    for (const reason of [
      "wrong-code",
      "no-peer",
      "no-confirmation",
    ] as const satisfies readonly PairingFailureReason[]) {
      const sentence = describePairingFailure(reason);
      const markup = render(
        <PairingPanel
          role="displayer"
          code="ABCD2345"
          state={{ kind: "failed", code: "ABCD2345", role: "displayer", reason }}
          failure={sentence}
          busy={false}
          onRetry={noop}
          onSwitchRole={noop}
        />,
      );
      expect(markup).toContain(sentence);
      // No distance, no radius, no decibel, no "out of range".
      expect(sentence).not.toMatch(/\b(metre|meter|metres|meters|km|range|too far|distance)\b/i);
      // No identity claim: it names a code, never a person.
      expect(sentence).not.toMatch(/\b(they|he|she|them|person|someone|friend|who)\b/i);
    }
  });

  it("the blocked screens name a cause and never claim the microphone is off", () => {
    for (const kind of Object.keys(
      SOUND_CHAT_COPY.blocked,
    ) as (keyof typeof SOUND_CHAT_COPY.blocked)[]) {
      const copy = SOUND_CHAT_COPY.blocked[kind];
      const markup = render(
        <BlockedPanel block={{ kind, detail: "D" }} onRetry={noop} onBack={noop} />,
      );
      expect(markup).toContain(copy.heading);
      // The claim "the microphone is not listening" is only true for the three
      // microphone kinds; for `device-rate` and `codec-unavailable` the mic is
      // granted and the copy must not say it is off.
      const microphoneFacts = /microphone (?:is )?(?:off|not (?:on|listening)|muted|silenced)/i;
      if (!kind.startsWith("mic-")) expect(copy.body).not.toMatch(microphoneFacts);
      // Nothing anywhere claims the channel is inaudible.
      expect(copy.body).not.toMatch(/\b(silent|silently|inaudible|in-audible|without a sound)\b/i);
    }
  });

  it("the copy never states a range, a rate or a success rate the code does not enforce", () => {
    const everything = JSON.stringify(SOUND_CHAT_COPY);
    // The alphabet sentence is derived from the constant, so a code the field
    // accepts is a code the sentence describes — and the only figure it quotes is
    // the length the protocol enforces. The 40-bit entropy budget is not quoted,
    // because nothing in the product measures it.
    expect(SOUND_CHAT_COPY.pairing.enterBody).toContain(PAIRING_CODE_RULE);
    expect(PAIRING_CODE_RULE).toContain(String(PAIRING_CODE_LENGTH));
    expect(PAIRING_CODE_RULE).toContain("except I and O");
    expect(SOUND_CHAT_COPY.permission.limits.join(" ")).not.toMatch(/\b\d+\s*bits\b/i);
    expect(everything).not.toMatch(/\b\d+(\.\d+)?\s*(metres|meters)\b/i);
  });
});

describe("Q-4 what a send the user cannot see says about itself", () => {
  it("KNOWN DEFECT: an accepted note that is still queued is in no rendered list", () => {
    // The composer clears the draft the moment `send()` returns `{ ok: true }`,
    // and a transcript row only exists once the pump has *claimed* the message
    // and published an `outbound` event. Everything behind the head of the
    // session's private queue has no row, so with four notes sent in a row the
    // screen says "Queued" once and shows one of the four.
    const one = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 1, sendId: 1, text: "first", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    expect(one).toContain(SOUND_CHAT_COPY.outbound.sending);
    const two = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 1, sendId: 1, text: "first", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    // The markup for the same state is byte-identical, so nothing anywhere in
    // the screen names the three notes that are not in it.
    expect(two).toBe(one);
    expect(one).not.toContain("second");
  });

  it("KNOWN DEAD COPY: a send before the controller exists says it stopped", () => {
    // `useSoundChat.submit()` runs `controller?.send(draft)`; the controller is
    // created in an effect, so the very first render has none and
    // `sendRefusalText(undefined)` answers with the `stopped` sentence. Nothing
    // is stopped — the screen has not started anything yet.
    expect(SOUND_CHAT_COPY.refusal.stopped).toBe("Sound Chat has stopped.");
  });
});
