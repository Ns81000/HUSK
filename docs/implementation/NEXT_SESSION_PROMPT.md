# HUSK — Implementation Prompt (Session 4: Phase 4 only, then hand off)

You are continuing the phased hardening of the Husk project (ephemeral,
end-to-end encrypted chat and file sharing; React + TanStack Start frontend;
Cloudflare Workers + SQLite Durable Objects backend).

Implementation Phases 1–3 are complete and were re-tested immediately before
this hand-off. **This session's scope is Implementation Phase 4 only.** Do not
implement Phase 5 or Phase 6 in this session. When Phase 4 is complete, write
its log, create the Phase 5-only hand-off prompt by rewriting this file, and
commit all Phase 4 changes plus the new hand-off prompt.

## Read these files FIRST, in full

Read every file below completely before writing code:

```text
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\NEXT_SESSION_PROMPT.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-1-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-2-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-3-log.md

C:\Users\Ns8pc\Pictures\HUSK\docs\audit\IMPLEMENTATION_PROMPT.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-1-backend-architecture.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-2-security-crypto.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-3-reliability-races.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-4-frontend-pwa.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-5-design-accessibility.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-6-performance-testgaps.md
```

The audit files are the ground truth for the intended fixes. If current code
already addresses an audit item, verify it and record that fact; do not
duplicate it or silently omit it.

## Verified baseline before this hand-off

These commands were run successfully in the preceding session:

- `pnpm test` — 12 test files, **87/87 pass** (including the workerd project).
- `cd worker && pnpm test` — **19/19 pass**.
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass.
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass.
- `cd worker && pnpm typecheck` — pass.
- `pnpm build` — pass.
- Focused Phase 3 node tests — **38/38 pass**.

Do not assume a green baseline proves Phase 4 is finished. The production
build currently warns that `/fonts/inter-latin.woff2` is referenced but absent.

## What is already implemented

### Phase 1 — backend/storage

- R2 and the KV placeholder were removed. `HuskRoom` and `HuskGatekeeper` use
  SQLite Durable Object migrations; rate limiting is fail-closed through the
  gatekeeper DO.
- Files use membership-gated grants, write-once 1 MiB chunk rows, per-room
  100 MB accounting, streamed GETs, cancel cleanup, and alarm purge.
- The client uploads and downloads incrementally, carries download capability
  only inside encrypted file messages, and shows upload failure/retry UI.
- `MAX_FILE_BYTES` is 25 MB in both configs; `MAX_ROOM_FILE_BYTES` is 100 MB.
- The workerd harness covers real file byte equality, forged/expired/replayed
  tickets, membership, budget, unsigned GET, cancel cleanup, alarm cleanup,
  capacity, PIN collision, and related security cases.

### Phase 2 — security

