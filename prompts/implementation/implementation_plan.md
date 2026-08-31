# Husk Frontend Redesign & PIN Removal

Complete redesign of the Husk frontend with PIN mechanism removal, new design system, Grainient background integration, and PWA asset regeneration.

## Resolved Design Decisions

| Decision | Choice |
|---|---|
| Room identifier | 8-char alphanumeric slug (e.g., `a7xk9m2p`) |
| Joining flow | Link-only — no manual entry, no keypad |
| Typography | Keep self-hosted Inter with better weight contrast |
| Landing page | Centered hero with full-viewport Grainient background |
| Chat layout | Full-height single column, messages fill width |
| Room info panel | Bottom sheet (mobile via Vaul) + slide-out drawer (desktop) |
| Message style | Aligned bubbles with subtle tinted backgrounds + tail |
| System messages | Inline but visually distinct (centered, muted, timeline markers) |
| Grainient scope | Landing page only — solid backgrounds on chat page |
| Share mechanism | One-click copy button with checkmark animation |
| PWA icons | Regenerate all from hexagon logo SVG |
| First-room UX | Prominent share card in empty state, auto-collapses on peer join |
| Theme toggle | Segmented control pill (Light / Dark) |
| Backend changes | Minimal — update regex, rename param |
| Default theme | Dark mode |
| Deliverable | Full AI agent prompt document |

---

## Codebase Analysis Findings

### Backend Issues Found (Report Only — No Fix Unless PIN-Related)

> [!NOTE]
> The backend is solid. The only required change is the PIN → roomId regex.

1. **`worker/src/config.ts` L15**: `PIN_PATTERN = /^[1-9][0-9]{5}$/` — must change to accept 8-char alphanumeric
2. **`worker/src/index.ts` L88-89**: `PIN_PATTERN.test(pin)` validation — will need the new pattern
3. **`worker/src/room.ts` L278**: File route regex `/room/([1-9][0-9]{5})/file` — must accept new slug format
4. **`worker/src/room.ts` L283, L294**: Chunk and get route regexes — same issue
5. **`worker/src/index.ts` L44-46**: Socket, file init, and file object patterns — must accept new slug format

### Frontend Issues Found

> [!WARNING]
> These are UX/design bugs that will be fixed in the redesign.

1. **System messages scroll away**: Leave/join notifications are inserted into the `entries` array and scroll with messages. If a participant leaves while you're scrolled up, you never see it.
2. **No button press feedback**: Buttons have zero `:active` state. No `scale()`, no haptic response. Feels unresponsive.
3. **No toast entry animation**: Toasts appear and disappear instantly. No slide-in or fade transition.
4. **Theme toggle is an afterthought**: The switch component is tiny and hidden. No visual connection to the brand.
5. **No loading states for room creation**: The button says "Creating room" but there's no spinner or progress indication.
6. **Empty state is weak**: The "Waiting for someone to join" state shows a static SVG with no motion or character.
7. **Mobile invite link field is cramped**: The compact room info on mobile crams the invite link into a tiny input field.
8. **No connection status animation**: The connection indicator dot is static. A pulsing dot would better communicate "connecting" vs "connected" states.
9. **File upload has no progress indicator**: The busy flag exists but no visual progress bar appears during encryption/upload.
10. **Closed screen has no brand presence**: Terminal states (room expired, left, etc.) show a generic error mark with no logo or branding.

---

## Proposed Changes

### Component 1: Backend (Minimal, Surgical)

> [!CAUTION]
> Backend is working and tested. Changes here are ONLY to support the new room ID format.

#### [MODIFY] [config.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/worker/src/config.ts)

- Change `PIN_PATTERN` to `/^[a-z0-9]{8}$/` (lowercase alphanumeric, 8 chars)
- Rename export to `ROOM_ID_PATTERN` for clarity

#### [MODIFY] [index.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/worker/src/index.ts)

- Update `SOCKET_PATTERN`, `FILE_INIT_PATTERN`, `FILE_OBJECT_PATTERN` regexes to match `[a-z0-9]{8}` instead of `[1-9][0-9]{5}`
- Rename `pin` variable to `roomId` in all route handlers
- Update JSON response: `{ ok: true, pin }` → `{ ok: true, roomId }`

#### [MODIFY] [room.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/worker/src/room.ts)

- Update file route regexes (L278, L283, L294) to match `[a-z0-9]{8}`
- Rename internal `pin` references to `roomId` where they appear in URL parsing

---

