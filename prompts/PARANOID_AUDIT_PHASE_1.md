# HUSK — Paranoid Audit: Phase 1 (Analyse → Test → Document)

> **Role**: You are a paranoid, adversarial QA engineer and security auditor. You trust NOTHING. You assume every line of code is hiding a bug until you prove otherwise. You do NOT stop until you have inspected every module, run every test, stress-tested every mechanism, and documented every finding. You do NOT make assumptions — you READ the actual code, RUN actual tests, and VERIFY actual behavior. If a test passes, you ask "what did it NOT test?" If a comment says "this is safe", you prove it. If documentation says "working", you verify it.

> **Constraint: Token Efficiency.** You are operating in a single chat session. You MUST be token-efficient:
> - Do NOT dump full file contents into your context unless actively analyzing them.
> - Read files in targeted ranges (50-100 lines) not whole files.
> - Use `grep_search` to locate patterns instead of reading entire files sequentially.
> - Write findings to disk INCREMENTALLY in chunks — do NOT accumulate everything in memory.
> - When you finish a subsection, FLUSH findings to the markdown file immediately.
> - Summarize what you've verified so far before moving to the next section.

> **Constraint: No Production Code Changes.** In this session you MUST NOT modify any source code in `src/`, `worker/`, or `public/`. You may ONLY:
> - Create/modify files in `prompts/findings/`
> - Create/modify/fix test files in `live-tests/`, `e2e/`, or test files (`*.test.ts`)
> - Run commands to test, lint, type-check, or analyze

> **Constraint: Completeness.** You MUST NOT stop or ask the user anything. You operate autonomously until every section below is complete. If something fails, document the failure and move on. If a test is flaky, run it 3 times and note the flake rate. You never say "I'll skip this" — you either do it or document exactly why you couldn't.

---

## Project Context (DO NOT SKIP — READ THESE FIRST)

**HUSK** is a real-time, end-to-end encrypted ephemeral chat app.

### Architecture
```
Browser (React/TanStack Router/Zustand)
    ↕ WebSocket + HTTPS
Cloudflare Worker (edge router: worker/src/index.ts)
    ↕ Durable Object RPC
HuskRoom DO (worker/src/room.ts)     — one per room, SQLite storage
HuskGatekeeper DO (worker/src/gate.ts) — singleton, join rate limiting
```

### Critical File Map — Read each of these IN FULL during analysis
| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| **Worker entry** | `worker/src/index.ts` | 225 | Edge routing, CORS, file ticket minting |
| **Room DO** | `worker/src/room.ts` | 611 | Room lifecycle, WebSocket relay, file storage, alarm purge |
| **Rate limiter** | `worker/src/rate-limit.ts` | 116 | Join throttling per IP |
| **Gatekeeper DO** | `worker/src/gate.ts` | 103 | Durable Object wrapper for rate-limit state |
| **Tickets** | `worker/src/tickets.ts` | 70 | HMAC ticket signing/verification for file transfer |
| **Worker config** | `worker/src/config.ts` | 53 | Server-side constants |
| **Worker types** | `worker/src/types.ts` | 47 | TypeScript types for worker env |
| **Client connection** | `src/lib/husk/connection.ts` | 325 | WebSocket client, reconnect logic, ping/pong, outbox buffering |
| **Client store** | `src/lib/husk/store.ts` | 536 | Zustand room store, message lifecycle, delivery state machine |
| **Room machine** | `src/lib/husk/room-machine.ts` | 106 | State machine for room lifecycle |
| **Protocol** | `src/lib/husk/protocol.ts` | 208 | Wire protocol types and server message parser |
| **Crypto** | `src/lib/husk/crypto.ts` | 119 | AES-256-GCM encrypt/decrypt |
| **Files** | `src/lib/husk/files.ts` | 246 | Chunked encrypted file upload/download |
| **API** | `src/lib/husk/api.ts` | 90 | HTTP API calls (create, join) |
| **Client config** | `src/lib/husk/config.ts` | 64 | Client-side constants |
| **Backoff** | `src/lib/husk/backoff.ts` | 13 | Exponential backoff calculator |
| **Chat UI** | `src/components/husk/chat.tsx` | 433 | Chat component (touch only if critical bug) |
| **Room page** | `src/routes/r.$roomId.tsx` | 458 | Room route (touch only if critical bug) |
| **Landing page** | `src/routes/index.tsx` | 161 | Landing/create room page |
| **Root layout** | `src/routes/__root.tsx` | 180 | Root layout, service worker |
| **Service worker** | `public/sw.js` | 123 | Offline caching |

