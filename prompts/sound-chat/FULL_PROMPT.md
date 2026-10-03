# Sound Chat UI — Complete Redesign & Bug Fix Prompt

> **Scope**: Only the Sound Chat feature UI. Do NOT modify any file outside `src/components/sound-chat/`, `src/routes/sound-chat.tsx`, and `src/styles.css` (Sound Chat–specific CSS additions only). Do NOT touch main chat files (`src/components/husk/*`, `src/routes/r.$roomId.tsx`, `src/routes/index.tsx`).

> **Package Manager**: Use `pnpm` exclusively. Never `npm`, `yarn`, or `bun`.

---

## Table of Contents

1. [Project Context & Architecture](#1-project-context--architecture)
2. [Design Language & Constraints](#2-design-language--constraints)
3. [Screen 1: Info / Permission Page Redesign](#3-screen-1-info--permission-page-redesign)
4. [Screen 2: Pairing Panels (Enter Code & Show Code)](#4-screen-2-pairing-panels-enter-code--show-code)
5. [Screen 3: Chat Screen Redesign](#5-screen-3-chat-screen-redesign)
6. [Header Redesign (All Screens)](#6-header-redesign-all-screens)
7. [Attribution Placement](#7-attribution-placement)
8. [Button Distinctiveness & Micro-interactions](#8-button-distinctiveness--micro-interactions)
9. [Bug Fixes](#9-bug-fixes)
10. [Responsive Breakpoints & Device Rules](#10-responsive-breakpoints--device-rules)
11. [Accessibility Checklist](#11-accessibility-checklist)
12. [File-by-File Change Map](#12-file-by-file-change-map)

---

## 1. Project Context & Architecture

### Tech Stack

- **Framework**: React 19 + TanStack Router + Vite
- **Styling**: Tailwind CSS v4 with custom design-system tokens in `src/styles.css`
- **Language**: TypeScript (strict)
- **Font**: Inter (self-hosted, variable weight 400–600)

### Key Files You Will Edit

| File | Purpose |
|------|---------|
| `src/components/sound-chat/permission-prompt.tsx` | Info/permission page (Screen 1) |
| `src/components/sound-chat/pairing-panel.tsx` | Show code / enter code (Screen 2) |
| `src/components/sound-chat/sound-chat-screen.tsx` | Main shell, header, phase router |
| `src/components/sound-chat/composer.tsx` | Chat text input + send button |
| `src/components/sound-chat/message-list.tsx` | Chat transcript |
| `src/components/sound-chat/transmit-status.tsx` | Transport state indicator |
| `src/components/sound-chat/info-panel.tsx` | Info (ⓘ) button panel |
| `src/components/sound-chat/blocked-panel.tsx` | Startup failure screen |
| `src/components/sound-chat/fatal-panel.tsx` | Fatal error screen |
| `src/components/sound-chat/use-sound-chat.ts` | React hook for controller |
| `src/styles.css` | Add Sound Chat–specific CSS (append only) |
| `src/lib/sound-chat/ui/copy.ts` | Text strings (modify minimally if needed) |

### Key Files You Must READ but NOT Modify

- `src/components/husk/chat.tsx` — Main chat: MessageList, Composer, FileCard. **Study every pattern.**
- `src/components/husk/primitives.tsx` — Button, IconButton, Panel, Modal, Toast. **Reuse these.**
- `src/components/husk/room-info.tsx` — Room info panel, connection indicator. **Study desktop drawer + mobile bottom sheet pattern.**
- `src/components/husk/icons.tsx` — All icon components. **Reuse existing icons.**
- `src/routes/r.$roomId.tsx` — Main chat route. **Study the header, info drawer (desktop slide-out + mobile vaul Drawer), share card, closed screen, the `useIsDesktop()` hook.**
- `src/routes/index.tsx` — Landing page.

### Design System Tokens (from `src/styles.css`)

**Colors (dark theme — Sound Chat always runs in dark mode):**

| Token | Value | Use |
|-------|-------|-----|
| `--canvas` | `oklch(0.233 0.031 135.6)` | Dark green-black background |
| `--surface` | `oklch(0.268 0.035 136.8)` | Card/panel surface |
| `--surface-raised` | `oklch(0.302 0.038 137.7)` | Elevated surface |
| `--surface-sunken` | `oklch(0.206 0.026 135.5)` | Inset/recessed surface |
| `--line` | `oklch(0.367 0.047 137.2)` | Border |
| `--line-strong` | `oklch(0.441 0.055 135.9)` | Strong border |
| `--ink` | `oklch(0.962 0.016 133.8)` | Primary text (near white) |
| `--ink-muted` | `oklch(0.799 0.036 134.6)` | Secondary text |
| `--ink-faint` | `oklch(0.758 0.036 134.6)` | Tertiary text |
| `--accent` | `oklch(0.836 0.236 135.4)` | Brand green/lime |
| `--ok` | `oklch(0.816 0.219 147.3)` | Success green |
| `--warn` | `oklch(0.8 0.1 85)` | Warning amber |
| `--danger` | `oklch(0.759 0.144 26.1)` | Error red |

**DO NOT introduce any new colors.** Only the tokens above.

**Typography scale:**

- `text-display`: 32px / 38px, weight 600, letter-spacing -0.02em
- `text-title`: 20px / 27px, weight 600, letter-spacing -0.01em
- `text-body`: 15px / 23px
- `text-caption`: 12.5px / 18px, letter-spacing 0.01em

**Radii:** `rounded-xs` 6px, `rounded-sm` 8px, `rounded-md` 12px, `rounded-lg` 16px, `rounded-xl` 24px, `rounded-pill` 999px

**Existing CSS classes to reuse (do NOT duplicate):**

- `.btn-tactile-primary`, `.btn-tactile-quiet`, `.btn-tactile-danger`, `.btn-tactile-icon` — Button styles
- `.press`, `.press-sm` — Press/squeeze feedback
- `.enter` — Entrance animation (fade + rise, supports `--enter-delay`)
- `.fade-in` — Fade in animation
- `.chat-header` — Glassmorphic header (backdrop-blur, border-bottom)
- `.composer-bar` — Glassmorphic composer footer (backdrop-blur, border-top)
- `.composer-input` — Textarea focus glow + scrollbar hiding
- `.bubble`, `.bubble-mine`, `.bubble-theirs` — Message bubbles
- `.share-card` — Glassmorphic card with animated border shimmer
- `.modal-scrim`, `.modal-panel` — Modal overlay + panel
- `.drawer-panel` — Slide-out drawer
- `.dot-pulse` — Pulsing dot animation
- `.waiting-glow` — Breathing glow for waiting states
- `.upload-bar` — Indeterminate progress bar
- `.info-divider` — Gradient divider line
- `.swap-check` — Copy success checkmark animation
- `.safe-top`, `.safe-bottom` — Safe area padding
- `.touch-target` — 44px minimum touch size
- `.tabular` — Tabular nums

### Reusable React Components (from `src/components/husk/primitives.tsx`)

```tsx
// Button — tone: "primary" | "quiet" | "danger"; full: boolean; loading: boolean
<Button tone="primary" full loading={busy} onClick={fn}>Label</Button>

// IconButton — always 44×44, aria-label required
<IconButton label="Room info" onClick={fn}><InfoIcon /></IconButton>

// Panel — glassmorphic card (rounded-2xl, border, backdrop-blur, shadow)
<Panel className="...">content</Panel>

// Modal — custom confirm dialog (focus trap, Escape, scrim)
<Modal open={bool} title="..." description="..." confirmLabel="..."
       onConfirm={fn} onCancel={fn} />
```

---

## 2. Design Language & Constraints

### Absolute Rules

1. **No new colors.** Only the palette tokens listed above.
2. **No browser-native elements.** No `<select>`, `window.alert()`, `window.confirm()`, `window.prompt()`, default scrollbars (already overridden), default tooltips, default audio controls, default form styling.
3. **No AI slop.** No neon glows, random gradients, pulsing orbs, glowing rings, decorative emoji, or generic "AI app" aesthetics.
4. **No decorative elements** that don't belong to Husk's design language.
5. **Respect `prefers-reduced-motion`.** Already handled globally in `styles.css`. Any new `@keyframes` must be inside `@layer components`.
6. **Every interactive element must have:** focus-visible outline (global), aria-label or visible label, min 44px touch target.
7. **Every error state must have:** a clear message (what happened + what to do) + an action button.
8. **Study the main chat** for every pattern decision. When in doubt, match the main chat.

### Visual Consistency Rules (from main chat study)

- **Header**: Glassmorphic `.chat-header`, `safe-top` padding, back button left, title left or center, action button right.
- **Composer**: Glassmorphic `.composer-bar` at bottom, `safe-bottom` padding, textarea + send button in a row.
- **Message bubbles**: `.bubble-mine` (right-aligned) and `.bubble-theirs` (left-aligned).
- **Empty states**: Center-aligned, icon + heading + body text.
- **Panels/Cards**: Use `Panel` component.
- **Info drawer**: Desktop = slide-out from right with scrim. Mobile = vaul `Drawer` bottom sheet.
- **Modals**: Use `Modal` component.
- **Status indicators**: Colored dot (`.dot-pulse` when unsettled) + sentence.
- **Buttons**: Always use `<Button>` component with appropriate tone.
- **Spacing**: Consistent `px-4 sm:px-6` horizontal padding.

---

## 3. Screen 1: Info / Permission Page Redesign

### Current Problems

1. Layout is a single narrow column — looks mobile-centric on desktop, simultaneously poor on mobile.
2. Too much text before buttons — limits list, "why microphone" text, volume note push buttons below the fold.
3. "Not now" button is redundant — the back button does the same thing.
4. Attribution text at the bottom of the panel clutters the action area.
5. On desktop: wastes most of the screen width with a narrow centered card.
6. The `Panel` wrapper makes it look like a floating card — doesn't feel like a full page.

### Redesigned Layout

#### Desktop (≥1024px): Full-height Two-Column Split

```
┌──────────────────────────────────┬──────────────────────────────────┐
│                                  │                                  │
│     [LEFT BRAND COLUMN]          │      [RIGHT ACTION COLUMN]       │
│     Darker tint background       │      Standard bg-canvas          │
│                                  │                                  │
│         ┌──────────┐             │   ← (back arrow, top-left)       │
│         │  HUSK    │             │                                  │
│         │  LOGO    │             │   "Sound Chat talks              │
│         │  (SVG)   │             │    through sound"                │
│         └──────────┘             │                                  │
│                                  │   Short description (2-3 lines)  │
│      "Sound Chat"                │                                  │
│      (text-display)              │   ┌────────────────────────────┐  │
│                                  │   │  Show a pairing code       │  │
│      Tagline in text-body        │   └────────────────────────────┘  │
│      text-ink-muted              │   ┌────────────────────────────┐  │
│                                  │   │  Enter a pairing code      │  │
│      (ⓘ) Learn more link        │   └────────────────────────────┘  │
│                                  │                                  │
└──────────────────────────────────┴──────────────────────────────────┘
```

**Left column (brand/atmosphere):**

- Full viewport height, vertically centered content.
- Background: a slightly darker shade than `--canvas`. Add this CSS class:
  ```css
  .sc-brand-column {
    background: oklch(0.21 0.028 136);
    border-right: 1px solid oklch(0.3 0.04 136 / 0.3);
  }
  ```
- Content: Husk logo SVG (`/icons/husk-mark.svg`, ~80px height with `drop-shadow-[0_8px_28px_rgba(60,231,103,0.35)]`), "Sound Chat" in `text-display`, tagline in `text-body text-ink-muted`, centered.
- A "(ⓘ) Learn more" text button at the bottom of the centered content. Style: `text-caption text-accent underline underline-offset-2 hover:text-ink transition-colors`. Clicking opens a centered overlay/modal (use `Modal`-like pattern but with custom content — or a custom overlay using `.modal-scrim` + `.modal-panel` classes containing a scrollable `Panel`).

**The "Learn more" overlay content:**

- The full limits list (with shield icons for proof limits, dots for others — exactly as currently rendered).
- "Why microphone" text.
- "Volume" tip text.
- `info-divider`.
- Privacy explanation.
- `info-divider`.
- Attribution line + license toggle (moved from the permission prompt bottom).

**Right column (action):**

- Full viewport height, vertically centered content, `bg-canvas`.
- Back arrow: positioned `absolute top-6 left-6`, a plain `<a href="/">` with `BackIcon`, styled as a subtle touch target (no background, just the icon, hover:text-ink transition).
- Content in a `max-w-md` wrapper, centered:
  - Heading: `text-title text-ink` — "Sound Chat talks through sound"
  - Body: `text-body text-ink-muted mt-3` — "Two devices in the same room pass short encrypted notes to each other as audible tones. No Wi-Fi, no relay, no server."
  - Buttons: `mt-8 space-y-2.5`:
    - `<Button tone="primary" full onClick={onDisplay}>Show a pairing code</Button>`
    - `<Button tone="quiet" full onClick={() => setStep("code")}>Enter a pairing code</Button>`
  - **Remove the "Not now" button** entirely.
- Apply `.enter` animation with staggered `--enter-delay` on heading, body, and buttons.

**Column layout CSS:**

```tsx
<div className="grid min-h-dvh lg:grid-cols-[45fr_55fr]">
```

#### Tablet (768px–1023px): Same structure as mobile (single column) since the two-column split would be too cramped.

#### Mobile (<768px): Single Column

```
┌─────────────────────────────┐
│ ←             Sound Chat    │  ← Header (redesigned)
├─────────────────────────────┤
│                             │
│  "Sound Chat talks          │
│   through sound"            │
│                             │
│  Two devices in the same    │
│  room pass short encrypted  │
│  notes...                   │
│                             │
│  ┌───────────────────────┐  │
│  │ Show a pairing code   │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ Enter a pairing code  │  │
│  └───────────────────────┘  │
│                             │
│       (ⓘ) Learn more       │
│                             │
└─────────────────────────────┘
```

- Header: The redesigned Sound Chat header (see Section 6).
- Content: vertically centered in `flex-1`, `px-4`, `max-w-md mx-auto`.
- Same heading, body, buttons as desktop right column.
- "Learn more" link below buttons. On mobile it opens a **vaul `Drawer` bottom sheet** (copy the pattern from `src/routes/r.$roomId.tsx` lines 293-317) containing the same "Learn more" content.
- **No "Not now" button** — the header back button handles this.

#### Code Entry Step

When user taps "Enter a pairing code":

- **Desktop**: The code entry form replaces the right column's content only. Left brand column stays. Animate transition with `.fade-in`.
- **Mobile**: The code entry form replaces the main content below the header.
- Keep: code input field (monospace, `composer-input`, `font-mono text-title`), "Connect" primary button, "Use the other option instead" quiet button.
- Keep: error display for invalid codes (`role="alert"`, `text-danger`).
- Keep: `Escape` key returning to role step.
- Keep: `aria-describedby` linking field to body text and error.

### Implementation Notes for `permission-prompt.tsx`

1. **Add `useIsDesktop()` hook** — copy from `r.$roomId.tsx` (lines 337-347). Uses `window.matchMedia("(min-width: 1024px)")`.

2. **Add state for learn-more overlay**: `const [learnOpen, setLearnOpen] = useState(false);`

3. **Import vaul `Drawer`** for mobile learn-more bottom sheet.

4. **Remove** the `<Panel>` wrapper. Content is directly in the column layout.

5. **Remove** the attribution line from the bottom of the permission prompt. It moves into the "Learn more" overlay.

6. **Remove** the "Not now" / dismiss button and its `onDismiss` prop usage in the component body (keep the prop in the type for backward compat but ignore it, or remove if all callers are updated).

7. The `onDismiss` is called from `sound-chat-screen.tsx` line 78. Since we're replacing "Not now" with the back button, the back button in the header (which is `<a href="/">`) handles this. The `onDismiss` prop can be kept but will not be rendered as a button in the permission prompt.
## 4. Screen 2: Pairing Panels (Enter Code & Show Code)

### Current Problems

1. **Panels float in a narrow card** — looks lost on desktop, cramped on mobile.
2. **The WaitingMark SVG** (two circles with dashes) appears broken/incomplete visually (user circled it in their screenshot — the dashed circle looks like a rendering glitch).
3. **Empty space below the code readout** before the listening indicator.
4. **"Use the other option instead" button text** is too vague — it should say what the other option actually is.
5. **Copy button** doesn't feel distinct — no visual feedback beyond text change.
6. **Elements are positioned in a weird stacking order** — code, copy button, then waiting animation, then "use other option" at the very bottom with lots of space between.
7. **The code readout + waiting area + buttons should be centered and compact**, not spread out with gaps.

### Redesigned Layout

Both the "Show Code" and "Enter Code" pairing panels should be **centered on screen** in both desktop and mobile. Use the same two-column approach as the permission prompt on desktop (left brand column stays, right column shows the pairing panel). On mobile, full-screen below the header.

#### Show Code Panel (Displayer)

```
┌─────────────────────────────────┐
│  YOU ARE SHOWING A CODE         │  ← Role label (text-caption, uppercase)
│                                 │
│  Show this code on the          │  ← Heading (text-title)
│  other device                   │
│                                 │
│  Type it into the second        │  ← Body (text-body, text-ink-muted)
│  device...                      │
│                                 │
│  ┌───────────────────────────┐  │
│  │     P E H N B N Z T       │  │  ← Code readout (font-mono, text-display)
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │  📋 Copy code       ✓    │  │  ← Copy button with feedback
│  └───────────────────────────┘  │
│                                 │
│       ◉ Listening for the       │  ← Status (dot-pulse + sentence)
│         other device            │
│       Both devices nearby...    │  ← Hint (text-caption)
│                                 │
│  ┌───────────────────────────┐  │
│  │  Enter a code instead     │  │  ← Renamed from "Use the other option"
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

#### Key Changes for `pairing-panel.tsx`

1. **Keep the `Panel` wrapper** — the pairing panel IS a card/modal-like element, so `Panel` is appropriate here.

2. **Center the panel** on screen. On desktop (≥1024px): show inside the right column of the two-column layout, or if the permission-prompt already navigated away, center in the full viewport. The `sound-chat-screen.tsx` already wraps pairing in `<main className="flex flex-1 flex-col">`, so the panel gets centered via its own `enter w-full` + `mx-auto max-w-xl` classes (this is already done).

3. **Fix the WaitingMark SVG**: The current SVG shows two overlapping circles (one solid, one dashed) with a vertical line between them. The dashed circle looks broken/unintentional. Replace the `WaitingMark` rendering with a simpler, cleaner waiting indicator:
   - Use the existing `.dot-pulse` class on a larger dot (e.g., `h-4 w-4 rounded-pill bg-accent dot-pulse`) centered above the waiting text.
   - OR keep the `WaitingMark` SVG but remove the `waiting-glow` class animation which makes it appear broken at low opacity. Instead, just use a steady opacity with `dot-pulse`-like subtle pulse.
   - **Best approach**: Replace the large `WaitingMark` with a smaller, cleaner indicator — a horizontal row with a pulsing dot + the status text. This matches how `TransmitStatus` works in the chat phase and is consistent with the `ConnectionIndicator` pattern in the main chat:
   ```tsx
   <div role="status" className="fade-in mt-6 flex items-center justify-center gap-2.5">
     <span className="inline-block h-2.5 w-2.5 rounded-pill bg-accent dot-pulse" />
     <p className="text-body text-ink">{waitingText}</p>
   </div>
   <p className="mt-1.5 text-center text-caption text-ink-muted">{hint}</p>
   ```

4. **Copy button micro-interaction**: When copied, show a checkmark icon with the `.swap-check` animation class + "Copied" text in `text-ok` color. This is already partially implemented. Ensure:
   - Before copy: `<Button tone="quiet" full>` with `CopyIcon` + "Copy code"
   - After copy: Same button but text changes to "Copied" with `CheckIcon` in `text-ok` and the `.swap-check` animation.
   - Import `CopyIcon` from `@/components/husk/icons` (it already exists there).

5. **Rename "Use the other option instead"** to be specific:
   - When role is "displayer": Button says "Enter a code instead"
   - When role is "enterer": Button says "Show a code instead"
   - Update `SOUND_CHAT_COPY.pairing.changeRole` in `copy.ts` — OR better, make it a function that takes the current role:
   ```ts
   changeRole: {
     displayer: "Enter a code instead",
     enterer: "Show a code instead",
   } satisfies Record<PairingRole, string>,
   ```
   Then in the component: `SOUND_CHAT_COPY.pairing.changeRole[role === "displayer" ? "enterer" : "displayer"]`
   Wait — the button switches TO the other role, so: if current role is "displayer", button says "Enter a code instead"; if current role is "enterer", button says "Show a code instead". So:
   ```ts
   switchTo: {
     displayer: "Show a code instead",  // switch TO displayer
     enterer: "Enter a code instead",   // switch TO enterer
   }
   ```
   Usage: `SOUND_CHAT_COPY.pairing.switchTo[role === "displayer" ? "enterer" : "displayer"]`

6. **Remove empty space**: The current gap between the code readout and the waiting indicator is too large. Use `mt-4` instead of `mt-6` for the status section.

7. **Paired state**: The success message (green border card with checkmark) is good. Keep it.

8. **Failed state**: The error card (danger border with ErrorMark icon) is good. Keep it but ensure:
   - The "Start pairing again" button is `tone="primary"`.
   - The "Enter/Show a code instead" button is `tone="quiet"`.

---

## 5. Screen 3: Chat Screen Redesign

### Current Problems

1. **Message doesn't send on pressing Enter** — BUG: The `<textarea>` in the composer has no `onKeyDown` handler for Enter-to-submit. The main chat's composer (`src/components/husk/chat.tsx` lines 438-443) has `shouldSubmitOnEnter()` handling. The Sound Chat composer is a `<form>` with `noValidate onSubmit={submit}`, but the textarea's Enter key inserts a newline by default in a `<textarea>`. The form `onSubmit` only fires on button click, not on Enter in a textarea. **FIX**: Add an `onKeyDown` handler to the textarea that calls `submit()` on Enter (not Shift+Enter), matching the main chat pattern.

2. **Textarea size is not right** — It has `rows={2}` hardcoded but no auto-grow behavior. The main chat's composer auto-grows (`autoGrow()` function, lines 334-340). The Sound Chat composer should do the same: start at 1 row, grow up to ~3-4 rows (this is a short-notes channel with 84 byte max, so it doesn't need 5 rows).

3. **Too many informational lines below the textarea** — byte counter, character counter (when non-ASCII), timing info, over-cap warning, at-cap notice, bytes hint text, blocked message, refusal message. This creates visual clutter. Redesign:
   - Show byte counter inline, right-aligned below the textarea row (like a simple `12 / 84 bytes`).
   - The "over-cap" warning replaces the counter (same position, `text-danger`).
   - The timing info ("One block: about 1.9 s") can go next to the byte counter, separated by a `·`.
   - Remove the `bytesHint` permanent text ("Plain letters and digits cost one byte each..."). This is an educational note that adds clutter — move it into the info (ⓘ) panel where it belongs.
   - The `atCap` notice ("That is the limit") should be a brief inline note, not a separate paragraph.
   - The `blocked` and `refusal` messages stay as separate lines below (they're error states and need visibility).
   - The `empty` message ("Nothing to send yet") should NOT be rendered at all — an empty textarea with a placeholder already communicates this.

4. **TransmitStatus, NoticeList, and EndSessionButton are stacked at the top** of the chat, pushing messages down. This is not how the main chat works — the main chat has status info in the header area and a clean message area. Redesign:
   - **TransmitStatus**: Move it into the header area or make it a compact single-line indicator just below the header (not inside the message scroll area).
   - **NoticeList**: Keep it below the transmit status but make it compact and dismissible.
   - **EndSessionButton**: Move it to the info panel / side menu (not floating above messages).

5. **The info (ⓘ) button and its panel** are at the very bottom of the screen (below the composer). This is wrong — it should be accessible from the header, matching the main chat's info button pattern.

6. **No background watermark** in the message area. The main chat shows a subtle Husk logo watermark behind messages. Sound Chat should do the same.

7. **Empty state** is functional but could be more polished. The main chat uses the Husk mark SVG with a drop shadow and a heading + body text. Match that style.

### Redesigned Chat Layout

#### Structure (matches main chat pattern)

```
┌─────────────────────────────────────┐
│ ←  Sound Chat  ◉ Listening    (ⓘ)  │  ← Header with transport status
├─────────────────────────────────────┤
│  ┌─ TransmitStatus (compact) ─┐    │  ← Below header, above messages
│  │ progress bar (when active)  │    │
│  └─────────────────────────────┘    │
│  Notices (if any, dismissible)      │
│                                     │
│  ┌─────────────────────────────┐    │
│  │                             │    │
│  │    Message transcript       │    │  ← Scrollable area
│  │    (with watermark behind)  │    │
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
├─────────────────────────────────────┤
│  [textarea]              [Send]     │  ← Composer bar
│  12 / 84 bytes · ~1.9 s            │
└─────────────────────────────────────┘
```

#### Header (Chat Phase)

```tsx
<header className="chat-header safe-top px-4 pb-3 sm:px-6">
  <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
    {/* Back / End session - left side */}
    <a href="/" className="touch-target press ..."><BackIcon /></a>

    {/* Title + transport status - center */}
    <div className="min-w-0 flex-1">
      <p className="text-[15px] font-semibold text-ink">Sound Chat</p>
      {/* Compact transport status: dot + sentence */}
      <p className={cn("flex items-center gap-2 text-caption", tone)}>
        <span className={cn("inline-block h-2 w-2 rounded-pill bg-current", moving && "dot-pulse")} />
        {transportSentence(transport, attempts)}
      </p>
    </div>

    {/* Info button - right side */}
    <IconButton label="About Sound Chat" onClick={toggleInfo}>
      <InfoIcon />
    </IconButton>
  </div>
</header>
```

This moves the transport status INTO the header (like the main chat's `ConnectionIndicator`), freeing the message area from the status block.

#### Below-Header Status Area

Only when there's a progress bar or notices:

```tsx
{/* Progress bar — only when transmitting */}
{progress !== null ? (
  <div className="px-4 sm:px-6">
    <div role="progressbar" ...className="relative h-1.5 w-full overflow-hidden rounded-pill bg-surface-sunken">
      <div className="absolute inset-y-0 left-0 rounded-pill bg-accent" style={{ width: `${percent}%` }} />
    </div>
    <p className="tabular mt-1 text-caption text-ink-muted">{blockText}</p>
  </div>
) : null}

{/* Notices */}
{notices.length > 0 ? (
  <div className="px-4 pt-2 sm:px-6">
    <NoticeList notices={notices} onDismiss={dismissNotices} />
  </div>
) : null}
```

#### End Session Button

**Remove from the main chat area.** Move it to the info panel. The info panel (opened by the ⓘ button) will contain:
- "About Sound Chat" content (how it works, rate, privacy).
- Session stats.
- Attribution + licence.
- "End this session" button (danger tone, at the bottom — matching the main chat's "Leave room" button in `RoomInfoPanel`).

#### Info Panel — Desktop vs Mobile

**Follow the main chat pattern exactly:**

- **Desktop (≥1024px)**: Slide-out drawer from the right, with scrim overlay. Copy the pattern from `r.$roomId.tsx` lines 265-291.
- **Mobile (<1024px)**: vaul `Drawer` bottom sheet. Copy the pattern from `r.$roomId.tsx` lines 293-317.

The info panel content:
```tsx
<div className="flex h-full flex-col justify-between">
  <div className="space-y-5">
    {/* Stats section */}
    {stats ? <Stats stats={stats} /> : null}
    <div className="info-divider" />
    {/* About section */}
    <div>
      <p className="text-[11px] font-medium uppercase tracking-widest text-ink-faint">
        About Sound Chat
      </p>
      <p className="mt-2 text-[13px] text-ink-muted leading-snug">{howItWorks}</p>
      <p className="mt-2 text-[13px] text-ink-muted leading-snug">{rate}</p>
      <p className="mt-2 text-[13px] text-ink-muted leading-snug">{privacy}</p>
    </div>
    <div className="info-divider" />
    {/* Bytes hint (moved from composer) */}
    <p className="text-[13px] text-ink-muted leading-snug">{bytesHint}</p>
    <div className="info-divider" />
    {/* Attribution */}
    <div>
      <AttributionLine />
      <LicenceText />
    </div>
  </div>
  {/* End session button at bottom */}
  <div className="pt-5">
    <Button tone="danger" full onClick={() => setConfirming(true)}>
      <LeaveIcon /> End this session
    </Button>
  </div>
</div>
```

This matches the main chat's `RoomInfoPanel` structure exactly.

#### Message Area

Keep the existing `MessageList` structure but add:

1. **Husk watermark** behind messages (when messages exist), matching the main chat:
```tsx
{rows.length > 0 ? (
  <div className="pointer-events-none fixed inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-center select-none" aria-hidden="true">
    <img src="/icons/husk-mark.svg" alt="" width={140} height={160}
         className="h-36 w-auto opacity-[0.06] drop-shadow-[0_8px_32px_rgba(60,231,103,0.15)]" />
  </div>
) : null}
```

2. **Empty state** — match the main chat's pattern:
```tsx
{rows.length === 0 ? (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 px-4 text-center">
    <img src="/icons/husk-mark.svg" alt="Husk" width={56} height={64}
         className="mx-auto h-14 w-auto drop-shadow-[0_4px_16px_rgba(60,231,103,0.3)] select-none" />
    <div>
      <p className="text-[17px] font-semibold text-ink">{emptyHeading}</p>
      <p className="mt-1 text-[13px] text-ink-muted">{emptyBody}</p>
    </div>
  </div>
) : null}
```

3. **Auto-scroll**: Add `nearBottomRef` + `bottomRef` pattern from the main chat (`chat.tsx` lines 221-250) so new messages auto-scroll only when the user is near the bottom.

#### Composer Redesign

Model after the main chat's composer (`chat.tsx` lines 319-461):

```tsx
<div className="composer-bar safe-bottom px-4 pt-2 pb-2 sm:px-6">
  <div className="flex items-end gap-2">
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => { onChange(e.target.value); autoGrow(); }}
      onKeyDown={(e) => {
        if (shouldSubmitOnEnter(e)) {
          e.preventDefault();
          onSubmit();
        }
      }}
      disabled={disabled}
      rows={1}
      placeholder="Type a short note"
      aria-label="Note to send"
      aria-invalid={!budget.fits}
      aria-describedby={...}
      className="composer-input max-h-[100px] min-h-[44px] flex-1 resize-none rounded-xl
                 border border-line/50 bg-surface-sunken/50 px-4 py-2.5
                 text-[15px] text-ink transition-all placeholder:text-ink-faint"
    />
    <Button
      type="submit"
      tone="primary"
      aria-disabled={unavailable || undefined}
      data-unavailable={unavailable || undefined}
      onClick={(e) => { if (unavailable) e.preventDefault(); }}
      className="h-11 shrink-0 px-4 rounded-xl font-medium
                 data-[unavailable]:cursor-not-allowed data-[unavailable]:opacity-50"
    >
      <SendIcon />
      <span className="hidden sm:inline">Send</span>
    </Button>
  </div>
  {/* Compact info line */}
  <div className="flex items-center justify-between pt-1.5 pb-0">
    {overCap ? (
      <span className="text-caption text-danger">{overCapText}</span>
    ) : (
      <span className="tabular text-[11px] text-ink-faint/50">
        {byteCounter}{timing ? ` · ${timing}` : ""}
      </span>
    )}
    <span className="text-[11px] text-ink-faint/50">
      Enter to send · Shift + Enter for new line
    </span>
  </div>
  {/* Error states — only when present */}
  {blocked ? <p className="text-caption text-warn mt-1">{sendReason}</p> : null}
  {refusal ? <p role="alert" className="text-caption text-danger mt-1">{refusal}</p> : null}
</div>
```

**Key changes:**
1. `rows={1}` instead of `rows={2}` — auto-grows.
2. Add `autoGrow()` function (copy from main chat).
3. Add `onKeyDown` with `shouldSubmitOnEnter()` — **import it from `@/components/husk/chat`** (it's already exported).
4. Add `ref={textareaRef}` for auto-grow.
5. Compact the info line — byte counter + timing on one line, hints on the other.
6. Remove `bytesHint` permanent text (moved to info panel).
7. Remove `empty` message display (placeholder handles this).
8. Remove `atCap` display (the byte counter already shows "84 / 84 bytes").
9. Remove `characterCounter` display (it's a nice-to-have that adds clutter — the byte counter is the meaningful one for this protocol).
10. Style matches main chat's composer: `border-line/50`, `bg-surface-sunken/50`, `placeholder:text-ink-faint`.
## 6. Header Redesign (All Screens)

### Current Problems

1. Header has "Sound Chat" on the left and "← Back to Husk" on the right — this is the **reverse** of every standard app pattern. Back should be on the left.
2. The header is rendered as a `<header>` with `.chat-header` class and `safe-top` — this is correct and should stay.
3. On the permission/info screen (Screen 1), the header is rendered by `sound-chat-screen.tsx` which wraps ALL phases. This means the header appears on the permission prompt too, which is redundant with the two-column desktop layout (where the right column has its own back arrow). **On desktop**, the global header should be hidden during the permission phase, and the right column's own back arrow serves as navigation. **On mobile**, the global header should show.

### Redesigned Header

#### For ALL phases except `permission` on desktop:

```tsx
<header className="chat-header safe-top px-4 pb-3 sm:px-6">
  <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
    {/* Back button — LEFT side */}
    <a href="/" className="touch-target press inline-flex h-10 items-center gap-2 rounded-xl px-2">
      <BackIcon className="h-5 w-5 text-ink-muted" />
    </a>

    {/* Title — takes remaining space */}
    <h1 className="min-w-0 flex-1 text-[15px] font-semibold text-ink">
      Sound Chat
    </h1>

    {/* Right side action (varies by phase) */}
    {/* In chat phase: info button */}
    {/* In other phases: nothing, or minimal */}
  </div>
</header>
```

#### Changes in `sound-chat-screen.tsx`:

1. **Move the header inside `renderPhase()`** or make it conditional. During the `permission` phase on desktop, don't render the global header (the permission prompt's own layout handles navigation). During the `permission` phase on mobile, render a simple header with just back arrow + "Sound Chat" title.

2. **In chat phase**, include the transport status in the header (as shown in Section 5) and the info (ⓘ) button on the right.

3. **In pairing phase**, include just the back arrow + "Sound Chat" title.

4. **In blocked/fatal phases**, include just the back arrow + "Sound Chat" title.

#### Implementation approach:

The cleanest way is to make the `Header` component accept props for what to show:

```tsx
function Header({
  showInfo,
  onToggleInfo,
  transportLine,
}: {
  readonly showInfo?: boolean;
  readonly onToggleInfo?: () => void;
  readonly transportLine?: ReactElement | null;
}) { ... }
```

- In chat phase: `<Header showInfo onToggleInfo={ui.toggleInfo} transportLine={<TransportStatusLine />} />`
- In other phases: `<Header />`
- In permission phase on desktop: don't render `<Header />` at all.

---

## 7. Attribution Placement

### Current Problem

The attribution line "Sound encoding by ggwave (MIT), copyright (c) 2020 Georgi Gerganov." appears in **multiple places**:
- Bottom of the permission prompt panel.
- Inside the info panel (when opened), both above and inside the expanded content.

### Solution

**Show the attribution in exactly ONE place: inside the info (ⓘ) panel / "Learn more" overlay.**

1. **Remove** from `permission-prompt.tsx` bottom.
2. **In the info panel** (`info-panel.tsx`): Keep the attribution line + licence toggle, but only inside the info panel content. Remove the `AttributionLine` that renders outside the panel (the one in the `flex-wrap items-center justify-end` row with the ⓘ button).
3. **In the "Learn more" overlay** (on the permission screen): Include attribution + licence toggle at the bottom.

This means the ggwave attribution is reachable from every screen (via the ⓘ button) but never clutters the primary UI.

---

## 8. Button Distinctiveness & Micro-interactions

### Current Problem

Buttons all look the same regardless of their function. The user specifically mentioned buttons don't feel distinct enough and their colors don't match their purpose.

### Rules

1. **Primary action** (Show code, Enter code, Connect, Send, Try again, Retry): Use `tone="primary"` — emerald gradient, prominent.
2. **Secondary action** (Enter code instead, Show code instead, Use other option, Go back, Dismiss): Use `tone="quiet"` — dark forest, subtle.
3. **Destructive action** (End session, Leave, Restart): Use `tone="danger"` — crimson, warns the user.
4. **Copy button special behavior**:
   - Default state: `tone="quiet"` with `CopyIcon` + "Copy code"
   - Success state (2s timeout): Button text changes to "Copied" with `CheckIcon` animating in via `.swap-check` class, icon color `text-ok`. The button itself can briefly flash a success tint — add a `data-copied` attribute and style:
     ```css
     /* In styles.css, @layer components */
     .btn-copy-success {
       border-color: oklch(0.816 0.219 147.3 / 0.4) !important;
       transition: border-color 200ms ease;
     }
     ```
   - Apply `btn-copy-success` class when `copied` is true.

5. **Send button**: Icon-only on mobile (`<SendIcon />`), icon + "Send" text on `sm:` screens (`<span className="hidden sm:inline">Send</span>`). This matches the main chat's composer button.

6. **Back button in header**: Just the icon, no text label, `aria-label="Back to Husk"`. Subtle, not a full button — just a touch target with icon.

---

## 9. Bug Fixes

### BUG 1: Enter key doesn't send messages

**File**: `src/components/sound-chat/composer.tsx`

**Problem**: The `<textarea>` has no `onKeyDown` handler. The `<form onSubmit={submit}>` only triggers on button click or native form submission, but a `<textarea>` treats Enter as a newline, not a submit.

**Fix**: Add `onKeyDown` handler to the textarea:

```tsx
import { shouldSubmitOnEnter } from "@/components/husk/chat";

// In the textarea:
onKeyDown={(event) => {
  if (shouldSubmitOnEnter(event)) {
    event.preventDefault();
    if (!unavailable) onSubmit();
  }
}}
```

`shouldSubmitOnEnter` is already exported from `@/components/husk/chat` and handles Enter (submit), Shift+Enter (newline), and IME composition correctly.

### BUG 2: Textarea doesn't auto-grow

**File**: `src/components/sound-chat/composer.tsx`

**Problem**: `rows={2}` is hardcoded with no auto-grow logic. The textarea is always 2 rows tall regardless of content.

**Fix**: Add auto-grow (copied from main chat):

```tsx
const textareaRef = useRef<HTMLTextAreaElement>(null);
const MAX_TEXTAREA_HEIGHT = 3 * 28 + 20; // ~3 lines (shorter than main chat since notes are tiny)

function autoGrow(): void {
  const el = textareaRef.current;
  if (el !== null) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }
}

// In the textarea:
ref={textareaRef}
rows={1}
onChange={(event) => { onChange(event.target.value); autoGrow(); }}
```

### BUG 3: Info panel positioned at bottom of page

**File**: `src/components/sound-chat/sound-chat-screen.tsx`

**Problem**: `<InfoPanel>` is rendered after `<main>` at the bottom of the viewport. It should be accessible from the header.

**Fix**: Move the info panel to be triggered from the header's ⓘ button and rendered as a drawer/bottom sheet overlay (see Section 5 for the full pattern).

### BUG 4: Broken WaitingMark SVG appearance

**File**: `src/components/sound-chat/pairing-panel.tsx`

**Problem**: The `WaitingMark` SVG (two circles + dashed circle) combined with `waiting-glow` animation makes it look broken — the dashed circle at low opacity looks like a rendering error.

**Fix**: Replace with a cleaner status indicator as described in Section 4.

### BUG 5: "End this session" button is always visible in chat area

**File**: `src/components/sound-chat/sound-chat-screen.tsx`

**Problem**: `EndSessionButton` sits above the message list, taking up space and not matching the main chat's pattern (where "Leave room" is in the info panel).

**Fix**: Move to the info panel, as described in Section 5.

---

## 10. Responsive Breakpoints & Device Rules

### Breakpoints

| Breakpoint | Range | Layout |
|-----------|-------|--------|
| Mobile | < 768px | Single column, compact |
| Tablet | 768px – 1023px | Single column, more padding |
| Desktop | ≥ 1024px | Two-column on permission, full-width chat |

### Mobile-Specific

- Use `min-h-dvh` (not `min-h-screen`) — handles dynamic viewport height correctly on iOS Safari.
- `safe-top` and `safe-bottom` for notch/home-indicator areas.
- Touch targets: minimum 44×44px (enforced by `.touch-target` utility).
- Composer: `pb-2` with `safe-bottom` to account for on-screen keyboard.
- Use vaul `Drawer` for bottom sheets (mobile info panel, mobile learn-more).
- Horizontal padding: `px-4`.

### Tablet-Specific

- Same as mobile layout but with more breathing room.
- Horizontal padding: `px-6`.
- Panels get wider `max-w-xl` or `max-w-2xl`.

### Desktop-Specific

- Permission screen: Two-column split layout.
- Chat screen: Full-width, centered content with `max-w-2xl`.
- Info panel: Right-side slide-out drawer (not bottom sheet).
- Horizontal padding: `px-6`.
- Hover states on all interactive elements.
- The `useIsDesktop()` hook (from main chat) detects `min-width: 1024px`.

### All Sizes

- Panels inside the chat area: `max-w-xl mx-auto`.
- Message bubbles: `max-w-[85%] sm:max-w-[70%]` (already correct).
- Content doesn't touch screen edges — always has `px-4 sm:px-6`.

---

## 11. Accessibility Checklist

Verify all of these after implementing:

- [ ] Every button has either visible text or `aria-label`.
- [ ] Every form field has a `<label>` (visible or `sr-only`).
- [ ] Every error message uses `role="alert"`.
- [ ] Every status update uses `role="status"` with `aria-live="polite"`.
- [ ] The message log uses `role="log"` with `aria-live="polite"` and `aria-relevant="additions"`.
- [ ] The progress bar uses `role="progressbar"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext`.
- [ ] Focus is trapped inside modals (the existing `Modal` component handles this).
- [ ] Escape closes modals/drawers.
- [ ] Tab order is logical (header → content → composer).
- [ ] Color contrast meets WCAG AA (4.5:1 for text, 3:1 for large text).
- [ ] `prefers-reduced-motion` is respected (already global in `styles.css`).
- [ ] No `aria-controls` points to an element that doesn't exist in the DOM.
- [ ] Touch targets are at least 44×44px.

---

## 12. File-by-File Change Map

### `src/components/sound-chat/sound-chat-screen.tsx`

1. **Header**: Make conditional by phase. In chat phase, include transport status + info button. In other phases, simple back + title. In permission phase on desktop, hide entirely.
2. **Remove** `<InfoPanel>` from the bottom of the screen. Replace with drawer/bottom-sheet triggered from header.
3. **Move** `EndSessionButton` into the info panel content.
4. **Move** `TransmitStatus` into the header for compact display, keep progress bar below header.
5. **Move** `NoticeList` to below the progress bar area, not inside the message area.
6. **Add** `useIsDesktop()` hook.
7. **Add** desktop drawer + mobile vaul Drawer for info panel (copy pattern from `r.$roomId.tsx`).
8. **Import** vaul `Drawer` component.

### `src/components/sound-chat/permission-prompt.tsx`

1. **Redesign** to two-column layout on desktop, single-column on mobile.
2. **Remove** `Panel` wrapper.
3. **Remove** "Not now" button.
4. **Remove** attribution from bottom.
5. **Add** "Learn more" overlay (desktop: modal, mobile: vaul Drawer).
6. **Add** `useIsDesktop()` hook.
7. **Import** vaul `Drawer`.
8. **Move** limits list, microphone explanation, volume tip, privacy text into the "Learn more" overlay.

### `src/components/sound-chat/pairing-panel.tsx`

1. **Replace** `WaitingMark` with compact dot + text indicator.
2. **Add** `CopyIcon` import and use it in the copy button.
3. **Rename** "Use the other option instead" to be role-specific.
4. **Tighten** spacing (reduce `mt-6` to `mt-4` where excessive).
5. **Add** `.btn-copy-success` class when copied.

### `src/components/sound-chat/composer.tsx`

1. **Add** `onKeyDown` handler with `shouldSubmitOnEnter()` for Enter-to-send.
2. **Add** `autoGrow()` function + `textareaRef`.
3. **Change** `rows={2}` to `rows={1}`.
4. **Restyle** textarea to match main chat: `border-line/50 bg-surface-sunken/50 placeholder:text-ink-faint`.
5. **Compact** the info area below textarea.
6. **Remove** `bytesHint` permanent text (moved to info panel).
7. **Remove** `empty` message rendering.
8. **Remove** `atCap` display (byte counter shows it).
9. **Add** "Enter to send · Shift + Enter for new line" hint (like main chat).
10. **Send button**: Icon-only on mobile, icon + text on sm+.

### `src/components/sound-chat/message-list.tsx`

1. **Add** Husk watermark behind messages (when messages exist).
2. **Update** empty state to use Husk mark SVG with drop shadow (matching main chat).
3. **Add** auto-scroll logic (nearBottomRef + bottomRef pattern from main chat).

### `src/components/sound-chat/info-panel.tsx`

1. **Complete redesign**: Becomes the content for the drawer/bottom-sheet. No longer a bottom-of-page disclosure.
2. **Remove** the `IconButton` toggle and the outer wrapper. The panel is now just the content rendered inside a drawer/bottom-sheet controlled by the parent.
3. **Add** "End this session" button at the bottom (moved from chat area).
4. **Add** `bytesHint` text (moved from composer).
5. **Keep** stats, about text, attribution, licence.
6. **Structure** to match `RoomInfoPanel` from main chat.

### `src/components/sound-chat/transmit-status.tsx`

1. **Split** into two parts:
   - A compact one-line status (dot + sentence) for the header.
   - A progress bar section for below the header.
2. **Export** a `TransportStatusLine` component for the header.
3. **Keep** the progress bar component as `TransmitProgressBar`.

### `src/components/sound-chat/blocked-panel.tsx`

1. **No major changes** — the layout is already good (error icon + heading + body + retry/back buttons).
2. **Verify** it centers properly in the viewport.

### `src/components/sound-chat/fatal-panel.tsx`

1. **No major changes** — already good.
2. **Verify** centering.

### `src/components/sound-chat/use-sound-chat.ts`

1. **No changes needed** — the hook is clean and thin.

### `src/lib/sound-chat/ui/copy.ts`

1. **Update** `changeRole` to be role-specific (see Section 4).
2. **Remove** or keep `dismiss` ("Not now") — it can stay in the copy file even if unused.
3. **Consider** adding a new copy entry for the "Learn more" link text.

### `src/styles.css`

**Append** inside `@layer components`:

```css
/* Sound Chat brand column (info page, desktop only). */
.sc-brand-column {
  background: oklch(0.21 0.028 136);
  border-right: 1px solid oklch(0.3 0.04 136 / 0.3);
}

/* Copy button success border flash. */
.btn-copy-success {
  border-color: oklch(0.816 0.219 147.3 / 0.4) !important;
  transition: border-color 200ms ease;
}
```

---

## Summary of Removed Elements

| Element | Why Removed | Where It Went |
|---------|------------|---------------|
| "Not now" button | Redundant with back button | Header back button |
| Attribution at bottom of permission panel | Clutters action area | "Learn more" overlay + info panel |
| Info (ⓘ) button at bottom of page | Wrong position | Header right side |
| `EndSessionButton` in chat area | Clutters message area | Info panel (drawer/sheet) |
| `bytesHint` permanent text in composer | Clutters composer | Info panel |
| `empty` message in composer | Redundant with placeholder | Removed entirely |
| `atCap` display in composer | Redundant with byte counter | Removed entirely |
| `characterCounter` in composer | Nice-to-have clutter | Removed |
| Full WaitingMark SVG | Looks broken | Compact dot + text indicator |
| Large `TransmitStatus` block in chat area | Pushes messages down | Compact status in header + progress bar below header |

---

## Implementation Order

1. **CSS additions** (`styles.css`) — add the two new classes.
2. **Header redesign** (`sound-chat-screen.tsx`) — conditional header, transport status in header.
3. **Info panel redesign** (`info-panel.tsx`) — convert to drawer/sheet content.
4. **Permission prompt redesign** (`permission-prompt.tsx`) — two-column layout, "Learn more" overlay.
5. **Pairing panel fixes** (`pairing-panel.tsx`) — waiting indicator, copy feedback, role-specific text.
6. **Composer fixes** (`composer.tsx`) — Enter-to-send, auto-grow, compact layout.
7. **Message list polish** (`message-list.tsx`) — watermark, empty state, auto-scroll.
8. **Transmit status split** (`transmit-status.tsx`) — header line + progress bar.
9. **Copy text updates** (`copy.ts`) — role-specific switch text, learn more text.
10. **Testing** — verify every screen on mobile, tablet, desktop. Check all error states. Check accessibility.

---

## Final Notes

- **Read the main chat files thoroughly** before starting. Every pattern you need is already there.
- **Do not invent new patterns.** Reuse what exists.
- **Test on mobile viewport** (375px width) after every change.
- **Keep all existing test files compiling.** The test files import from these components — if you rename exports or change prop types, update the test imports too. But do NOT modify test logic.
- **Keep all existing comments/docstrings** unless they describe something you removed.
- **Run `pnpm run dev`** and verify visually after implementation.
