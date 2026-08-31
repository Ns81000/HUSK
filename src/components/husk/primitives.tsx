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
  readonly loading?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
};

const toneClass = {
  primary: "btn-tactile-primary text-[#04180c] font-semibold",
  quiet: "btn-tactile-quiet font-medium",
  danger: "btn-tactile-danger font-semibold",
} satisfies Record<ButtonTone, string>;

export function Button({
  tone = "primary",
  full,
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const isInactive = disabled === true && !loading;

  return (
    <button
      {...rest}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        "touch-target press inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-[15px] font-medium transition-all duration-200",
        toneClass[tone],
        loading && "cursor-wait opacity-90",
        isInactive && "cursor-not-allowed shadow-none filter-none transform-none",
        full === true && "w-full",
        className,
      )}
    >
      {children}
    </button>
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
        "touch-target press press-sm inline-flex h-11 w-11 items-center justify-center rounded-xl btn-tactile-icon text-white/90 disabled:opacity-40 disabled:pointer-events-none",
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
    <section
      className={cn(
        "rounded-2xl border border-white/10 bg-black/40 backdrop-blur-xl p-6 shadow-2xl",
        className,
      )}
    >
      {children}
    </section>
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
      className="modal-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-panel w-full max-w-sm rounded-2xl p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-xl font-semibold text-white">
          {title}
        </h2>
        <p className="mt-3 text-[14px] text-white/70 leading-relaxed">{description}</p>
        <div className="mt-8 flex justify-end gap-3">
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
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-3 px-4 sm:bottom-8"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "toast-in pointer-events-auto max-w-sm rounded-xl border-l-4 border border-white/10 bg-black/80 backdrop-blur-xl px-5 py-3.5 text-[14px] font-medium shadow-2xl transition-all duration-300",
              toast.tone === "danger"
                ? "border-l-danger text-white"
                : "border-l-[#3ce767] text-white",
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