### Live URLs
- **Backend (Worker relay)**: `https://husk.ns8pc1.workers.dev`
- **Frontend**: `https://ns81000-husk.ns8pc1.workers.dev`

### Existing Test Infrastructure
- **Unit tests** (`vitest`): `src/lib/husk/*.test.ts`, `worker/tests/integration.test.ts`
- **Live probe tests** (raw WebSocket, Node ≥ 24): `live-tests/probe-*.mjs` — use `probe-lib.mjs`
- **Live drive tests** (Playwright browser): `live-tests/drive-*.mjs` — use `drive-lib.mjs`
- **E2E tests** (Playwright): `e2e/*.spec.ts`

### Package Manager
- **pnpm** exclusively. Never use npm, yarn, or bun. Use `pnpm dlx` instead of `npx`.

---

## Execution Plan — Follow EXACTLY in this order

### STEP 0: Setup Findings File
Create `prompts/findings/FINDINGS.md` with the following skeleton, then flush findings into it section-by-section as you complete each step:

```markdown
# HUSK Paranoid Audit — Phase 1 Findings
> Generated: [timestamp]
> Auditor: Automated Paranoid Audit Agent

## Summary
(filled at the end)

## 1. Static Analysis
### 1.1 Type Errors
### 1.2 Lint Violations
### 1.3 Dead Code

## 2. Unit Test Results
### 2.1 Frontend Tests (vitest)
### 2.2 Worker Tests (vitest)
### 2.3 Failing Tests
### 2.4 Missing Coverage

## 3. Code Review Findings
### 3.1 Worker (worker/src/)
### 3.2 Client Logic (src/lib/husk/)
### 3.3 Frontend Components (src/components/husk/ + src/routes/)
### 3.4 Config Sync Issues (client ↔ worker)

## 4. Race Conditions & Concurrency

## 5. Security Vulnerabilities

## 6. Reliability & Error Handling

## 7. Performance Issues

## 8. Live Test Results
### 8.1 Existing Probe Tests
### 8.2 Existing Drive Tests
### 8.3 Custom Stress Tests

## 9. Edge Cases & Scenarios Tested

## 10. Dead Code Inventory

## 11. Prioritized Fix List
(severity: CRITICAL / HIGH / MEDIUM / LOW)
```

---

### STEP 1: Static Analysis (Type Check + Lint)

Run these commands and record EVERY error:

```bash
# 1a. TypeScript type-check — frontend
cd C:\Users\Ns8pc\Pictures\HUSK
pnpm exec tsc --noEmit 2>&1

# 1b. TypeScript type-check — worker
cd C:\Users\Ns8pc\Pictures\HUSK\worker
pnpm exec tsc --noEmit 2>&1

# 1c. ESLint
cd C:\Users\Ns8pc\Pictures\HUSK
pnpm run lint 2>&1

# 1d. OxLint anti-slop
cd C:\Users\Ns8pc\Pictures\HUSK
pnpm run lint:anti-slop 2>&1
```

Record every error in `FINDINGS.md § 1. Static Analysis`. Don't summarize — list every single error with file, line, and message.

---

### STEP 2: Run ALL Existing Unit Tests

```bash
# 2a. Frontend unit tests
cd C:\Users\Ns8pc\Pictures\HUSK
pnpm test 2>&1

# 2b. Worker unit tests
cd C:\Users\Ns8pc\Pictures\HUSK\worker
pnpm test 2>&1
```

- Record pass/fail counts and every failure with stack trace in `FINDINGS.md § 2`.
- If any test fails, analyze WHY (is it a real bug or a stale test?). Document your conclusion.
- If a test is stale/wrong, note what it should test and mark it for Phase 2 to fix.

---

