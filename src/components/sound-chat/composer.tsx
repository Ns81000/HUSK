/**
 * The note composer, and the only place in the feature that predicts anything.
 *
 * WHY it measures with `measureMessage()` rather than counting characters: the
 * limit the protocol enforces is UTF-8 bytes, and `TextEncoder` is the same
 * encoder `session.send()` uses, so the verdict shown here cannot drift from the
 * refusal the session would give. That is also why the textarea carries no
 * `maxLength`.
 *
 * WHY the over-cap sentence is not a live region: it changes on every keystroke
 * once the note is over the cap, and a live region would re-announce it each
 * time. It is reached through `aria-describedby` together with `aria-invalid`,
 * which is the arrangement that tells a screen-reader user the field is wrong
 * once, on focus, instead of thirty times while they are deleting characters.
 *
 * WHY the send control is `aria-disabled` and not `disabled`: a `disabled`
 * button leaves the tab order, and the textarea is `disabled` at the same time,
 * so the reason a note cannot be sent would be reachable from nowhere in the
 * form. `aria-disabled` keeps the control focusable and describable, which is the
 * only way the reason survives for someone who is not looking at the screen.
 *
 * WHY there is an `onKeyDown` here now, when this file used to argue that a form
 * was the keyboard path and a handler was how Shift + Enter breaks. A `<textarea>`
 * inserts a newline on Enter and never submits the form it sits in, so the button
 * was the only way to send and Enter — the first key anyone tries in a note field
 * — silently added a line break instead. The handler is the app's own
 * `shouldSubmitOnEnter`, not a second predicate written here, because that
 * function is where the IME rule lives: an Enter that merely commits a
 * composition must not send half-converted text, and a copy of that rule is a
 * second place for it to be wrong.
 *
 * WHY the field grows and starts at one row: it was a fixed `rows={2}` box for a
 * note whose whole protocol budget is 84 bytes. It now starts at one row and
 * grows to three, which is what a short note needs and what the main composer
 * does.
 *
 * WHAT THE REDESIGN ASKED TO DELETE, AND WHY IT IS STILL HERE. The byte counter,
 * the character counter, the timing line, the at-cap sentence and the empty
 * sentence are all still rendered: this feature's accessibility suite requires
 * each of them — the counter and the over-cap sentence must *both* describe the
 * field while it is over the cap, the empty sentence must describe it while it is
 * empty, and the at-cap and timing sentences are asserted by name. Deleting them
 * would have been a tidy-up that removed behaviour four assertions depend on.
 * What did move is the schooling: the per-byte cost sentence now lives in the
 * info panel, where reading belongs. The `placeholder:text-ink-faint` the
 * redesign specified is `placeholder:text-ink-muted` here, because the contrast
 * suite forbids the `ink-faint` token in this feature's components outright.
 */

import { useId, useRef, type FormEvent, type ReactElement } from "react";
import { shouldSubmitOnEnter } from "@/components/husk/chat";
import { SendIcon } from "@/components/husk/icons";
import { Button } from "@/components/husk/primitives";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

/**
 * Three lines of text plus the padding. Shorter than the main composer's, because
 * a note here is capped at 84 bytes: a field that grew to five rows for a note of
 * three would be a form pretending to be a document.
 */
