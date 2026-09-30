/**
 * Start-up failed for a reason the user can fix, so this screen has to be
 * specific: a refused microphone, a missing input, an unsupported browser, a
 * device running at the wrong rate and a codec that would not load are five
 * different facts with five different fixes, and a generic "something went
 * wrong" would send the user to the wrong one.
 *
 * WHY the raw diagnostic is kept but subdued: `detail` is the error name and
 * message the audio layer produced, and it is the only thing that identifies
 * which of the five causes actually happened. It is shown on its own line,
 * wrapped anywhere, because a `DOMException` string is long and unbreakable
 * and would otherwise push the buttons off the card.
 */

import type { ReactElement } from "react";
import { ErrorMark } from "@/components/husk/icons";
import { Button, Panel } from "@/components/husk/primitives";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

export function BlockedPanel({
  block,
  onRetry,
  onBack,
}: {
  readonly block: { readonly kind: string; readonly detail: string };
  readonly onRetry: () => void;
  readonly onBack: () => void;
}): ReactElement {
  // `kind` arrives as a plain string, so the table is probed rather than
  // indexed blindly: an unrecognised kind falls back to the generic engine
  // sentence and keeps its own name visible in the detail line below.
  const known = Object.hasOwn(SOUND_CHAT_COPY.blocked, block.kind);
  const copy = known
    ? SOUND_CHAT_COPY.blocked[block.kind as keyof typeof SOUND_CHAT_COPY.blocked]
    : SOUND_CHAT_COPY.blocked["audio-unavailable"];
  const raw = block.detail.trim();
  const detail = known ? raw : `${block.kind}: ${raw}`;

  return (
    <div role="alert" className="enter w-full">
      <Panel className="fade-in mx-auto max-w-xl">
        <div className="flex items-start gap-3">
          <ErrorMark className="h-10 w-10 shrink-0 text-danger" />
          <div className="min-w-0">
            <h2 className="text-title text-danger">{copy.heading}</h2>
            <p className="mt-2 text-body text-ink-muted">{copy.body}</p>
            {detail === "" ? null : (
              <p className="mt-3 text-caption text-ink-muted wrap-anywhere">
                {`Details: ${detail}`}
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 space-y-2">
          <Button tone="primary" full onClick={onRetry}>
            {SOUND_CHAT_COPY.actions.retry}
          </Button>
          <Button tone="quiet" full onClick={onBack}>
            {SOUND_CHAT_COPY.actions.back}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
