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
  queued,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly queued: boolean;
}): ReactElement {
  const fieldId = useId();
  const counterId = useId();
  const overCapId = useId();
  const budget = measureMessage(value);
  const overCap = budget.bytes > 0 && !budget.fits;

  // Only one block or two can fit, so the timing line is a straight choice and
  // an over-cap note has no honest duration to quote at all.
  const timing = !budget.fits
    ? null
    : budget.blocks === 1
      ? SOUND_CHAT_COPY.composer.singleBlock
      : SOUND_CHAT_COPY.composer.twoBlocks;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
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
            aria-describedby={overCap ? `${counterId} ${overCapId}` : counterId}
            className="composer-input min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-faint"
          />
          <Button
            type="submit"
            tone="primary"
            disabled={disabled || !budget.fits || budget.bytes === 0}
            className="h-11 shrink-0 px-4"
          >
            <SendIcon className="h-4 w-4" />
            {SOUND_CHAT_COPY.composer.send}
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span id={counterId} className="tabular text-caption text-ink-muted">
            {SOUND_CHAT_COPY.composer.byteCounter(budget.bytes)}
          </span>
          {timing === null ? null : <span className="text-caption text-ink-faint">{timing}</span>}
        </div>

        {overCap ? (
          // Reached through aria-describedby, deliberately not a live region:
          // it changes on every keystroke while the note is over the cap.
          <p id={overCapId} className="text-caption text-danger">
            {SOUND_CHAT_COPY.composer.overCap(-budget.remainingBytes)}
          </p>
        ) : null}

        {budget.atCap ? (
          <p className="text-caption text-ink-faint">{SOUND_CHAT_COPY.composer.atCap}</p>
        ) : null}

        <p className="text-caption text-ink-faint">{SOUND_CHAT_COPY.composer.bytesHint}</p>

        {queued ? (
          <p role="status" className="text-caption text-ok">
            {SOUND_CHAT_COPY.transmit.queued}
          </p>
        ) : null}

        {disabled && disabledReason !== null ? (
          <p className="text-caption text-warn">{disabledReason}</p>
        ) : null}
      </form>
    </div>
  );
}
