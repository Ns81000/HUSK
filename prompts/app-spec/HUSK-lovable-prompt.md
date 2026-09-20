# Husk — Build Specification for Lovable

> Read this entire document before writing any code. This is not a feature list — it is a contract. Every section is load-bearing. Where this document says "must," treat it as a hard requirement, not a suggestion. Where it says "test," actually write and run the test before considering the feature done.

## 0. What Husk Is

Husk is an ephemeral, end-to-end encrypted chat and file-sharing app. Two or more people create or join a temporary room using a short PIN, talk and share files while the room is open, and when everyone leaves, the room and everything in it disappears — not eventually, not via a cleanup job, but because it was never durably stored in the first place.

Husk is a spiritual rebuild of an earlier project called "PeerChat" that claimed to be peer-to-peer, encrypted, and zero-storage — and was none of those things in its actual code (centralized Supabase backend, plaintext storage, no encryption, data that survived host crashes indefinitely). Husk's entire purpose is to make every one of those claims literally true at the code level. Do not let any surface-level claim in this document go unimplemented. If something can't be done as described, flag it — don't silently simplify it into a false claim.

**Non-negotiable qualities, in priority order:**
1. **Secure** — the server must be architecturally incapable of reading message content or files, not just "configured" not to.
2. **Reliable** — network drops, backgrounded tabs, crashed hosts, and simultaneous actions must all have a defined, tested behavior. No undefined states.
3. **Simple** — no component, dependency, or abstraction exists unless it earns its place. Prefer deleting a clever idea over shipping a fragile one.
4. **Scalable** — the architecture should handle 10 rooms or 100,000 rooms without a re-design, because each room is an independent unit of compute and storage.

---

## 1. Tech Stack (exact)

- **Frontend:** React 18 + TypeScript, Vite, TanStack Router (routing), TanStack Query (only for the rare non-realtime request, e.g. fetching a file blob), Zustand for local room/connection state.
- **Styling:** Tailwind CSS as the utility engine only — **all colors, spacing, radii, and type styles must come from a custom design token file** (see Section 7). Do not use Tailwind's default color palette anywhere.
- **Crypto:** Web Crypto API (`crypto.subtle`) only. AES-256-GCM for message/file encryption. No custom cryptography, no hand-rolled ciphers, no third-party crypto libraries unless Web Crypto genuinely cannot do the job (it can, for everything in this spec).
- **Backend runtime:** Cloudflare Workers.
- **Room state:** Cloudflare Durable Objects — exactly one Durable Object instance per active room, holding all ephemeral state in memory.
- **File storage:** Cloudflare R2 (S3-compatible), storing **ciphertext only**, never plaintext.
- **Realtime transport:** WebSocket connection from client to the room's Durable Object (Durable Objects natively support WebSocket hibernation — use it, so idle rooms cost near-zero compute).
- **No database.** No Postgres, no Supabase, no persistent SQL/NoSQL store of any kind. If a durable record is ever needed (see Section 9, abuse-prevention rate limiting), use Cloudflare KV — nothing heavier.

**Explicitly forbidden:** Supabase (any product), Firebase, any component library's default unstyled look (shadcn defaults, MUI defaults, etc. used unmodified), any browser-native form controls left unstyled (native `<select>`, native date pickers, native checkboxes/radios — all must be custom-built to match the design system), emoji anywhere in UI copy or code comments, placeholder "Lorem ipsum" content in the shipped build, WebRTC/STUN/TURN (explicitly rejected earlier in this project for reliability reasons).

---

## 2. Architecture Overview

