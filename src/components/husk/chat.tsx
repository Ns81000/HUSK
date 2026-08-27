/** Message list, message composer and file cards. */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AttachIcon, DeleteIcon, DownloadIcon, FileIcon, SendIcon, WaitingMark } from "./icons";
import { Button, IconButton, useToast } from "./primitives";
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
    <p className="whitespace-pre-wrap break-words text-[15px]">
      {tokenize(text).map((token, index) =>
        token.kind === "link" ? (
          <a
            key={index}
            href={token.href}
            rel="noopener noreferrer"
            target="_blank"
            className="underline decoration-line-strong underline-offset-2 hover:decoration-current"
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
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface-raised p-3">
      <FileIcon className="shrink-0 text-ink-muted" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-ink">{body.name}</p>
        <p className="text-caption text-ink-muted">
          {formatSize(body.size)}
          {progress !== null && progress < 1 ? ` · ${Math.round(progress * 100)}%` : ""}
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
        <DownloadIcon />
      </IconButton>
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
    return <span className="text-caption text-ink-faint">Sending</span>;
  }
  if (entry.delivery === "failed") {
    return (
      <span className="flex items-center gap-2 text-caption text-danger">
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
  return <span className="text-caption text-ink-faint">{formatTime(entry.ts)}</span>;
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
    return <p className="text-center text-caption text-ink-faint">{entry.system}</p>;
  }
  if (entry.delivery === "unverified") {
    return (
      <p className="text-center text-caption text-warn">
        A message could not be verified and was discarded.
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1", entry.mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg border px-4 py-3 sm:max-w-[70%]",
          entry.mine
            ? "border-accent bg-accent text-accent-ink"
            : "border-line bg-surface text-ink",
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

  if (ordered.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <WaitingMark className="text-line-strong" />
        <div>
          <p className="text-title text-ink">
            {state === "waiting_for_peer" ? "Waiting for someone to join" : "No messages yet"}
          </p>
          <p className="mt-1 text-[14px] text-ink-muted">
            Messages are encrypted in this browser before they leave it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 space-y-3 overflow-y-auto px-4 py-6 sm:px-6"
    >
      {ordered.map((entry) => (
        <MessageItem key={entry.id} entry={entry} onDownload={onDownload} onRetry={handleRetry} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

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
  const notify = useToast();

  async function submit() {
    if (draft.trim().length === 0) {
      return;
    }
    const value = draft;
    setDraft("");
    await sendText(value);
  }

  function send(file: File): void {
    setBusy(true);
    setFailedFile(null);
    void onSendFile(file)
      .then(() => setFailedFile(null))
      .catch(() => {
        setFailedFile(file);
        notify("File could not be sent.", "danger");
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="safe-bottom border-t border-line bg-surface px-4 pt-3 sm:px-6">
      {failedFile !== null ? (
        <div className="mb-2 flex items-center gap-3 rounded-md border border-danger bg-surface-raised p-3">
          <FileIcon className="shrink-0 text-ink-muted" />
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
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          className="sr-only"
          aria-label="File to send"
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
          className="border border-line"
        >
          <AttachIcon />
        </IconButton>
        <textarea
          value={draft}
          disabled={disabled}
          rows={1}
          placeholder="Write a message"
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          className="max-h-40 min-h-touch flex-1 resize-none rounded-md border border-line bg-surface-raised px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-faint"
        />
        <Button
          onClick={() => void submit()}
          disabled={disabled || draft.trim().length === 0}
          aria-label="Send message"
        >
          <SendIcon />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>
      <p className="pb-2 pt-2 text-caption text-ink-faint">
        {busy ? "Encrypting and uploading file" : "Enter to send, Shift plus Enter for a new line"}
      </p>
    </div>
  );
}
