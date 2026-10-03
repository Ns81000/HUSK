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
 *
 * WHY the header is now a function of the phase rather than a constant. It used
 * to be "Sound Chat" on the left and "Back to Husk" on the right of every screen,
 * which is the reverse of every other app's header and of this one's own chat
 * screen. Back is now on the left, the title is beside it, and the right-hand slot
 * carries the info control when there is a session to describe. On the pre-prompt
 * at `lg` there is no header at all: that screen draws its own brand column and
 * its own back control, and a second title bar over a screen that already has one
 * is one more thing to read.
 *
 * WHY the transport sentence and the progress bar are in two places. The sentence
 * is what the main chat puts in its header beside the title, and it is the only
 * part of the block worth interrupting for. The bar moves ten times a second and
 * belongs under the header, where it can be a hairline instead of a card's worth
 * of vertical space above the transcript. `TransmitProgress` renders nothing at
 * all when nothing is on the air and its row is `empty:hidden`, so a quiet
 * channel costs zero pixels rather than a paragraph.
 */

import { useEffect, useState, type ReactElement } from "react";
import { Drawer } from "vaul";
import { BackIcon, InfoIcon } from "@/components/husk/icons";
import { IconButton } from "@/components/husk/primitives";
import { BlockedPanel } from "./blocked-panel";
import { Composer } from "./composer";
import { FatalPanel } from "./fatal-panel";
import { InfoPanel } from "./info-panel";
import { MessageList } from "./message-list";
import { PairingPanel } from "./pairing-panel";
import { PermissionPrompt } from "./permission-prompt";
import { TransmitProgress, TransportStatusLine } from "./transmit-status";
import { useSoundChat, type SoundChatUi } from "./use-sound-chat";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

export function SoundChatScreen(): ReactElement {
  const ui = useSoundChat();
  const isDesktop = useIsDesktop();
  // The pre-prompt owns the whole viewport at `lg`: it draws its own brand column
  // and its own back control. Below `lg` it is a single column with no navigation
  // of its own, so the shell's header stays and is the way out.
  const headerless = isDesktop && ui.state.phase === "permission";
  const inChat = ui.state.phase === "chat";

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {headerless ? null : (
        <Header
          transport={inChat ? ui.state.transport : null}
          attempts={attemptsOnAir(ui)}
          infoOpen={ui.infoOpen}
          onToggleInfo={inChat ? ui.toggleInfo : undefined}
        />
      )}
      <main className="flex flex-1 flex-col">{renderPhase(ui)}</main>
      <InfoDrawer ui={ui} isDesktop={isDesktop} />
    </div>
  );
}

/**
 * The transport block reports progress for *one* note: whichever is on the air.
 * Taking the newest row instead meant a queue of four showed the wrong attempt
 * count while an earlier note was being retried — measured: "attempt 1 of 3" for
 * a note on its second try, because the newest row had never been transmitted at
 * all. The rows themselves read their own status, so only this unattributed line
 * was wrong.
 */
function attemptsOnAir(ui: SoundChatUi): number {
  const onAir = ui.state.outbound.find((row) => row.status === "sending");
  if (onAir !== undefined) return onAir.attempts;
  for (let index = ui.state.outbound.length - 1; index >= 0; index -= 1) {
    const row = ui.state.outbound[index];
    if (row !== undefined && row.attempts > 0) return row.attempts;
  }
  return 0;
}

/**
 * The shell's title bar.
 *
 * The exit control is an icon with `sr-only` text rather than an icon with an
 * `aria-label`: the accessible name is the same either way, but the text keeps
 * the visible control an icon while the name stays part of the document.
 *
 * The right-hand slot is empty on every phase with no session to describe, which
 * is why the info control is opt-in rather than always rendered.
 */