```
Browser (Host)                    Cloudflare Edge                     Browser (Guest)
──────────────                    ────────────────                    ──────────────
1. Generate room                                                      
   - random PIN (6 digit)
   - random 256-bit room key K
   - K lives ONLY in URL
     fragment, never sent
     anywhere
        │
        ├── POST /room/create (PIN only, no key) ──► Worker
        │                                              │
        │                                              ├─► spawns/gets Durable Object
        │                                              │    for this PIN
        │                                              │
        │◄───────────── room routing info ─────────────┘
        │
        ├── open WebSocket to Durable Object
        │
   2. Share PIN (voice/text) + full URL (with #key fragment)
      with guest via any out-of-band channel                    
                                                                        │
                                                              3. Guest opens URL
                                                                 - reads key from
                                                                   fragment (browser
                                                                   never transmits it)
                                                                 - POST /room/join
                                                                   with PIN ────────► Worker
                                                                                        │
                                                                                        ├─► routes to
                                                                                        │    same Durable
                                                                                        │    Object
                                                                                        │
                                                              ◄───────── routing info ──┘
                                                                        │
                                                              4. Opens WebSocket to
                                                                 same Durable Object
        │                                                              │
        │◄──────────── both connected to same room ────────────────────►│
        │
   5. All messages encrypted client-side with K (AES-256-GCM)
      BEFORE being sent over the WebSocket. Durable Object relays
      ciphertext blindly — it has no key, cannot decrypt, cannot
      inspect content.
        │
   6. Files: encrypt client-side with K → upload ciphertext to R2
      via a short-lived signed upload URL issued by the Worker →
      share only the R2 object key over the encrypted channel.
```