### Component 2: Design System (New Color Palette & Tokens)

#### [MODIFY] [styles.css](file:///c:/Users/Ns8pc/Pictures/HUSK/src/styles.css)

Complete rewrite of the design tokens based on the provided palette:

```
:root {
  --color-primary: #7de925;
  --color-dark: #172112;
  --color-surface: #f6faf4;
  --color-accent: #3ce767;
  --color-highlight: #f2d8c4;
}
```

New token mapping:
- **Dark mode (default)**: Canvas/surface built from `--color-dark` (`#172112`), accent from `--color-primary` (`#7de925`) and `--color-accent` (`#3ce767`), highlight from `--color-highlight` (`#f2d8c4`)
- **Light mode**: Canvas from `--color-surface` (`#f6faf4`), dark ink from `--color-dark`, same accent and highlight colors
- Add custom easing curves: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`
- Add button press transition: `transition: transform 160ms ease-out` and `:active { transform: scale(0.97) }` as utility
- Add `@media (prefers-reduced-motion: reduce)` rules
- Update `theme-color` meta to match dark mode default

---

### Component 3: PIN Removal (Frontend)

#### [DELETE] [keypad.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/keypad.tsx)

Entire file deleted — keypad and PIN display components are no longer needed.

#### [DELETE] [pin.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/pin.ts)

Entire file deleted — PIN generation, validation, and formatting functions removed.

#### [DELETE] [pin.test.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/pin.test.ts)

Entire test file deleted.

#### [MODIFY] [config.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/config.ts)

- Remove `PIN_LENGTH` export
- Add `ROOM_ID_LENGTH = 8` and `ROOM_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'`

#### [MODIFY] [api.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/api.ts)

- Replace `import { generatePin } from './pin'` with a new `generateRoomId()` function (8-char from CSPRNG)
- Update `createRoom()` to send `{ roomId }` instead of `{ pin }`
- Update `joinRoom(roomId)` signature
- Parse response as `{ ok: true, roomId, joinToken }` 

#### [MODIFY] [connection.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/connection.ts)

- Rename `pin` parameter to `roomId` throughout
- Update `roomSocketUrl(roomId, joinToken)` 

#### [MODIFY] [store.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/store.ts)

- Rename `pin` field to `roomId` in store state
- Update all references

#### [MODIFY] [r.$pin.tsx → r.$roomId.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routes/r.$pin.tsx)

- Rename file to `r.$roomId.tsx` (TanStack Router file-based routing)
- Update `Route.useParams()` to destructure `{ roomId }`
- Update all internal `pin` references
- Update `shareLink` construction

---

### Component 4: Grainient Integration

#### [NEW] [Grainient.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/Grainient.tsx)

Full component source from the provided spec. The WebGL fragment shader component with all props.

#### [NEW] [Grainient.css](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/Grainient.css)

Container styles for the Grainient component.

**Dependency**: `ogl` must be added via `pnpm add ogl`

**Performance optimizations**:
- Use `IntersectionObserver` (already in the component) to pause when offscreen
- Use `visibilitychange` listener (already in the component) to pause when tab hidden
- Cap DPR at 2 to prevent GPU overwork on high-DPI screens
- Only render on landing page — unmount completely when navigating to chat

---

### Component 5: Landing Page Redesign

#### [MODIFY] [index.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routes/index.tsx)

Complete rewrite of the Landing component:

**Layout**:
- Full-viewport Grainient as absolute-positioned background
- Content centered vertically and horizontally with `flex items-center justify-center min-h-screen`
- Hexagon logo (inline SVG, theme-aware: `#18794e` for light, `#3ce767` for dark) at ~64px
- "HUSK" text below logo — `text-display` weight 600, letter-spacing -0.02em
- Short tagline: "Ephemeral encrypted rooms" — `text-body`, muted color
- "Create a Room" button — prominent, full-width up to 320px, with custom styling (see Component 7)
- Segmented theme toggle (Light/Dark pill) — top-right corner, `position: fixed`
- Remove: keypad, PIN display, "Join with a PIN" button, all PIN-related state

**Mobile layout**:
- Same centered layout, logo slightly smaller (48px)
- Button full-width with proper touch target (min 44px height)
- Theme toggle remains top-right but slightly larger for touch

**Animations**:
- Stagger entrance: logo fades up first (0ms), title (50ms), tagline (100ms), button (150ms)
- Button has `:active` scale(0.97) press feedback
- Error messages fade in with `@starting-style`

---