### STEP 3: Deep Code Review (THE CORE — SPEND MOST TIME HERE)

**Read every file listed in the Critical File Map above IN FULL.** For each file, hunt for:

#### 3a. Race Conditions & Concurrency Bugs
- WebSocket `onmessage` handlers modifying shared state without guards
- Timers (`setTimeout`/`setInterval`) that can fire after teardown
- Multiple `connect()` calls that could create duplicate sockets
- Durable Object alarm vs. WebSocket message ordering
- `store.ts`: Zustand `set()` calls that read stale closures
- File upload: concurrent chunk uploads racing with room expiry or socket close
- `connection.ts`: reconnect loop interleaving with manual `close()`

#### 3b. Security Vulnerabilities
- Room key ever appearing server-side (worker code must NEVER see plaintext)
- CORS bypass: does `corsHeaders()` correctly reject unknown origins?
- Ticket signature: is HMAC constant-time? Can expired tickets be replayed?
- Join token: can a token be reused? Is the TTL enforced server-side?
- File download: can forged `exp`/`sig` parameters download arbitrary files?
- WebSocket: can a non-member send frames to a room? Can they inject fake `senderId`?
- Rate limiting: can it be bypassed with multiple IPs? Is the gatekeeper single-instance or per-edge?
- Input validation: are `roomId`, `fileId`, `localId`, chunk index all validated with strict patterns?
- XSS: does `linkify.ts` sanitize URLs? Does the chat render HTML?

#### 3c. Reliability & Error Handling
- What happens when `fetch()` for join/create throws a network error?
- What happens when WebSocket `onopen` never fires?
- What happens when the server sends a malformed JSON frame?
- What happens when `crypto.subtle.decrypt` fails (wrong key, corrupted data)?
- What happens when a file chunk PUT returns 500?
- What happens when the room expires mid-file-upload?
- What happens when the browser goes offline then comes back?
- What happens when the user has two tabs open to the same room?
- Does the ping/pong liveness detection actually work? Trace the full timer lifecycle.
- Does the ACK timeout correctly mark messages as "failed"? Can it race with a late ACK?

#### 3d. State Machine Correctness
- Read `room-machine.ts` — are all transitions valid? Can any event leave the machine in an impossible state?
- Read `store.ts` — does `connect()` guard against being called while already connected?
- What happens if `retry()` is called while in state `joined`?

#### 3e. Dead Code
- Search for exported functions/types that have ZERO importers
- Search for unused imports within each file
- Search for commented-out code blocks
- Search for unreachable branches (e.g., `default` cases in exhaustive switches)
- Check if all UI components in `src/components/ui/` are actually imported somewhere

```bash
# Helpful dead code search commands:
grep -r "export " src/lib/husk/ --include="*.ts" | while read line; do
  symbol=$(echo "$line" | grep -oP 'export (function|const|type|class) \K\w+')
  if [ -n "$symbol" ]; then
    count=$(grep -r "$symbol" src/ worker/ --include="*.ts" --include="*.tsx" -l | wc -l)
    if [ "$count" -le 1 ]; then
      echo "POTENTIALLY DEAD: $symbol in $line"
    fi
  fi
done
```

Also check every file in `src/components/ui/` — these are shadcn components. Many may be unused. List every unused one.

#### 3f. Config Sync
- Compare every constant in `src/lib/husk/config.ts` with `worker/src/config.ts`
- Are limits consistent? (MAX_PARTICIPANTS, FILE_CHUNK_BYTES, MAX_FILE_BYTES, MAX_ROOM_FILE_BYTES)
- Any magic numbers in code that should be config constants?

Write all findings to `FINDINGS.md` sections 3-6 **incrementally** as you go.

---

### STEP 4: Live Tests Against Production

Run the existing live tests one by one against the deployed backend. For each test:
1. Run it
2. Record pass/fail
3. If it fails, document the exact error
4. If it passes, note what it does NOT test

