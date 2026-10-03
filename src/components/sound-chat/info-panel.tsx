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
import { InfoIcon, LeaveIcon } from "@/components/husk/icons";
import { Button } from "@/components/husk/primitives";
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
  onClose,
  onLearnMore,
}: {
  /** This session's own counters, shown because they explain what happened. */
  readonly stats?: SessionStats | undefined;
  /** Ends the session and returns to the pre-prompt. */
  readonly onEnd?: (() => void) | undefined;
  /** Closes the side drawer or bottom sheet. */
  readonly onClose?: (() => void) | undefined;
  /** Opens the full Sound Chat protocol & licence modal. */
  readonly onLearnMore?: (() => void) | undefined;
  /** Accepted and not read: see the file header. */
  readonly open?: boolean;
  readonly onToggle?: () => void;
}): ReactElement {
  const headingId = useId();
  return (
    <div className="flex h-full flex-col justify-between space-y-6">
      <div className="space-y-5">
        {/* Header row with title and close button */}
        <div className="flex items-center justify-between border-b border-line/30 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <InfoIcon className="h-4 w-4" />
            </div>
            <h2 id={headingId} className="text-[16px] font-semibold text-ink">
              {SOUND_CHAT_COPY.info.statsHeading}
            </h2>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={SOUND_CHAT_COPY.permission.close}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-white/10 hover:text-ink"
            >
              <span className="text-base font-medium leading-none">✕</span>
            </button>
          ) : null}
        </div>

        {/* Live Acoustic Link Status Card */}
        <div className="flex items-center gap-2.5 rounded-xl border border-line/30 bg-surface-sunken/40 px-3.5 py-2.5">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">{SOUND_CHAT_COPY.info.channelActive}</p>
            <p className="text-[11px] text-ink-muted">{SOUND_CHAT_COPY.info.channelSecurity}</p>
          </div>
        </div>

        {/* Telemetry / Statistics Cards */}
        {stats === undefined ? null : <Stats stats={stats} />}

        {/* Quick Link to Protocol & Licences */}
        {onLearnMore ? (
          <button
            type="button"
            onClick={onLearnMore}
            className="flex w-full items-center justify-between rounded-xl border border-line/30 bg-surface-sunken/30 px-3.5 py-2.5 text-left text-caption text-ink-muted transition-colors hover:border-line hover:text-ink"
          >
            <span>{SOUND_CHAT_COPY.permission.learnMore}</span>
            <span className="text-accent font-medium">→</span>
          </button>
        ) : null}
      </div>

      {/* End Session Button pinned at bottom */}
      {onEnd === undefined ? null : (
        <div className="border-t border-line/30 pt-4">
          <Button tone="danger" full onClick={onEnd}>
            <LeaveIcon className="h-4 w-4" />
            {SOUND_CHAT_COPY.actions.leave}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * This session's counters as styled metric cards.
 */
function Stats({ stats }: { readonly stats: SessionStats }): ReactElement {
  const rows: readonly (readonly [string, number])[] = [
    [SOUND_CHAT_COPY.info.statMessagesDelivered, stats.messagesDelivered],
    [SOUND_CHAT_COPY.info.statBlocksDecoded, stats.blocksDecoded],
    [SOUND_CHAT_COPY.info.statRetries, stats.retries],
    [SOUND_CHAT_COPY.info.statDuplicatesSuppressed, stats.duplicatesSuppressed],
    [SOUND_CHAT_COPY.info.statUnreadable, stats.framesUnreadable],
  ];

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
        {SOUND_CHAT_COPY.info.telemetryHeading}
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col justify-between rounded-xl border border-line/30 bg-surface-sunken/40 p-3"
          >
            <span className="text-[11px] font-medium leading-tight text-ink-muted">{label}</span>
            <span className="mt-1 font-mono text-[20px] font-bold text-ink">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
