import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { Composer, MessageList } from "@/components/husk/chat";
import { BackIcon, CheckIcon, HuskMark, InfoIcon, ShieldIcon } from "@/components/husk/icons";
import { Button, IconButton, Modal, useToast } from "@/components/husk/primitives";
import { ConnectionIndicator, RoomInfoPanel } from "@/components/husk/room-info";
import {
  EmptyFileError,
  FileTooLargeError,
  UploadFailedError,
  assertFileSendable,
  downloadAndDecrypt,
  encryptAndUpload,
  requestFileUpload,
} from "@/lib/husk/files";
import { importRoomKey } from "@/lib/husk/crypto";
import { isTerminal, type RoomState } from "@/lib/husk/room-machine";
import { useRoomStore } from "@/lib/husk/store";
import { cn } from "@/lib/utils";
import type { SealedBody } from "@/lib/husk/protocol";

export const Route = createFileRoute("/r/$roomId")({
  head: ({ params }) => ({
    meta: [
      { title: `Husk room ${params.roomId}` },
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
  closed_disconnected: {
    title: "Disconnected",
    body: "The connection to the relay was lost. The room may still exist — try reconnecting.",
  },
} satisfies Record<string, ClosedCopy>;

function closedCopyFor(state: RoomState): ClosedCopy {
  // SAFETY: lookup on a plain record; a missing key falls back below.
  const entry = (CLOSED_COPY as Record<string, ClosedCopy | undefined>)[state];
  return entry ?? CLOSED_COPY.closed_not_found;
}
function RoomScreen() {
  const { roomId } = Route.useParams();
  const navigate = useNavigate();
  const notify = useToast();
  const [keyFragment, setKeyFragment] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const isDesktop = useIsDesktop();

  const state = useRoomStore((store) => store.state);
  const status = useRoomStore((store) => store.status);
  const participants = useRoomStore((store) => store.participants);
  const selfId = useRoomStore((store) => store.selfId);
  const connect = useRoomStore((store) => store.connect);
  const leave = useRoomStore((store) => store.leave);
  const sendFileMessage = useRoomStore((store) => store.sendFileMessage);
  const cancelFile = useRoomStore((store) => store.cancelFile);
  const retry = useRoomStore((store) => store.retry);

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    setKeyFragment(fragment);
    setOrigin(window.location.origin);
    if (fragment.length === 0) {
      return;
    }
    void connect(roomId, fragment);
    return () => {
      useRoomStore.getState().leave();
    };
  }, [roomId, connect]);
  const onSendFile = useCallback(
    async (file: File) => {
      if (keyFragment === null) {
        return;
      }
      // Size guards run before the grant request: the relay rejects a
      // 0-byte or over-cap grant with 400, so asking first would put a
      // doomed request on the network.
      assertFileSendable(file.size);
      if (status !== "open" || selfId === "") {
        // No doomed request: the file lands in the composer's failed state
        // and the user retries once the room is connected (welcome assigns
        // the participant id the membership check requires).
        throw new UploadFailedError(null);
      }
      const key = await importRoomKey(keyFragment);
      try {
        const grant = await requestFileUpload(roomId, selfId, file.size);
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
    [keyFragment, roomId, status, selfId, sendFileMessage, cancelFile],
  );

  const onDownload = useCallback(
    async (body: Extract<SealedBody, { kind: "file" }>) => {
      if (keyFragment === null) {
        return;
      }
      const key = await importRoomKey(keyFragment);
      const blob = await downloadAndDecrypt(key, roomId, body, body.mime, () => undefined);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = body.name;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("File decrypted and downloaded.");
    },
    [keyFragment, roomId, notify],
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
      <ClosedScreen
        title={copy.title}
        body={copy.body}
        onHome={() => void navigate({ to: "/" })}
        onRetry={state === "closed_disconnected" ? () => void retry() : undefined}
      />
    );
  }
  const [shareDismissed, setShareDismissed] = useState(false);
  const hadPeerRef = useRef(false);
  if (participants.length > 1) {
    hadPeerRef.current = true;
  }
  const shareLink = origin === "" ? "" : `${origin}/r/${roomId}#${keyFragment ?? ""}`;
  const waiting =
    state === "waiting_for_peer" &&
    participants.length <= 1 &&
    !hadPeerRef.current &&
    !shareDismissed;

  return (
    <main className="flex h-screen flex-col bg-canvas">
      <header className="chat-header safe-top flex items-center gap-3 px-4 pb-3 sm:px-6">
        <button
          type="button"
          aria-label="Back to start"
          onClick={() => void navigate({ to: "/" })}
          className="-ml-1 flex items-center justify-center p-1.5 transition-transform duration-200 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3ce767] rounded-lg"
        >
          <BackIcon className="h-5 w-5 text-ink-muted hover:text-ink lg:hidden" />
          <img
            src="/icons/husk-mark.svg"
            alt="Husk"
            width={28}
            height={32}
            className="h-7 w-auto drop-shadow-[0_2px_8px_rgba(60,231,103,0.25)] select-none hidden lg:block"
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="tabular truncate text-[15px] font-semibold text-ink">Room {roomId}</p>
          <ConnectionIndicator status={status} state={state} />
        </div>
        <IconButton label="Room info" onClick={() => setInfoOpen(true)}>
          <InfoIcon />
        </IconButton>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ShareCard
          shareLink={shareLink}
          visible={waiting}
          onDismiss={() => setShareDismissed(true)}
        />
        <MessageList onDownload={onDownload} />
      </div>

      <Composer onSendFile={onSendFile} disabled={status !== "open"} />

      {isDesktop ? (
        <div aria-hidden={!infoOpen}>
          {infoOpen ? (
            <div className="fixed inset-0 z-40">
              <div
                className="modal-scrim absolute inset-0 bg-scrim"
                onClick={() => setInfoOpen(false)}
              />
              <aside
                role="dialog"
                aria-label="Room info"
                className="drawer-panel absolute inset-y-0 right-0 flex w-88 max-w-[85vw] flex-col border-l border-line/30 p-6 shadow-panel"
              >
                <RoomInfoPanel
                  roomId={roomId}
                  shareLink={shareLink}
                  participants={participants.length}
                  onClose={() => setInfoOpen(false)}
                  onLeave={() => {
                    setInfoOpen(false);
                    setConfirmLeave(true);
                  }}
                />
              </aside>
            </div>
          ) : null}
        </div>
      ) : (
        <Drawer.Root open={infoOpen} onOpenChange={setInfoOpen}>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
            <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] rounded-t-xl border-t border-line/30 bg-surface p-6 outline-none" style={{ backdropFilter: "blur(24px) saturate(1.4)", background: "oklch(0.26 0.034 137 / 0.95)" }}>
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-pill bg-line-strong/50" aria-hidden />
              <div className="max-h-[calc(85vh-5rem)] overflow-y-auto">
                <RoomInfoPanel
                  roomId={roomId}
                  shareLink={shareLink}
                  participants={participants.length}
                  onLeave={() => {
                    setInfoOpen(false);
                    setConfirmLeave(true);
                  }}
                />
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}

      <Modal
        open={confirmLeave}
        title="Leave this room?"
        description="Everything in it disappears from this browser. Others stay connected until they leave too."
        confirmLabel="Leave"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          leave();
          setConfirmLeave(false);
          setInfoOpen(false);
          void navigate({ to: "/" });
        }}
      />
    </main>
  );
}
/** 1024px matches the lg breakpoint used across the room layout. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (): void => setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    setIsDesktop(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

/**
 * The first-room empty state: a glassmorphic share card that auto-collapses
 * the moment the first peer joins. Uses animated border shimmer instead of
 * a blinking logo.
 */
function ShareCard({
  shareLink,
  visible,
  onDismiss,
}: {
  readonly shareLink: string;
  readonly visible: boolean;
  readonly onDismiss?: () => void;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);
  const [collapsing, setCollapsing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const wasVisible = useRef(visible);

  useEffect(() => {
    if (wasVisible.current && !visible && !hidden) {
      wasVisible.current = visible;
      setCollapsing(true);
      const timer = setTimeout(() => {
        setCollapsing(false);
        setHidden(true);
      }, 260);
      return () => clearTimeout(timer);
    }
    wasVisible.current = visible;
    if (visible) {
      setHidden(false);
    }
    return undefined;
  }, [visible, hidden]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (hidden || !visible) {
    return null;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      notify("Invite link copied.");
    } catch {
      notify("Clipboard access was refused — copy the link manually.", "danger");
    }
  }

  return (
    <div className="flex justify-center px-4 pt-6 sm:px-6">
      <div className={cn("share-card relative w-full max-w-md p-6 text-center", collapsing && "collapse-out")}>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss invite card"
            className="absolute top-3.5 right-3.5 flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-white/5 transition-colors"
          >
            <span className="text-sm font-semibold leading-none">✕</span>
          </button>
        ) : null}
        <div className="mx-auto flex h-13 w-13 items-center justify-center rounded-2xl btn-tactile-primary text-[#04180c] shadow-lg shadow-black/40">
          <ShieldIcon className="h-6 w-6 stroke-[2.2]" />
        </div>
        <h2 className="mt-4 text-[17px] font-semibold text-ink">Waiting for someone to join</h2>
        <p className="mt-1.5 text-[14px] text-ink-muted">
          Share the invite link. The encryption key travels in the URL fragment — the relay never sees it.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-line/30 bg-surface-sunken/40 px-3 py-2.5 text-left">
          <span className="truncate text-caption text-ink-muted">{shareLink || "…"}</span>
        </div>
        <Button onClick={() => void copy()} className="mt-3 rounded-lg" full>
          {copied ? (
            <>
              <CheckIcon className="swap-check h-4 w-4" />
              Copied
            </>
          ) : (
            "Copy invite link"
          )}
        </Button>
      </div>
    </div>
  );
}

function ClosedScreen({
  title,
  body,
  onHome,
  onRetry,
}: {
  readonly title: string;
  readonly body: string;
  readonly onHome: () => void;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="share-card fade-in max-w-md p-8 text-center rounded-2xl shadow-2xl">
        <img
          src="/icons/husk-mark.svg"
          alt="Husk"
          width={64}
          height={73}
          className="mx-auto h-16 w-auto drop-shadow-[0_6px_20px_rgba(60,231,103,0.3)] select-none"
        />
        <h1 className="mt-6 text-[20px] font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-[14px] text-ink-muted leading-relaxed">{body}</p>
        <div className="mt-6 flex flex-col gap-2.5">
          {onRetry !== undefined ? (
            <Button full onClick={onRetry} className="rounded-xl h-11 text-[15px]">
              Reconnect
            </Button>
          ) : null}
          <Button
            tone={onRetry !== undefined ? "quiet" : "primary"}
            full
            onClick={onHome}
            className="rounded-xl h-11 text-[15px]"
          >
            Back to start
          </Button>
        </div>
      </div>
    </main>
  );
}
