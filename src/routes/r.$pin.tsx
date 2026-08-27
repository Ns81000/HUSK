import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Composer, MessageList } from "@/components/husk/chat";
import { ErrorMark } from "@/components/husk/icons";
import { Button, Modal, Panel, useToast } from "@/components/husk/primitives";
import { ConnectionIndicator, RoomInfo } from "@/components/husk/room-info";
import {
  UploadFailedError,
  downloadAndDecrypt,
  encryptAndUpload,
  requestFileUpload,
} from "@/lib/husk/files";
import { importRoomKey } from "@/lib/husk/crypto";
import { isTerminal, type RoomState } from "@/lib/husk/room-machine";
import { useRoomStore } from "@/lib/husk/store";
import type { SealedBody } from "@/lib/husk/protocol";

export const Route = createFileRoute("/r/$pin")({
  head: ({ params }) => ({
    meta: [
      { title: `Husk room ${params.pin}` },
      {
        name: "description",
        content:
          "An ephemeral end-to-end encrypted Husk room. Content lives only in the participants' browsers.",
      },
      { property: "og:title", content: "Husk room" },
      {
        property: "og:description",
        content: "An ephemeral end-to-end encrypted room for chat and file sharing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RoomScreen,
});

type ClosedCopy = { readonly title: string; readonly body: string };

const CLOSED_COPY = {
  closed_by_host: {
    title: "You left the room",
    body: "The room and everything in it is gone from this browser.",
  },
  closed_expired: {
    title: "Room expired",
    body: "This room reached its lifetime limit and was closed by the relay.",
  },
  closed_full: { title: "Room full", body: "This room already has the maximum participants." },
  closed_not_found: {
    title: "Room unavailable",
    body: "The room does not exist, is full, or the link is missing its key.",
  },
  closed_rate_limited: {
    title: "Too many attempts",
    body: "Join attempts are throttled. Wait a few minutes and try again.",
  },
} satisfies Record<string, ClosedCopy>;

function closedCopyFor(state: RoomState): ClosedCopy {
  // SAFETY: lookup on a plain record; a missing key falls back below.
  const entry = (CLOSED_COPY as Record<string, ClosedCopy | undefined>)[state];
  return entry ?? CLOSED_COPY.closed_not_found;
}

function RoomScreen() {
  const { pin } = Route.useParams();
  const navigate = useNavigate();
  const notify = useToast();
  const [keyFragment, setKeyFragment] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [origin, setOrigin] = useState("");

  const state = useRoomStore((store) => store.state);
  const status = useRoomStore((store) => store.status);
  const participants = useRoomStore((store) => store.participants);
  const selfId = useRoomStore((store) => store.selfId);
  const connect = useRoomStore((store) => store.connect);
  const leave = useRoomStore((store) => store.leave);
  const sendFileMessage = useRoomStore((store) => store.sendFileMessage);
  const cancelFile = useRoomStore((store) => store.cancelFile);

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    setKeyFragment(fragment);
    setOrigin(window.location.origin);
    if (fragment.length === 0) {
      return;
    }
    void connect(pin, fragment);
    return () => {
      useRoomStore.getState().leave();
    };
  }, [pin, connect]);

  const onSendFile = useCallback(
    async (file: File) => {
      if (keyFragment === null) {
        return;
      }
      const key = await importRoomKey(keyFragment);
      try {
        const grant = await requestFileUpload(pin, selfId, file.size);
        const uploaded = await encryptAndUpload(key, file, grant, () => undefined);
        const body: SealedBody = {
          kind: "file",
          name: file.name,
          size: file.size,
          mime: file.type === "" ? "application/octet-stream" : file.type,
          fileId: uploaded.fileId,
          chunks: uploaded.chunks,
          ivs: uploaded.ivs,
          lengths: uploaded.lengths,
          exp: uploaded.exp,
          sig: uploaded.sig,
          sentAt: Date.now(),
        };
        await sendFileMessage(body);
      } catch (error) {
        // Free the reserved storage of a half-uploaded file before surfacing.
        if (error instanceof UploadFailedError && error.fileId !== null) {
          cancelFile(error.fileId);
        }
        throw error;
      }
    },
    [keyFragment, pin, selfId, sendFileMessage, cancelFile],
  );

  const onDownload = useCallback(
    async (body: Extract<SealedBody, { kind: "file" }>) => {
      if (keyFragment === null) {
        return;
      }
      const key = await importRoomKey(keyFragment);
      const blob = await downloadAndDecrypt(key, pin, body, body.mime, () => undefined);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = body.name;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("File decrypted and downloaded.");
    },
    [keyFragment, pin, notify],
  );

  if (keyFragment !== null && keyFragment.length === 0) {
    return (
      <ClosedScreen
        title="This link has no key"
        body="Husk links carry the encryption key after the hash. Ask for the full invite link."
        onHome={() => void navigate({ to: "/" })}
      />
    );
  }

  if (isTerminal(state)) {
    const copy = closedCopyFor(state);
    return (
      <ClosedScreen title={copy.title} body={copy.body} onHome={() => void navigate({ to: "/" })} />
    );
  }

  const shareLink = origin === "" ? "" : `${origin}/r/${pin}#${keyFragment ?? ""}`;

  return (
    <main className="flex h-screen flex-col lg:flex-row">
      <aside className="hidden w-80 shrink-0 border-r border-line bg-surface p-6 lg:block">
        <RoomInfo
          pin={pin}
          shareLink={shareLink}
          participants={participants.length}
          onLeave={() => setConfirmLeave(true)}
        />
      </aside>

      <section className="flex min-h-0 flex-1 flex-col">
        <header className="safe-top flex items-center justify-between gap-4 border-b border-line bg-surface px-4 pb-3 sm:px-6">
          <div>
            <p className="tabular text-title text-ink">Room {pin}</p>
            <ConnectionIndicator status={status} state={state} />
          </div>
          <Button tone="quiet" onClick={() => setConfirmLeave(true)} className="lg:hidden">
            Leave
          </Button>
        </header>

        <MessageList onDownload={onDownload} />

        <div className="border-t border-line bg-surface px-4 py-3 lg:hidden">
          <RoomInfoCompact pin={pin} shareLink={shareLink} participants={participants.length} />
        </div>

        <Composer onSendFile={onSendFile} disabled={status !== "open"} />
      </section>

      <Modal
        open={confirmLeave}
        title="Leave this room?"
        description="Everything in it disappears from this browser. Others stay connected until they leave too."
        confirmLabel="Leave"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          leave();
          setConfirmLeave(false);
        }}
      />
    </main>
  );
}

function RoomInfoCompact({
  pin,
  shareLink,
  participants,
}: {
  readonly pin: string;
  readonly shareLink: string;
  readonly participants: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        readOnly
        value={shareLink}
        aria-label="Invite link"
        onFocus={(event) => event.target.select()}
        className="min-w-0 flex-1 rounded-md border border-line bg-surface-sunken px-3 py-2 text-caption text-ink-muted"
      />
      <span className="tabular text-caption text-ink-faint">
        {participants} in room {pin}
      </span>
    </div>
  );
}

function ClosedScreen({
  title,
  body,
  onHome,
}: {
  readonly title: string;
  readonly body: string;
  readonly onHome: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Panel className="max-w-md text-center">
        <ErrorMark className="mx-auto text-line-strong" />
        <h1 className="mt-4 text-title text-ink">{title}</h1>
        <p className="mt-2 text-[14px] text-ink-muted">{body}</p>
        <Button className="mt-6" full onClick={onHome}>
          Back to start
        </Button>
      </Panel>
    </main>
  );
}
