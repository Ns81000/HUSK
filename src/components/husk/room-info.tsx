/** Connection indicator, room info panel and share controls. */

import { useState } from "react";
import { CopyIcon, LeaveIcon, ShieldIcon } from "./icons";
import { Button, IconButton, Switch, useToast } from "./primitives";
import { formatPin } from "@/lib/husk/pin";
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
  return (
    <p className={cn("flex items-center gap-2 text-caption", tone)} aria-live="polite">
      <span className="inline-block h-2 w-2 rounded-pill bg-current" />
      {offline ? "You are offline — messages can't send while offline" : statusCopy[status]}
      {!offline &&
      state === "peer_disconnected_grace" &&
      inGraceWindow(lastLeaveAt, Date.now())
        ? " · peer may be reconnecting"
        : ""}
    </p>
  );
}

export function RoomInfo({
  pin,
  shareLink,
  participants,
  onLeave,
}: {
  readonly pin: string;
  readonly shareLink: string;
  readonly participants: number;
  readonly onLeave: () => void;
}) {
  const notify = useToast();
  const { theme, setTheme } = useTheme();
  const [copyFallback, setCopyFallback] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      notify("Invite link copied.");
    } catch {
      setCopyFallback(true);
      notify("Copy the link from the field below.", "danger");
    }
  }

  return (
    <div className="flex h-full flex-col gap-6">
      <div>
        <p className="text-caption uppercase tracking-wide text-ink-faint">Room PIN</p>
        <p className="tabular mt-1 text-display text-ink">{formatPin(pin)}</p>
        <p className="mt-1 text-caption text-ink-muted">
          {participants} {participants === 1 ? "participant" : "participants"} connected
        </p>
      </div>

      <div>
        <p className="text-caption uppercase tracking-wide text-ink-faint">Invite link</p>
        <div className="mt-2 flex items-center gap-2">
          <input
            readOnly
            value={shareLink}
            aria-label="Invite link"
            onFocus={(event) => event.target.select()}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface-sunken px-3 py-2 text-caption text-ink-muted"
          />
          <IconButton label="Copy invite link" onClick={() => void copy()} className="border border-line">
            <CopyIcon />
          </IconButton>
        </div>
        {copyFallback ? (
          <p className="mt-2 text-caption text-ink-muted">
            Clipboard access was refused. Select the field above and copy manually.
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
        <Switch
          checked={theme === "dark"}
          onChange={(next) => setTheme(next ? "dark" : "light")}
          label="Dark theme"
        />
        <Button tone="danger" full onClick={onLeave}>
          <LeaveIcon />
          Leave room
        </Button>
      </div>
    </div>
  );
}