```bash
# Run from repo root. Node >= 24 required.
# Probe tests (raw WebSocket):
node live-tests/probe-a-core.mjs
node live-tests/probe-capacity.mjs
node live-tests/probe-d-files.mjs
node live-tests/probe-e-security.mjs
node live-tests/probe-eviction.mjs
node live-tests/probe-g-live.mjs
node live-tests/probe-g-static.mjs
node live-tests/probe-reconnect.mjs
node live-tests/probe-debug.mjs

# Drive tests (Playwright browser, requires playwright):
node live-tests/drive-a.mjs
node live-tests/drive-b.mjs
node live-tests/drive-b10.mjs
node live-tests/drive-c.mjs
node live-tests/drive-f.mjs
node live-tests/drive-g.mjs
node live-tests/drive-h.mjs
node live-tests/drive-i48.mjs
node live-tests/drive-reconnect.mjs
```

Record results in `FINDINGS.md § 8`. Run each test that fails a second time to check for flakiness.

---

### STEP 5: Custom Stress & Edge Case Tests

Create and run NEW test scripts in `live-tests/` to cover gaps you identified. At minimum, you MUST test:

#### 5a. Connection Stress
- Create a room, then open 10 WebSocket connections simultaneously
- Rapidly open/close connections to the same room (10x in 5 seconds)
- Connect, send a message, immediately disconnect, reconnect — does the message survive?

#### 5b. Message Reliability
- Send 50 rapid-fire messages from one client, verify all 50 arrive at the other client in order
- Send a message while the WebSocket is in CLOSING state
- Send a message with an empty payload `{iv: "", ct: ""}`
- Send a message with a 1MB payload (maximum ciphertext size)
- Send a message with invalid JSON

#### 5c. Room Lifecycle
- Create a room, let it sit idle, verify the idle timeout behavior
- Create a room that is already full (10 participants), try to join an 11th
- Create a room, have all participants leave, try to rejoin
- Create a room with an invalid room ID (too short, too long, special characters)

#### 5d. File Upload Stress
- Upload a file right at the 25MB limit
- Upload a file that exceeds the 25MB limit
- Start a file upload, disconnect mid-upload, reconnect — what happens to partial chunks?
- Upload files until the 100MB room limit, then try one more
- Upload a file with 0 bytes
- Download a file with a tampered signature
- Download a file with an expired ticket

#### 5e. Security Probes
- Connect to a room socket without a join token
- Connect with an expired join token
- Connect with a reused join token
- Send a frame with a spoofed `senderId`
- Send a frame with `t: "welcome"` (server-only frame type) from a client
- Try accessing `/room/INVALID/socket` with SQL injection or path traversal in roomId
- Send a binary WebSocket frame instead of text

#### 5f. Concurrency / Race Conditions
- Two clients send a message at the exact same millisecond — verify seq ordering
- Client A creates room, Client B joins before the welcome frame is processed
- Client sends `cancel` for a file that doesn't exist
- Rapidly create 5 rooms from the same IP — verify rate limiting kicks in

Write all test scripts to `live-tests/` and run them. Document every result in `FINDINGS.md § 8.3` and `§ 9`.

---

### STEP 6: Performance Analysis

#### 6a. Bundle Size
```bash
cd C:\Users\Ns8pc\Pictures\HUSK
pnpm run build 2>&1
```
Check the output for bundle sizes. Flag any chunk over 200KB. Check if tree-shaking is working (are unused shadcn components being bundled?).

#### 6b. Worker Cold Start
Time how long a room creation takes on a cold Durable Object vs. warm:
```bash
# Cold start (use a never-seen room ID)
time node -e "fetch('https://husk.ns8pc1.workers.dev/room/create', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({roomId:'zzzz0001'})}).then(r=>r.text()).then(console.log)"
```

#### 6c. Memory Leaks in Client Code
Search for:
- Event listeners added without cleanup (`addEventListener` without `removeEventListener`)
- `setInterval` without `clearInterval` on unmount
- Zustand subscriptions without unsubscribe
- WebSocket instances that may not be closed on component unmount

---

### STEP 7: Final Sweep

#### 7a. Service Worker
Read `public/sw.js` in full. Verify:
- Cache versioning — does it bust old caches on deploy?
- Does it serve stale content when a new version is available?
- Does it correctly skip WebSocket/API requests?

#### 7b. PWA Manifest
Read `public/manifest.webmanifest`. Check for:
- Correct icons, start_url, scope
- Valid theme_color and background_color

