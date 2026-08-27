/** Large custom numeric keypad. The OS number pad is never used. */

import { PIN_LENGTH } from "@/lib/husk/config";
import { cn } from "@/lib/utils";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

export function PinDisplay({ value }: { readonly value: string }) {
  return (
    <div className="flex justify-center gap-2" aria-live="polite" aria-label="Room PIN">
      {Array.from({ length: PIN_LENGTH }, (_, index) => {
        const digit = value[index];
        return (
          <span
            key={index}
            className={cn(
              "tabular flex h-14 w-11 items-center justify-center rounded-md border text-[22px] font-medium",
              digit === undefined
                ? "border-line bg-surface-sunken text-ink-faint"
                : "border-line-strong bg-surface text-ink",
            )}
          >
            {digit ?? ""}
          </span>
        );
      })}
    </div>
  );
}

export function Keypad({
  onDigit,
  onBackspace,
}: {
  readonly onDigit: (digit: string) => void;
  readonly onBackspace: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {KEYS.map((key, index) => {
        if (key === "") {
          return <span key={index} />;
        }
        if (key === "back") {
          return (
            <button
              key={index}
              type="button"
              onClick={onBackspace}
              aria-label="Delete last digit"
              className="touch-target h-14 rounded-md border border-line bg-surface text-ink-muted transition-colors hover:bg-surface-sunken"
            >
              <span aria-hidden>&#9003;</span>
            </button>
          );
        }
        return (
          <button
            key={index}
            type="button"
            onClick={() => onDigit(key)}
            className="tabular touch-target h-14 rounded-md border border-line bg-surface text-[20px] font-medium text-ink transition-colors hover:bg-surface-sunken active:bg-accent-soft"
          >
            {key}
          </button>
        );
      })}
    </div>
  );
}
