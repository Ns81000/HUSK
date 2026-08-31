/** Connection indicator, room info panel and share controls. */

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, LinkIcon, LeaveIcon, ShieldIcon } from "./icons";
import { Button, IconButton, useToast } from "./primitives";
import type { ConnectionStatus } from "@/lib/husk/connection";
import type { RoomState } from "@/lib/husk/room-machine";
import { inGraceWindow, useRoomStore } from "@/lib/husk/store";
import { cn } from "@/lib/utils";

const statusCopy = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
} satisfies Record<ConnectionStatus, string>;

export function ConnectionIndicator({
  status,
  state,
}: {
  readonly status: ConnectionStatus;
  readonly state: RoomState;
}) {
  const lastLeaveAt = useRoomStore((store) => store.lastLeaveAt);
  const online = useRoomStore((store) => store.online);
  const offline = !online;
  const tone = offline
    ? "text-warn"
    : status === "open"
      ? "text-ok"
      : status === "reconnecting" || status === "connecting"
        ? "text-warn"
        : "text-danger";
  // A pulsing dot says "not settled yet"; a still dot says "connected".
  const pulsing = offline || status === "connecting" || status === "reconnecting";
  return (
    <p className={cn("flex items-center gap-2 text-caption", tone)} aria-live="polite">
      <span
        className={cn("inline-block h-2 w-2 rounded-pill bg-current", pulsing && "dot-pulse")}
      />
      {offline ? "You are offline — messages can't send while offline" : statusCopy[status]}
      {!offline && state === "peer_disconnected_grace" && inGraceWindow(lastLeaveAt, Date.now())
        ? " · peer may be reconnecting"
        : ""}
    </p>
  );
}

/**
 * The shared room-info content, used by the desktop drawer and the mobile
 * bottom sheet. Owns the copy-to-clipboard interaction with its checkmark.
 */
export function RoomInfoPanel({
  roomId,
  shareLink,
  participants,
  onLeave,
  onClose,
}: {
  readonly roomId: string;
  readonly shareLink: string;
  readonly participants: number;
  readonly onLeave: () => void;
  readonly onClose?: () => void;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      notify("Invite link copied.");
    } catch {
      setCopyFallback(true);
      notify("Copy the link from the field below.", "danger");
    }
  }

  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest text-ink-faint">
              Room
            </p>
            <p className="tabular mt-1 text-[22px] font-semibold leading-tight text-ink">{roomId}</p>
            <p className="mt-1 text-caption text-ink-muted">
              {participants} {participants === 1 ? "participant" : "participants"} connected
            </p>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Collapse menu"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-white/10 transition-colors"
            >
              <span className="text-base font-medium leading-none">✕</span>
            </button>
          ) : null}
        </div>

        <div className="info-divider" />

        <div>
          <p className="text-[11px] font-medium uppercase tracking-widest text-ink-faint">
            Invite link
          </p>
          <div className="mt-2 flex min-w-0 items-center gap-2 rounded-xl border border-line/30 bg-surface-sunken/40 px-3.5 py-2.5">
            <LinkIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="truncate text-[13px] text-ink-muted font-mono">{shareLink || "…"}</span>
          </div>
          <Button
            onClick={() => void copy()}
            className="mt-2.5 rounded-xl h-10 font-medium"
            full
          >
            {copied ? (
              <>
                <CheckIcon className="swap-check h-4 w-4 text-emerald-950 stroke-[2.5]" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <CopyIcon className="h-4 w-4" />
                <span>Copy invite link</span>
              </>
            )}
          </Button>
          {copyFallback ? (
            <p className="mt-2 text-caption text-ink-muted">
              Clipboard access was refused. Ask your browser to allow it and retry.
            </p>
          ) : null}
          <p className="mt-2 text-[12px] text-ink-faint/70 leading-relaxed">
            The key travels in the URL fragment — the server never sees it.
          </p>
        </div>

        <div className="info-divider" />

        <div className="rounded-xl border border-line/20 bg-surface-sunken/30 p-4 text-ink-muted">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-ink mb-3 flex items-center gap-2">
            <ShieldIcon className="h-4 w-4 text-ok" />
            Security & Privacy
          </p>
          <ul className="space-y-2.5 text-[13px] leading-snug">
            <li className="flex items-start gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
              <span><strong className="text-ink font-medium">End-to-End Encrypted:</strong> AES-256-GCM browser encryption keeps data private.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
              <span><strong className="text-ink font-medium">Zero Knowledge:</strong> Relay never sees room keys or unencrypted content.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
              <span><strong className="text-ink font-medium">Instant Dissolution:</strong> When all participants leave, the room vanishes forever.</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="pt-5">
        <Button tone="danger" full onClick={onLeave} className="rounded-xl h-11 text-[15px] font-semibold">
          <LeaveIcon />
          Leave room
        </Button>
      </div>
    </div>
  );
}
