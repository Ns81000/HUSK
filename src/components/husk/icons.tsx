/** Single-weight custom icon set (1.5px stroke, 24px grid). */

import { useId } from "react";
import { cn } from "@/lib/utils";

type IconProps = { readonly className?: string };

function base(className?: string) {
  return {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M4 12 20 4l-3.5 16-4-6.5L4 12Z" />
    </svg>
  );
}

export function AttachIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M12 3 5 6v5.5c0 4.3 2.9 8.1 7 9.5 4.1-1.4 7-5.2 7-9.5V6l-7-3Z" />
      <path d="M9.5 12.2 11.4 14l3.4-3.6" />
    </svg>
  );
}

export function LeaveIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14" />
      <path d="M10 8 6 12l4 4" />
      <path d="M6 12h9" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M12 4v10" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M13 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V9l-6-6Z" />
      <path d="M13 3v4.5A1.5 1.5 0 0 0 14.5 9H19" />
    </svg>
  );
}

export function DeleteIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M4 7h16" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M6.5 7 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7" />
    </svg>
  );
}

/** Abstract mark used for the "waiting for peer" empty state. */
export function WaitingMark({ className }: IconProps) {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden className={className}>
      <circle cx="34" cy="48" r="17" stroke="currentColor" strokeWidth="1.5" />
      <circle
        cx="62"
        cy="48"
        r="17"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="4 6"
      />
      <path d="M48 39v18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorMark({ className }: IconProps) {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden className={className}>
      <rect x="20" y="24" width="56" height="48" rx="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M48 38v16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="48" cy="60" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg {...base(className)} className={cn("animate-spin", className)}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export function BackIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </svg>
  );
}

export function LinkIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.24 4.24 0 0 0-6-6l-1.2 1.2" />
      <path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.24 4.24 0 0 0 6 6l1.2-1.2" />
    </svg>
  );
}

export function WarnIcon({ className }: IconProps) {
  return (
    <svg {...base(className)}>
      <path d="M12 4 2.8 19.5h18.4L12 4Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.8" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The Husk 3D isometric-cube brand mark. Three gradient-filled rhombus faces
 * create a solid cube illusion with a top-edge highlight.
 */
export function HuskMark({
  size = 64,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  const id = useId();
  const topId = `hm-top-${id}`;
  const leftId = `hm-left-${id}`;
  const rightId = `hm-right-${id}`;
  const h = (size * 96) / 84;
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 84 96"
      fill="none"
      aria-hidden
      className={cn("husk-mark", className)}
    >
      <defs>
        <linearGradient id={topId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9dffbf" />
          <stop offset="100%" stopColor="#5cf28c" />
        </linearGradient>
        <linearGradient id={leftId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3ce767" />
          <stop offset="100%" stopColor="#2ec158" />
        </linearGradient>
        <linearGradient id={rightId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22a24c" />
          <stop offset="100%" stopColor="#157a37" />
        </linearGradient>
      </defs>
      <polygon points="42,8 76,28 42,48 8,28" fill={`url(#${topId})`} />
      <polygon points="8,28 42,48 42,88 8,68" fill={`url(#${leftId})`} />
      <polygon points="76,28 76,68 42,88 42,48" fill={`url(#${rightId})`} />
      <polyline
        points="8,28 42,8 76,28"
        fill="none"
        stroke="#d9fff0"
        strokeWidth="1.5"
        opacity="0.7"
      />
      <polyline points="8,68 42,88 76,68" fill="none" stroke="#0a3f2670" strokeWidth="1.5" />
    </svg>
  );
}
