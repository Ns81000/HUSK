/**
 * The Sound Chat screen: one switch over six phases, and the shell they share.
 *
 * WHY a switch and not a set of conditionally-rendered panels: the phases are
 * mutually exclusive by construction — there is no honest state in which the
 * composer and the microphone pre-prompt are both on screen — and a switch makes
 * that structural, so a future phase cannot be added "alongside" an existing one
 * by accident.
 *
 * WHY the restart affordance is a confirm dialog inside the fatal panel rather
 * than a banner: restarting ends the session, releases the microphone and
 * discards anything in flight while keeping the pairing code, and that is a
 * trade the user should be asked about. It reuses the app's own `Modal`, so it
 * inherits the focus trap and the Escape behaviour the rest of Husk already has.
 *
 * WHY leaving is a plain anchor rather than a router `Link`: this route's chunk
 * is fetched on demand, and a `Link` would make that chunk statically import
 * `@tanstack/react-router`, which the bundler then hoists into the entry along
 * with the whole `/r/$roomId` route chunk. Measured: the entry was 371.87 kB /
 * 116.51 kB gzip with the router link, and 307.78 kB / 94.81 kB gzip without it
 * (307779 B raw, `index-vs4XZW65.js`, node zlib level 9), against a 307.00 kB /
 * 95.75 kB baseline. The baseline's gzip figure came from a different tool,
 * which is why the two are not directly comparable; the raw byte counts are.
 * A full navigation is also the more honest teardown: it guarantees the
 * AudioContext and the microphone tracks are released by the browser rather
 * than kept alive behind a cached route.
 */

import { useState, type ReactElement } from "react";
import { BackIcon } from "@/components/husk/icons";
import { Button, Modal } from "@/components/husk/primitives";
import { BlockedPanel } from "./blocked-panel";
import { Composer } from "./composer";
import { FatalPanel } from "./fatal-panel";
import { InfoPanel } from "./info-panel";
import { MessageList } from "./message-list";
import { PairingPanel } from "./pairing-panel";
import { PermissionPrompt } from "./permission-prompt";
import { TransmitStatus } from "./transmit-status";
import { useSoundChat, type SoundChatUi } from "./use-sound-chat";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

export function SoundChatScreen(): ReactElement {
  const ui = useSoundChat();

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <Header />
      <main className="flex flex-1 flex-col">{renderPhase(ui)}</main>
      <InfoPanel open={ui.infoOpen} onToggle={ui.toggleInfo} stats={ui.state.stats} />
    </div>
  );
}

function renderPhase(ui: SoundChatUi): ReactElement {
  const { state } = ui;
  switch (state.phase) {
    case "permission":
      return (
        <PermissionPrompt
          onDisplay={() => ui.begin("displayer")}
          onEnter={(code) => ui.begin("enterer", code)}
          onDismiss={() => void navigateHome()}
        />
      );
    case "preparing":
      return <PreparingNotice />;
    case "pairing":
      return (
        <PairingPanel
          role={state.role ?? "displayer"}
          code={state.code}
          state={state.pairing}
          failure={state.pairingFailure}
          busy={false}
          onRetry={() => ui.begin(state.role ?? "displayer", state.code ?? undefined)}
          onSwitchRole={ui.cancel}
        />
      );
    case "chat":
      return (
        <>
          <div className="px-4 pt-3 sm:px-6">
            <TransmitStatus
              transport={state.transport}
              transmitting={state.transmitting}
              progress={state.progress}
              attempts={state.outbound.at(-1)?.attempts ?? 0}
            />
            <NoticeList notices={state.notices} onDismiss={ui.dismissNotices} />
            <EndSessionButton onConfirm={ui.cancel} />
          </div>
          <MessageList inbound={state.inbound} outbound={state.outbound} />
          <Composer
            value={ui.draft}
            onChange={ui.setDraft}
            onSubmit={ui.submit}
            disabled={ui.composerBlock !== null}
            disabledReason={ui.composerBlock}
            refusal={ui.refusal}
          />
        </>
      );
    case "blocked":
      return (
        <BlockedPanel
          block={state.block ?? { kind: "audio-unavailable", detail: "" }}
          onRetry={() => retry(ui)}
          onBack={ui.cancel}
        />
      );
    case "fatal":
      return (
        <FatalPanel
          fatal={state.fatal ?? { kind: "codec-died", detail: "" }}
          onRestart={ui.restart}
        />
      );
    default:
      // `SoundChatUiState` is one object type with a union-typed `phase`, so the
      // switch narrows the discriminant rather than the object. Passing the
      // discriminant is what makes a phase added later a compile error here.
      return breakNever(state.phase);
  }
}

/**
 * A retry after a start-up failure re-runs the same choice, which is the only
 * thing that can have changed (the permission grant, the device, the code). It
 * deliberately does *not* go through `session.restart()`: that method refuses a
 * healthy session outright rather than reporting a success it cannot deliver,
 * and the honest recovery is a full teardown followed by a new one — which
 * `begin` is.
 *
 * WHY the enterer's code is reused rather than discarded. This used to call
 * `cancel()` for any enterer, which threw away a code the person had typed and
 * sent the control's own copy ("... then try again") to a screen that could not
 * retry anything. The controller keeps the code across a failure that is not
 * about it — a refused microphone says nothing about a pairing code — so the
 * retry is now a real second attempt with the same code.
 *
 * The one case it cannot help is a code the protocol itself refused: that code
 * is deliberately cleared from the published state, so there is nothing honest
 * to re-run, and the code field is the only place it can be corrected.
 */
