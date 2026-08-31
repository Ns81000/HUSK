/** Message list, message composer and file cards. */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AttachIcon,
  CheckIcon,
  DeleteIcon,
  DownloadIcon,
  FileIcon,
  SendIcon,
  SpinnerIcon,
  WarnIcon,
} from "./icons";
import { Button, IconButton } from "./primitives";
import { tokenize } from "@/lib/husk/linkify";
import { orderedEntries, useRoomStore, type ChatEntry } from "@/lib/husk/store";
import { cn } from "@/lib/utils";
import type { SealedBody } from "@/lib/husk/protocol";

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Enter submits; Shift+Enter is a newline; and Enter that merely commits an
 * IME composition (isComposing, incl. the keyCode-229 path some browsers
 * emit) must never submit the half-converted text.
 */
export function shouldSubmitOnEnter(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean | undefined };
}): boolean {
  return event.key === "Enter" && !event.shiftKey && event.nativeEvent.isComposing !== true;
}

function MessageText({ text }: { readonly text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
      {tokenize(text).map((token, index) =>
        token.kind === "link" ? (
          <a
            key={index}
            href={token.href}
            rel="noopener noreferrer"
            target="_blank"
            className="underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {token.value}
          </a>
        ) : (
          <span key={index}>{token.value}</span>
        ),
      )}
    </p>
  );
}

