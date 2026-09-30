/**
 * The pre-prompt: the last screen before the browser asks for the microphone.
 *
 * WHY it is a screen of its own rather than a dialog over the chat: a microphone
 * prompt with no explanation is how a page earns a permanent refusal, and a
 * refusal is a dead end the user cannot walk back out of. So every honest limit
 * of the medium — audible in the room, recordable, short, and a key check
 * rather than an identity check — is on screen *before* the browser's own
 * prompt, and the pairing code is the only way past it.
 *
 * It owns two steps so the two branches are mutually exclusive: a role choice
 * and a code field are never on screen together, and Escape from the code step
 * returns to the role choice instead of leaving the page. The typed value is
 * normalised on every keystroke (case and separators are never part of the
 * code) and validated on submit, so a refusal is a named reason attached to the
 * field rather than a handshake that mysteriously fails later. The alphabet is
 * on screen as prose *and* in the field's description, because the one thing a
 * person cannot guess — which letters are left out — is the thing that makes a
 * code they typed correctly fail.
 */

import {
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { ShieldIcon } from "@/components/husk/icons";
import { Button, Panel } from "@/components/husk/primitives";
import {
  PAIRING_CODE_LENGTH,
  normalisePairingCode,
  validatePairingCode,
} from "@/lib/sound-chat/crypto";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

type Step = "role" | "code";

/**
 * Which limits are about what the handshake proves rather than about length or
 * volume. Those two carry the shield; the rest carry a plain dot, because a
 * shield next to a byte count would claim more than the sentence below it.
 */
const PROOF_LIMITS: readonly number[] = [2, 3];

export function PermissionPrompt({
  onDisplay,
  onEnter,
  onDismiss,
}: {
  readonly onDisplay: () => void;
  readonly onEnter: (code: string) => void;
  readonly onDismiss: () => void;
}): ReactElement {
  const [step, setStep] = useState<Step>("role");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();
  const fieldId = useId();
  const problemId = useId();
  const bodyId = useId();

  function toRoleStep(): void {
    setStep("role");
    setProblem(null);
  }

  function type(value: string): void {
    setTyped(normalisePairingCode(value));
    setProblem(null);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const candidate = normalisePairingCode(typed);
    setTyped(candidate);
    try {
      const code = validatePairingCode(candidate);
      setProblem(null);
      onEnter(code);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Escape") {
      return;
    }
    // Escape is "go back", not "leave": there is nothing behind this step but a
    // role choice the user can still change.
    event.stopPropagation();
    toRoleStep();
  }

  return (
    <section aria-labelledby={headingId} className="enter w-full">
      <Panel className="fade-in mx-auto max-w-xl">
        {step === "role" ? (
          <div className="fade-in">
            <h2 id={headingId} className="text-title text-ink">
              {SOUND_CHAT_COPY.permission.title}
            </h2>
            <p className="mt-3 text-body text-ink-muted">{SOUND_CHAT_COPY.permission.lead}</p>
            <p className="mt-3 text-caption text-ink-muted">{SOUND_CHAT_COPY.permission.why}</p>
            <p className="mt-2 text-caption text-ink-muted">
              {SOUND_CHAT_COPY.permission.whyVolume}
            </p>
            <h2 className="mt-6 text-caption font-semibold uppercase tracking-widest text-ink-muted">
              {SOUND_CHAT_COPY.permission.limitsHeading}
            </h2>
            <ul className="mt-3 space-y-2.5">
              {SOUND_CHAT_COPY.permission.limits.map((limit, index) => (
                <li key={limit} className="flex items-start gap-2.5 text-caption text-ink-muted">
                  {PROOF_LIMITS.includes(index) ? (
                    <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                  ) : (
                    <span
                      aria-hidden
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-ink-faint"
                    />
                  )}
                  <span className="min-w-0">{limit}</span>
                </li>
              ))}
            </ul>
            <div className="mt-6 space-y-2">
              <Button tone="primary" full onClick={onDisplay}>
                {SOUND_CHAT_COPY.permission.displayAction}
              </Button>
              <Button tone="quiet" full onClick={() => setStep("code")}>
                {SOUND_CHAT_COPY.permission.enterAction}
              </Button>
              <Button tone="quiet" full onClick={onDismiss}>
                {SOUND_CHAT_COPY.permission.dismiss}
              </Button>
            </div>
          </div>
        ) : (
          <div className="fade-in">
            <h2 id={headingId} className="text-title text-ink">
              {SOUND_CHAT_COPY.pairing.enterHeading}
            </h2>
            <p id={bodyId} className="mt-2 text-body text-ink-muted">
              {SOUND_CHAT_COPY.pairing.enterBody}
            </p>
            <form noValidate onSubmit={submit} onKeyDown={onKeyDown} className="mt-6 space-y-2">
              <label
                htmlFor={fieldId}
                className="block text-caption font-medium uppercase tracking-widest text-ink-muted"
              >
                {SOUND_CHAT_COPY.pairing.fieldLabel}
              </label>
              <input
                id={fieldId}
                name="pairing-code"
                type="text"
                value={typed}
                onChange={(event) => type(event.target.value)}

                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                // A code is single-byte ASCII by definition, so a character limit is
                // exact here — unlike a note, which is counted in UTF-8 bytes and
                // has no such cap on its input. It is twice the code length, not
                // the code length, because `normalisePairingCode` strips spaces
                // and dashes: a pasted "AB CD-2345" is ten characters and eight
                // after normalising, and a limit of eight would cut it to a code
                // the user never typed.
                maxLength={PAIRING_CODE_LENGTH * 2}
                aria-invalid={problem !== null}
                // The rules the field has to satisfy, and the reason the last
                // attempt was refused. Both are prose a person cannot guess, and
                // a screen reader reading the field hears only its value.
                aria-describedby={problem === null ? bodyId : `${bodyId} ${problemId}`}
                className="composer-input mt-2 w-full rounded-xl border border-line-strong bg-surface px-4 py-3 font-mono text-title text-ink"
              />
              {problem === null ? null : (
                <p id={problemId} role="alert" className="fade-in mt-2 text-caption text-danger">
                  {problem}
                </p>
              )}
              <div className="mt-4 space-y-2">
                <Button type="submit" tone="primary" full>
                  {SOUND_CHAT_COPY.pairing.codeAction}
                </Button>
                <Button type="button" tone="quiet" full onClick={toRoleStep}>
                  {SOUND_CHAT_COPY.pairing.changeRole}
                </Button>
              </div>
            </form>
          </div>
        )}
        <div className="info-divider mt-6" />
        <p className="mt-3 text-caption text-ink-muted">{SOUND_CHAT_COPY.info.attribution}</p>
      </Panel>
    </section>
  );
}
