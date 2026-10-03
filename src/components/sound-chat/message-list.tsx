/**
 * The transcript: both directions, in the order the session happened in.
 *
 * WHY it merges on `seq` and not on `msgId`: the two peers allocate message ids
 * from independent counters seeded with their own session salts, so a sender's
 * `msgId` 3 and a receiver's `msgId` 3 are two different notes and merging on
 * them would interleave the transcript into nonsense. `seq` is the controller's
 * one render-order counter for both directions, which is the only sequence that
 * means the same thing for the whole conversation.
 *
 * WHY the `role="log"` is mounted even when the transcript is empty: a live
 * region that is inserted into the document at the same moment as its first
 * child is not reliably announced, so the first note of a conversation — the one
 * a person is actually waiting for — would arrive silently. The region is here
 * from the first frame and the empty state is content inside it.
 *
 * WHY a status line sits under each of our own bubbles and under none of the
 * other's: an inbound note exists because it was decoded, so the transcript
 * already proves it arrived and a second status would only add words. Our own
 * notes have four genuinely different proven states — queued, on the air,
 * confirmed, and never confirmed — and the copy says exactly that: a queued
 * note reads "Queued, not played yet", a note being played reads "Playing" and
 * never the word delivered, because the session cannot know anything about the
 * other device until the acknowledgement comes back.
 */

import { memo, useEffect, useRef, type ReactElement } from "react";
import { CheckIcon, ErrorMark } from "@/components/husk/icons";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import { cn } from "@/lib/utils";
import type { OutboundStatus } from "@/lib/sound-chat/protocol";

type Inbound = { readonly seq: number; readonly msgId: number; readonly text: string };

type Outbound = {
  readonly seq: number;
  /**
   * The submission's identity, assigned when the session accepted the note.
   * This is the React key, not `msgId`: `msgId` is null while a note is queued
   * and unsealed, and two notes must never be able to collide on a key that only
   * exists for part of a submission's life.
   */
  readonly sendId: number;
  readonly msgId: number | null;
  readonly text: string;
  readonly status: OutboundStatus;
  readonly attempts: number;
  readonly blocks: number;
};

/** One rendered row, tagged so the merge below can stay a single ordered walk. */
type Row =
  | { readonly kind: "inbound"; readonly view: Inbound }
  | { readonly kind: "outbound"; readonly view: Outbound };

/**
 * One array for the whole conversation, ordered by the controller's single
 * `seq` counter. `sort` is stable and the inbound notes are pushed first, so a
 * tie (which one counter cannot produce anyway) resolves to the note that is
 * already proven rather than to whichever list happened to be concatenated
 * second.
 */
function mergeBySeq(inbound: readonly Inbound[], outbound: readonly Outbound[]): readonly Row[] {
  const rows: Row[] = [];
  for (const view of inbound) rows.push({ kind: "inbound", view });
  for (const view of outbound) rows.push({ kind: "outbound", view });
  rows.sort((left, right) => left.view.seq - right.view.seq);
  return rows;
}

/**
 * One note's own text. Pre-wrapped and broken anywhere: a note is typed by
 * hand on a phone, so it carries the newlines the sender pressed, and a single
 * long word must not widen the bubble past the screen.
 */
function NoteText({ text }: { readonly text: string }): ReactElement {
  return <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{text}</p>;
}

function OutboundRow({ view }: { readonly view: Outbound }): ReactElement {
  // Only `sent` has proof the other device confirmed the note, so only `sent`
  // is ever allowed the word delivered — and that word comes from the copy file
  // rather than from anything written here.
  const tone =
    view.status === "sent"
      ? "text-ok"
      : view.status === "failed"
        ? "text-danger"
        : "text-ink-muted";
  const retrying = view.status === "sending" && view.attempts > 1;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="bubble bubble-mine max-w-[85%] px-4 py-3 text-ink sm:max-w-[70%]">
        <NoteText text={view.text} />
      </div>
      <p className={cn("flex flex-wrap items-center justify-end gap-x-1.5 text-caption", tone)}>
        {view.status === "sent" ? <CheckIcon className="h-3.5 w-3.5 shrink-0" /> : null}
        {view.status === "failed" ? <ErrorMark className="h-3.5 w-3.5 shrink-0" /> : null}
        <span>{SOUND_CHAT_COPY.outbound[view.status]}</span>
        {retrying ? <span>{SOUND_CHAT_COPY.transmit.retrying(view.attempts)}</span> : null}
      </p>
    </div>
  );
}