/** Exported for the XSS-in-filename render contract test. */
export function FileCard({
  body,
  onDownload,
}: {
  readonly body: Extract<SealedBody, { kind: "file" }>;
  readonly onDownload: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  return (
    <div className="file-card w-56 rounded-lg border border-line bg-surface-sunken/50 p-3 sm:w-64">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10">
          <FileIcon className="text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{body.name}</p>
          <p className="text-caption text-ink-muted">
            {formatSize(body.size)}
            {failed ? " · download failed" : ""}
          </p>
        </div>
        <IconButton
          label={failed ? "Retry download" : "Download file"}
          onClick={() => {
            setFailed(false);
            setProgress(0);
            void onDownload()
              .then(() => setProgress(1))
              .catch(() => {
                setFailed(true);
                setProgress(null);
              });
          }}
        >
          {progress !== null && progress < 1 ? (
            <SpinnerIcon className="h-4 w-4" />
          ) : (
            <DownloadIcon />
          )}
        </IconButton>
      </div>
      {progress !== null && progress < 1 ? <div className="upload-bar mt-2" aria-hidden /> : null}
    </div>
  );
}

function EntryBody({
  body,
  onDownload,
}: {
  readonly body: SealedBody | null;
  readonly onDownload: (body: Extract<SealedBody, { kind: "file" }>) => Promise<void>;
}) {
  if (body === null) {
    return null;
  }
  if (body.kind === "text") {
    return <MessageText text={body.text} />;
  }
  return <FileCard body={body} onDownload={() => onDownload(body)} />;
}

function DeliveryNote({
  entry,
  onRetry,
}: {
  readonly entry: ChatEntry;
  readonly onRetry: (id: string) => void;
}) {
  if (entry.delivery === "sending") {
    return (
      <span className="flex items-center gap-1.5 text-caption text-ink-faint">
        <SpinnerIcon className="h-3 w-3" />
        Sending
      </span>
    );
  }
  if (entry.delivery === "failed") {
    return (
      <span className="flex items-center gap-1.5 text-caption text-danger">
        <WarnIcon className="h-3 w-3" />
        Not sent
        <button
          type="button"
          onClick={() => onRetry(entry.id)}
          className="touch-target rounded-xs underline underline-offset-2 hover:decoration-current"
        >
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-caption text-ink-faint">
      <CheckIcon className="h-3 w-3 text-ok" />
      {formatTime(entry.ts)}
    </span>
  );
}
const MessageItem = memo(function MessageItem({
  entry,
  onDownload,
  onRetry,
}: {
  readonly entry: ChatEntry;
  readonly onDownload: (body: Extract<SealedBody, { kind: "file" }>) => Promise<void>;
  readonly onRetry: (id: string) => void;
}) {
  if (entry.system !== undefined) {
    return (
      <div className="system-marker px-2 text-center text-caption" role="note">
        <span className="shrink-0">{entry.system}</span>
        <span className="ml-2 text-[11px] text-ink-faint/60">{formatTime(entry.ts)}</span>
      </div>
    );
  }
  if (entry.delivery === "unverified") {
    return (
      <div className="system-marker px-2 text-center text-caption text-warn" role="note">
        <WarnIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">A message could not be verified and was discarded.</span>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1", entry.mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "bubble max-w-[90%] px-4 py-3 sm:max-w-[70%]",
          entry.mine ? "bubble-mine text-ink" : "bubble-theirs text-ink",
        )}
      >
        <EntryBody body={entry.body} onDownload={onDownload} />
      </div>
      <DeliveryNote entry={entry} onRetry={onRetry} />
    </div>
  );
});

/** Below this distance from the bottom, new messages keep the view pinned. */
const NEAR_BOTTOM_PX = 120;

export function MessageList({
  onDownload,
}: {
  readonly onDownload: (body: Extract<SealedBody, { kind: "file" }>) => Promise<void>;
}) {
  const entries = useRoomStore((store) => store.entries);
  const state = useRoomStore((store) => store.state);
  const participants = useRoomStore((store) => store.participants);
  const retryMessage = useRoomStore((store) => store.retryMessage);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const ordered = orderedEntries(entries);

  function handleScroll(): void {
    const el = containerRef.current;
    if (el !== null) {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    }
  }

  useEffect(() => {
    // Reading history must not be yanked to the bottom by a peer's message.
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [entries.length]);

  const handleRetry = useCallback(
    (id: string) => {
      void retryMessage(id);
    },
    [retryMessage],
  );

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="relative flex flex-1 flex-col overflow-y-auto px-4 py-2 sm:px-6"
    >
      {ordered.length === 0 ? (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 py-6 px-4 text-center">
          <img
            src="/icons/husk-mark.svg"
            alt="Husk"
            width={56}
            height={64}
            className="mx-auto h-14 w-auto drop-shadow-[0_4px_16px_rgba(60,231,103,0.3)] select-none transition-transform duration-300 hover:scale-105"
          />
          <div>
            <p className="text-[17px] font-semibold text-ink">
              {state === "waiting_for_peer" ? "Waiting for someone to join" : "No messages yet"}
            </p>
            <p className="mt-1 text-[13px] text-ink-muted">
              Messages are encrypted in this browser before they leave it.
            </p>
          </div>
        </div>
      ) : (
        <div className="relative z-10 space-y-4 py-3">
          {/* Subtle persistent background watermark when messages are active */}
          <div
            className="pointer-events-none fixed inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-center select-none"
            aria-hidden="true"
          >
            <img
              src="/icons/husk-mark.svg"
              alt=""
              width={140}
              height={160}
              className="h-36 w-auto opacity-[0.06] drop-shadow-[0_8px_32px_rgba(60,231,103,0.15)]"
            />
          </div>
          {ordered.map((entry) => (
            <MessageItem key={entry.id} entry={entry} onDownload={onDownload} onRetry={handleRetry} />
          ))}
          {state === "waiting_for_peer" && participants.length <= 1 ? (
            <p className="pt-2 text-center text-caption text-ink-faint">
              Nobody else is here yet — share the invite link above.
            </p>
          ) : null}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
const MAX_TEXTAREA_HEIGHT = 5 * 28 + 20; // ~5 lines

export function Composer({
  onSendFile,
  disabled,
}: {
  readonly onSendFile: (file: File) => Promise<void>;
  readonly disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const sendText = useRoomStore((store) => store.sendText);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function autoGrow(): void {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    }
  }

  async function submit() {
    if (draft.trim().length === 0) {
      return;
    }
    const value = draft;
    setDraft("");
    requestAnimationFrame(autoGrow);
    await sendText(value);
  }

  function send(file: File): void {
    setBusy(true);
    setFailedFile(null);
    void onSendFile(file)
      .then(() => setFailedFile(null))
      .catch(() => {
        setFailedFile(file);
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="composer-bar safe-bottom px-4 pt-2 pb-2 sm:px-6">
      {busy ? (
        <div className="upload-bar mb-2" role="status" aria-label="Encrypting and uploading file" />
      ) : null}
      {failedFile !== null ? (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-danger/10">
            <FileIcon className="text-danger" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-medium text-ink">{failedFile.name}</p>
            <p className="text-caption text-danger">Upload failed · not sent</p>
          </div>
          <Button
            tone="quiet"
            disabled={busy}
            onClick={() => send(failedFile)}
            aria-label="Retry file upload"
          >
            Retry
          </Button>
          <IconButton label="Discard failed upload" onClick={() => setFailedFile(null)}>
            <DeleteIcon className="text-ink-muted" />
          </IconButton>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          aria-label="File to send"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file === undefined) {
              return;
            }
            send(file);
          }}
        />
        <IconButton
          label="Attach a file"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-xl"
        >
          <AttachIcon />
        </IconButton>
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          rows={1}
          placeholder="Write a message…"
          aria-label="Message"
          onChange={(event) => {
            setDraft(event.target.value);
            autoGrow();
          }}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          className="composer-input max-h-[160px] min-h-[44px] flex-1 resize-none rounded-xl border border-line/50 bg-surface-sunken/50 px-4 py-2.5 text-[15px] text-ink transition-all placeholder:text-ink-faint"
        />
        <Button
          onClick={() => void submit()}
          disabled={disabled || draft.trim().length === 0}
          aria-label="Send message"
          className="shrink-0 h-11 px-4 rounded-xl font-medium"
        >
          <SendIcon />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>
      <p className="pt-1.5 pb-0 text-center text-[11px] text-ink-faint/50">
        {busy ? "Encrypting and uploading file…" : "Enter to send · Shift + Enter for new line"}
      </p>
    </div>
  );
}
