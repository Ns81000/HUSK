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
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
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

/**
 * The states in which our own audio is on the air: `transmitting` while the
 * blocks are being played, `awaiting_ack` for the window after they were
 * scheduled — which is the window the speaker is still playing them in, because
 * the session emits `TRANSMIT_DONE` on *scheduling*, not on completion.
 * `satisfies Record<TransportState, boolean>` rather than a two-value test, so a
 * state the machine grows cannot be silently left out of the rule that decides
 * whether the bar is showing.
 */
const ON_AIR = {
  idle: false,
  listening: false,
  transmitting: true,
  awaiting_turn: false,
  awaiting_ack: true,
  backoff: false,
  hidden_hold: false,
  error: false,
  module_error: false,
} as const satisfies Record<TransportState, boolean>;

/** Any number into `[1, high]`, with a non-finite value treated as the start. */
function clampIndex(value: number | undefined, high: number): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.round(value)), high);
}

export function TransmitStatus({
  transport,
  transmitting,
  busy,
  progress,
}: {
  readonly transport: TransportState;
  readonly transmitting: boolean;
  readonly busy: boolean;
  readonly progress: {
    readonly blocks: number;
    readonly blockIndex: number;
    readonly fraction: number;
    readonly remainingMs: number;
  } | null;
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
        {SOUND_CHAT_COPY.transport[transport]}
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

      {busy && !ON_AIR[transport] ? (
        // A note of ours is in the system and the radio is not playing it: it is
        // sealed, queued, or waiting for the turn. This is the *only* place the
        // queued state is stated. The composer used to have its own copy of the
        // same sentence driven by `send()`'s return value, and it never cleared —
        // so a note delivered ten seconds in was still announced as queued for the
        // rest of the session. One fact, one place, derived from a fact rather
        // than remembered.
        <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.transmit.queued}</p>
      ) : null}
    </div>
  );
}