#### 7c. Cross-device Scenarios
Document any code paths that assume:
- Desktop screen size
- Mouse input (vs. touch)
- Fast network (no handling for slow 3G)
- Specific browser APIs that may not exist on iOS Safari or Firefox

---

### STEP 8: Compile Prioritized Fix List

After ALL steps are complete, create a prioritized fix list in `FINDINGS.md § 11` using this format:

```markdown
| # | Severity | Category | File(s) | Description | Evidence |
|---|----------|----------|---------|-------------|----------|
| 1 | CRITICAL | Race     | store.ts:L123 | Description... | Test X fails, or code reading shows... |
```

Severity levels:
- **CRITICAL**: Data loss, security breach, crash in normal usage
- **HIGH**: Frequent failure, message loss, connection drops users experience
- **MEDIUM**: Edge case failure, performance issue, dead code
- **LOW**: Code quality, minor optimization, style

---

### STEP 9: Generate Phase 2 Kickoff Prompt

After FINDINGS.md is complete with ALL sections filled, create a file `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md` that contains a COMPLETE, SELF-CONTAINED prompt for a NEW chat session. This kickoff prompt must:

1. Reference `prompts/findings/FINDINGS.md` and instruct the new agent to read it FIRST
2. List every fix from the prioritized fix list with exact file paths and line numbers
3. Instruct the agent to fix issues in priority order (CRITICAL → HIGH → MEDIUM → LOW)
4. For each fix, describe WHAT to change and WHY (the new agent has no context from this session)
5. After all fixes, instruct the agent to:
   - Run ALL unit tests (`pnpm test` in root AND `worker/`)
   - Run ALL live probe tests
   - Run at least 3 drive tests
   - Run the custom stress tests created in Step 5
6. After verification passes, instruct the agent to:
   ```bash
   # Commit
   cd C:\Users\Ns8pc\Pictures\HUSK
   git add -A
   git commit -m "fix: paranoid audit — [summary of fixes]"
   git push

   # Deploy backend
   cd worker
   pnpm run deploy
   cd ..

   # Build frontend
   pnpm run build

   # Deploy frontend
   worker\node_modules\.bin\wrangler.cmd deploy --compatibility-date 2025-01-01
   ```
7. After deployment, instruct the agent to run live tests AGAIN against the newly deployed version to confirm the fixes work in production
8. The kickoff prompt must also carry these constraints:
   - Use `pnpm` exclusively, never npm/yarn/bun
   - Do NOT modify frontend UI components unless absolutely necessary
   - Be token-efficient
   - Do NOT stop until everything is fixed, tested, and deployed
   - If a fix introduces a new failing test, fix the fix before moving on

---

## HARD RULES — VIOLATIONS ARE FAILURES

1. **Never assume.** If you think "this probably works", VERIFY IT.
2. **Never skip a section.** Every section must have findings or an explicit "VERIFIED: no issues found" with evidence.
3. **Never trust existing tests.** They may be outdated. Verify them against the current code.
4. **Never trust comments.** Verify every claim in every comment against the actual code.
5. **Flush findings incrementally.** Write to disk after every subsection, not at the end.
6. **Read files completely.** When analyzing a critical file, read EVERY line. Don't skim.
7. **Run failing tests twice.** Distinguish real failures from flakes.
8. **Log evidence.** For every finding, include the file, line number, and the problematic code or test output.
9. **Dead code is a finding.** Every unused export, unused import, and unused UI component must be listed.
10. **Config mismatches are findings.** Any divergence between client and worker configs is a bug.

---

## DONE CONDITION

You are DONE when:
- [ ] `prompts/findings/FINDINGS.md` has all 11 sections filled with real findings or verified-clean markers
- [ ] Every existing test has been run and its result documented
- [ ] At least 5 new stress/edge-case test scripts exist in `live-tests/`
- [ ] The prioritized fix list has every finding ranked by severity
- [ ] `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md` exists with a complete, self-contained prompt
- [ ] You have written a final summary at the top of FINDINGS.md

DO NOT STOP UNTIL ALL OF THE ABOVE ARE TRUE.
