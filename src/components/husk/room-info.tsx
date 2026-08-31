/** Connection indicator, room info panel and share controls. */

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, LinkIcon, LeaveIcon, ShieldIcon } from "./icons";
import { Button, IconButton, SegmentedControl, useToast } from "./primitives";
import type { ConnectionStatus } from "@/lib/husk/connection";
import type { RoomState } from "@/lib/husk/room-machine";
import { inGraceWindow, useRoomStore } from "@/lib/husk/store";
import { useTheme } from "@/lib/husk/theme";
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
}: {
  readonly roomId: string;
  readonly shareLink: string;
  readonly participants: number;
  readonly onLeave: () => void;
}) {
  const notify = useToast();
  const { theme, setTheme } = useTheme();
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
    <div className="flex h-full flex-col gap-6">
      <div>
        <p className="text-caption uppercase tracking-wide text-ink-faint">Room</p>
        <p className="tabular mt-1 text-display text-ink">{roomId}</p>
        <p className="mt-1 text-caption text-ink-muted">
          {participants} {participants === 1 ? "participant" : "participants"} connected
        </p>
      </div>

      <div>
        <p className="text-caption uppercase tracking-wide text-ink-faint">Invite link</p>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2">
            <LinkIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="truncate text-caption text-ink-muted">{shareLink || "…"}</span>
          </div>
          <IconButton
            label={copied ? "Invite link copied" : "Copy invite link"}
            onClick={() => void copy()}
            className="border border-line"
          >
            {copied ? <CheckIcon className="swap-check text-ok" /> : <CopyIcon />}
          </IconButton>
        </div>
        {copyFallback ? (
          <p className="mt-2 text-caption text-ink-muted">
            Clipboard access was refused. Ask your browser to allow it and retry.
          </p>
        ) : null}
        <p className="mt-2 text-caption text-ink-faint">
          The part after the hash is the encryption key. It never reaches the server.
        </p>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-line bg-surface-sunken p-3 text-caption text-ink-muted">
        <ShieldIcon className="mt-0.5 shrink-0 text-ok" />
        <span>
          Messages and files are encrypted with AES-256-GCM in this browser. The relay stores
          nothing and holds no key.
        </span>
      </div>

      <div className="mt-auto space-y-4">
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "light", text: "Light" },
            { value: "dark", text: "Dark" },
          ]}
        />
        <Button tone="danger" full onClick={onLeave}>
          <LeaveIcon />
          Leave room
        </Button>
      </div>
    </div>
  );
}
