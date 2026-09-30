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
 */

import { useId, type FormEvent, type ReactElement } from "react";
import { SendIcon } from "@/components/husk/icons";
import { Button } from "@/components/husk/primitives";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

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
   * `TransmitStatus`, from a fact about the session rather than from what a past
   * `send()` happened to return.
   */
  readonly refusal?: string | null;
}): ReactElement {
  const fieldId = useId();
  const counterId = useId();
  const overCapId = useId();
  const emptyId = useId();
  const blockedId = useId();
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

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // The control is `aria-disabled` rather than `disabled`, so Enter and a
    // click both arrive here while the note cannot be sent. Nothing is sent.
    if (unavailable) {
      return;
    }
    onSubmit();
  }

  return (
    <div className="composer-bar safe-bottom px-4 pt-3">
      {/* A real form, so Enter submits and Shift+Enter inserts a newline with no
          key handler of our own to get wrong. */}
      <form noValidate onSubmit={submit} className="space-y-2">
        <label htmlFor={fieldId} className="sr-only">
          {SOUND_CHAT_COPY.composer.label}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={fieldId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            rows={2}
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
            className="composer-input min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-muted"
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
            className="h-11 shrink-0 px-4 data-[unavailable]:cursor-not-allowed data-[unavailable]:opacity-50"
          >
            <SendIcon className="h-4 w-4" />
            {SOUND_CHAT_COPY.composer.send}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
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
        <p className="text-caption text-ink-muted">{SOUND_CHAT_COPY.composer.bytesHint}</p>
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
