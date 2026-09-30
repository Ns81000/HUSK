/**
 * What the channel is doing right now, and how far through our own note it is.
 *
 * WHY one sentence per transport state and a bar that is never inside the live
 * region: the sentence is the thing worth interrupting for, while the bar moves
 * ten times a second. Putting the bar inside `aria-live` would make a screen
 * reader announce every tick for the two or four seconds a note is on the air,
 * so the sentence is the live region and the bar is a sibling of it with its own
 * `aria-valuetext`.
 *
 * WHY the bar measures our own schedule rather than the peer: the peer decodes
 * a block at the *end* of it, so nothing on this side can know what the other
 * device has actually understood. Every string under the bar therefore comes
 * from copy that says "about", and the bar is labelled as progress, never as
 * delivery.
 *
 * The dot pulses only in the two states where something is genuinely in motion.
 * A settled state with a pulsing dot would read as "waiting on something" after
 * the transmission had already finished.
 */

import type { ReactElement } from "react";
import { SOUND_CHAT_COPY, transportSentence } from "@/lib/sound-chat/ui/copy";
import { cn } from "@/lib/utils";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

/**
 * One tone per state, `satisfies` so a state the machine grows later is a
 * compile error here rather than a sentence rendered in the wrong colour.
 */
const TONE = {
  idle: "text-ink-muted",
  listening: "text-ok",
  transmitting: "text-accent",
  awaiting_turn: "text-accent",
  awaiting_ack: "text-ok",
  backoff: "text-warn",
  hidden_hold: "text-warn",
  error: "text-danger",
  module_error: "text-danger",
} as const satisfies Record<TransportState, string>;

/** In motion, as opposed to settled: the only two states where the dot pulses. */
const MOVING = {
  listening: true,
  transmitting: true,
  awaiting_turn: false,
  awaiting_ack: false,
  backoff: false,
  hidden_hold: false,
  idle: false,
  error: false,
  module_error: false,
} as const satisfies Record<TransportState, boolean>;

/** Any number into `[1, high]`, with a non-finite value treated as the start. */
function clampIndex(value: number | undefined, high: number): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.round(value)), high);
}

/**
 * The sentence for the live state. Defined once, in the copy file, so the
 * component and every test read the same function rather than each
 * re-deriving the string with a conditional of its own.
 */
export function TransmitStatus({
  transport,
  transmitting,
  progress,
  attempts,
}: {
  readonly transport: TransportState;
  readonly transmitting: boolean;
  readonly progress: {
    readonly blocks: number;
    readonly blockIndex: number;
    readonly fraction: number;
    readonly remainingMs: number;
  } | null;
  /**
   * How many times the note on the air has been transmitted, used only by
   * `transport.backoff`'s sentence.
   *
   * Optional, defaulting to 0, because it is one number about one of nine states:
   * a caller that does not care — a state preview, a test sweeping the other
   * eight — must not be made to invent it. The sentence degrades to a first
   * attempt rather than to nothing.
   */
  readonly attempts?: number;
}): ReactElement {
  const tone = TONE[transport];
  // Clamped here as well as in the controller. The component is the last thing
  // between a number and `aria-valuenow`, and a value that is not finite would
  // render as `aria-valuenow="NaN"` — while "Block 2 of 1" would be a sentence
  // the medium cannot produce. Cheap belt to the controller's braces.
  const total =
    Number.isFinite(progress?.blocks) && (progress?.blocks ?? 0) >= 1 ? (progress?.blocks ?? 1) : 1;
  const index = clampIndex(progress?.blockIndex, total);
  const percent =
    progress === null
      ? 0
      : clampIndex(
          Math.round((Number.isFinite(progress.fraction) ? progress.fraction : 0) * 100),
          100,
        );
  const remaining = Number.isFinite(progress?.remainingMs)
    ? Math.max(0, progress?.remainingMs ?? 0)
    : 0;
  const blockText =
    progress === null ? null : SOUND_CHAT_COPY.transmit.block(index, total, remaining);

  return (
    <div className="space-y-2">
      {/* First child and the only live region: the state sentence, nothing that
          moves underneath it. */}
      <p
        role="status"
        aria-live="polite"
        className={cn("flex items-center gap-2 text-caption", tone)}
      >
        <span
          aria-hidden="true"
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-pill bg-current",
            MOVING[transport] && "dot-pulse",
          )}
        />
        {transportSentence(transport, attempts ?? 0)}
      </p>

      {progress === null ? null : (
        <>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={blockText ?? undefined}
            aria-label={SOUND_CHAT_COPY.transmit.progressLabel}
            // Utilities only, not `upload-bar`: that class drives its own
            // indeterminate pseudo-element, which would slide over this
            // determinate fill. The width is the one inline style in the
            // feature, because it is the one value a class cannot carry.
            className="relative h-1.5 w-full overflow-hidden rounded-pill bg-surface-sunken"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-pill bg-accent"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="tabular text-caption text-ink-muted">{blockText}</p>
        </>
      )}

      {transmitting && progress === null && transport !== "awaiting_ack" ? (
        // The honest gap between `send()` returning and the first block being
        // scheduled: the audio is ours and starting, but nothing of it has been
        // played yet, so no progress figure would be true. Excluded from
        // `awaiting_ack`, where the blocks *are* scheduled and the sentence that
        // belongs is the confirmation one below.
        <p className="text-caption text-accent">{SOUND_CHAT_COPY.transmit.arming}</p>
      ) : null}

      {transport === "awaiting_ack" && progress === null ? (
        <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.transmit.acking}</p>
      ) : null}

      {/* Neither of the two facts this component used to own survives here, and
          both moved somewhere that can be the single owner of them.

          There is no "is our own audio on the air" table. The controller owns
          that rule (`ON_AIR` in `ui/controller.ts`) and it is the controller
          that decides whether a `progress` record exists at all; this component
          renders what it is handed, so a second table could only ever disagree
          with the first. `transmitting` arrives already carrying it.

          There is no global "queued" line. Before Phase 3V this component
          rendered one for every busy-but-not-on-air state, which said the same
          thing the per-note `outbound.queued` row says and did not say which
          note — two sentences for one fact, one of them unattributed. That is
          why the component no longer takes a `busy` prop at all: after the
          change the transport block genuinely has no opinion about queued
          work, so taking the number and discarding it would be a lie about what
          it knows. The rows own it, attributed, once each. */}
    </div>
  );
}
