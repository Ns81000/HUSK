/**
 * Terminal for this session: a restart is the only way out, and it is a
 * deliberate act rather than a button.
 *
 * WHY the restart goes through a confirm dialog: it ends the session, releases
 * the microphone and discards anything in flight, while keeping the pairing
 * code. That is a trade the user should be asked about, and it is the same
 * trade the discard dialog describes from the other side.
 *
 * The two fatal kinds read differently on purpose. A codec that died is a codec
 * the page session can no longer use, by policy; a frame that did not match the
 * format this session writes is our own contract breaking, which leaves the
 * codec unusable for the rest of the page too. Neither is retryable, and
 * neither is a microphone problem the user can fix in their address bar.
 */

import { useState, type ReactElement } from "react";
import { ErrorMark, WarnIcon } from "@/components/husk/icons";
import { Button, Modal, Panel } from "@/components/husk/primitives";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

export function FatalPanel({
  fatal,
  onRestart,
}: {
  readonly fatal: { readonly kind: string; readonly detail: string };
  readonly onRestart: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  // As in the blocked panel: the kind is a plain string here, so an
  // unrecognised one falls back and keeps its own name in the detail line.
  const known = Object.hasOwn(SOUND_CHAT_COPY.fatal, fatal.kind);
  const copy = known
    ? SOUND_CHAT_COPY.fatal[fatal.kind as keyof typeof SOUND_CHAT_COPY.fatal]
    : SOUND_CHAT_COPY.fatal["codec-died"];
  const raw = fatal.detail.trim();
  const detail = known ? raw : `${fatal.kind}: ${raw}`;

  return (
    <div role="alert" className="enter w-full">
      <Panel className="fade-in mx-auto max-w-xl">
        <div className="flex items-start gap-3">
          <ErrorMark className="h-10 w-10 shrink-0 text-danger" />
          <div className="min-w-0">
            <h2 className="text-title text-danger">{copy.heading}</h2>
            <p className="mt-2 text-body text-ink-muted">{copy.body}</p>
            {detail === "" ? null : (
              <p className="mt-3 text-caption text-ink-faint wrap-anywhere">
                {`Details: ${detail}`}
              </p>
            )}
          </div>
        </div>
        <div className="mt-6 space-y-2">
          <Button tone="primary" full onClick={() => setConfirming(true)}>
            <WarnIcon className="h-4 w-4" />
            {SOUND_CHAT_COPY.modal.restartConfirm}
          </Button>
        </div>
      </Panel>
      <Modal
        open={confirming}
        title={SOUND_CHAT_COPY.modal.restartTitle}
        description={SOUND_CHAT_COPY.modal.restartDescription}
        confirmLabel={SOUND_CHAT_COPY.modal.restartConfirm}
        onConfirm={onRestart}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