- SSR responses have hashed inline-script CSP plus `frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  static security headers in `public/_headers`.
- Socket connections require a one-time, rate-limited, IP-bound join token;
  replay and untokenized probes return generic failure responses.
- Production builds exclude Lovable telemetry. Security tests cover frame
  contents, join throttling, token replay, unsigned file GET, and filename XSS.

### Phase 3 — reliability

- Reconnect attempts terminate on refused joins, repeated failed handshakes,
  or the bounded retry budget; terminal `closed_disconnected` has a retry UI.
- Sending entries time out after 10 seconds, become `failed`, and can be
  retried under the same local ID. ACKs and buffered frames are covered by
  store/connection tests.
- Relay deduplication exists in both the client store and the DO, malformed
  server frames are shape-validated and counted, grace state is deadline data,
  late decrypts are guarded, close events are deduplicated, and outbox size/
  expiry are bounded.
- Phase 3's worker edge tests cover PIN collision, cancel cleanup, duplicate
  tabs, resend deduplication, and exactly-once leave notification.

Known residuals that must not be falsely reported as fixed:

- `worker/src/room.ts` still polls its alarm every 60 seconds rather than
  scheduling only the next meaningful deadline. Carry this to the appropriate
  later hardening phase unless the user explicitly expands Phase 4's scope.
- The outbox drops its oldest frame silently when capped; it does not create
  the audit's suggested plaintext system note because unsent plaintext is not
  retained. Preserve this as a documented residual for the later phase.
- `wrangler dev`/Cloudflare deployment has not been performed here.
- Repository-wide lint has a pre-existing large failure baseline. Keep touched
  files formatted and clean; do not reformat the repository.

## Current Phase 4 groundwork already present in the tree

The audit predates some current files. Inspect and verify these before editing:

- `public/manifest.webmanifest` and `public/icons/*` already contain a manual
  manifest and regular/maskable icon assets.
- `src/routes/__root.tsx` already links the manifest, registers `/sw.js`, has a
  pre-paint theme bootstrap script, and uses Husk tokens on 404/error screens.
- `src/server.ts` hashes inline scripts in the CSP, so any final inline theme
  script must remain covered after rendering.
- `src/styles.css` declares a self-hosted Inter face, but the referenced
  `public/fonts/inter-latin.woff2` is missing.
- `src/lib/husk/store.ts` and `room-info.tsx` already contain browser
  online/offline state and a distinct offline connection message.
- `chat.tsx` already contains the IME composing guard, a memoized
  `MessageItem`, and near-bottom-aware auto-scroll.
- There is **no `vite-plugin-pwa` dependency and no `/sw.js` source/output yet**.
  The manual manifest/registration is therefore incomplete until a real,
  tested service worker is produced and the built output is checked.

## Rules

- Work on Phase 4 only. Do not begin Phase 5 or Phase 6.
- Implement → run all relevant tests and checks → hunt for regressions → write
  `docs/implementation/phase-4-log.md` → rewrite this file as the Phase 5-only
  hand-off → commit the session's intended changes.
- Required verification before declaring Phase 4 complete:
  `pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit -p tsconfig.json`,
  `pnpm exec tsc --noEmit -p worker/tsconfig.json`, and
  `cd worker && pnpm test`.
- Use `pnpm` exclusively. Do not use `npm install` or `pip install`.
- Do not deploy or use credentials. Stop only for a decision that genuinely
  requires the user.
- Keep tests deterministic and focused. Add regression tests for behavior
  changed in this phase where a reliable seam exists.
- Keep touched files Prettier-formatted. Do not fix the repository-wide lint
  baseline or create unrelated diff noise.
- Kill any `wrangler dev`, `vite preview`, or workerd process you start; a
  leftover process can lock `.output` and break the next `pnpm build` on
  Windows.
- Before committing, inspect `git diff` and `git status`; stage only intended
  files. Do not amend or rewrite earlier commits, and do not push unless asked.

## Implementation Phase 4 — PWA, Frontend Runtime & Cross-Platform Fixes

Use `C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-4-frontend-pwa.md` as
the source of the requirements. Finish and verify all seven items below,
accounting for the groundwork listed above:

1. **PWA:** add and configure `vite-plugin-pwa` (or an equally real Vite PWA
   integration if the plugin is incompatible with the existing TanStack Start
   setup). Produce a manifest with standalone display, token-derived theme and
   background colors, regular and maskable 192/512 icons, and the existing
   Husk mark. Produce a minimal app-shell service worker. It may precache only
   frontend shell assets; it must never cache Worker API/WebSocket/file routes
   or sensitive room data. Register it safely from the root shell. Verify the
   built `.output/public` contains and serves the manifest, icons, and `sw.js`.

2. **IME:** retain or complete the Enter guard so Enter does not submit while
   `event.nativeEvent.isComposing` is true. Add a focused regression test if
   the current test seams permit it.

3. **Online/offline:** retain or complete `window` `online`/`offline` listeners.
   The online event must reset the connection backoff and reconnect immediately;
   the UI must distinguish “You are offline” from ordinary reconnecting. Check
   listener cleanup and SSR safety.

4. **Self-host Inter:** add the actual licensed Inter `.woff2` asset under
   `public/fonts/`, keep `font-display: swap`, and remove any Google Fonts
   preconnect/stylesheet or CSP allowlist entries. Rebuild and confirm the
   font request resolves without the current missing-file warning.

5. **Error screens:** verify the 404 and error screens use only Husk tokens and
   existing primitives. Keep the error boundary behavior intact and add no
   nonexistent Tailwind token utilities.

6. **Theme flash:** verify the pre-paint `dark` class application works for a
   persisted dark theme and OS-preferred dark theme, without hydration errors.
   Ensure every inline script emitted by the final SSR shell is covered by the
   existing response CSP hash mechanism.

7. **Message rendering:** retain a memoized message item and auto-scroll only
   when the user is already near the bottom. Verify that incoming messages do
   not yank a user reading history to the bottom and that existing ordering,
   delivery, retry, and unverified-message behavior remains intact.

## Phase 4 definition of done

- The phase-4 audit findings are either fixed and tested or explicitly listed
  as residual risk in `phase-4-log.md` with the reason and next phase.
- The PWA artifacts are real in the production build; the service worker has
  no Worker-route caching behavior.
- Inter is locally served with no missing asset warning and no Google request.
- CSP, hydration, theme bootstrap, IME, offline/reconnect, error screens, and
  message scroll behavior have each been checked at an appropriate seam.
- All required verification commands pass.
- `docs/implementation/phase-4-log.md` records exact changes, commands,
  results, manual checks, residual risk, and the final test counts.

## After Phase 4 — create the Phase 5-only hand-off and commit

After the Phase 4 log exists and all required checks pass, rewrite this same
file as the next prompt. The new prompt must:

- Scope the next session to **Implementation Phase 5 only**.
- Begin with an absolute-path “Read these files FIRST, in full” block listing
  the new `NEXT_SESSION_PROMPT.md`, logs 1–4, and all seven audit files.
- Carry forward the Phase 1–3 decisions above plus concrete Phase 4 decisions:
  PWA plugin/config, manifest/icon paths, service-worker caching policy,
  registration, font asset path, CSP/hash behavior, offline handling, and any
  manual/browser verification results.
- Include the full Phase 5 requirements from the audit: AA contrast tokens and
  permanent contrast test, modal focus trap/restoration/scrim click, `--scrim`,
  spacing decision, and axe smoke specs for landing/PIN screens in both themes.
- Preserve the Rules, exact verification commands, Windows `.output` warning,
  known residuals, and the one-phase boundary.
- End by telling the Phase 5 agent to write its log, create the Phase 6-only
  hand-off prompt, and commit before ending its session.

Finally, review the diff, stage only the Phase 4 implementation/log and the
rewritten hand-off prompt, and create one commit. Do not push it.