function InboundRow({ view }: { readonly view: Inbound }): ReactElement {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="bubble bubble-theirs max-w-[85%] px-4 py-3 text-ink sm:max-w-[70%]">
        <NoteText text={view.text} />
      </div>
    </div>
  );
}

/**
 * Below this distance from the bottom, an arriving note keeps the view pinned.
 * The same figure the main chat uses, for the same reason: it is roughly one
 * bubble, so a reader who has deliberately scrolled up is never moved.
 */
const NEAR_BOTTOM_PX = 120;

export const MessageList = memo(function MessageList({
  inbound,
  outbound,
}: {
  readonly inbound: readonly Inbound[];
  readonly outbound: readonly Outbound[];
}): ReactElement {
  const rows = mergeBySeq(inbound, outbound);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the view was at the bottom before the last addition. A note that
   * arrives while the reader is looking at the top of the transcript must not
   * yank them to the bottom of it — which is the same rule the main chat's
   * transcript follows, and the reason this is a ref and not state: it is read
   * inside an effect and never rendered.
   */
  const nearBottomRef = useRef(true);

  function handleScroll(): void {
    const el = scrollerRef.current;
    if (el !== null) {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    }
  }

  useEffect(() => {
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [rows.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The scroll container is separate from the log so scrolling is reachable
          by the browser's own affordances while the log keeps a single live
          region that only ever announces what was added. It is a named,
          focusable `region` rather than a bare `div`: `aria-label` on an
          element with no role is not exposed, and a scroll container that cannot
          be reached from the keyboard cannot be scrolled from the keyboard. */}
      <div
        role="region"
        tabIndex={0}
        aria-label={SOUND_CHAT_COPY.transcript.scrollLabel}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 sm:px-6"
        ref={scrollerRef}
        onScroll={handleScroll}
      >
        {/* Mounted from the first frame, empty or not. A live region has to be in
            the document, and settled, before its content changes: a `role="log"`
            created at the same moment as its first child is an insertion, and an
            insertion into a region that did not exist is not reliably announced
            at all. So the region is always here and the empty state lives inside
            it. */}
        <div
          role="log"
          aria-live="polite"
          // Additions only: a status line changing under an existing bubble is
          // a detail the person who sent the note can read, not an event worth
          // interrupting for.
          aria-relevant="additions"
          aria-label={SOUND_CHAT_COPY.transcript.logLabel}
          className="flex flex-1 flex-col space-y-4"
        >
          {rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center">
              {/* The same mark and the same shadow the main chat's empty
                  transcript uses, so an empty Sound Chat and an empty room read
                  as two empty rooms in one app rather than two empty rooms in
                  two. */}
              <img
                src="/icons/husk-mark.svg"
                alt="Husk"
                width={56}
                height={64}
                className="mx-auto h-14 w-auto select-none drop-shadow-[0_4px_16px_rgba(60,231,103,0.3)]"
              />
              <div>
                <p className="text-[17px] font-semibold text-ink">
                  {SOUND_CHAT_COPY.transcript.emptyHeading}
                </p>
                <p className="mt-1 max-w-sm text-[13px] text-ink-muted">
                  {SOUND_CHAT_COPY.transcript.emptyBody}
                </p>
              </div>
            </div>
          ) : (
            rows.map((row) =>
              row.kind === "outbound" ? (
                <OutboundRow key={`outbound-${row.view.sendId}`} view={row.view} />
              ) : (
                <InboundRow key={`inbound-${row.view.msgId}`} view={row.view} />
              ),
            )
          )}
        </div>
        {/* The scroll anchor, outside the log so the region's children stay the
            rows themselves. */}
        <div ref={bottomRef} />
      </div>
    </div>
  );
});