### Component 6: Chat Page Redesign  

#### [MODIFY/RENAME] r.$pin.tsx → [r.$roomId.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routes/r.$roomId.tsx)

Complete rewrite of the RoomScreen component:

**Desktop layout** (≥1024px):
- Full-height single column, no sidebar
- Compact header bar: hexagon logo (small, 24px) + "Room" text + connection indicator dot (animated pulse) + room info trigger icon (right side)
- Messages area fills remaining height
- Composer bar at bottom (same safe-area-inset handling)
- Room info in a slide-out drawer from right (320px wide, overlay with scrim)

**Mobile layout** (< 1024px):
- Same single column
- Header: back arrow (→ home) + connection dot + room info icon
- Messages area with native scrolling momentum
- Composer with proper `safe-bottom` padding for iOS notch
- Room info in a Vaul bottom sheet (drag to dismiss)

**Waiting-for-peer state**:
- Prominent share card centered in the message area
- Shows the invite link in a styled box with "Copy invite link" button
- Subtle animated waiting indicator (pulsing hexagon or dots)
- Card auto-collapses with animation when first peer joins

**Message list improvements**:
- Messages render as aligned bubbles:
  - Own messages: right-aligned, `--color-primary` at 15% opacity background, slight right-side tail
  - Others: left-aligned, surface-raised background, left-side tail
  - Timestamps below each bubble, `text-caption` size
- System messages: centered horizontal rule with text overlay, muted color, smaller size
- Smooth scroll-to-bottom behavior preserved
- "Unverified message" indicator improved with icon

**Composer improvements**:
- Textarea with auto-grow (up to 5 lines max)
- Attach button with subtle border
- Send button: filled accent color, icon + text on desktop, icon-only on mobile
- Active states on every button (scale 0.97)
- Upload progress: thin progress bar above the composer during file encryption/upload
- File failure card: cleaner design with retry and dismiss

**Closed/error screens**:
- Brand presence: show hexagon logo above the error title
- Same Grainient-style background (optional, or just solid)
- Clean buttons with proper press states
- "Back to start" → navigates home

#### [MODIFY] [chat.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/chat.tsx)

Major rewrite of MessageList, MessageItem, Composer:
- New bubble rendering with tails
- System messages as timeline markers with `<hr>` + centered label
- Improved DeliveryNote with icons (checkmark for sent, clock for sending, warning for failed)
- File card redesign with progress bar

#### [MODIFY] [room-info.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/room-info.tsx)

Rewrite as RoomInfoDrawer (desktop) and RoomInfoSheet (mobile):
- Remove PIN display (`formatPin` calls)
- Rename all `pin` references to `roomId`
- Copy invite link with checkmark animation
- Participant count
- Encryption badge
- Theme toggle (segmented control)
- Leave room button (danger tone)

---

### Component 7: UI Primitives Redesign

#### [MODIFY] [primitives.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/primitives.tsx)

**Button**:
- Add CSS transition: `transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1)`
- Add `:active` state: `transform: scale(0.97)`
- Improve disabled styling (not just faint text — add opacity too)
- Add loading spinner variant (for "Creating room" state)

**SegmentedControl** (NEW):
- Replace the Switch component for theme toggle
- Pill container with sliding indicator
- Two segments: "Light" / "Dark"
- Animated indicator slides between positions (150ms ease-out)
- Active segment gets accent color, inactive gets muted

**Modal**:
- Add enter/exit animations (scale 0.95 → 1.0, opacity 0 → 1, 200ms ease-out)
- Scrim fade-in animation
- Keep focus trap and keyboard handling

**Toast**:
- Add slide-up entrance animation (`translateY(100%) → translateY(0)`, 300ms ease-out)
- Add slide-down exit animation
- Improve visual styling with left accent border

**IconButton**:
- Add `:active` scale(0.95) for press feedback
- Ensure min touch target 44×44px

#### [MODIFY] [icons.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/components/husk/icons.tsx)

- Add `SunIcon`, `MoonIcon` for theme toggle
- Add `InfoIcon` for room info trigger
- Add `CheckIcon` for copy success
- Add `SpinnerIcon` for loading states
- Add `BackIcon` (arrow left) for mobile navigation
- Add `LinkIcon` for invite link
- Keep all existing icons used in chat

---

### Component 8: Logo & PWA Assets

#### [MOVE] hexagon_final_logo_light_dark.svg → [public/icons/husk-logo.svg](file:///c:/Users/Ns8pc/Pictures/HUSK/public/icons/husk-logo.svg)

