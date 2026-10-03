/**
 * The pre-prompt: the last screen before the browser asks for the microphone.
 *
 * WHY it is a screen of its own rather than a dialog over the chat: a microphone
 * prompt with no explanation is how a page earns a permanent refusal, and a
 * refusal is a dead end the user cannot walk back out of. So every honest limit
 * of the medium — audible in the room, recordable, short, and a key check rather
 * than an identity check — is reachable *before* the browser's own prompt, and
 * the pairing code is the only way past it.
 *
 * WHY the reading and the deciding are in different columns now. The screen used
 * to be one narrow card that put the limits list, the microphone explanation, the
 * volume note and the MIT attribution between the user and the only two buttons
 * on it, so the buttons fell below the fold on a phone and the card floated in
 * the middle of a desktop window. At `lg` the copy is a brand column beside a
 * single-purpose action column; below `lg` the copy moves behind one "Learn
 * more" disclosure and the action column is the whole screen. The content did
 * not get quieter — it got a door.
 *
 * WHY the disclosure's content is mounted while the disclosure is closed: the
 * trigger carries `aria-controls`, and a reference to an element that is not in
 * the document is worse than no attribute at all. That is the same arrangement,
 * for the same reason, that `InfoPanel` uses. It is also why there is one node
 * and not a vaul `Drawer` on mobile beside a modal on desktop: two shells would
 * be two copies of the content, and therefore two elements claiming the same
 * heading id.
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
  useEffect,
  useId,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { BackIcon, InfoIcon, ShieldIcon } from "@/components/husk/icons";
import { Button, Panel } from "@/components/husk/primitives";
import {
  PAIRING_CODE_LENGTH,
  normalisePairingCode,
  validatePairingCode,
} from "@/lib/sound-chat/crypto";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";
import { AttributionLine, LicenceText } from "./info-panel";

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
}: {
  readonly onDisplay: () => void;
  readonly onEnter: (code: string) => void;
  /**
   * Accepted, and no longer rendered.
   *
   * "Not now" duplicated the shell's own back control — both of them leave Sound
   * Chat — so the screen offered two exits and neither was the obvious one. The
   * prop stays in the type so callers that still pass it keep compiling, and
   * `SOUND_CHAT_COPY.permission.dismiss` keeps the wording with the reason it is
   * no longer on screen.
   */
  readonly onDismiss?: () => void;
}): ReactElement {
  const [step, setStep] = useState<Step>("role");
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const headingId = useId();
  const fieldId = useId();
  const problemId = useId();
  const bodyId = useId();
  const learnId = useId();
  const learnHeadingId = useId();
  const isDesktop = useIsDesktop();

  // Escape closes the disclosure. A window listener rather than a handler on the
  // panel itself, because the panel is not focusable and nothing moves focus into
  // it: the feature's accessibility contract forbids taking focus, so Escape has
  // to work from wherever the keyboard already is.
  useEffect(() => {
    if (!learnOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setLearnOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [learnOpen]);

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

  /**
   * The disclosure trigger, rendered twice: once in the brand column where there
   * is room for it, once under the buttons on the screens that have no brand
   * column. A function rather than a component, so the two are the same markup
   * with no second definition to drift and neither remounts when the panel opens.
   */
  function learnTrigger(className: string): ReactElement {
    return (
      <button
        type="button"
        onClick={() => setLearnOpen(true)}
        aria-expanded={learnOpen}
        aria-controls={learnId}
        className={className}
      >
        <InfoIcon className="mr-1.5 inline h-3.5 w-3.5 align-[-3px]" />
        {SOUND_CHAT_COPY.permission.learnMore}
      </button>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="enter grid w-full lg:min-h-dvh lg:grid-cols-[45fr_55fr]"
    >
      {/* The brand column: `lg` and up only. Below that the same prose is behind
          the disclosure, because on a phone this column would be the whole screen
          and the two buttons would be off it. */}
      <div className="sc-brand-column hidden flex-col items-center justify-center gap-4 px-10 py-12 lg:flex">
        <img
          src="/icons/husk-mark.svg"
          alt="Husk"
          width={80}
          height={91}
          className="h-20 w-auto select-none drop-shadow-[0_8px_28px_rgba(60,231,103,0.35)]"
        />
        <p className="text-display text-ink">{SOUND_CHAT_COPY.shell.title}</p>
        <p className="max-w-xs text-center text-body text-ink-muted">
          {SOUND_CHAT_COPY.permission.lead}
        </p>
        {learnTrigger(
          "press mt-1 text-caption text-accent underline underline-offset-2 transition-colors hover:text-ink",
        )}
      </div>

      {/* The action column: the whole screen below `lg`, the right half above it. */}
      <div className="relative flex flex-col justify-center px-4 py-10 sm:px-6 lg:py-12">
        {/* The shell hides its own header on this screen at `lg`, so the back
            control has to exist here. An anchor rather than a router link, for the
            same reason the shell's is: this route's chunk is fetched on demand, and
            a full navigation is the more honest teardown of a live microphone. The
            name is `sr-only` text rather than an `aria-label`, so the control has a
            name in the accessibility tree without the icon growing a caption. */}
        {isDesktop ? (
          <a
            href="/"
            className="press absolute top-6 left-6 inline-flex h-10 items-center rounded-xl px-2 text-ink-muted transition-colors hover:text-ink"
          >
            <BackIcon className="h-5 w-5" />
            <span className="sr-only">{SOUND_CHAT_COPY.actions.exit}</span>
          </a>
        ) : null}

        <div className="mx-auto w-full max-w-md">
          {step === "role" ? (
            <div className="fade-in">
              <h2 id={headingId} className="text-title text-ink">
                {SOUND_CHAT_COPY.permission.title}
              </h2>
              <p className="mt-3 text-body text-ink-muted">{SOUND_CHAT_COPY.permission.lead}</p>
              <div className="mt-8 space-y-2.5">
                <Button tone="primary" full onClick={onDisplay}>
                  {SOUND_CHAT_COPY.permission.displayAction}
                </Button>
                <Button tone="quiet" full onClick={() => setStep("code")}>
                  {SOUND_CHAT_COPY.permission.enterAction}
                </Button>
              </div>
              {/* Only where the brand column is not, so there is exactly one
                  "Learn more" per screen rather than two with the same name. */}
              <div className="mt-6 text-center lg:hidden">
                {learnTrigger(
                  "press text-caption text-accent underline underline-offset-2 transition-colors hover:text-ink",
                )}
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
                    {SOUND_CHAT_COPY.actions.back}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* The disclosure's content. See the file header for why it is mounted
          whether or not it is open, and why there is exactly one copy of it. One
          node whose presentation changes at `lg`: a bottom sheet on the phone, a
          centred overlay on the desktop, with the panel's own corners following.
          Clicking the scrim does not close it — nothing in this feature may put an
          `onClick` on a `div`; Escape and the panel's own control are the two ways
          out, and the control is inside the panel so it is reachable either way. */}
      <div
        id={learnId}
        hidden={!learnOpen}
        role={learnOpen ? "dialog" : undefined}
        aria-labelledby={learnOpen ? learnHeadingId : undefined}
        className={
          learnOpen
            ? "fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm lg:items-center lg:p-4"
            : undefined
        }
      >
        <Panel className="max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl rounded-b-none lg:max-w-lg lg:rounded-2xl">
          <h2 id={learnHeadingId} className="text-title text-ink">
            {SOUND_CHAT_COPY.info.heading}
          </h2>
          <p className="mt-3 text-caption text-ink-muted">{SOUND_CHAT_COPY.permission.why}</p>
          <p className="mt-2 text-caption text-ink-muted">{SOUND_CHAT_COPY.permission.whyVolume}</p>
          <h3 className="mt-6 text-caption font-semibold uppercase tracking-widest text-ink-muted">
            {SOUND_CHAT_COPY.permission.limitsHeading}
          </h3>
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
          <div className="info-divider mt-6" />
          <p className="mt-3 text-caption text-ink-muted">{SOUND_CHAT_COPY.info.privacy}</p>
          <div className="info-divider mt-6" />
          <div className="mt-3">
            <AttributionLine />
            <LicenceText />
          </div>
          <div className="mt-5">
            <Button tone="quiet" full onClick={() => setLearnOpen(false)}>
              {SOUND_CHAT_COPY.permission.close}
            </Button>
          </div>
        </Panel>
      </div>
    </section>
  );
}

/** 1024px matches the `lg` breakpoint the two-column split uses. */
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