function Header({
  transport,
  attempts,
  infoOpen,
  onToggleInfo,
}: {
  readonly transport: TransportState | null;
  readonly attempts: number;
  readonly infoOpen: boolean;
  readonly onToggleInfo?: (() => void) | undefined;
}): ReactElement {
  return (
    <header className="chat-header safe-top px-4 pb-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
        <a
          href="/"
          className="press -ml-1 flex shrink-0 items-center justify-center rounded-xl p-2 text-ink-muted transition-colors hover:text-ink"
        >
          <BackIcon className="h-5 w-5" />
          <span className="sr-only">{SOUND_CHAT_COPY.actions.exit}</span>
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-ink">{SOUND_CHAT_COPY.shell.title}</h1>
          {transport === null ? null : (
            <TransportStatusLine transport={transport} attempts={attempts} />
          )}
        </div>
        {onToggleInfo === undefined ? null : (
          <IconButton
            label={SOUND_CHAT_COPY.info.heading}
            aria-expanded={infoOpen}
            onClick={onToggleInfo}
          >
            <InfoIcon className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </header>
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
        />
      );
    case "preparing":
      return <PreparingNotice />;
    case "pairing":
      return (
        <Centered>
          <PairingPanel
            role={state.role ?? "displayer"}
            code={state.code}
            state={state.pairing}
            failure={state.pairingFailure}
            busy={false}
            onRetry={() => ui.begin(state.role ?? "displayer", state.code ?? undefined)}
            onSwitchRole={ui.cancel}
          />
        </Centered>
      );
    case "chat":
      return (
        <>
          {/* The persistent watermark, the same mark at the same opacity the main
              chat paints behind an active transcript.

              WHY it lives here and not in `MessageList`: that component's own
              suite renders a note containing `<img src=x onerror=…>` and asserts
              the *raw* markup it produces contains no `<img` at all — the check
              that proves a note cannot become markup. One decorative image inside
              it would make that assertion false for every transcript, which is
              the worst possible trade for a background. The shell is also where
              the main chat keeps its own, so the decoration sits at the same
              layer in both features. */}
          {state.inbound.length + state.outbound.length > 0 ? (
            <div
              className="pointer-events-none fixed inset-x-0 top-1/2 flex -translate-y-1/2 items-center justify-center select-none"
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
          ) : null}
          {/* The bar, in its own row under the header rather than inside the
              transcript. `empty:hidden` is what makes a quiet channel free: when
              nothing is on the air `TransmitProgress` renders no nodes at all, so
              the row is `:empty` and costs neither height nor padding. Writing the
              condition a second time here would be a second place to keep right. */}
          <div className="px-4 pt-3 empty:hidden sm:px-6">
            <TransmitProgress
              transport={state.transport}
              transmitting={state.transmitting}
              progress={state.progress}
            />
          </div>
          {/* The notices are facts about the room, not about the transcript, so
              they sit above it instead of scrolling with it. The region has to be
              mounted even when it is empty, and an always-present margin would
              push the transcript down for the whole session — so the padding is
              conditional and the region is not. */}
          <div className={state.notices.length > 0 ? "px-4 pt-2 sm:px-6" : undefined}>
            <NoticeList notices={state.notices} onDismiss={ui.dismissNotices} />
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
        <Centered>
          <BlockedPanel
            block={state.block ?? { kind: "audio-unavailable", detail: "" }}
            onRetry={() => retry(ui)}
            onBack={ui.cancel}
          />
        </Centered>
      );
    case "fatal":
      return (
        <Centered>
          <FatalPanel
            fatal={state.fatal ?? { kind: "codec-died", detail: "" }}
            onRestart={ui.restart}
          />
        </Centered>
      );
    default:
      // `SoundChatUiState` is one object type with a union-typed `phase`, so the
      // switch narrows the discriminant rather than the object. Passing the
      // discriminant is what makes a phase added later a compile error here.
      return breakNever(state.phase);
  }
}

/**
 * Centres a panel in the space the header and the composer leave it.
 *
 * WHY: the failure panels and the pairing panel are narrow cards, and in a plain
 * `flex-1` column they sat against the top edge with the whole rest of the screen
 * empty underneath — the layout said "there is more above you" about a screen with
 * nothing above it.
 */
function Centered({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">{children}</div>
  );
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
 * Diagnostics from the session, with a control to clear them.
 *
 * Without the control the list would be permanent: a warning that the session
 * recovered from one of its own errors is worth reading, but not for the rest of
 * the session, and a list nothing can empty becomes the only thing on screen.
 *
 * A polite live region, and not only "for reading on demand". The claim that the
 * events behind these are announced where they happen is true for a listener
 * error but false for "a transmission was heard, but this pairing code cannot
 * read it": `HEARD_UNREADABLE` changes no transport state and has no sentence of
 * its own, so that notice used to appear silently — measured, the announced
 * status line was byte-identical before and after. It is the one notice that
 * reports a fact about the room, and it is exactly the one a person would not
 * notice arriving.
 *
 * PHASE 5 CORRECTION TO THAT FIX. Adding the attributes was necessary but not
 * sufficient: this function used to `return null` when the list was empty, so the
 * region and its first `<li>` entered the document in the same commit. That is an
 * *insertion*, and an insertion into a region that did not exist is not reliably
 * announced at all — which is why the first notice of a session, and the first
 * notice after every dismissal (dismissing unmounts the region), were still
 * silent: the defect Phase 4 set out to close was only closed from the second
 * notice onward. `MessageList` in this same directory documents the rule this
 * was breaking, and follows it. So the region is now mounted from the first frame
 * and the empty state lives inside it, exactly as there. The dismiss control is
 * inside the region too, so an empty list renders no visible control.
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
}): ReactElement {
  return (
    <ul
      className="space-y-1.5"
      aria-label={SOUND_CHAT_COPY.shell.noticesLabel}
      role="status"
      aria-live="polite"
    >
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
      {notices.length > 0 ? (
        <li>
          <button
            type="button"
            onClick={onDismiss}
            className="press mt-1.5 text-caption text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            {SOUND_CHAT_COPY.actions.dismissNotices}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function breakNever(value: never): ReactElement {
  throw new Error(`Sound Chat UI reached an unknown phase: ${JSON.stringify(value)}`);
}

/**
 * "About Sound Chat", the session counters, and the way out of the session.
 *
 * WHY the header owns the control and this owns the surface: the info disclosure
 * used to be an icon button and a panel rendered at the bottom of the page, below
 * the composer — the last thing on the screen, under everything it explained. The
 * shell puts the control in the header where the main chat keeps its own, and the
 * content in the same two surfaces the main chat uses: a slide-out drawer at `lg`,
 * a bottom sheet below it.
 *
 * WHY there is no scrim click-to-close and no focus trap. This feature's
 * accessibility contract forbids an `onClick` on a layout element and forbids
 * taking focus, so a scrim that closes on click and a trap that holds Tab are both
 * unavailable — the shared `Modal` primitive is the one that does both, and it
 * will not carry arbitrary content. Escape closes the drawer, and the header's own
 * control stays mounted behind it, so there is always a reachable way out; the
 * drawer is a `dialog` and deliberately not `aria-modal`, because claiming
 * modality without trapping focus would be the lie.
 */
function InfoDrawer({
  ui,
  isDesktop,
}: {
  readonly ui: SoundChatUi;
  readonly isDesktop: boolean;
}): ReactElement | null {
  const open = ui.state.phase === "chat" && ui.infoOpen;
  const close = ui.toggleInfo;

  // vaul handles Escape on the bottom sheet; this is the desktop drawer's own
  // listener. A window listener rather than a handler on the panel, for the same
  // reason the pre-prompt's disclosure uses one: nothing here takes focus, so
  // Escape has to work from wherever the keyboard already is.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Nothing before there is a session: the counters, the end-session control and
  // the transcript all describe a session that does not exist yet.
  if (ui.state.phase !== "chat") {
    return null;
  }

  const content = <InfoPanel stats={ui.state.stats} onEnd={ui.cancel} />;

  if (isDesktop) {
    return open ? (
      <div className="fixed inset-0 z-40">
        <div className="absolute inset-0 bg-scrim" />
        <aside
          role="dialog"
          aria-label={SOUND_CHAT_COPY.info.heading}
          className="drawer-panel absolute inset-y-0 right-0 flex w-88 max-w-[85vw] flex-col overflow-y-auto border-l border-line/30 p-6 shadow-panel"
        >
          {content}
        </aside>
      </div>
    ) : null;
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        // `toggleInfo` is the only setter the hook exposes, so it is asked to
        // toggle only when the sheet's own state disagrees with it.
        if (next !== open) close();
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] rounded-t-xl border-t border-line/30 p-6 outline-none"
          style={{
            backdropFilter: "blur(24px) saturate(1.4)",
            background: "oklch(0.26 0.034 137 / 0.95)",
          }}
        >
          <div className="mx-auto mb-4 h-1.5 w-12 rounded-pill bg-line-strong/50" aria-hidden />
          <div className="max-h-[calc(85vh-5rem)] overflow-y-auto">{content}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** 1024px matches the `lg` breakpoint the pre-prompt and the room layout use. */
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
