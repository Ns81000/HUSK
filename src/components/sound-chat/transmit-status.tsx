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
  const blockText =
    progress === null
      ? null
      : SOUND_CHAT_COPY.transmit.block(progress.blockIndex, progress.blocks, progress.remainingMs);
  const percent =
    progress === null ? 0 : Math.min(100, Math.max(0, Math.round(progress.fraction * 100)));

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

      {transmitting && progress === null ? (
        // The honest gap between `send()` returning and the first block being
        // scheduled: the audio is ours and starting, but nothing of it has been
        // played yet, so no progress figure would be true.
        <p className="text-caption text-accent">{SOUND_CHAT_COPY.transmit.arming}</p>
      ) : null}

      {transport === "awaiting_ack" && progress === null ? (
        <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.transmit.acking}</p>
      ) : null}

      {busy && transport === "idle" ? (
        // A note of ours is already in the system while the transport machine is
        // still reporting that it has not started. "Not started" on its own
        // would leave a pending note invisible, so the queue sentence stands in
        // for the gap.
        <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.transmit.queued}</p>
      ) : null}
    </div>
  );
}