const MAX_TEXTAREA_HEIGHT = 3 * 23 + 20;

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  disabledReason,
  refusal,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /**
   * Why the last send was refused, or nothing. Optional rather than required so
   * a caller that never sends (a state preview, a test) does not have to invent a
   * value for it.
   *
   * There is deliberately no "queued" prop: the queued state is stated once, by
   * the note's own row in the transcript, from a fact about the session rather
   * than from what a past `send()` happened to return.
   */
  readonly refusal?: string | null;
}): ReactElement {
  const fieldId = useId();
  const counterId = useId();
  const overCapId = useId();
  const emptyId = useId();
  const blockedId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const budget = measureMessage(value);
  const overCap = budget.bytes > 0 && !budget.fits;
  const empty = budget.bytes === 0;
  const blocked = disabled && disabledReason !== null;
  // Why the send control cannot be used right now, or `null` when it can. The
  // control carries it, because `aria-disabled` is what keeps the control in the
  // tab order: a `disabled` button is not focusable, and a `disabled` textarea is
  // not either, so with `disabled` on both there is nowhere in the form a
  // keyboard could read the reason from.
  const sendReason = blocked
    ? disabledReason
    : empty
      ? SOUND_CHAT_COPY.composer.empty
      : overCap
        ? SOUND_CHAT_COPY.composer.overCap(-budget.remainingBytes)
        : null;
  const sendReasonId = blocked ? blockedId : empty ? emptyId : overCap ? overCapId : null;
  const unavailable = disabled || overCap || empty;

  // Only one block or two can fit, so the timing line is a straight choice and
  // an over-cap note has no honest duration to quote at all.
  const timing = !budget.fits
    ? null
    : budget.blocks === 1
      ? SOUND_CHAT_COPY.composer.singleBlock
      : SOUND_CHAT_COPY.composer.twoBlocks;

  // Grow with the text, up to three lines. Reset to `auto` first so the field can
  // also *shrink*: the `scrollHeight` of a box that is already tall is the tall
  // box, so measuring without the reset would ratchet upwards and never come back.
  function autoGrow(): void {
    const element = textareaRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // The form's own guard, and the backstop for an `aria-disabled` control: a
    // click on one still fires, and so does Enter.
    if (unavailable) {
      return;
    }
    onSubmit();
  }

  return (
    <div className="composer-bar safe-bottom px-4 pt-2 pb-2 sm:px-6">
      <form noValidate onSubmit={submit} className="space-y-2">
        <label htmlFor={fieldId} className="sr-only">
          {SOUND_CHAT_COPY.composer.label}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={fieldId}
            ref={textareaRef}
            value={value}
            disabled={disabled}
            rows={1}
            wrap="soft"
            placeholder={SOUND_CHAT_COPY.composer.placeholder}
            // No maxLength: it counts UTF-16 code units while this budget counts
            // UTF-8 bytes, and the two disagree in both directions — 84 emoji is
            // 168 code units but 336 bytes, while 42 accented letters is 84 code
            // units and exactly 84 bytes. `budget.ts` carries those figures, so
            // the cap is enforced and explained below rather than by the input.
            aria-invalid={!budget.fits}
            aria-describedby={
              overCap ? `${counterId} ${overCapId}` : empty ? `${counterId} ${emptyId}` : counterId
            }
            onChange={(event) => {
              onChange(event.target.value);
              autoGrow();
            }}
            onKeyDown={(event) => {
              if (shouldSubmitOnEnter(event)) {
                event.preventDefault();
                if (!unavailable) {
                  onSubmit();
                }
              }
            }}
            className="composer-input max-h-[100px] min-h-[44px] flex-1 resize-none rounded-xl border border-line/50 bg-surface-sunken/50 px-4 py-2.5 text-[15px] text-ink transition-all placeholder:text-ink-muted"
          />
          <Button
            type="submit"
            tone="primary"
            // `aria-disabled`, not `disabled`: the control stays focusable so the
            // reason it cannot be used is one Tab away, and `data-unavailable`
            // keeps it looking unavailable. `disabled` would take it out of the
            // tab order and out of the tree, which is the opposite of helpful.
            aria-disabled={unavailable || undefined}
            data-unavailable={unavailable || undefined}
            aria-describedby={sendReasonId === null ? counterId : `${counterId} ${sendReasonId}`}
            onClick={(event) => {
              // A click on an `aria-disabled` control still fires; the form's own
              // guard is the backstop, and this keeps the pointer honest too.
              if (unavailable) event.preventDefault();
            }}
            className="h-11 shrink-0 rounded-xl px-4 font-medium data-[unavailable]:cursor-not-allowed data-[unavailable]:opacity-50"
          >
            <SendIcon className="h-4 w-4" />
            {/* The icon is the whole label on a phone, where the field needs the
                width, and the word is there from `sm` up. */}
            <span className="hidden sm:inline">{SOUND_CHAT_COPY.composer.send}</span>
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex flex-wrap items-center gap-x-3">
            <span id={counterId} className="tabular text-caption text-ink-muted">
              {SOUND_CHAT_COPY.composer.byteCounter(budget.bytes)}
            </span>
            {/* Only when the two counts differ, which is only when the note is not
                plain ASCII. `budget.characters` is `Array.from(text).length`, so a
                combining mark or an emoji counts as the one character a person
                typed, not as the two code units it is stored in. */}
            {budget.characters === budget.bytes ? null : (
              <span className="tabular text-caption text-ink-muted">
                {SOUND_CHAT_COPY.composer.characterCounter(budget.characters)}
              </span>
            )}
            {timing === null ? null : <span className="text-caption text-ink-muted">{timing}</span>}
          </span>
          <span className="text-caption text-ink-muted">{SOUND_CHAT_COPY.composer.enterHint}</span>
        </div>
        {overCap ? (
          // Reached through aria-describedby, deliberately not a live region:
          // it changes on every keystroke while the note is over the cap.
          <p id={overCapId} className="text-caption text-danger">
            {SOUND_CHAT_COPY.composer.overCap(-budget.remainingBytes)}
          </p>
        ) : null}
        {empty ? (
          <p id={emptyId} className="text-caption text-ink-muted">
            {sendReason}
          </p>
        ) : null}
        {budget.atCap ? (
          <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.composer.atCap}</p>
        ) : null}
        {blocked ? (
          <p id={blockedId} className="text-caption text-warn">
            {sendReason}
          </p>
        ) : null}
        {refusal == null ? null : (
          // A refusal is a discrete event, so it interrupts: a queue that is full,
          // a codec that died, an unpaired session. Unlike the over-cap line it
          // does not change on every keystroke, so an alert here is the right
          // choice rather than a firehose.
          <p role="alert" className="text-caption text-danger">
            {refusal}
          </p>
        )}
      </form>
    </div>
  );
}
