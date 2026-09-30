/**
 * The pairing screen: one branch per role, and one status line per pairing
 * state.
 *
 * WHY the code is a readout and not another label: the displayer's job is to
 * hold a device where the other person can read eight characters off it, so it
 * has to be large, monospaced and character-spaced. The copy button exists
 * because reading eight characters aloud across a room is the failure mode this
 * whole feature is designed around — but a clipboard can be refused, so the
 * code also falls back to a selectable field, which is something the user can
 * still act on when there is no clipboard at all.
 *
 * The pairing state is switched on exhaustively. A new `PairingState` kind is a
 * compile error here rather than a blank screen with a heading on it, because
 * the five states are five different facts about a handshake in progress and
 * none of them can honestly borrow another's sentence.
 *
 * WHY the code readout is its own named group: it was labelled by the panel's
 * own heading, so its accessible name was the same string as the region around
 * it and the eight characters were announced with nothing saying what they are.
 * `codeLabel` is the sentence that says it, and it is the same one the
 * clipboard-refused fallback input carries.
 */

import { useEffect, useId, useState, type ReactElement } from "react";
import { CheckIcon, ErrorMark, WaitingMark } from "@/components/husk/icons";
import { Button, Panel } from "@/components/husk/primitives";
import { PAIRING_CONFIRMATION_COPY, SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import type { PairingState } from "@/lib/sound-chat/pairing";

export function PairingPanel({
  role,
  code,
  state,
  failure,
  busy,
  onRetry,
  onSwitchRole,
}: {
  readonly role: "displayer" | "enterer";
  readonly code: string | null;
  readonly state: PairingState;
  readonly failure: string | null;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onSwitchRole: () => void;
}): ReactElement {
  const headingId = useId();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(): Promise<void> {
    if (code === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setManual(false);
    } catch {
      // A refused clipboard is a real failure mode, not an edge case: the field
      // below is the way through, so nothing has to be explained here.
      setManual(true);
    }
  }

  /**
   * One line per state. Called as a function rather than rendered as a nested
   * component so the region keeps its identity (and its announcement) when the
   * state changes.
   */
  function status(): ReactElement | null {
    switch (state.kind) {
      case "idle":
        // Nothing is on the air yet — the stack is still coming up, and the
        // heading above already says what is about to happen.
        return null;
      case "waiting-for-peer":
      case "awaiting-confirmation":
        return (
          <div role="status" className="fade-in mt-6 flex flex-col items-center text-center">
            <WaitingMark className="waiting-glow h-24 w-24 text-accent" />
            <p className="mt-2 text-body text-ink">
              {state.kind === "waiting-for-peer"
                ? SOUND_CHAT_COPY.pairing.waitingDisplay
                : SOUND_CHAT_COPY.pairing.waitingEnter}
            </p>
            <p className="mt-1 text-caption text-ink-muted">{SOUND_CHAT_COPY.pairing.hint}</p>
          </div>
        );
      case "paired":
        return (
          <p
            role="status"
            className="fade-in mt-6 flex items-start gap-2.5 rounded-xl border border-line bg-surface-sunken p-4 text-caption text-ok"
          >
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{PAIRING_CONFIRMATION_COPY}</span>
          </p>
        );
      case "failed":
        return (
          <div
            role="alert"
            className="fade-in mt-6 rounded-xl border border-danger/30 bg-danger/5 p-4"
          >
            <p className="flex items-start gap-2.5 text-body text-danger">
              <ErrorMark className="h-8 w-8 shrink-0" />
              <span className="min-w-0">
                {failure ?? SOUND_CHAT_COPY.pairingFailure(state.reason)}
              </span>
            </p>
            <div className="mt-4 space-y-2">
              <Button tone="primary" full loading={busy} onClick={onRetry}>
                {SOUND_CHAT_COPY.pairing.retry}
              </Button>
              <Button tone="quiet" full disabled={busy} onClick={onSwitchRole}>
                {SOUND_CHAT_COPY.pairing.changeRole}
              </Button>
            </div>
          </div>
        );
      default: {
        // A kind with no line here is a missing sentence, not a fallback.
        const unreached: never = state;
        return unreached;
      }
    }
  }

  return (
    <section aria-labelledby={headingId} className="enter w-full">
      <Panel className="fade-in mx-auto max-w-xl">
        <p className="text-caption font-medium uppercase tracking-widest text-ink-muted">
          {SOUND_CHAT_COPY.pairing.roleLabel[role]}
        </p>
        <h2 id={headingId} className="mt-2 text-title text-ink">
          {role === "displayer"
            ? SOUND_CHAT_COPY.pairing.displayHeading
            : SOUND_CHAT_COPY.pairing.enterHeading}
        </h2>
        <p className="mt-2 text-body text-ink-muted">
          {role === "displayer"
            ? SOUND_CHAT_COPY.pairing.displayBody
            : SOUND_CHAT_COPY.pairing.enterBody}
        </p>
        {role === "displayer" && code !== null ? (
          <>
            <div
              role="group"
              aria-label={SOUND_CHAT_COPY.pairing.codeLabel}
              className="mt-6 rounded-xl border border-line-strong bg-surface-sunken p-6"
            >
              {manual ? (
                <input
                  readOnly
                  value={code}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label={SOUND_CHAT_COPY.pairing.codeLabel}
                  className="composer-input w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-center font-mono text-title text-ink"
                />
              ) : (
                <p className="tabular text-center font-mono text-display tracking-widest text-ink">
                  {code}
                </p>
              )}
            </div>
            {manual ? (
              <p className="mt-2 text-caption text-warn">{SOUND_CHAT_COPY.pairing.copyRefused}</p>
            ) : null}
            <Button tone="quiet" full disabled={busy} onClick={() => void copy()} className="mt-3">
              {copied ? <CheckIcon className="h-4 w-4 text-ok" /> : null}
              {copied ? SOUND_CHAT_COPY.pairing.copiedAction : SOUND_CHAT_COPY.pairing.copyAction}
            </Button>
          </>
        ) : null}
        {status()}
      </Panel>
    </section>
  );
}