**Why this satisfies "secure, simple, scalable" simultaneously:**
- *Secure*: the Durable Object and Worker never possess K. Even a fully compromised Cloudflare account leaks only ciphertext and metadata (PIN, timestamps, room size) — never content.
- *Simple*: no key-exchange protocol to implement or get subtly wrong (see Section 0's refinement) — the browser's URL-fragment behavior does the hard work for free.
- *Scalable*: each room is one Durable Object. Cloudflare places, migrates, and scales these automatically. There is no shared database to become a bottleneck.
- *Reliable*: Durable Objects are single-threaded per room, so "two guests join at once" and similar races are resolved by the platform, not by application-level locking.

---

## 3. Cloudflare Setup — Manual Steps (include this verbatim in the delivered project's README)

Lovable cannot provision Cloudflare resources automatically. After Lovable generates the project, the user must do the following, in order:

1. **Create a Cloudflare account** at cloudflare.com if one doesn't exist (free tier is sufficient).
2. **Install Wrangler CLI:** `npm install -g wrangler`, then `wrangler login` to authenticate.
3. **Create the R2 bucket:** `wrangler r2 bucket create husk-files`
4. **Create a KV namespace** for rate-limiting: `wrangler kv:namespace create HUSK_RATE_LIMIT`
5. **Copy the returned IDs** into `wrangler.toml` (Lovable should generate this file with placeholder comments showing exactly where each ID goes).
6. **Deploy the Worker:** `wrangler deploy` from the project's `/worker` directory.
7. **Set the deployed Worker URL** as an environment variable (`VITE_WORKER_URL`) in the frontend's `.env` file.
8. **CORS:** confirm the Worker's CORS config allows the frontend's deployed origin (Lovable's preview domain and any custom domain the user adds later).
9. **Test the connection:** open the deployed frontend, create a room, and confirm the browser's Network tab shows a successful WebSocket upgrade to the Worker URL — this is the single best signal the wiring is correct.

Each of these steps should be echoed as its own numbered section in the project README, with the exact commands, so the user can follow it without returning to this spec.

---

## 4. Room & Message Lifecycle

### Room states (state machine — implement explicitly, don't let this be implicit in scattered booleans)
`idle → creating → waiting_for_peer → active → peer_disconnected_grace → active | closed`, plus terminal states `closed_by_host`, `closed_expired`, `closed_full`, `closed_not_found`.

- **`waiting_for_peer`**: host has created the room, no guest yet. Show a clear "waiting for someone to join" state with the shareable link/PIN prominent, not buried.
- **`peer_disconnected_grace`**: on receiving a `leave` presence event, start an 8-second grace timer (carried forward from the original project's proven pattern for surviving mobile tab backgrounding). If the peer's presence returns within the window, cancel silently. If not, transition to a visible "peer left" system message — never a silent disappearance.
- **`closed_expired`**: rooms have a hard maximum lifetime (default 24 hours) even if active, and an idle timeout (default 30 minutes with zero participants) enforced by the Durable Object's alarm feature. Both are configurable constants, not hardcoded magic numbers scattered in code.
- **Room capacity**: default max 10 participants, enforced atomically inside the Durable Object (this is what Durable Objects are for — no separate "check then insert" race is possible if the check and the insert happen in the same synchronous handler).

### Message flow
1. User types message → client generates local message ID → optimistic UI insert.
2. Client encrypts plaintext with K (AES-256-GCM, fresh random IV per message) → sends ciphertext + IV over WebSocket.
3. Durable Object assigns a **server-side monotonic sequence number** to the message and relays it to all connected peers. **Do not rely on client timestamps for ordering** — clock skew between devices will produce visibly wrong ordering. Sequence number is the source of truth; timestamp is display-only.
4. Receiving client decrypts, verifies the local optimistic message (if it was the sender) or inserts fresh (if a peer's message), and renders.
5. If the WebSocket send fails, the client must show a per-message failed/retry state — never silently drop a message the user believes was sent.

### File transfer
1. Client encrypts the file client-side with K (chunk large files — stream encryption for files above ~5MB, don't buffer the whole plaintext file in memory).
2. Client requests a signed upload URL from the Worker (short-lived, single-use).
3. Client uploads ciphertext directly to R2 via the signed URL (not proxied through the Durable Object — keeps the room's compute light and the transfer fast).
4. Client sends the R2 object key + file metadata (name, size, mime type — all encrypted, same as a message) over the WebSocket.
5. Receiving client fetches ciphertext from R2, decrypts client-side, offers download.
6. **Orphan prevention:** if a file's associated room closes before the upload completes, or the upload is abandoned, R2's lifecycle rules must auto-delete objects older than a short TTL (e.g. 1 hour) that are unreferenced — implement via R2 bucket lifecycle policy, not application logic that can be skipped by a crash.

---

## 5. Security & Abuse-Resistance Checklist

Implement and test every row. This is the direct fix list for what the paranoid audit found wrong in the previous project.

| Concern | Requirement |
|---|---|
| PIN brute-forcing | Rate-limit `join` attempts per IP and per PIN using Cloudflare KV (e.g. 10 attempts / 5 minutes, exponential backoff on repeated failures). A failed join must return a generic error — don't reveal whether the PIN doesn't exist vs. is full vs. is wrong, to avoid leaking room existence. |
| Key exposure | Room key K must never appear in any HTTP request, any server log, any Worker code path, or any analytics event. Code review checklist item: grep the entire Worker codebase for any variable that could hold K — there should be none. |
| Storage confidentiality | R2 objects contain ciphertext only. Bucket must not be publicly listable or readable without a valid signed URL. |
| XSS | All rendered user content (messages, filenames, display labels) goes through React's default escaping — never `dangerouslySetInnerHTML`. Link auto-detection in message text must use safe tokenization (matching the earlier project's approach) with `rel="noopener noreferrer"` on any generated links. |
| Replay / tampering | AES-GCM provides authenticated encryption — verify the auth tag on decrypt and reject/discard any message that fails verification, surfacing a "message could not be verified" state rather than silently dropping or crashing. |
| Metadata minimization | Server-side logs may retain PIN-to-room mapping and connection timestamps for abuse investigation, but must not log message ciphertext content, file contents, or IP-to-message associations beyond what's needed for rate limiting. Define and document a log retention window (recommend 24 hours). |
| Content-Security-Policy | Strict CSP headers on the deployed frontend — no inline scripts, no wildcard script-src, no third-party analytics or trackers of any kind (metadata leakage risk for an app whose entire value proposition is privacy). |
| Dependency hygiene | No dependency with a known unpatched CVE at build time. Lockfile committed. |

---

## 6. Reliability & Edge Cases (build these into the actual state machine, not as afterthought try/catch)

- Two guests attempting to join a room at exactly the capacity limit → Durable Object's synchronous handler resolves this deterministically (one succeeds, one gets `closed_full`), never a partial/corrupt membership state.
- Host's tab crashes or loses power → no client-side cleanup ever runs, by design. The Durable Object's idle-timeout alarm is the *only* mechanism that ever closes a room — this must not depend on any client behaving well.
- Guest reconnects after a brief network drop (elevator, tunnel, etc.) → client keeps a short in-memory buffer of the WebSocket session and attempts automatic reconnect with exponential backoff (starting ~1s, capping ~15s), showing a visible "reconnecting…" indicator, not a frozen UI.
- Message ordering under simultaneous sends from two peers → resolved by the Durable Object's sequence counter (Section 4), never by client-side timestamp comparison.
- User opens the same room URL in two tabs → both connect as the same identity (the room key is in the URL, so both tabs can prove they belong); the UI should handle a duplicate-self connection gracefully (e.g. show messages in both, don't create two distinct "users").
- Large file upload interrupted mid-transfer → client shows a clear failed state with retry, and the R2 lifecycle policy (Section 4) guarantees the orphaned partial object is eventually cleaned up regardless of whether the user retries.
- Room PIN collision on creation (extremely rare with 900,000 combinations, but must be handled) → Durable Object namespace lookup returns "already exists," Worker regenerates a new PIN transparently, user never sees the collision.
- Clipboard/share failures (e.g. `navigator.clipboard` unavailable) → always provide a visible fallback (selectable text field) for copying the room link, never rely on the Clipboard API succeeding silently.
- Every async action in the UI (creating a room, joining, sending a file, reconnecting) needs three visually distinct states at minimum: in-progress, success, and failure-with-explanation. No spinner that can spin forever with no timeout or escape hatch.

---

## 7. Design System (fresh, minimal, professional — built for this project, not inherited)

An earlier reference file (a marketing site's design system, bright/saturated/illustrated) was considered and explicitly **rejected** for this project except for its structural conventions. Do not reuse its color palette, illustration style, or marketing-page layout patterns. Build the following instead.

### Principles
- Minimal, professional, quiet confidence — not sterile, not playful. Think "a tool a security researcher would trust," not "a startup landing page."
- No emoji anywhere — in UI, in system messages, in code, in commit-style copy.
- No neon, no saturated brand-color cards, no illustrated mascots, no decorative 3D art.
- No AI-slop visual tells: no generic gradient blobs, no overused glassmorphism, no stock-photo-style abstract shapes, no purple-to-blue gradient defaults.
- Every component is custom-built. No unstyled native `<select>`, `<input type="date">`, checkboxes, or radios — design and build each as a proper component matching the system.
- Both dark and light themes are first-class, not one default + an inverted afterthought. Design both simultaneously.

### Structural tokens carried forward (from the reference file's *structure*, not its colors)
- Base spacing unit: 4px, scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 96.
- Border radius scale: 6 / 8 / 12 / 16 / 24 / pill.
- Touch targets minimum 44×44px (WCAG AAA), applied strictly on mobile.
- Type scale structure (display / title / body / caption tiers), but re-authored with a neutral professional typeface — use **Inter** for everything (UI and any display text) rather than introducing a second display face; weight discipline (500–600 max for emphasis, avoid 700+ bombast) carried forward as a principle.

### New color system (to be finalized visually in-tool, but constraints are fixed)
- Light theme: neutral off-white/paper canvas (not stark white, not warm cream à la the rejected reference) with a single restrained accent color used sparingly (interactive elements only — links, primary buttons, active states). No multi-color card cycling.
- Dark theme: true dark neutral (not navy-tinted, not pure black) with the same single accent color adjusted for contrast.
- Semantic colors only for success/warning/error/info — kept desaturated enough to feel professional, not alarmist.
- No decorative color. If a color appears, it communicates state or hierarchy — never decoration for its own sake.

### Component inventory (build all, custom, no native fallbacks left unstyled)
Room-create screen, PIN-entry/join screen (large custom numeric keypad on mobile), chat message list (with distinct bubble treatment for self/peer/system messages), message composer with attach-file action, file message card (name, size, type icon, download/progress state), connection-status indicator (connected/reconnecting/disconnected — always visible, never hidden), room-info panel (PIN, participant count, share link, leave-room action), toast/inline notification system for transient feedback (no browser `alert()`/`confirm()` ever), empty states (waiting for peer, no messages yet), error states (room not found, room full, room expired), custom checkbox/toggle for any settings (e.g. theme switch), custom modal/dialog system for confirmations (e.g. "leave room?").

### Mobile-native feel
- Primary actions (send, attach, leave) anchored in a bottom thumb-zone bar, not top navigation.
- PIN entry via a large custom numeric keypad, not the OS's native number pad.
- Swipe gestures for message-level actions where natural (e.g. swipe to reveal timestamp/status) instead of long-press context menus.
- Safe-area-aware layout (respect notches/home indicators via `env(safe-area-inset-*)`).

### Desktop-native feel
- Distinct layout, not a stretched mobile view: sidebar (room info, participant presence) + main chat pane.
- Keyboard shortcuts for core actions (Enter to send, Shift+Enter for newline, Cmd/Ctrl+K for a command palette if one is warranted — don't add one just to have one).
- Hover states throughout (absent by necessity on mobile, expected on desktop) — but restrained, no heavy shadow/scale effects; a subtle background or border shift is enough.

### SVG usage
Use hand-crafted or purpose-built SVG for iconography and any illustrative empty/error states (e.g. a simple abstract mark for "waiting for peer," not a stock illustration or mascot). Icons should be a single consistent stroke-width custom set (or one well-chosen open-source icon set used consistently) — not mixed icon styles.

---

## 8. Testing Requirements (this is not optional polish — test harshly, as instructed)

- **Unit tests (Vitest):** encryption/decryption round-trip correctness, PIN generation entropy/format, message sequence-number ordering logic, room state machine transitions (every edge listed in Section 6 gets its own test), rate-limit logic.
- **Integration tests:** full room-create → join → message exchange → file exchange flow against a local Durable Object test harness (`wrangler dev` / Miniflare).
- **Edge-case tests, explicitly, one per row of Section 6:** simultaneous join at capacity, host crash (no graceful disconnect) leading to eventual idle-timeout closure, reconnect after network drop, duplicate-tab same-identity connection, interrupted file upload, PIN collision on creation.
- **Security tests:** attempt to read plaintext from a captured WebSocket frame (must fail — only ciphertext observable), attempt to fetch an R2 object without a valid signed URL (must fail), brute-force join attempts against rate limiting (must throttle), XSS payload in a message body and in a filename (must render inert).
- **Accessibility:** run an automated audit (axe or equivalent) against every screen in both themes; keyboard-only navigation must reach every interactive element; color contrast must pass WCAG AA minimum in both themes.
- **Manual QA pass required before calling this done:** create a room on desktop, join from a separate mobile device (or emulator) over real network conditions, send messages both directions, send a file both directions, background the mobile tab for >8 seconds and confirm the grace-period/reconnect behavior, force-close the host tab and confirm the guest sees an appropriate state, and confirm the room actually stops existing after it closes (no lingering server-side trace beyond the documented rate-limit metadata).

---

## 9. What "Reimagined" Means vs. the Original Project

Be explicit in the README about what changed and why, since this project's entire premise is fixing a gap between claims and reality:

- No more false "P2P" framing — Husk is honest about being a relayed architecture, and gets its security from encryption, not from a topology claim.
- Real E2EE via client-side AES-256-GCM with a key that never leaves the URL fragment, replacing zero encryption over plaintext WSS/HTTPS.
- Real zero-persistent-storage, enforced by Durable Object in-memory state, not "zero storage" while actually running a Postgres database.
- Room closure is guaranteed by a server-side idle-timeout alarm, not dependent on the host's client running a cleanup function — fixing the "crash leaves ghost data forever" issue.
- No hidden keep-alive automation faking user activity to prevent a database from sleeping — there is no database to sleep, because Cloudflare Workers/Durable Objects don't have Supabase's free-tier pause behavior.

---

## 10. Final Instruction to Lovable

Build this as a real, working application, not a mockup. Every screen must be reachable, every stated behavior in Sections 4–6 must actually execute, and every test in Section 8 must actually run and pass before this is considered complete. If any requirement in this document conflicts with a Lovable platform limitation, surface that conflict explicitly rather than silently shipping a simplified version that would misrepresent what the app does — the entire point of this project is that the app must actually be what it claims to be.