Move the logo SVG to the proper icons directory.

#### [NEW] [public/icons/husk-mark-light.svg](file:///c:/Users/Ns8pc/Pictures/HUSK/public/icons/husk-mark-light.svg)

Single hexagon for light surfaces (`fill="#18794e"`), sized for favicon use.

#### [NEW] [public/icons/husk-mark-dark.svg](file:///c:/Users/Ns8pc/Pictures/HUSK/public/icons/husk-mark-dark.svg)

Single hexagon for dark surfaces (`fill="#3ce767"`), sized for favicon use.

#### [MODIFY] [husk-mark.svg](file:///c:/Users/Ns8pc/Pictures/HUSK/public/icons/husk-mark.svg)

Replace with the new hexagon mark.

#### PWA Icon Generation

Generate PNG icons from the hexagon SVG (using a build script or canvas):
- `husk-icon-192.png` — 192×192, hexagon centered on transparent background
- `husk-icon-512.png` — 512×512, same
- `husk-maskable-192.png` — 192×192, hexagon on `#172112` background (safe area compliant)
- `husk-maskable-512.png` — 512×512, same

#### [MODIFY] [manifest.webmanifest](file:///c:/Users/Ns8pc/Pictures/HUSK/public/manifest.webmanifest)

- Update `background_color` to `#172112` (dark mode default)
- Update `theme_color` to `#172112`
- Update icon paths if any change

#### [MODIFY] [__root.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routes/__root.tsx)

- Update `theme-color` meta to `#172112` (dark mode default)
- Update favicon link references

#### [MODIFY] [sw.js](file:///c:/Users/Ns8pc/Pictures/HUSK/public/sw.js)

- Bump `CACHE_VERSION` to `v2` to invalidate old cached icons
- Update precache URLs if icon paths change

---

### Component 9: Theme System Updates

#### [MODIFY] [theme.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/lib/husk/theme.ts)

- Change default initial state from `"light"` to `"dark"` (dark mode is the default)
- Update the `useTheme` hook so the initial effect checks for `"dark"` as the OS fallback first

#### [MODIFY] [__root.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routes/__root.tsx)

- Update `themeBootstrap` inline script to default to dark mode when no stored preference exists

---

### Component 10: Route & Config Cleanup

#### [MODIFY] [routeTree.gen.ts](file:///c:/Users/Ns8pc/Pictures/HUSK/src/routeTree.gen.ts)

This file is auto-generated by TanStack Router — renaming `r.$pin.tsx` to `r.$roomId.tsx` will auto-regenerate it on next dev server start.

#### [MODIFY] [router.tsx](file:///c:/Users/Ns8pc/Pictures/HUSK/src/router.tsx)

No changes expected — routing is file-based.

---

## Verification Plan

### Automated Tests

```bash
# Run existing unit tests to ensure no regressions
pnpm run test

# Run lint to catch any dead imports
pnpm run lint
```

### Manual Verification

1. **Room creation flow**: Click "Create a Room" → verify 8-char slug in URL → verify invite link shows with hash key
2. **Room joining flow**: Open invite link in incognito → verify joins correctly → verify messages encrypt/decrypt
3. **PIN removal verification**: Confirm no keypad, no PIN input, no `pin.ts` imports anywhere
4. **Dark mode default**: Fresh load (no localStorage) → should be dark mode
5. **Theme toggle**: Segmented control switches smoothly between light/dark
6. **Grainient**: Landing page shows animated gradient → navigating to chat unmounts it cleanly
7. **Mobile responsive**: Test on 375px width (iPhone SE), 390px (iPhone 14), 430px (iPhone 14 Pro Max)
8. **PWA**: Install as PWA → verify icon shows hexagon → verify offline landing page works
9. **Chat UX**: 
   - Send message → verify bubble alignment and delivery indicators
   - Wait for peer → verify share card shows
   - Peer joins → verify share card collapses
   - Peer leaves → verify system message appears inline (not scrolling away)
   - Leave room → verify confirmation modal with animation
10. **Button press feedback**: Every button should scale(0.97) on press
11. **File transfer**: Attach file → verify upload progress → other peer downloads → verify decryption
12. **Error states**: Test expired room, full room, disconnected — verify branded error screens
13. **Service worker**: Verify cache version bumped, new icons cached

---

## Open Questions

> [!IMPORTANT]
> These are resolved — documented here for completeness.

All design decisions were resolved in the interview. No open questions remain.
