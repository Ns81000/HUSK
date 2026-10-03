/**
 * The "About Sound Chat" content, the session's counters, and the one place the
 * MIT notice is reachable from.
 *
 * WHY the notice is plain visible text beside the toggle rather than inside it: a
 * one-line attribution tucked inside a collapsed disclosure is not an
 * attribution. The line is always there and the toggle carries the full text.
 *
 * WHY the full licence text is imported with `?raw` rather than linked as a
 * `?url` asset: Vite inlines an asset under 4 kB as a base64 `data:` URL, which
 * turns the licence into an opaque blob the reader cannot select or copy — and a
 * licence nobody can read is a worse notice than none. `?raw` puts the actual
 * MIT text from `vendor/LICENSE.ggwave` into the document, verbatim, so it cannot
 * drift from the licence that covers the bundled codec.
 *
 * WHY this is content and not a panel with a toggle of its own any more. It used
 * to own an icon button and open in the flow of the page, which put the one
 * control that explains the feature below the composer — the last thing on the
 * screen, under everything it was meant to explain. The shell now owns the drawer
 * (desktop) and the bottom sheet (mobile), exactly as the room screen does, and
 * this is what fills them. The `open` and `onToggle` props are still accepted and
 * are deliberately not read: the callers and the tests that pass them are not
 * this feature's to rewrite in one go, and a prop that is accepted-and-ignored is
 * a smaller lie than a second, invisible disclosure with the same label as the
 * header's button.
 *
 * WHY the end-session control lives here: ending a session is not navigation, so
 * it does not belong in the header, and it is the same class of action as the
 * room screen's "Leave room" — which is at the bottom of the room's own info
 * panel. It is behind a confirmation because it is the same three consequences
 * the restart describes: the session ends, the microphone is released, and the
 * transcript is cleared.
 */

import { useId, useState, type ReactElement } from "react";
import { LeaveIcon } from "@/components/husk/icons";
import { Button, Modal } from "@/components/husk/primitives";
import type { SessionStats } from "@/lib/sound-chat/session";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import ggwaveLicenceText from "@/lib/sound-chat/vendor/LICENSE.ggwave?raw";

/**
 * The always-visible half of the attribution. One definition, exported, so the
 * permission screen's disclosure and this panel cannot drift into two notices.
 */
export function AttributionLine(): ReactElement {
  return <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.info.attribution}</p>;
}

/** The full MIT text, behind its own toggle so the panel does not open as a wall. */
export function LicenceText(): ReactElement {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((shown) => !shown)}
        className="press text-caption text-accent underline underline-offset-2 transition-colors hover:text-ink"
      >
        {SOUND_CHAT_COPY.info.attributionLink}
      </button>
      <pre
        id={panelId}
        hidden={!open}
        className="mt-2 max-h-64 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-sunken p-3 text-[11px] leading-snug text-ink-muted"
      >
        {ggwaveLicenceText}
      </pre>
    </div>
  );
}

export function InfoPanel({
  stats,
  onEnd,
}: {
  /** This session's own counters, shown because they explain what happened. */
  readonly stats?: SessionStats;
  /**
   * Ends the session and returns to the pre-prompt. Optional, because the panel is
   * rendered on its own by the accessibility suite and by the pre-prompt, where
   * there is no session to end and no honest use for the control.
   */
  readonly onEnd?: () => void;
  /** Accepted and not read: see the file header. */
  readonly open?: boolean;
  readonly onToggle?: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <div className="flex h-full flex-col justify-between">
        <div className="space-y-5">
          {stats === undefined ? null : <Stats stats={stats} />}

          <div className="info-divider" />

          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest text-ink-muted">
              {SOUND_CHAT_COPY.info.heading}
            </p>
            <p className="mt-2 text-[13px] leading-snug text-ink-muted">
              {SOUND_CHAT_COPY.info.how}
            </p>
            <p className="mt-2 text-[13px] leading-snug text-ink-muted">
              {SOUND_CHAT_COPY.info.rate}
            </p>
            <p className="mt-2 text-[13px] leading-snug text-ink-muted">
              {SOUND_CHAT_COPY.info.privacy}
            </p>
          </div>

          <div className="info-divider" />

          {/* Moved out of the composer. What a byte costs is worth reading once,
              and it was five lines of schooling under a field that takes one
              short note. */}
          <p className="text-[13px] leading-snug text-ink-muted">
            {SOUND_CHAT_COPY.composer.bytesHint}
          </p>

          <div className="info-divider" />

          <div>
            <AttributionLine />
            <LicenceText />
          </div>
        </div>

        {onEnd === undefined ? null : (
          <div className="pt-5">
            <Button tone="danger" full onClick={() => setConfirming(true)}>
              <LeaveIcon className="h-4 w-4" />
              {SOUND_CHAT_COPY.actions.leave}
            </Button>
          </div>
        )}
      </div>

      {/* A sibling of the content, never inside a live region: the same reason the
          restart dialog is not nested inside its `role="alert"`. */}
      <Modal
        open={confirming}
        title={SOUND_CHAT_COPY.modal.leaveTitle}
        description={SOUND_CHAT_COPY.modal.leaveDescription}
        confirmLabel={SOUND_CHAT_COPY.modal.leaveConfirm}
        onConfirm={() => {
          setConfirming(false);
          onEnd?.();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * This session's counters.
 *
 * They are here because each one answers a question a user who just watched
 * something odd will ask anyway: how many blocks came off the air, how many were
 * unreadable, how many were the same block heard again. Nothing here is a
 * performance claim and nothing here is a success rate.
 */
function Stats({ stats }: { readonly stats: SessionStats }): ReactElement {
  const rows: readonly (readonly [string, number])[] = [
    [SOUND_CHAT_COPY.info.statBlocksDecoded, stats.blocksDecoded],
    [SOUND_CHAT_COPY.info.statMessagesDelivered, stats.messagesDelivered],
    [SOUND_CHAT_COPY.info.statDuplicatesSuppressed, stats.duplicatesSuppressed],
    [SOUND_CHAT_COPY.info.statUnreadable, stats.framesUnreadable],
    [SOUND_CHAT_COPY.info.statRetries, stats.retries],
  ];
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-widest text-ink-muted">
        {SOUND_CHAT_COPY.info.statsHeading}
      </p>
      <dl className="tabular mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-caption text-ink-muted sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt>{label}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
