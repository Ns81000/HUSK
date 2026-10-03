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
import { cn } from "@/lib/utils";
import ggwaveLicenceText from "@/lib/sound-chat/vendor/LICENSE.ggwave?raw";
import { AttributionLine } from "./info-panel";

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
      className="enter grid w-full min-h-dvh lg:grid-cols-[45fr_55fr]"
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
          className="h-20 w-auto select-none"
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
            aria-hidden={learnOpen}
            tabIndex={learnOpen ? -1 : undefined}
            className={cn(
              "press absolute top-6 left-6 inline-flex h-10 items-center rounded-xl px-2 text-ink-muted transition-all duration-200 hover:text-ink",
              learnOpen && "pointer-events-none opacity-0 invisible",
            )}
          >
            <BackIcon className="h-5 w-5" />
            <span className="sr-only">{SOUND_CHAT_COPY.actions.exit}</span>
          </a>
        ) : null}

        <div className="mx-auto w-full max-w-md">
          {step === "role" ? (
            <div className="fade-in">
              {/* Mobile hero: Husk logo + Sound Chat title (mobile only) */}
              <div className="flex flex-col items-center pb-8 lg:hidden">
                <img
                  src="/icons/husk-mark.svg"
                  alt="Husk"
                  width={80}
                  height={91}
                  className="h-20 w-auto select-none"
                />
                <p className="mt-4 text-[26px] font-bold tracking-tight text-ink">
                  {SOUND_CHAT_COPY.shell.title}
                </p>
              </div>

              {/* Desktop heading and lead: hidden on mobile, visible on desktop */}
              <h2 id={headingId} className="sr-only lg:not-sr-only text-title text-ink">
                {SOUND_CHAT_COPY.permission.title}
              </h2>
              <p className="hidden lg:block mt-3 text-body text-ink-muted">
                {SOUND_CHAT_COPY.permission.lead}
              </p>

              {/* Action buttons */}
              <div className="space-y-3 lg:mt-8 lg:space-y-2.5">
                <Button tone="primary" full onClick={onDisplay}>
                  {SOUND_CHAT_COPY.permission.displayAction}
                </Button>
                <Button tone="quiet" full onClick={() => setStep("code")}>
                  {SOUND_CHAT_COPY.permission.enterAction}
                </Button>
              </div>

              {/* Mobile bottom: Learn more trigger button */}
              <div className="mt-8 text-center lg:hidden">
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

      {/* The disclosure's content. On desktop (lg), it renders as a grand, horizontal
          two-part modal: the left part presents the protocol guarantees & limits in
          structured cards, and the right part presents the engine specs & raw MIT licence in
          an open-source console pane. On mobile (<lg), it stacks responsively as a bottom sheet.
          Clicking the scrim does not close it — nothing in this feature may put an
          onClick on a div; Escape and the panel's own controls are the ways out. */}
      <div
        id={learnId}
        hidden={!learnOpen}
        role={learnOpen ? "dialog" : undefined}
        aria-labelledby={learnOpen ? learnHeadingId : undefined}
        aria-modal={learnOpen ? "true" : undefined}
        className={
          learnOpen
            ? "fixed inset-0 z-50 flex items-end justify-center overflow-y-auto p-0 transition-all duration-300 sm:items-center sm:p-4 lg:p-6"
            : undefined
        }
      >
        {learnOpen ? (
          <button
            type="button"
            aria-label={SOUND_CHAT_COPY.permission.close}
            onClick={() => setLearnOpen(false)}
            className="fixed inset-0 bg-black/80 backdrop-blur-md cursor-default"
          />
        ) : null}
        <div className="no-scrollbar relative z-10 mt-auto flex max-h-[85dvh] w-full flex-col overflow-y-auto rounded-t-2xl rounded-b-none border-t border-line-strong/40 bg-surface shadow-2xl backdrop-blur-xl animate-in slide-in-from-bottom duration-300 ease-out sm:my-auto sm:max-h-[88dvh] sm:rounded-2xl sm:border sm:animate-none lg:max-w-4xl xl:max-w-5xl">
          {/* Mobile Sheet Grab Handle */}
          <div
            className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line-strong/50 sm:hidden"
            aria-hidden="true"
          />

          {/* Header - Sticky */}
          <div className="sticky top-0 z-20 flex items-center justify-between border-b border-line/30 bg-surface/95 px-6 py-4 backdrop-blur-md">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <InfoIcon className="h-4 w-4" />
              </div>
              <h2 id={learnHeadingId} className="text-[17px] font-semibold text-ink leading-tight">
                {SOUND_CHAT_COPY.info.heading}
              </h2>
            </div>
          </div>

          {/* Body Content - Two columns on desktop */}
          <div className="flex flex-col lg:grid lg:grid-cols-[1.2fr_1fr] lg:items-stretch">
            {/* LEFT PART: Our Text (Overview, Mic & Volume, Limits & Privacy) */}
            <div className="flex flex-col space-y-4 border-b border-line/30 p-6 lg:border-b-0 lg:border-r lg:border-line/30">
              {/* Lead Summary */}
              <div className="space-y-1">
                <h3 className="text-[14px] font-semibold text-ink">
                  {SOUND_CHAT_COPY.permission.title}
                </h3>
                <p className="text-caption text-ink-muted leading-relaxed">
                  {SOUND_CHAT_COPY.permission.lead}
                </p>
              </div>

              {/* Audio & Environment Inset Card */}
              <div className="rounded-xl border border-line/30 bg-surface-sunken/50 p-3.5 space-y-2">
                <p className="text-caption text-ink-muted leading-relaxed">
                  {SOUND_CHAT_COPY.permission.why}
                </p>
                <div className="info-divider" />
                <p className="text-caption text-ink-muted leading-relaxed">
                  {SOUND_CHAT_COPY.permission.whyVolume}
                </p>
              </div>

              {/* Limits & Guarantees - Single cohesive card */}
              <div className="rounded-xl border border-line/30 bg-surface-sunken/30 p-3.5">
                <h3 className="text-caption font-semibold uppercase tracking-widest text-ink-muted">
                  {SOUND_CHAT_COPY.permission.limitsHeading}
                </h3>
                <ul className="mt-2.5 space-y-2">
                  {SOUND_CHAT_COPY.permission.limits.map((limit, index) => (
                    <li
                      key={limit}
                      className={cn(
                        "flex items-start gap-2 text-caption leading-relaxed",
                        PROOF_LIMITS.includes(index) ? "text-ink" : "text-ink-muted",
                      )}
                    >
                      {PROOF_LIMITS.includes(index) ? (
                        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
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
              </div>

              {/* Privacy Architecture */}
              <div className="rounded-xl border border-line/30 bg-surface-sunken/30 p-3.5">
                <p className="text-caption text-ink-muted leading-relaxed">
                  {SOUND_CHAT_COPY.info.privacy}
                </p>
              </div>

              {/* Cryptographic Specifications */}
              <div className="rounded-xl border border-line/30 bg-surface-sunken/30 p-3.5 space-y-2">
                <h3 className="text-caption font-semibold uppercase tracking-widest text-ink-muted">
                  {SOUND_CHAT_COPY.info.cryptoHeading}
                </h3>
                <div className="space-y-1.5 text-caption text-ink-muted leading-relaxed">
                  <p>
                    <strong className="font-medium text-ink">
                      {SOUND_CHAT_COPY.info.cryptoKeyScheduleLabel}
                    </strong>{" "}
                    {SOUND_CHAT_COPY.info.cryptoKeySchedule}
                  </p>
                  <p>
                    <strong className="font-medium text-ink">
                      {SOUND_CHAT_COPY.info.cryptoReplayLabel}
                    </strong>{" "}
                    {SOUND_CHAT_COPY.info.cryptoReplay}
                  </p>
                  <p>
                    <strong className="font-medium text-ink">
                      {SOUND_CHAT_COPY.info.cryptoZeroPersistenceLabel}
                    </strong>{" "}
                    {SOUND_CHAT_COPY.info.cryptoZeroPersistence}
                  </p>
                </div>
              </div>
            </div>

            {/* RIGHT PART: Engine & Licence Console */}
            <div className="flex flex-col bg-surface-sunken/60 p-6 space-y-4">
              <div className="flex flex-1 flex-col space-y-3.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[14px] font-semibold text-ink">
                    {SOUND_CHAT_COPY.info.attributionLink}
                  </h3>
                  <span className="inline-flex items-center rounded-md border border-line/40 bg-surface px-2 py-0.5 text-[11px] font-mono font-medium text-ink-muted">
                    MIT License
                  </span>
                </div>

                <div>
                  <AttributionLine />
                </div>

                {/* Technical Protocol Notes */}
                <div className="rounded-xl border border-line/30 bg-surface/50 p-3 text-caption text-ink-muted space-y-1.5">
                  <p className="leading-snug">{SOUND_CHAT_COPY.info.how}</p>
                  <p className="leading-snug">{SOUND_CHAT_COPY.info.rate}</p>
                </div>

                {/* Licence pre */}
                <div className="flex flex-1 flex-col min-h-0">
                  <pre
                    tabIndex={0}
                    aria-label="ggwave MIT Licence text"
                    className="no-scrollbar h-64 w-full flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/40 bg-canvas/90 p-3.5 font-mono text-[11px] leading-relaxed text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent select-text lg:h-full"
                  >
                    {ggwaveLicenceText}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Close Action - appears only when scrolled down to the end */}
          <div className="border-t border-line/30 bg-surface/40 p-4">
            <Button tone="danger" full onClick={() => setLearnOpen(false)}>
              {SOUND_CHAT_COPY.permission.close}
            </Button>
          </div>
        </div>
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
