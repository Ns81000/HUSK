/**
 * Custom primitives built directly on the Husk token set.
 * No component library defaults and no unstyled native controls.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

type ButtonTone = "primary" | "quiet" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: ButtonTone;
  readonly full?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
};

const toneClass = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-hover disabled:bg-line disabled:text-ink-faint",
  quiet: "bg-surface text-ink border border-line hover:bg-surface-sunken disabled:text-ink-faint",
  danger:
    "bg-surface text-danger border border-line hover:bg-surface-sunken disabled:text-ink-faint",
} satisfies Record<ButtonTone, string>;

export function Button({ tone = "primary", full, className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={cn(
        "touch-target inline-flex items-center justify-center gap-2 rounded-md px-4 text-[15px] font-medium transition-colors",
        "disabled:cursor-not-allowed",
        toneClass[tone],
        full === true && "w-full",
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        "touch-target inline-flex items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:text-ink-faint",
        className,
      )}
    />
  );
}

export function Panel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-line bg-surface p-6 shadow-panel", className)}>
      {children}
    </section>
  );
}

/** Custom switch. Never a native checkbox. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="touch-target inline-flex items-center gap-3 rounded-md px-1 text-[13px] text-ink-muted"
    >
      <span
        className={cn(
          "relative h-6 w-touch rounded-pill border transition-colors",
          checked ? "border-accent bg-accent" : "border-line-strong bg-surface-sunken",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-4 w-4 rounded-pill transition-all",
            checked ? "left-[25px] bg-accent-ink" : "left-[3px] bg-ink-faint",
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

/** Custom modal. Replaces every window.confirm in the app. */
export function Modal({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) {
      return;
    }
    invokerRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const focusableIn = (): HTMLElement[] => {
      const dialog = dialogRef.current;
      if (dialog === null) {
        return [];
      }
      const candidates = dialog.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      return Array.from(candidates).filter((el) => el.tabIndex >= 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      // Trap Tab inside the dialog: wrap at both ends (WCAG 2.4.3).
      const focusable = focusableIn();
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const dialog = dialogRef.current;
      const inside = dialog !== null && dialog.contains(document.activeElement);
      const atEdge = event.shiftKey
        ? !inside || document.activeElement === first
        : !inside || document.activeElement === last;
      if (atEdge) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const invoker = invokerRef.current;
      invokerRef.current = null;
      invoker?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim p-4 sm:items-center"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-title text-ink">
          {title}
        </h2>
        <p className="mt-2 text-[14px] text-ink-muted">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button tone="quiet" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirmRef} tone="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

type Toast = { readonly id: string; readonly text: string; readonly tone: "info" | "danger" };

const ToastContext = createContext<((text: string, tone?: "info" | "danger") => void) | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const notify = useCallback((text: string, tone: "info" | "danger" = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto max-w-sm rounded-md border bg-surface px-4 py-3 text-[14px] shadow-panel",
              toast.tone === "danger" ? "border-danger text-danger" : "border-line text-ink",
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
