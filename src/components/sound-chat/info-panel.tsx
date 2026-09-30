/**
 * The "About Sound Chat" disclosure, and the one place the MIT notice is
 * reachable from.
 *
 * WHY the notice is plain visible text in both the open and collapsed states: a
 * one-line attribution tucked inside a collapsed disclosure is not an
 * attribution. It costs one line of caption and it is there whether or not the
 * user opens anything.
 *
 * WHY the full licence text is imported with `?raw` rather than linked as a
 * `?url` asset: Vite inlines an asset under 4 kB as a base64 `data:` URL, which
 * turns the licence into an opaque blob the reader cannot select or copy — and a
 * licence nobody can read is a worse notice than none. `?raw` puts the actual
 * MIT text from `vendor/LICENSE.ggwave` into the document, verbatim, so it cannot
 * drift from the licence that covers the bundled codec.
 *
 * The panel is a disclosure rather than a dialog because it explains: nothing in
 * it needs the microphone released or a decision made, so it can be opened and
 * closed without the user losing their place or their draft.
 */

import { useId, useState, type ReactElement } from "react";
import { InfoIcon } from "@/components/husk/icons";
import { IconButton, Panel } from "@/components/husk/primitives";
import type { SessionStats } from "@/lib/sound-chat/session";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import ggwaveLicenceText from "@/lib/sound-chat/vendor/LICENSE.ggwave?raw";

/**
 * The always-visible half of the attribution. One definition, rendered in both
 * states, so the notice can never exist in only one of them.
 */
function AttributionLine(): ReactElement {
  return <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.info.attribution}</p>;
}

/** The full MIT text, behind its own toggle so the card does not open as a wall. */
function LicenceText(): ReactElement {
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
  open,
  onToggle,
  stats,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  /** This session's own counters, shown because they explain what happened. */
  readonly stats?: SessionStats;
}): ReactElement {
  const panelId = useId();

  return (
    <div className="enter w-full">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <AttributionLine />
        <IconButton
          type="button"
          label={SOUND_CHAT_COPY.info.heading}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="rounded-xl"
        >
          <InfoIcon className="h-4 w-4" />
        </IconButton>
      </div>

      {/* Kept mounted and hidden, so `aria-controls` always points at an element
          that exists and the panel keeps its content across a collapse. */}
      <div id={panelId} hidden={!open}>
        <Panel className="fade-in mx-auto mt-3 max-w-2xl">
          <h2 className="text-title text-ink">{SOUND_CHAT_COPY.info.heading}</h2>
          <p className="mt-3 text-body text-ink-muted">{SOUND_CHAT_COPY.info.how}</p>
          <p className="mt-3 text-body text-ink-muted">{SOUND_CHAT_COPY.info.rate}</p>
          <p className="mt-3 text-body text-ink-muted">{SOUND_CHAT_COPY.info.privacy}</p>
          {stats === undefined ? null : <Stats stats={stats} />}
          <div className="info-divider mt-6" />
          <div className="mt-3">
            <AttributionLine />
            <LicenceText />
          </div>
        </Panel>
      </div>
    </div>
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
    <div className="mt-4">
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