function retry(ui: SoundChatUi): void {
  const { role, code } = ui.state;
  if (role === null) {
    // Nothing was chosen yet, so there is no attempt to repeat.
    ui.cancel();
    return;
  }
  if (role === "enterer" && code === null) {
    ui.cancel();
    return;
  }
  ui.begin(role, code ?? undefined);
}

/**
 * The window between choosing a role and the session existing. It has to be a
 * real screen rather than a blank frame: microphone permission, a 48000 Hz
 * context and 600000 PBKDF2 iterations all take time, and a blank frame looks
 * broken.
 */
function PreparingNotice(): ReactElement {
  return (
    <div className="enter flex flex-1 items-center justify-center px-6" role="status">
      <p className="text-body text-ink-muted">{SOUND_CHAT_COPY.shell.preparing}</p>
    </div>
  );
}

/**
 * The in-app way out of a live session.
 *
 * WHY this exists at all when the header already has a "Back to Husk" anchor:
 * the anchor leaves Sound Chat entirely, but the situation it cannot serve is
 * pairing with the *wrong device* and wanting to try again inside this feature.
 * Without a control here, `renderPhase` wired `cancel()` only into the blocked
 * and pairing panels, so from `chat` the sole in-app transition was a codec
 * death. That is a UX gap rather than a dead end (the header anchor was always
 * there), but it is the gap a person hits the first time they mistype a code on
 * the other side.
 *
 * WHY it is behind a confirmation, like the restart: it is the same three
 * consequences — the session ends, the microphone is released, the transcript is
 * cleared — and it can be pressed while a note is still on the air. Reusing the
 * app's own `Modal` inherits the focus trap and Escape behaviour the rest of
 * Husk already has, rather than inventing a second dialog.
 *
 * WHY it is a quiet button at the end of the status block and not in the header:
 * ending a session is not navigation. The header's control gets you out of
 * Sound Chat; this one gets you back to the start of it.
 */
function EndSessionButton({ onConfirm }: { readonly onConfirm: () => void }): ReactElement {
  const [confirming, setConfirming] = useState(false);
  return (
    // A sibling of nothing live: the dialog is never nested inside a live region,
    // for the same reason the restart dialog is not nested inside its `role="alert"`.
    <>
      <div className="mt-2 flex justify-end">
        <Button
          tone="quiet"
          onClick={() => setConfirming(true)}
          aria-label={SOUND_CHAT_COPY.actions.leave}
          className="h-9 px-3 text-caption"
        >
          <BackIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {SOUND_CHAT_COPY.actions.leave}
        </Button>
      </div>
      <Modal
        open={confirming}
        title={SOUND_CHAT_COPY.modal.leaveTitle}
        description={SOUND_CHAT_COPY.modal.leaveDescription}
        confirmLabel={SOUND_CHAT_COPY.modal.leaveConfirm}
        onConfirm={() => {
          setConfirming(false);
          onConfirm();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Diagnostics from the session, with a control to clear them.
 *
 * Without the control the list would be permanent: a warning that the session
 * recovered from one of its own errors is worth reading, but not for the rest of
 * the session, and a list nothing can empty becomes the only thing on screen.
 * Deliberately not a live region — these are for reading on demand, and the
 * events that produce them are announced where they happen.
 */
function NoticeList({
  notices,
  onDismiss,
}: {
  readonly notices: readonly {
    readonly id: number;
    readonly tone: string;
    readonly text: string;
  }[];
  readonly onDismiss: () => void;
}): ReactElement | null {
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="mt-3">
      <ul className="space-y-1.5" aria-label={SOUND_CHAT_COPY.shell.noticesLabel}>
        {notices.map((notice) => (
          <li
            key={notice.id}
            className={
              notice.tone === "danger"
                ? "text-caption text-danger"
                : notice.tone === "warn"
                  ? "text-caption text-warn"
                  : "text-caption text-ink-muted"
            }
          >
            {notice.text}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onDismiss}
        className="press mt-1.5 text-caption text-ink-muted underline underline-offset-2 hover:text-ink"
      >
        {SOUND_CHAT_COPY.actions.dismissNotices}
      </button>
    </div>
  );
}

function Header(): ReactElement {
  return (
    <header className="chat-header safe-top px-4 pb-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
        <h1 className="text-title text-ink">{SOUND_CHAT_COPY.shell.title}</h1>
        <a
          href="/"
          className="touch-target press btn-tactile-quiet inline-flex h-10 items-center gap-2 rounded-xl px-4 text-caption font-medium"
        >
          <BackIcon className="h-4 w-4" />
          {SOUND_CHAT_COPY.actions.exit}
        </a>
      </div>
    </header>
  );
}

/**
 * The exit path for the "Not now" button, which is a real `<button>` so it can
 * stay disabled and focusable while the stack is coming up. A full navigation
 * rather than a router call, for the same reason as the anchor above: the browser
 * destroys the session instead of leaving a live AudioContext and a held
 * microphone behind a cached route.
 */
function navigateHome(): void {
  if (typeof window !== "undefined") window.location.assign("/");
}

function breakNever(value: never): ReactElement {
  throw new Error(`Sound Chat UI reached an unknown phase: ${JSON.stringify(value)}`);
}
