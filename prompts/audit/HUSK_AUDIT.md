# HUSK — Paranoid Full-Codebase Audit (Ground Truth, read-only)

Auditor: Cline (agent), read-only session. Repo: `c:\Users\Ns8pc\Videos\HUSK`.
Git HEAD at audit time: `d91b774e294a2f17e646f8b9eeb57e7f8fe04391` (branch `main`).
File inventory: `git ls-files` = **186 files** (verified by count).
Rule applied throughout: a statement counts as "verified" only if this session opened the
file/line. Otherwise it is marked UNVERIFIED / COULD NOT CONFIRM.
Nothing in `src/`, `worker/`, `public/`, `tools/`, `live-tests/`, `e2e/` was modified.
`audit/` is the only thing written.

Vendored duplication note: `.agents/skills/install-anti-slop/assets/anti-slop/**` and
`tools/oxlint/anti-slop/**` were SHA256-hashed this session — all 21 files match
pair-for-pair, so the two trees are byte-duplicates (verified, not assumed).

---

## [00] Workflow & Conventions

Files covered:
- `prompts/HUSK-lovable-prompt.md`
- `prompts/PARANOID_AUDIT_PHASE_1.md`
- `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md`
- `prompts/PARANOID_AUDIT_PHASE_2_TEMPLATE.md`
- `prompts/audit/Husk audit prompt.md`
- `prompts/audit/Phases/phase-1-backend-architecture.md`
- `prompts/audit/Phases/phase-2-security-crypto.md`
- `prompts/audit/Phases/phase-3-reliability-races.md`
- `prompts/audit/Phases/phase-4-frontend-pwa.md`
- `prompts/audit/Phases/phase-5-design-accessibility.md`
- `prompts/audit/Phases/phase-6-performance-testgaps.md`
- `prompts/findings/FINDINGS.md`, `prompts/findings/README.md`
- `prompts/implementation/implementation_plan.md`
- `prompts/implementation/IMPLEMENTATION_PROMPT.md`
- `prompts/implementation/LIVE_TEST_SESSION_PROMPT.md`
- `prompts/implementation/NEXT_SESSION_PROMPT.md`
- `.agents/skills/install-anti-slop/SKILL.md`
- `.agents/skills/install-anti-slop/scripts/install.mjs`
- `.agents/skills/install-anti-slop/assets/anti-slop/**` (21 files; hash-identical to `tools/oxlint/anti-slop/**`)
- `skills-lock.json`, `.oxlintrc.json` (also counted in [01])

Read in full: YES for every file above **except** `prompts/audit/Husk audit prompt.md`
(235 lines; opened 1–25, 26–160 and 235-end — the middle block ~161–234, i.e. the Phase 4/5/6
checklists, was **not** opened; anything only in that range is UNVERIFIED).
`prompts/findings/FINDINGS.md` (276 lines) was read in three overlapping ranges — all lines seen.

Last verified: 2026-09-17

### What this repo's dev workflow actually is
- Three generations of prompt docs coexist in `prompts/`, and they describe **different app
  states**. Chronological order established from content (not filenames):
  1. `prompts/HUSK-lovable-prompt.md` — original build spec (PIN-based rooms, R2, KV,
     React 18). Stale relative to code → [12].
  2. `prompts/audit/Husk audit prompt.md` + `prompts/audit/Phases/phase-1..6*.md` — a
     "6-phase paranoid audit" of the PIN-era tree whose outputs are `docs/audit/*`
     (that directory does not exist in this repo → [12]).
  3. `prompts/PARANOID_AUDIT_PHASE_1.md` → `prompts/findings/FINDINGS.md` →
     `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md` — the *current* workflow. It ran 2026-08-31
     against commit `d64dd49` and its fixes landed in commit `db5531b`
     (`FINDINGS.md:4-5`; commit exists in `git log`).
- Current standard loop (`PARANOID_AUDIT_PHASE_2_TEMPLATE.md:13-41`,
  `PARANOID_AUDIT_PHASE_2_KICKOFF.md:89-117`):
  audit → findings file → kickoff prompt → fix CRITICAL→LOW → tests → commit/push →
  deploy relay → build + deploy frontend → re-run live tests → append outcome table to FINDINGS.
- Fix priority order is fixed: `CRITICAL → HIGH → MEDIUM → LOW`
  (`PARANOID_AUDIT_PHASE_2_TEMPLATE.md:16`).
- Required verification battery (`PARANOID_AUDIT_PHASE_2_KICKOFF.md:89-97`): root and worker
  `tsc --noEmit`; `pnpm test` in root **and** `worker/`; `pnpm run lint`; `pnpm run build`;
  then named live probes (`probe-a-core`, `probe-capacity`, `probe-d-files`,
  `probe-e-security`, `probe-eviction`, `probe-g-static`, `probe-reconnect`), at least
  `drive-a`, `drive-b`, `drive-reconnect`, and five stress scripts.
- Phase-1 hard rules still binding on any future audit/implementation session
  (`PARANOID_AUDIT_PHASE_1.md:439-450`): never assume; never skip a section; never trust
  comments or existing tests; flush findings incrementally; **dead code is a finding**;
  client↔worker config divergence is a bug. Phase-2 session also must not weaken security
  controls to make things work (`LIVE_TEST_SESSION_PROMPT.md:265-267`).

### Anti-slop rules (real, enforced, deliberately weakened)
- Rule set: `tools/oxlint/anti-slop/` = `index.ts`, 15 generic rules in `rules/`, 1 Effect
  rule in `effect/rules/`, 3 shared helpers. Registration: `.oxlintrc.json:26-28` +
  `:3-25` ignore list; script `oxlint --type-aware` (`package.json:16`).
- Rule severity **exactly as configured** (`.oxlintrc.json:29-45`):
  `no-chained-type-assertions` warn, `no-conditional-empty-object-spread` error,
  `no-known-value-widening` error, `no-module-mocking` error, `no-object-parameters` error,
  `no-reflect-apply` error, `no-reflect-get` error, `no-runtime-typeof` warn,
  `no-shape-in-symbol-names` error, `no-unknown-parameters` warn, `no-unknown-returns` error,
  `no-unknown-type-aliases` error, `no-unsafe-dictionary-type` warn,
  `no-widen-then-assert` error, `require-safety-comment-for-type-assertion` warn.
- The install skill prescribes **error** for all 15
  (`.agents/skills/install-anti-slop/SKILL.md:59-79`). This repo downgraded exactly 5 to
  `warn` and disabled none; the downgrade is deliberate — recorded as fix #11 in
  `FINDINGS.md:19` ("5 stylistic rules downgraded to warn, tests/live-scripts ignored —
  they were never enforced and fought the app's deliberate boundary-parsing design").
- Gate coverage gaps (verified): ignores include `tools/oxlint/anti-slop/**`, `live-tests/**`,
  `e2e/**`, `worker/tests/**` and **all `src/**/*.test.ts(x)`** (`.oxlintrc.json:17-24`).
  So the anti-slop gate never runs on tests or live scripts.
- The Effect plugin (`tools/oxlint/anti-slop/effect/index.ts` +
  `effect/rules/no-service-constructor-imports.ts`) is **not registered**. Consistent with
  `SKILL.md:95` (enable only for a direct `effect` dependency; `effect` is absent from both
  package.jsons).
- Skill provenance: `skills-lock.json:4-9` — `install-anti-slop` from `dmmulroy/anti-slop`
  (github), path `skills/install-anti-slop/SKILL.md`, `computedHash b903a7ac…`.
  Installer `.agents/skills/install-anti-slop/scripts/install.mjs` (18 lines, not executed).
- Both vendored copies must be edited together if either is changed.

### Coding/agent constraints stated in docs (worth preserving)
- **pnpm exclusively**, `pnpm dlx` instead of `npx` (`PARANOID_AUDIT_PHASE_2_KICKOFF.md:10`;
  same in the workspace AGENTS.md). "Never `npm install` / `pip install`"
  (`IMPLEMENTATION_PROMPT.md:27`).
- "Do NOT modify `src/components/husk/*` UI components" was a Phase-2 scoped constraint
  (`PARANOID_AUDIT_PHASE_2_KICKOFF.md:11`), **not** permanent — the PIN-removal redesign
  rewrote them (`implementation_plan.md`).
- Token-efficiency audit protocol: targeted ranges, batched greps, incremental flush
  (`PARANOID_AUDIT_PHASE_1.md:5-11`; `prompts/audit/Husk audit prompt.md:55-60`).
- Stop-and-ask rule: if a fix needs user-only input (Cloudflare credentials, deployment,
  a tradeoff), stop rather than guess (`IMPLEMENTATION_PROMPT.md:23-25`).
- No CI exists — `git ls-files` contains no `.github/`; "CI" mentions in
  `phase-5-design-accessibility.md:23` and `phase-6-performance-testgaps.md:49` are
### Prior-phase logs (state of the tree *per those logs*; not re-verified by me)
- `FINDINGS.md:4-5`: Phase 2 finished 2026-08-31 at commit `db5531b`; all 22 findings addressed;
  relay deployed as `husk` version `16eb8204`, frontend as `ns81000-husk` version `c0aec268`.
- `FINDINGS.md:33-39`: at that time root `pnpm test` = **120/120**, worker = **26/26**, lint
  and anti-slop both exit 0, main bundle **307 KB / 95.75 KB gzip**, `drive-a` never green.
- `FINDINGS.md:54-55`: that audit ran on a severely degraded network (`*.workers.dev` ~35 s per
  request, TLS drops); flaky results were re-run and classified, and three sub-scenarios were
  deferred to Phase 2.
- Superseded, mutually inconsistent test-count claims elsewhere (do not trust any of them):
  `133/133` (`FINDINGS.md:46`), `107/107` (`LIVE_TEST_SESSION_PROMPT.md:54`),
  `100/100` + worker `19/19` (`NEXT_SESSION_PROMPT.md:43-45`), `37 tests`
  (`phase-3-reliability-races.md:5,76`), README badge `147 passing` (`README.md:17`),
  README body `121 unit + 26 integration` (`README.md:318-319`). **Current counts must be
  re-measured, not quoted.** See [05] and [10].
- `FINDINGS.md:22`: `RECENT_SENDS_LIMIT` raised 500→1000. `FINDINGS.md:25`: `seenRelays`
  capped at 1000 (Map-based oldest-delete). `FINDINGS.md:10`: create limit =
  `CREATE_MAX_ATTEMPTS = 5` per `JOIN_WINDOW_SECONDS`, 429 `{error, retryAfter}`.
  `FINDINGS.md:17`: fetch timeouts `AbortSignal.timeout(15_000)` (create/join/grant) and
  `60_000` (chunk PUT / file GET). `FINDINGS.md:26`: `URL.revokeObjectURL` deferred 10 s.
  All of these are claims about current code that I re-verify in [03]/[04]/[06].
- `FINDINGS.md:175-176`: claims no client↔worker config divergence and that all server
  constants live in `worker/src/config.ts`. Re-verified in [04].
- `phase-1-backend-architecture.md:9-39,138-149`: the R2→SQLite migration plan and its
  rationale (Free plan, KV placeholder ID, broken file download route). Describes the
  pre-migration tree; current `worker/wrangler.toml` re-read in [02].
- `NEXT_SESSION_PROMPT.md:319-341` plans `docs/implementation/SUMMARY.md` and
  `phase-N-log.md` files; those files are **absent from this repo** — the doc trail is
  incomplete (a reviewer cannot reconstruct the implementation history from the repo).

### Path/dir drift that will bite an agent running these prompts
- Prompt docs hardcode `C:\Users\Ns8pc\Pictures\HUSK`
  (`PARANOID_AUDIT_PHASE_2_KICKOFF.md:101`, `PARANOID_AUDIT_PHASE_1.md:135-148`,
  `NEXT_SESSION_PROMPT.md:19-32`) and `docs/audit/…`, `docs/implementation/…` paths.
  Actual checkout is `c:\Users\Ns8pc\Videos\HUSK` and contains **no `docs/` directory**.
- `LIVE_TEST_SESSION_PROMPT.md:15-24` mandates reading
  `prompts/implementation/{SUMMARY,phase-1-log,phase-2-log,phase-3-log,phase-4-log,phase-6-log}.md`
  — none exist.
- `prompts/audit/Husk audit prompt.md:39` expects `worker/r2-lifecycle.json` — absent.
- `PARANOID_AUDIT_PHASE_1.md:53-59` file map lists modules deleted by the PIN-removal redesign:
  `src/lib/husk/pin.ts`, `src/components/husk/keypad.tsx`, `src/routes/r.$pin.tsx`,
  `pin.test.ts` (`implementation_plan.md:10,401` confirms the removal intent).
- Live URLs in docs (`PARANOID_AUDIT_PHASE_1.md:62-63`): relay
  `https://husk.ns8pc1.workers.dev` (matches `.env.production:4`), frontend
  `https://ns81000-husk.ns8pc1.workers.dev` (must match `ALLOWED_ORIGINS`, checked in [02]).
  **No network requests were made this session** — production state is not re-verified.

### Product intent captured from the originating spec (feeds future feature work)
- `HUSK-lovable-prompt.md:11-15` priority order: **Secure > Reliable > Simple > Scalable**.
- `HUSK-lovable-prompt.md:30` — explicit bans that constrain any new feature: Supabase,
  Firebase, unmodified component-library defaults, native unstyled form controls,
  **emoji anywhere in UI copy or code**, "Lorem ipsum", and
  **WebRTC/STUN/TURN** ("explicitly rejected earlier in this project for reliability
  reasons"). Directly relevant to a planned audio mode → [12]/[13].
- `HUSK-lovable-prompt.md:114-120` state-machine vocabulary and lifetimes (24 h max /
  30 min idle); `:145` abuse model (10 attempts / 5 min per IP **and** per PIN, generic errors).
- `HUSK-lovable-prompt.md:183-186` structural tokens: 4px base, spacing 4/8/12/16/24/32/48/96,
  radius 6/8/12/16/24/pill, 44×44px minimum touch target, Inter only, weights ≤5–600.
- `HUSK-lovable-prompt.md:194-206` component inventory, mobile "bottom thumb-zone"
  requirement, desktop "distinct layout", hover states on desktop.
- `HUSK-lovable-prompt.md:213-220` testing requirements incl. an axe audit per screen in both
  themes and a manual cross-device QA pass.
- `implementation_plan.md:5-24` — the *resolved redesign decisions* the shipped UI follows:
  8-char slug, link-only joins (no keypad), Inter, Grainient background on landing only,
  full-height single-column chat, bottom sheet (mobile) + drawer (desktop) room info,
  aligned tinted bubbles, inline system messages, one-click copy share, hexagon-derived PWA

---

## [01] Root Config & Scripts

Files covered: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `eslint.config.js`, `.oxlintrc.json`, `.prettierrc`, `.prettierignore`,
`.gitignore`, `.gitattributes`, `components.json`, `skills-lock.json`, `.env.production`,
`.env.a11y`, `LICENSE`, `README.md`, `pnpm-lock.yaml`, `worker/package.json`,
`worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/pnpm-workspace.yaml`,
`worker/pnpm-lock.yaml`.

Read in full: YES for all except the two lockfiles (`pnpm-lock.yaml`, 5,310 lines / 242 KB;
`worker/pnpm-lock.yaml`). Those are **intentionally skipped** as generated resolution data
and verified with targeted regex instead — every lockfile fact below states so explicitly.
No `.env` file exists in the tree (absent from `git ls-files` and from the root directory
listing); `.env.production` and `.env.a11y` are the only dotenv files present.

Last verified: 2026-09-17

### Scripts — verbatim (`package.json:6-17`)
| Script | Command |
|---|---|
| `dev` | `vite dev` |
| `build` | `vite build` |
| `build:dev` | `vite build --mode development` |
| `preview` | `vite preview` |
| `lint` | `eslint .` |
| `format` | `prettier --write .` |
| `test` | `vitest run` |
| `build:a11y` | `vite build --mode a11y` |
| `test:a11y` | `pnpm build:a11y && playwright test` |
| `lint:anti-slop` | `oxlint --type-aware` |

`worker/package.json:5-10`: `dev` = `wrangler dev`; `deploy` = `wrangler deploy`;
`typecheck` = `tsc --noEmit`; `test` = `vitest run`.
**There is no root-level typecheck script** — typechecking is `pnpm exec tsc --noEmit`
(per `README.md:320`, `PARANOID_AUDIT_PHASE_2_KICKOFF.md:90-91`).

### Package identity / dependency inventory
- Root package is `tanstack_start_ts`, `private: true`, `sideEffects: false`,
  `type: module` (`package.json:2-5`) — not named "husk".
- `package.json:18-20` adds `overrides.rolldown = "1.2.1"`.
- Runtime deps (`package.json:21-76`): 27 × `@radix-ui/*`, `@hookform/resolvers`,
  `@tailwindcss/vite`, `@tanstack/react-query ^5.101.1`, `@tanstack/react-router`
  (**pinned `1.170.18`**), `@tanstack/react-start` (**pinned `1.168.32`**),
  `@tanstack/router-plugin` (**pinned `1.168.23`**), `class-variance-authority`, `clsx`,
  `cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`, `lucide-react`, `ogl ^1.0.11`,
  `react ^19.2.0`, `react-day-picker`, `react-dom ^19.2.0`, `react-hook-form`,
  `react-resizable-panels`, `recharts`, `sonner`, `tailwind-merge`, `tailwindcss ^4.2.1`,
  `tw-animate-css`, `vaul`, `vite-tsconfig-paths`, `zod ^3.24.2`, `zustand ^5.0.15`.
- Dev deps (`package.json:77-101`): `@axe-core/playwright`, `@eslint/js`,
  `@lovable.dev/vite-tanstack-config ^2.15.0`, `@oxlint/plugins` (pinned `1.79.0`),
  `@playwright/test`, `@types/node ^22.16.5`, `@types/react`, `@types/react-dom`,
  `@vitejs/plugin-react`, `eslint`, `eslint-config-prettier`, `eslint-plugin-prettier`,
  `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`,
  `nitro 3.0.260603-beta`, `oxlint` (pinned `1.79.0`), `oxlint-tsgolint ^7.0.2001`,
  `playwright`, `prettier`, `typescript ^5.8.3`, `typescript-eslint`, `vite`
  (**pinned `8.1.5`**), `vitest ^4.1.11`.
- **No `packageManager` field** in either package.json; toolchain governance is documentation-only.
- `worker/package.json:11-16` has **devDependencies only** (`@cloudflare/vitest-pool-workers
  ^0.22.0`, `typescript ^5.8.3`, `vitest 4.1.11`, `wrangler ^4.0.0`). The Worker has **zero
  production dependencies**.
- `worker/pnpm-workspace.yaml:1-6` is **not** a workspace declaration — it is a pnpm
  `allowBuilds` allow-list (`esbuild`, `workerd`, `@cloudflare/workerd`, `miniflare`,
  `@cloudflare/vitest-pool-workers`). Root and `worker/` therefore have **independent
  lockfiles**, contradicting `prompts/audit/Husk audit prompt.md:22` ("root and `worker/`
  are a pnpm workspace"). **Code wins** → [12].
- No `vite-plugin-pwa` or `workbox` dependency exists anywhere (grep over `pnpm-lock.yaml`:
### Env vars and configuration inputs (complete set found in the tree)
- `VITE_WORKER_URL` — the only client env var. `.env.production:4` =
  `https://husk.ns8pc1.workers.dev`; `.env.a11y:4` = `http://127.0.0.1:8787`.
  The a11y value exists so the served production build's relay calls are same-origin and
  therefore interceptable by the Playwright specs (`playwright.config.ts:3-6`,
  `.env.a11y:1-3`). **This var is baked at build time** (`README.md:364-365`).
- `HUSK_TICKET_SECRET` — Worker secret only. Never in the tree; `.gitignore:20-21` covers
  `.wrangler/` and `.dev.vars`. Integration tests inject the literal
  `integration-test-secret` (`worker/vitest.config.ts:14-18`).
- `ALLOWED_ORIGINS` — Worker var in `worker/wrangler.toml` (read in [02]).
- `README.md:305-309` tells developers to create a root `.env` with `VITE_WORKER_URL`.
  **That file is not gitignored** — `.gitignore:1-42` lists `logs`, `*.log`, `node_modules`,
  `dist`, `dist-ssr`, `.output`, `.vinxi`, `.tanstack/**`, `.nitro`, `*.local`, `.wrangler/`,
  `.dev.vars`, editor dirs, `test-results/`, `playwright-report/`, `pw-*.log`, `verify.log`,
  `workspace_files_metadata.txt`, `live-tests/debug-*.png` — but **not `.env`**. Logged in [12].
- `vite.config.ts:1-6` documents that `@lovable.dev/vite-tanstack-config` already supplies
  TanStack devtools (dev-only, first), `tanstackStart`, `viteReact`, `tailwindcss`,
  `tsConfigPaths`, `nitro` (build-only, cloudflare default target), `VITE_*` env injection,
  the `@` alias, React/TanStack dedupe, error-logger plugins and sandbox detection — with an
  explicit warning not to add them again or the app breaks with duplicate plugins.

### TypeScript configuration
- Root `tsconfig.json:3-29`: target `ES2022`, `jsx react-jsx`, module `ESNext`,
  `lib [ES2022, DOM, DOM.Iterable]`, `types ["vite/client"]`, `moduleResolution "Bundler"`,
  `allowImportingTsExtensions`, `verbatimModuleSyntax: false`, `noEmit`, `skipLibCheck`,
  `strict: true`, `noUnusedLocals: false`, `noUnusedParameters: false`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noImplicitReturns`,
  `noPropertyAccessFromIndexSignature`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUncheckedSideEffectImports`; path alias `@/* → ./src/*`.
- Root `tsconfig.json:2` `include` = `src/**/*.ts`, `src/**/*.tsx`, `vite.config.ts`,
  `eslint.config.js`. **Consequence: `e2e/`, `worker/`, `tools/`, `live-tests/` and `public/`
  are not covered by the root typecheck.**
- `worker/tsconfig.json:2-13`: `include` = `src/**/*.ts`, `tests/**/*.ts`; target `ES2022`,
  module `ESNext`, `lib [ES2022, DOM, DOM.Iterable]`, `moduleResolution "Bundler"`,
  `strict`, `noEmit`, `skipLibCheck`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
  No path aliases, and `types` is unspecified (Workers runtime types arrive via the
  generated `worker-configuration.d.ts` / `@cloudflare/workers-types`, see [02]/[05]).

### Test wiring
- `vitest.config.ts:3-19` declares **two projects**: an inline `node` project
  (`environment: "node"`, `resolve: { tsconfigPaths: true }`, includes
  `src/**/*.test.ts`, `src/**/*.test.tsx`, **and `worker/src/**/*.test.ts`**) plus the
  string reference `"worker/vitest.config.ts"`. Net effect: `worker/src/*.test.ts` run in
  the root suite, while `worker/tests/**` run only from `worker/` (see below).
- `worker/vitest.config.ts:4-20`: project name `workers`, includes `tests/**/*.test.ts`
  only, `testTimeout: 30_000`, and the plugin
  `cloudflareTest({ main: "./src/index.ts", wrangler: { configPath: "./wrangler.toml" },
  miniflare: { bindings: { HUSK_TICKET_SECRET: "integration-test-secret" } } })`.
  This is the only place the **real Worker + Durable Object routes** are exercised.
- `playwright.config.ts:7-25`: `testDir "./e2e"`, `timeout 30_000`, `workers: 1`,
  `fullyParallel: false`, reporter `[["list"]]`, `baseURL http://127.0.0.1:8787`,
  viewport 1280×720, one project (`chromium` + `devices["Desktop Chrome"]`).
  `webServer.command` =
  `pnpm --dir worker exec wrangler dev --config ../.output/server/wrangler.json --compatibility-date 2026-08-01 --port 8787`,
  with `reuseExistingServer: !process.env.CI` and `timeout: 90_000`.
  **So `pnpm test:a11y` serves the built `.output/` artifact under wrangler and requires a
  prior `pnpm build:a11y`; it does not start the Vite dev server.**

### Lint / format details
- `eslint.config.js:8-20`: flat config via `tseslint.config`; `ignores` = `dist`,
  `.output`, `.vinxi`, `.wrangler`, `.agents/**`, `tools/**`, `live-tests/**`
  (the last three added by fix #11, comment: "Vendored skill/tool assets and live probe
  scripts: not app code").
- `eslint.config.js:21-49`: applies `js.configs.recommended` + `tseslint.configs.recommended`
  to `**/*.{ts,tsx}`, `ecmaVersion 2020`, `globals.browser`, plugins `react-hooks` +
  `react-refresh`, `reactHooks.configs.recommended.rules`, `no-restricted-imports` banning
  `server-only` (with a TanStack-specific message about `*.server.ts` /
  `@tanstack/react-start/server-only`), `react-refresh/only-export-components` warn with
  `allowConstantExport`, and `@typescript-eslint/no-unused-vars: "off"`.
- Line 50 appends `eslintPluginPrettier` (i.e. `eslint-plugin-prettier/recommended`), so
  `pnpm run lint` **also enforces Prettier formatting**.
- `.prettierrc`: `printWidth 100`, `semi true`, `singleQuote false`, `trailingComma "all"`.
- `.prettierignore` = `node_modules`, `dist`, `.output`, `.vinxi`, `pnpm-lock.yaml`,
  `package-lock.json`, `bun.lock`, `routeTree.gen.ts`. **It does not ignore `.agents/` or
  `tools/`**, so `pnpm format` would rewrite the vendored anti-slop trees. Latent
  diff-noise source, not a bug today.
### Build targets, ports and deploy recipes
- `vite.config.ts:9-14`: `tanstackStart: { server: { entry: "server" } }` — TanStack Start's
  bundled server entry is redirected to `src/server.ts` (the SSR error wrapper); nitro/vite
  build from there. `README.md:323` describes the output as
  "client + SSR + nitro cloudflare target", landing in `.output/`.
- `vite.config.ts:16-21`: the Vite dev server is forced to **port 3000**, with a comment
  explaining that Windows/WinNAT reserves ports 8015–8114 so the Lovable wrapper's default
  8080 fails with EACCES on this machine, and that the relay's dev `ALLOWED_ORIGINS` covers 3000.
- Ports in play, verified: frontend dev **3000** (`vite.config.ts:20`); relay dev **8787**
  (`.env.a11y:4`, `playwright.config.ts:7`, `README.md:308`).
- Three *different* deployment recipes are documented and they disagree — none was executed
  this session, so which is current is **UNVERIFIED**:
  1. `README.md:340-362`: `wrangler login`; `cd worker; pnpm wrangler secret put
     HUSK_TICKET_SECRET`; set `ALLOWED_ORIGINS`; relay `cd worker; pnpm run deploy`; frontend
     `pnpm run build` then `wrangler deploy --config .output/server/wrangler.json`.
  2. `PARANOID_AUDIT_PHASE_2_TEMPLATE.md:24-39` (and `PARANOID_AUDIT_PHASE_1.md:411-428`):
     commit/push from `C:\Users\Ns8pc\Pictures\HUSK`; relay `cd worker; pnpm run deploy`;
     frontend `pnpm run build` then
     `worker\node_modules\.bin\wrangler.cmd deploy --compatibility-date 2025-01-01`.
  3. `LIVE_TEST_SESSION_PROMPT.md:38-50`: relay deploy must run **from `worker/` with
     `<root>/.wrangler/deploy/config.json` deleted first**; frontend deploy must run **from
     repo root** using the pinned `wrangler.cmd` command because nitro stamps the build date
     into `.output/server/wrangler.json` and the pinned wrangler rejects "future" dates; set
     `VITE_WORKER_URL` before building.
- `LIVE_TEST_SESSION_PROMPT.md:33-43` also asserts the *deployed* environment's limits
  (Free plan 10 ms CPU — a `[limits]` block fails deploys with error 100328; 25 MB max file;
  100 MB per room; 10 participants; 10 joins / 5 min per IP+PIN with escalating backoff;
  31 min idle / 24 h max lifetime). Those are **claims in a prompt doc**, not code —
  re-verified against `worker/src/config.ts` and `worker/wrangler.toml` in [02]/[04].

### Lockfiles (structural verification only — not read line-by-line)
- `pnpm-lock.yaml`: `lockfileVersion: '9.0'`, `autoInstallPeers: true`,
  `excludeLinksFromLockfile: false` (lines 1-5); **412** top-level package entries
  (regex count of `^  <name>:` keys). Grep for `vite-plugin-pwa|workbox` → **no matches**.
  Grep for `wrangler` → 3 hits, all dependency-edge references to `wrangler: ^4.0.0`.
- `worker/pnpm-lock.yaml`: `lockfileVersion: '9.0'`; **98** top-level entries; pins
  `@cloudflare/vitest-pool-workers@0.22.0`, `@cloudflare/kv-asset-handler@0.5.0`,
  `@cloudflare/unenv-preset@2.16.1`, two `@cloudflare/workerd` platform builds
  (`1.20260815.1` and `1.20260825.1`) with matching `@cloudflare/workers-types` ranges.
  Deliberate skip reason: generated resolution data, no hand-authored contract in it.

### Odd/meta files worth noting
- `components.json:1-21` is a **stale shadcn config**: it declares `style: "new-york"`,
  `rsc: false`, `tsx: true`, `tailwind.css: "src/styles.css"`, `baseColor: "slate"`,
  `cssVariables: true`, `iconLibrary: "lucide"`, aliases `@/components`, `@/lib/utils`,
  `@/components/ui`, `@/lib`, `@/hooks`. `src/components/ui/` and `src/hooks/` were deleted
  in `db5531b` (`FINDINGS.md:21`), so the `ui`/`hooks` aliases point at nothing.
- `.gitattributes:1` is the single line `* text=auto eol=lf` (added by fix #11).
- `.gitignore:1-42` is quoted in full in the env-vars bullet above.
- `LICENSE:1-3`: MIT, "Copyright (c) 2026 Ns81000".
- `workspace_files_metadata.txt` is an **untracked, gitignored** file at repo root
  (85,287 bytes) generated 2026-09-16T20:47:32Z, claiming "Workspace Root:
  c:/Users/Ns8pc/Videos/HUSK; Total Files: 186 (180 text files, 6 binary files);
  Total Lines: 29,810; Total Size: 1.25 MB". Independent corroboration of the 186 count;
  it is **not** one of the 186 tracked files. `git status --porcelain` shows only `?? audit/`.
- `README.md` — the parts that matter as contract: E2EE + fragment-only key + zero-knowledge
  relay + DO-resident encrypted chunks + alarm purge + no identity (lines 52-59); invite
  format `/r/<roomId>#<key>` with an 8-char room id (63-68); 1 MiB file chunking (72-73);
  Node 24+ and pnpm-only requirement (292); the test command block (317-324); the three
  live-test families (331-334); the design-token table quoted as **hex**
  (`primary #7de925`, `dark #172112`, `surface #f6faf4`, `accent #3ce767`,
  `highlight #f2d8c4`, lines 372-379) — cross-checked against `src/styles.css` in [07].
- README badge/test claims (`README.md:17` "147 passing", `:318` "121 unit tests",
  `:319` "26 integration tests") are **three numbers that do not agree** and match none of the
  historical numbers in the prompt docs → all unverified, see [05]/[10].

---

## [02] Worker Backend — Overview

Files covered: `worker/wrangler.toml`, `worker/src/index.ts`, `worker/src/config.ts`,
`worker/src/types.ts`, `worker/src/globals.d.ts`, `worker/package.json`,
`worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/pnpm-workspace.yaml`.
(`gate.ts`, `rate-limit.ts`, `tickets.ts` are covered in [04]; `room.ts` in [03]; worker
tests in [05].)
Read in full: YES — `index.ts` (234 lines) and `room.ts` (628 lines) were re-read via
explicit line ranges after the first full read truncated; every line of both was displayed.
Last verified: 2026-09-17

### Deployment target — `worker/wrangler.toml` (all 34 lines read)
- `name = "husk"`, `main = "src/index.ts"`, `compatibility_date = "2025-01-01"` (lines 1-3).
- `[vars] ALLOWED_ORIGINS = "http://localhost:8080,http://localhost:3000,https://ns81000-husk.ns8pc1.workers.dev"`
  (line 9) — comma separated, no trailing slash. `localhost:8080` is retained even though the
  dev server runs on 3000 (`vite.config.ts:16-21`).
- Two DO bindings (lines 11-19): `HUSK_ROOMS → HuskRoom`, `HUSK_GATE → HuskGatekeeper`.
- One migration (lines 24-26): `tag = "v1"`, `new_sqlite_classes = ["HuskRoom", "HuskGatekeeper"]`
  — **both** classes SQLite-backed. Lines 21-23 state chunks are 1 MiB rows in the room's own
  storage and die with the alarm purge.
- **No `[[kv_namespaces]]`, no `[[r2_buckets]]`, no `[limits]` block, no `routes`/`workers_dev`
  key.** Lines 31-34 explain the missing `[limits]`: declaring CPU limits is rejected on the
  Free plan (error 100328); Free already applies a 10 ms default and local workerd does not
  meter CPU.
- `HUSK_TICKET_SECRET` is a documented secret (lines 28-29), not a var.
- This confirms the R2/KV→SQLite migration described in `phase-1-backend-architecture.md` is
  **done** in the current tree (code wins over the older audit docs).

### Entry point — `worker/src/index.ts` (234 lines)
- Re-exports both DO classes so wrangler can bind them (`export { HuskRoom } from "./room"`
  line 21; `export { HuskGatekeeper } from "./gate"` line 22).
- No `WorkerEntrypoint`/`DurableObject` class syntax — a plain default-exported object with
  `async fetch(request, env)` (lines 76-233). Routing is an `if`-chain on `url.pathname`
  (+ method); no router library.
- Route patterns (lines 46-48), exact:
  - `SOCKET_PATTERN = /^\/room\/([a-z0-9]{8})\/socket$/`
  - `FILE_INIT_PATTERN = /^\/room\/([a-z0-9]{8})\/file$/`
  - `FILE_OBJECT_PATTERN = /^\/room\/([a-z0-9]{8})\/file\/([0-9a-f-]{36})(?:\/(\d+))?$/`
  The 8-char id shape is duplicated here as literals **and** in `config.ts:15`
  (`ROOM_ID_PATTERN`) **and** in three DO-side regexes (`room.ts:287,292,303`) — six copies
  of one contract.
- Full route table as implemented:
  | Method + path | Behaviour | Line |
  |---|---|---|
  | `OPTIONS *` | `204` + CORS headers, empty body | 81-83 |
  | `POST /room/create` `{roomId}` | pattern check → `checkJoinAllowed(env,["create:"+ip],CREATE_MAX_ATTEMPTS)` → 429 refusals → DO `/create`; 409 `room_taken` passthrough; else `200 {ok:true,roomId}` | 86-111 |
  | `POST /room/join` `{roomId}` | `checkJoinAllowed(env,["ip:"+ip])` → 429 → **malformed id yields 404 `unavailable`, not 400** → DO `/join`; any failure collapses to 404 `unavailable`; success mints a one-time join token `"<exp>.<nonce>.<sig>"` bound to `roomId|ip|exp|nonce` | 114-155 |
  | `GET /room/<id>/socket?jt=…` (upgrade) | forwards to DO with `x-husk-ip` + `x-husk-join-token` headers; **no edge rate-limit and no edge membership check** — enforcement lives in the DO via the token | 157-169 |
  | `POST /room/<id>/file` `{size,member}` | edge validates size/member → DO `/file` → wraps grant into absolute `chunkUrls[]` + `download {exp,sig}`; 503 `unavailable` if the grant shape is wrong | 171-221 |
  | `PUT /room/<id>/file/<uuid>/<n>?exp=&sig=` | forwarded to DO unchanged (ticket verified in DO) | 223-230 |
  | `GET /room/<id>/file/<uuid>?exp=&sig=` | forwarded to DO unchanged | 223-230 |
  | anything else | `404 {error:"not_found"}` | 232 |
- **CORS** (lines 24-38): `Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS`;
  `Access-Control-Allow-Headers: content-type`; `Access-Control-Max-Age: 86400`;
  `Vary: Origin`; `Access-Control-Allow-Origin` set **only** when `Origin` is non-empty and
  allowlisted. Line 33 comment: "No ACAO header at all for disallowed origins: the browser
  blocks the read." Nuances that matter for new work: a disallowed origin still receives a
  `204` on `OPTIONS` and identical status codes on real requests; there is **no `Origin`
  enforcement on request handling** — the allowlist only governs whether the browser may read
  the response; and WebSocket upgrades are never CORS-preflighted, so the join token is the
  sole gate on `/socket`.
- Helpers: `json()` (40-44) sets `content-type: application/json` + CORS headers;
  `forwardWithCors()` (61-65) copies the DO's own headers, overlays CORS and streams
  `response.body` without buffering; `readJson()` (51-58) returns `{}` on parse failure so
  callers answer `400 bad_request` via pattern checks instead of throwing.
- File-grant wiring (67-74, 197-221): the edge re-validates `fileId`, `putExpiresAt`,
  `getExpiresAt`, `getSig` and `Array.isArray(chunkSigs)` before building URLs of the form
  `<relay-origin>/room/<roomId>/file/<fileId>/<n>?exp=<putExpiresAt>&sig=<sig>`. The grant's
  `chunks` count is **not** forwarded to the client.
- **Cast convention to copy in new code:** every `as` cast carries a `// SAFETY:` comment
  (`index.ts:53,197`). Enforced (severity `warn`) by
  `tools/oxlint/anti-slop/rules/require-safety-comment-for-type-assertion.ts:39-61`, which
  requires a `SAFETY:` comment before the assertion or its containing statement, except for
  `as const`. All SAFETY sites in the repo (grepped): `src/lib/husk/api.ts:94`,
  `src/lib/husk/crypto.ts:58,70,85,112`, `src/lib/husk/files.ts:107`,
  `worker/src/gate.ts:27,64`, `worker/src/index.ts:53,197`, `worker/src/rate-limit.ts:111`,
  `worker/src/room.ts:67,329`.

### Server-side constants — `worker/src/config.ts` (all 59 lines read; authoritative)
| Constant | Value | Line |
|---|---|---|
| `MAX_PARTICIPANTS` | `10` | 3 |
| `ROOM_MAX_LIFETIME_MS` | `24*60*60*1000` | 6 |
| `ROOM_IDLE_TIMEOUT_MS` | `30*60*1000` | 9 |
| `ALARM_INTERVAL_MS` | `60*1000` | 12 |
| `ROOM_ID_PATTERN` | `/^[a-z0-9]{8}$/` | 15 |
| `JOIN_WINDOW_SECONDS` | `300` | 18 |
| `JOIN_MAX_ATTEMPTS` | `10` | 19 |
| `JOIN_BACKOFF_BASE_SECONDS` | `60` | 20 |
| `JOIN_BACKOFF_MAX_SECONDS` | `3600` | 21 |
| `CREATE_MAX_ATTEMPTS` | `5` | 28 |
| `MAX_FILE_BYTES` | `25*1024*1024` | 36 |
| `MAX_ROOM_FILE_BYTES` | `100*1024*1024` | 37 |
| `FILE_CHUNK_BYTES` | `1024*1024` | 38 |
| `FILE_ROW_PREFIX` | `"file:"` | 41 |
| `FILE_META_PREFIX` | `"file-meta:"` | 42 |
| `FILE_BYTES_USED_KEY` | `"file-bytes-used"` | 43 |
| `ROOM_STATE_KEY` | `"room-state"` | 46 |
| `TICKET_TTL_SECONDS` | `300` | 49 |
| `CIPHER_OVERHEAD_BYTES` | `16` | 56 |
| `JOIN_TOKEN_TTL_SECONDS` | `60` | 59 |

Line 1 declares this the "Server-side counterpart of `src/lib/husk/config.ts`" with
"No magic numbers inline"; lines 31-34 justify 1 MiB chunks against the 2 MB per-row DO
ceiling; lines 51-55 justify `CIPHER_OVERHEAD_BYTES` (the AES-GCM 128-bit tag on the final
partial chunk of an upload). `LIVE_TEST_SESSION_PROMPT.md:43` claims a "31 min idle"
timeout — code says 30 min plus an alarm cadence of up to 60 s, i.e. a rounded restatement,
not a contradiction.

### Ambient runtime types (hand-rolled — no `@cloudflare/workers-types` dependency)
- `worker/src/types.ts` (46 lines): `DurableObjectId`, `DurableObjectStub`,
  `DurableObjectNamespace`, `DurableObjectStorageListOptions`, `DurableObjectStorage`
  (`get/put/delete/list/deleteAll/setAlarm/getAlarm`), `DurableObjectState`
  (`storage`, `acceptWebSocket`, `getWebSockets`, `blockConcurrencyWhile`), and
  `Env = { HUSK_ROOMS, HUSK_GATE, HUSK_TICKET_SECRET, ALLOWED_ORIGINS }` (lines 41-46).
  Header (lines 1-5) explains this keeps the full workers-types package out of the frontend build.
- `worker/src/globals.d.ts` (19 lines): augments `WebSocket` with
  `serializeAttachment`/`deserializeAttachment`/`accept`, declares
  `class WebSocketPair { 0; 1 }`, and adds `ResponseInit.webSocket?: WebSocket | null`
  (needed for the `101` upgrade response). No generated `worker-configuration.d.ts` is
  tracked, so these two files are the entire runtime type surface.

### Error-handling pattern (consistent across the Worker)
- Boundary parsing: `try { … as Shape } catch { return {error:"bad_request"} }`, always with a
  `// SAFETY:` justification (`index.ts:51-58`, `gate.ts:25-31`, `room.ts:59-89,327-333`).
- Existence oracles: `/room/join` failures and every socket-route failure collapse to a
  generic `404 unavailable` (`index.ts:125-135`; `room.ts:203-228,242-247`), including
  malformed, expired and replayed join tokens.
- Non-generic codes exist only where they leak nothing: `409 room_taken`, `403 room_full`,
  `403 forbidden` (membership/ticket), `400 bad_request`, `507 room_file_budget`,
  `503 unavailable`.
- Swallowed failures are commented, never silent-by-accident: `broadcast()` wraps each
  `socket.send` in `try {} catch {}` ("A dead socket is closed by the runtime; nothing to
  recover here", `room.ts:165-169`); socket closes are wrapped similarly (`room.ts:607-613`).
- **No logging anywhere in the Worker** — a repo-wide `console.` grep returns hits only in
  `src/`: `store.ts:448` (warn), `error-capture.ts:12,52,55,56`, `__root.tsx:51`,
  `server.ts:120,145`, `start.ts:12`. There is no observability hook in Worker code.

### Risks spotted in this area (logged only — see [12])
- The room-id contract is copied six times (`index.ts:46,47,48`, `config.ts:15`,
  `room.ts:287,292,303`); changing it is a multi-site edit with no single source of truth.
- `/room/<id>/socket` has no edge throttle: without a token you cannot join, but every attempt
  still invokes a Durable Object, so the route is a request-quota amplifier on a plan that
  bills requests/day.
- The room id is **not a secret**: `/room/create` accepts a caller-supplied id (pattern-checked
  only) and the client regenerates on collision, so ids are guessable-by-enumeration and in
  fact enumerable — 36⁸ ≈ 2.8 × 10¹² values, gated by the join budget. Security rests entirely
  on the fragment key. Any future feature must not treat the room id as a capability.

---

## [03] Worker — Room/Protocol (room.ts)

Files covered: `worker/src/room.ts` (628 lines, every line displayed this session).
Read in full: YES.
Last verified: 2026-09-17
Length note: this section deliberately exceeds the ~80–150-line guidance (it is the contract
future chat modes must match) and is split into `###` subsections inside this one heading.

### Purpose and lifetime model
- One `HuskRoom` Durable Object instance per room id, addressed by
  `env.HUSK_ROOMS.idFromName(roomId)` (`index.ts:99,128,164,186,227`).
- Header comments (lines 1-15) state the design: state lives in memory, the object relays
  opaque ciphertext it can never read, encrypted chunks live in the same object's SQLite
  storage as 1 MiB rows, and **closure is driven only by the alarm, never by a client**.
- In-memory fields (lines 92-103): `seq`, `createdAt`, `emptySince`, `exists`, `bytesUsed`,
  `fileOpQueue` (promise chain serialising byte-accounting mutations), `recentSends` (Map,
  in-memory dedupe), `closeHandled` (WeakSet of sockets already close-handled).
- Persisted state (lines 47-51, 133-140): key `"room-state"` = `{createdAt, emptySince, seq}`
  written by `persistState()`; plus `"file-bytes-used"` (lines 122-123, 356, 497). Everything
  else is volatile. The constructor rehydrates via
  `blockConcurrencyWhile(restoreVolatileState)` (lines 105-131) so an evicted instance resumes
  the same `seq`, deadlines and byte budget.
- `expiresAt()` = `createdAt + 24 h` (lines 500-502) — a hard cap independent of activity.

### WebSocket acceptance (`fetch`, lines 199-284)
1. Non-upgrade request → **426 "Expected websocket"** (lines 200-202).
2. `ip` from header `x-husk-ip`, `token` from `x-husk-join-token` (lines 205-206); both
   injected by the edge (`index.ts:166-167`). The DO trusts those headers; it is reachable only
   through the edge route, so there is no direct-client spoofing path in production.
3. Token shape `"<exp>.<nonce>.<sig>"`, exactly 3 parts; signed payload is
   `` `${roomId}|${ip}|${tokenExpiresAt}|${tokenNonce}` `` with operation `"join"`
   (lines 207-228). The nonce exists because two same-second joins from one IP would otherwise
   mint byte-identical tokens and burn each other's (comment lines 207-209).
4. Invalid/expired/replayed/malformed token → `404 "unavailable"` (lines 226-228, 242-244).
5. One-time burn: check-then-write inside `state.blockConcurrencyWhile` under key
   `jt:<signature>` (lines 229-241) — the Phase-2 fix for the token TOCTOU race. Burned
   signatures persist until `deleteAll()`.
6. `!this.exists` → `404 "unavailable"` (lines 245-247).
7. Capacity: `participants().length >= MAX_PARTICIPANTS` → **`403 "room_full"`** (lines 248-252);
   comment claims atomicity because check and accept are synchronous in the single-threaded object.
8. Accept: `new WebSocketPair()`, `crypto.randomUUID()` participant id, `acceptWebSocket(server)`,
   `serializeAttachment({id, joinedAt})`, `emptySince = 0`, `persistState()` (lines 254-263).
   **The room DO uses hibernatable sockets** (`state.acceptWebSocket`) and therefore implements
   `webSocketMessage`/`webSocketClose`/`webSocketError` rather than `addEventListener` — the
   natural reuse point for any future real-time feature (see [12]).
9. First frame to the joining socket is `welcome` (265-273); then `presence join` is broadcast to
   everyone *except* the joiner (274-282); response is
### Message protocol — client → server (`parseClientFrame`, lines 59-89)
Exactly three frame types; anything else is rejected:
| Frame | Required fields | Validation | Line |
|---|---|---|---|
| `{t:"ping"}` | — | none | 72-74 |
| `{t:"cancel", fileId}` | `fileId` non-empty string | `String(... ?? "")` | 75-81 |
| `{t:"send", localId, payload:{iv, ct}}` | `localId`, `payload.iv`, `payload.ct` all non-empty strings | `String(... ?? "")` coercion then non-empty check | 82-88 |
- `JSON.parse(String(data))` failure → `null` → the socket receives
  `{"t":"error","code":"bad_request"}` (`webSocketMessage` lines 505-509). A malformed frame
  does **not** close the socket.
- There is **no size cap, no per-message rate limit, and no per-socket message budget** in
  code beyond platform limits; payload contents are never inspected (opaque base64 `iv`/`ct`).
- `webSocketMessage(socket, data)` accepts `string | ArrayBuffer` and does `String(data)` —
  a binary frame would be stringified into garbage and rejected as `bad_request`.

### Message protocol — server → client (every outbound frame, exact shapes)
| Frame | Shape | Sent to | Line |
|---|---|---|---|
| `welcome` | `{t:"welcome", you:<uuid>, participants:[{id,joinedAt}…], seq:<n>, expiresAt:<ms>}` | joining socket only | 265-273 |
| `presence` | `{t:"presence", event:"join", who:<uuid>, participants:[…]}` | all except joiner | 274-282 |
| `presence` | `{t:"presence", event:"leave", who:<uuid\|"unknown">, participants:[…]}` | all remaining | 580-585 |
| `relay` | `{t:"relay", seq:<n>, senderId:<uuid>, localId:<str>, ts:<ms>, payload:{iv,ct}}` | **all sockets including the sender** (`broadcast(relay)` with no `except`) | 542-550 |
| `ack` | `{t:"ack", localId:<str>, seq:<n>}` | sending socket (also sent on dedupe) | 533, 551 |
| `pong` | `{t:"pong"}` | pinging socket | 511-514 |
| `error` | `{t:"error", code:"bad_request"}` | offending socket | 507 |
| `closed` | `{t:"closed", reason:"expired"\|"idle"}` | broadcast, immediately before all sockets are closed with code `1000 "room_closed"` | 606-613 |

`senderId`, `ts` and `seq` are server-assigned and unforgeable by a client. `expiresAt` is an
absolute epoch-ms value.

### Sequence, dedupe and ordering semantics (`webSocketMessage`, lines 504-552)
- Dedupe key = `` `${attachment.id}:${localId}` `` (line 528) — per **socket**, not per
  participant or room. A replayed `localId` on the same socket is re-acked with the **original**
  seq and never relayed twice (lines 529-535).
- `recentSends` is a `Map` capped at `RECENT_SENDS_LIMIT = 1000` (lines 100-101) with
  **oldest-key eviction** (`this.recentSends.keys().next().value`, lines 554-562). A very late
  resend whose entry was evicted therefore receives a **new** seq and is relayed again.
- **`recentSends` is never persisted** — after an isolate eviction the map is empty, so any
  resend of a pre-eviction frame is treated as new and duplicated → [12].
- Order of operations on a `send` (lines 537-551): `seq += 1` → `rememberSend` →
  `await this.persistState()` → `broadcast(relay)` → `ack`. Every relayed message therefore
  costs one storage write of the whole room-state row before any peer sees it.
- `ts: Date.now()` is display metadata; ordering authority is `seq` (client `orderedEntries`
  is checked in [07]).
- `broadcast` (lines 159-171) stringifies once and writes to every socket from
  `state.getWebSockets()`, skipping the `except` argument (unused for `relay`), swallowing
  per-socket send errors.
- `participants()` (lines 142-150) maps `getWebSockets()` → `deserializeAttachment()` and drops
  sockets with a null attachment; `isLiveMember(id)` (lines 152-157) is the membership test used
  for file grants. Both are O(sockets) over the live socket list, so the socket list **is** the
### Room lifecycle state machine (`fetch` lines 176-197; `alarm()` lines 592-627)
- `POST /room/<id>/create` (DO side): if `this.exists` → **409 `room_taken`** (178-180);
  otherwise sets `exists=true`, `createdAt=now`, `emptySince=now`, clears `recentSends`, arms
  `alarm(now + ALARM_INTERVAL_MS)` and persists (185-192). Then the capacity check (193-195) →
  403; success `{ok:true, expiresAt}` (196).
- `POST /room/<id>/join`: if `!this.exists` → **404 `unavailable`** (181-184; comment: "never
  reveal whether a room exists"); capacity → 403 (193-195); else `{ok:true, expiresAt}` (196).
  **`/join` does not register a participant** — it is a pure existence+capacity probe; the real
  participant exists only when the socket upgrade succeeds. Two concurrent joins can therefore
  both pass the `/join` capacity check while only one can open a socket.
- Alarm cadence: armed at creation and re-armed by `alarm()` to `now + 60_000` whenever the room
  is neither expired nor idle (line 626). `alarm()` is the **only** closer:
  `expired = now >= createdAt + 24 h`; `idle = participants().length === 0 && emptySince > 0 &&
  now - emptySince >= 30 min` (599-603). On either condition (605-623): broadcast
  `{t:"closed", reason}` → close every socket `1000 "room_closed"` → reset
  `exists/seq/createdAt/emptySince/bytesUsed` and clear `recentSends` → `storage.deleteAll()`
  (which also removes the room-state row, the burn keys and every file row) → return
  **without re-arming**. A purged room answers 404 on `/join` afterwards.
- `emptySince` is set in `webSocketClose` only when the departing socket was the last
  participant (573-579) and cleared on every successful accept (262).
- `webSocketError` simply delegates to `webSocketClose` (588-590); a `WeakSet` (`closeHandled`)
  dedupes the double delivery (comment 565-567). The leaving participant is identified from the
  socket attachment and excluded from the broadcast `participants` list.

### File routes inside the DO (311-498)
- `POST /room/<id>/file` → `handleFileInit` (311-321) serialises every call through
  `fileOpQueue` so byte accounting cannot interleave, then `reserveFileStorage` (323-387):
  404 if `!exists`; `400` on unparseable body or invalid size (`<= 0 || > 25 MiB`);
  **`403 forbidden` unless `isLiveMember(member)`**; **`507 room_file_budget`** when
  `bytesUsed + size > 100 MiB`; then `fileId = crypto.randomUUID()`,
  `chunks = max(1, ceil(size / 1 MiB))`, writes `file-meta:<fileId>` =
  `{size, chunks, createdAt, owner: member}`, increments and persists `bytesUsed`, mints one
  `"chunk"` ticket per index over `${roomId}/${fileId}/${index}` expiring in
  `TICKET_TTL_SECONDS = 300`, and one `"get"` ticket over `${roomId}/${fileId}` expiring at
  `roomExpiry`; returns `{fileId, chunks, putExpiresAt, chunkSigs, getExpiresAt, getSig}`.
  Its `roomId` parameter is used **only** inside ticket keys — all storage keys derive from
  `fileId`, so the parameter is otherwise vestigial.
- `PUT /room/<id>/file/<fileId>/<n>` → `handleChunkPut` (389-430), in order: verify `"chunk"`
  ticket (expiry in seconds vs `Date.now()`; `tickets.ts:57-59` rejects `NaN` and
  `expiresAt*1000 < now`) → `403 forbidden`; meta missing or `index >= meta.chunks` → `404`;
  row already present → **`409 chunk_exists`** (write-once; the client treats 409 as success,
  comment 415-417); read body; empty body or `> 1 MiB + 16` → `400`; **re-read meta after the
  await** and 404 if the reservation vanished (the Phase-2 cancel/upload orphan fix, comment
  423-424); `storage.put("file:<fileId>:<index>", ArrayBuffer)`; `{ok:true}`.
- `GET /room/<id>/file/<fileId>` → `handleFileGet` (432-472): verify `"get"` ticket → 403; meta
  → 404; then a **pull-based `ReadableStream`** reading exactly one 1 MiB row per `pull()`,
  closing after `meta.chunks` rows and calling `controller.error(new Error("missing chunk"))` if
  a row is absent mid-download. Response headers: only `content-type:
  application/octet-stream` — no content-length, no range support, no cache directives.
- `cancel` frame → `deleteFileRows` (474-498), also serialised through `fileOpQueue`: loads
  meta, **returns silently unless `meta.owner === attachment.id`**, deletes every row under
  `file:<fileId>:` plus the meta row, decrements `bytesUsed` clamped at 0, persists.
- Reuse note for future features: the file capability model is "HMAC ticket in a URL, issued only
  to a live member, single-use by storage immutability". **Any peer-to-peer session-setup data
  (e.g. acoustic-mode handshake) can reuse this exact pattern — membership check in the DO →
### Room-level observations / risks (logged only — see [12])
- `persistState()` runs on **every** message (`room.ts:541`) — one SQLite write of the whole
  room-state row per chat message, on the same object that also stores 1 MiB file rows. It is
  what makes `seq` survive eviction; it is also the dominant per-message cost on a plan with a
  10 ms CPU budget.
- `recentSends` is in-memory only ⇒ duplicate relays after an eviction (the older audit's LOW
  finding, `FINDINGS.md:312`, is only partially addressed: the cap was raised, not persisted).
- `payload` is opaque: the server cannot validate `iv`/`ct` length, base64 shape or size, and
  there is no per-socket message-rate limit at either layer. A joined participant can make the DO
  do one storage write + N socket writes per frame as fast as the platform allows.
- `broadcast(relay)` includes the sender, so **the sender receives its own relay frame** and must
  self-filter (client behaviour verified in [07]).
- `handleFileGet` sends no `Cache-Control`/`X-Content-Type-Options`; it is the only Worker
  response with no hardening header at all (low impact — same-origin ciphertext).
- `welcome.participants` exposes peer participant ids and join timestamps to room members only
  (by design, and needed for presence UI).
- `alarm()` closes sockets with code `1000 "room_closed"` — a *normal* close code. Clients that
  distinguish "room gone" from "network blip" must use the preceding `{t:"closed"}` frame, not
  the close code (client-side handling checked in [06]/[07]).

---

## [04] Worker — Auth, Tickets, Rate Limiting

Files covered: `worker/src/tickets.ts` (69 lines), `worker/src/rate-limit.ts` (120 lines),
`worker/src/gate.ts` (112 lines) — all read in full — plus the auth-relevant paths of
`worker/src/index.ts` (86-169) and `worker/src/room.ts` (176-252, 311-345, 474-498) already
quoted in [02]/[03]. Tests for these modules are in [05].
Read in full: YES.
Last verified: 2026-09-17

### The complete session/auth model (there is no account system)
- **No cookies, no sessions, no passwords, no user records.** Grepped: the Worker sets no
  `Set-Cookie` and has no user storage. Identity inside a room is a per-socket UUID minted by
  the DO at accept time (`room.ts:257`, sent to the client in `welcome.you`).
- Authorization is capability-based, in three layers:
  1. **Join token** — minted by the edge only after a rate-limited `/room/join`
     (`index.ts:136-154`), consumed exactly once by the DO during socket upgrade
     (`room.ts:207-244`). TTL `JOIN_TOKEN_TTL_SECONDS = 60`; bound to the caller's IP; contains
     a per-mint nonce.
  2. **Membership** — the DO checks `isLiveMember(member)` (a live socket attachment id) before
     it will reserve file storage (`room.ts:339-342`). There is no other membership check
     anywhere; relay and cancel are authorized purely by "you hold an accepted socket".
  3. **Transfer tickets** — HMAC capabilities in URLs for chunk PUT and file GET.
- Room ids are **not** capabilities (see [02]); the room key in the URL fragment is never sent
  to the Worker, and no Worker code reads or stores a key (header comment `index.ts:1-9`).

### `worker/src/tickets.ts` — HMAC ticket sign/verify (69 lines, read in full)
- Operation vocabulary: `type TicketOperation = "put" | "get" | "chunk" | "join"` (line 32).
  `"put"` is declared but **never used** in the current codebase (grep: only `"chunk"`,
  `"get"`, `"join"` are passed) — a leftover from the R2-era design.
- Signed message is the string `` `${operation}:${objectKey}:${expiresAt}` `` (line 44),
  HMAC-SHA256 with a key imported non-extractable from the secret (`hmacKey`, lines 14-22,
  `false` for extractable, usages `["sign","verify"]`).
- Signature output: `base64Url(32 bytes)` = 43 chars (`base64Url`, lines 24-30; manual
  `String.fromCharCode` accumulation, `+`→`-`, `/`→`_`, `=` stripped). Not `btoa` on the raw
  bytes; it is safe here only because the input is 32 bytes (no code-unit overflow risk).
- `verifyTicket` (49-68): rejects `Number.isNaN(expiresAt)` and `expiresAt * 1000 < now`
  (so expiry is compared in **seconds**), re-signs and compares with a length check followed by
  a XOR-accumulating loop (lines 61-68) — i.e. a manual constant-time comparison rather than
  `crypto.subtle.verify`. Length mismatch returns early (harmless: signature length is fixed
  and public).
- **No replay store lives in this module** — single-use is enforced by the DO (join burn key,
  chunk-row immutability). `TICKET_TTL_SECONDS = 300` applies to chunk PUTs only; the `"get"`
  ticket's expiry is the room's own expiry (up to 24 h) — see `room.ts:372-378`.
- Object-key namespaces actually used: `${roomId}/${fileId}/${index}` (chunk),
  `${roomId}/${fileId}` (get), `${roomId}|${ip}|${exp}|${nonce}` (join). Because
### `worker/src/rate-limit.ts` — the budget algorithm (120 lines, read in full)
- Types (18-29): `RateRecord = {attempts, windowStart, strikes, blockedUntil}`;
  `RateDecision = {allowed, retryAfterSeconds, next}` — all fields `readonly`.
- `evaluate(record, now, maxAttempts = JOIN_MAX_ATTEMPTS)` (31-82), exact semantics:
  1. `base = record ?? {attempts:0, windowStart:now, strikes:0, blockedUntil:0}`.
  2. If `blockedUntil > now` → immediately `{allowed:false, retryAfterSeconds:
     ceil(remaining/1000), next: base}` — attempts made *during* an active penalty do **not**
     increment strikes or the counter (44-50).
  3. A served penalty resets the window: `penaltyServed = blockedUntil > 0 && now >= blockedUntil`;
     `windowExpired = penaltyServed || now - windowStart >= 300_000`;
     `attempts = windowExpired ? 1 : base.attempts + 1`; `windowStart = windowExpired ? now :
     base.windowStart` (52-57). The current call counts as attempt 1 of a fresh window when the
     window lapsed or a penalty was served.
  4. If `attempts > maxAttempts` → `strikes = base.strikes + 1`;
     `penalty = min(3600, 60 * 2**(strikes-1))`; returns
     `{allowed:false, retryAfterSeconds: penalty, next:{attempts, windowStart, strikes,
     blockedUntil: now + penalty*1000}}` (59-74). Escalation is 60 → 120 → 240 → 480 → 960 →
     1920 → capped 3600 s, **one strike per penalty cycle**.
  5. Else `{allowed:true, retryAfterSeconds:0, next:{attempts, windowStart, strikes:
     base.strikes, blockedUntil:0}}` (77-81) — a successful attempt **resets `blockedUntil` to
     0 but keeps `strikes`**, so accumulated strikes survive and the next overflow resumes at the
     previously reached penalty.
- Net effect: exactly `maxAttempts` requests allowed per 5-minute window; the next returns 429
  with `retryAfter` = 60 s; repeat offenders escalate to 1 h.
- `isRecordExpired(record, now)` (85-88): `now >= blockedUntil && now - windowStart >= 300_000`.
- `checkJoinAllowed(env, keys, maxAttempts = JOIN_MAX_ATTEMPTS)` (95-120): resolves
  `env.HUSK_GATE.idFromName("gate")` (line 100 — **one global instance per deployment**), POSTs
  `{keys, maxAttempts}` to `https://gate/check`, and **fails closed**: any non-OK response →
  `{allowed:false, retryAfterSeconds:30}` (108-110; intent documented at 90-93). Response parsing
  is defensive (`allowed === true`, `Number(… ?? 0)`) behind a `// SAFETY:` cast.

### `worker/src/gate.ts` — HuskGatekeeper DO (112 lines, read in full)
- Key prefix `RECORD_PREFIX = "rl:"`; purge cadence `PURGE_INTERVAL_MS = 1 h` (14-15).
- `fetch` serves **only** `POST /check` (24); otherwise `404 "not_found"` (52). Body parse
  failure → `400 bad_request` (25-31); `keys` filtered to strings (32-34), empty → `400` (35-37);
  `maxAttempts` accepted only as a positive integer else `JOIN_MAX_ATTEMPTS` (39-44).
- `check(keys, now, maxAttempts)` (55-83): for **every** key, `get` → `evaluate` →
  `put(decision.next)` — a storage write per key per request, including already-blocked keys. It
  keeps the most-blocking decision (largest `retryAfterSeconds`) and otherwise the first allowed
  one. The no-keys fallback (75-82) fabricates an allowed record and is unreachable through the
  route.
- `ensurePurgeAlarm` (46, 85-90) sets `alarm(now + 1 h)` **only when no alarm exists**.
- `alarm()` (92-111): lists all `rl:` records, deletes those where `isRecordExpired`, then
  **always re-arms** to `now + (JOIN_WINDOW_SECONDS + JOIN_BACKOFF_MAX_SECONDS)*1000 +
  PURGE_INTERVAL_MS` (= now + 3900 s + 3600 s). Comment 106-107: any still-relevant record
  expires within window + max penalty, so a sweep always terminates.

### Where budgets are actually applied (complete, verified list)
| Route | Gate keys | maxAttempts | On refusal | Line |
|---|---|---|---|---|
| `POST /room/create` | `create:<CF-Connecting-IP>` | `CREATE_MAX_ATTEMPTS = 5` | `429 {error:"rate_limited", retryAfter}` | `index.ts:94-98` |
| `POST /room/join` | `ip:<CF-Connecting-IP>` | default `10` | `429 {error:"rate_limited", retryAfter}` | `index.ts:117-124` |
| `GET /room/<id>/socket` | — | — | token required instead; no counter | `index.ts:157-169` |
| `POST /room/<id>/file` | — | — | membership check instead | `index.ts:171-221`, `room.ts:339` |
| `PUT`/`GET` file transfer | — | — | HMAC ticket instead | `room.ts:398-407,435-444` |
| WebSocket frames | — | — | **nothing** | `room.ts:504-552` |
- IP source: `headers.get("CF-Connecting-IP") ?? "unknown"` (`index.ts:94,117`; forwarded as
  `x-husk-ip` at 166). If the header is ever absent, **all** such callers share one bucket per
  namespace.
- `FINDINGS.md:14` records the deliberate removal of the per-room join key; `index.ts:118-121`
### Risks / observations for this area (logged only — see [12])
- **429 responses carry no `Retry-After` header** — clients must read `retryAfter` from the JSON
  body (`index.ts:97,123`).
- `checkJoinAllowed` reports `allowed:false, retryAfterSeconds:30` on any gatekeeper hiccup, so a
  gatekeeper outage is indistinguishable from a 30 s rate limit to every user, and there are no
  Worker logs to tell them apart (failing closed is deliberate — `rate-limit.ts:90-93`).
- The gatekeeper is a **singleton DO**: every join and create in the deployment funnels through
  one object (`rate-limit.ts:100`). That is the simplicity tradeoff for needing no KV namespace,
  and it is the highest-contention component in the system (one storage write per key per check).
- `TicketOperation` still declares `"put"`, which nothing uses (dead surface left from the R2 era).
- Join tokens are **IP-bound** (`room.ts:221`), and the binding is enforced in the DO. Any future
  flow that mints a token on one network and consumes it on another (a phone moving from Wi-Fi to
  cellular mid-handshake) will fail with a generic 404 — relevant to a future real-time session
  setup that might want a connection-independent capability.
- File GET tickets live until room expiry (up to 24 h) and are relayed only inside encrypted file
  messages, so a leaked ticket URL grants ciphertext download until the room dies; that is
  consistent with the threat model (the plaintext needs the fragment key) but means **there is no
  way to revoke a download capability early** except closing the room.
- The membership check for file reservation uses a participant id supplied by the client in the
  request body (`{size, member}`), validated against live socket attachments
  (`room.ts:335,339`). A member id is therefore a bearer credential for the duration of the
  socket — it is only ever sent over WSS to the relay and stored in the DO attachment.
- No rate limiting exists on `/room/<id>/file` reservations other than the 100 MB room budget and
  the 25 MB per-file cap, so a member can reserve/cancel repeatedly (each reservation writes a
  meta row; cancels delete it). Low impact, but it is the one unthrottled mutating endpoint.

---

## [05] Worker — Tests

Files covered: `worker/tests/integration.test.ts` (839 lines), `worker/src/rate-limit.test.ts`
(85 lines), `worker/src/tickets.test.ts` (38 lines), `worker/tests/test-types.d.ts` (49 lines),
`worker/vitest.config.ts` (read in [01]).
Read in full: `rate-limit.test.ts`, `tickets.test.ts`, `test-types.d.ts` = YES.
`integration.test.ts` = **NO — partial**: read lines 1-172 (harness + helpers), 630-720 and
780-839 (security/dedup/closure/presence bodies), plus the title of every one of its 26 `it()`
blocks. The ~350 unread lines are the bodies of the lifecycle/file/capacity tests; their titles
and the helper contracts they use are recorded, but not every assertion was read.
Last verified: 2026-09-17

### Test inventory (counted from file contents, not from docs)
- `worker/tests/integration.test.ts`: **26 `it()` blocks** in 5 `describe` groups —
  "room lifecycle and relay" (3: lines 173, 198, 229), "chunked file transfer" (9: 330, 352, 367,
  385, 400, 422, 447, 455, 471), "abuse controls" (8: 485, 501, 539, 562, 582, 605, 638, 657),
  "room closure" (1: 680), "edge cases" (5: 710, 716, 757, 783, 818).
- `worker/src/rate-limit.test.ts`: **7 `it()` blocks**, all pure-function tests of `evaluate`.
- `worker/src/tickets.test.ts`: **5 `it()` blocks**, pure HMAC sign/verify.
- `cd worker && pnpm test` runs **26** (its config includes only `tests/**`,
  `worker/vitest.config.ts:7`); root `pnpm test` additionally picks up
  `worker/src/**/*.test.ts` (12 more) via `vitest.config.ts:14`. README's "26 integration tests"
  (`README.md:319`) matches the integration file exactly; the "121 unit" figure was not verified.

### Integration harness design (lines 1-170) — the pattern to reuse for real-time tests
- Runs in workerd via `@cloudflare/vitest-pool-workers`; imports
  `SELF, env, runDurableObjectAlarm, runInDurableObject` from `cloudflare:test` (line 8).
- `api(path, init)` / `apiAbsolute(url)` route everything — including absolute signed chunk URLs
  — through `SELF.fetch`, so the **real Worker routes** are exercised (lines 23-31).
- `freshPin()` mints a room id from an incrementing counter in base 36 padded to 8 chars
  (16-21) — matches `ROOM_ID_PATTERN` and gives each test its own Durable Object.
- **Every create/join carries a unique `CF-Connecting-IP`** (`10.1.0.x` for creates,
  `10.0.0.x` for joins, lines 33-52), so per-IP budgets never bleed between tests. Key trick to
  copy when adding new tests.
- `FrameQueue` (63-86) subscribes once and buffers frames so none is lost between awaits.
  Any future WebSocket feature should reuse it rather than adding ad-hoc listeners.
- `openSocket(pin)` (92-115): join -> read `joinToken` -> upgrade with `Upgrade: websocket` and
  the **same `CF-Connecting-IP`** (the token is IP-bound) -> `ws.accept()` -> asserts the first
  frame is `welcome` -> returns `{ws, member, frames}`.
- `drainJoinPresence(frames)` (118-123) consumes the peer presence-join frame.
- `requestGrant(pin, member, size)` POSTs `{size, member}` to `/room/<id>/file` (127-132);
  `uploadVector` PUTs each 1 MiB slice asserting 200 per chunk (134-148); `randomBytes` fills via
  64 KiB `getRandomValues` slices (150-159).
- `beforeAll` (163-170) creates a room, joins, opens and closes a socket, keeping only `member`,
  so the module-level `member` is intentionally a **stale participant id** by the time the
  membership-refusal test runs.
- **Time is only manipulated through `runInDurableObject` / `runDurableObjectAlarm`** — the alarm
  test reaches into the live instance, sets `emptySince` to 31 minutes ago, then runs the real
  `alarm()` (lines 693-697). No fake timers anywhere. Extend this for time-based features.### Behaviours the tests pin that the source does not state (real contract evidence)
- **The relay wire format is a closed key set.** Lines 671-675 assert the `relay` frame own
  enumerable keys are a subset of `{t, seq, senderId, localId, ts, payload}` and that `payload`
  equals exactly the `{iv, ct}` that was sent — no plaintext, no key material, no extra field can
  be added to a relay frame without failing a test. This is the most useful existing guard for any
  future message type that reuses the relay path.
- **A resend is idempotent per socket** (783-816): send `m1` -> peer relays once -> resend `m1` ->
  the sender gets an `ack` with the **same seq** -> the peer next frame is `m2`, proving no
  duplicate relay was delivered. This is the reconnect contract in test form.
- **`presence leave` fires exactly once per socket close** (818-838): after A closes, the next
  frame B sees is `leave` with the departed member id, and the frame after B own next send is a
  relay, not a second leave — pinning the `closeHandled` WeakSet dedupe.
- **Alarm purge is externally observable** (699-705): after forcing `emptySince`,
  `runDurableObjectAlarm` returns `true`, `/room/join` 404s **and the previously valid file GET URL
  also 404s** — the strongest evidence that file rows die with the room and cannot be resurrected.
- **Room-id collision is a first-class case** (710-713): create twice with one id -> `200` then
  `409`, matching the client retry-on-409 contract.
- **Brute force is throttled at the HTTP layer** (638-655): repeated joins from one IP must yield a
  `429` within 12 attempts, with a positive numeric `retryAfter` in the JSON body.
- **Two same-second joins from one IP must mint distinct tokens and both sockets must open**
  (605-636) — pins the nonce fix at `index.ts:143` / `room.ts:207-213`.
- Several test names still say "PIN" (line 710 "PIN collision on creation", helper `freshPin()`),
  leftover naming from the pre-redesign era although the value is an 8-char room id.

### Unit-test coverage details
- `rate-limit.test.ts`: first attempt allowed (8-12); exactly `JOIN_MAX_ATTEMPTS` allowed then a
  refusal (14-22); backoff strictly increases on a second strike (24-34); a penalty keeps blocking
  until it elapses and the next attempt is then allowed (36-45); a stale window resets to
  `attempts: 1` (47-57); the create budget is asserted **smaller** than the join budget and
  enforced under `CREATE_MAX_ATTEMPTS` (59-72); backoff applies once the create budget is exhausted
  (74-84). All pure-function — **no test covers `checkJoinAllowed` HTTP wiring or the gatekeeper
  DO** (independently noted in `phase-2-security-crypto.md:68`).
- `tickets.test.ts`: fresh ticket passes; wrong operation fails; different object key fails;
  expired ticket fails; empty signature fails (9-37). It still uses the legacy `"put"` operation
  and a 6-digit `123456/object` key, i.e. the file reflects the pre-8-char-slug era while still
  exercising the real functions. The join-token payload has no dedicated unit test (covered
  indirectly by integration tests at 562/582/605).
- `worker/tests/test-types.d.ts`: minimal ambient declarations so `cloudflare:test` resolves
  without `@cloudflare/workers-types`; declares `Fetcher`, `DurableObject`, `DurableObjectStub`,
  `DurableObjectId`, `DurableObjectNamespace`, a storage-shaped object, `Cloudflare.Env` with the
  four bindings, and `Response.webSocket` (9-49).
- Lint asymmetry: `eslint.config.js:16-19` ignores only `.agents/**`, `tools/**`, `live-tests/**`,
  so **`worker/tests` IS linted by eslint**, while `.oxlintrc.json:22` excludes `worker/tests/**`
  from the anti-slop gate.
- **Nothing here verifies the client interpretation of any frame** — no test imports
  `src/lib/husk/*`. Client behaviour claimed in [06]-[08] is covered (or not) by the separate
  client test files listed there.

---

## [06] Frontend — Structure

Files covered (all 43 tracked files under `src/`): `src/router.tsx`, `src/routeTree.gen.ts`,
`src/routes/README.md`, `src/routes/__root.tsx`, `src/routes/index.tsx`,
`src/routes/r.$roomId.tsx`, `src/server.ts`, `src/start.ts`, `src/styles.css`,
`src/lib/utils.ts`, `src/lib/error-capture.ts`, `src/lib/error-page.ts`,
`src/lib/lovable-error-reporting.ts`,
`src/lib/husk/{api,backoff,config,connection,crypto,files,linkify,protocol,room-machine,store,theme}.ts`,
their 10 test files, and `src/components/husk/{chat,Grainient,MoltenMetal,icons,primitives,room-info}.tsx`
plus `Grainient.css` and `MoltenMetal.css`.
Read in full: YES for every file above except `Grainient.tsx` and `MoltenMetal.tsx` (roles taken
from their imports/props and the paired CSS; not read line-by-line — see [07]) and except the
10 `*.test.ts(x)` files, whose assertions are summarised in [08] without every line being read.
Last verified: 2026-09-17

### File-by-file role map (role derived from code, not filename)
| File | Role | Talks to relay |
|---|---|---|
| `src/router.tsx` | Builds the TanStack Router instance from the generated route tree plus a `QueryClient` in context; `scrollRestoration: true`, `defaultPreloadStaleTime: 0` | no |
| `src/routeTree.gen.ts` | Auto-generated tree: exactly 3 routes (`__root__`, `/`, `/r/$roomId`) plus the TanStack Start `Register` augmentation (`ssr: true`) | no |
| `src/routes/README.md` | File-based-routing conventions; explicitly forbids `src/pages/`, `_app/index.tsx`, `app/layout.tsx` | n/a |
| `src/routes/__root.tsx` | App shell: html/head, pre-paint dark-class script, meta + icon/manifest links, QueryClientProvider + ToastProvider + Outlet, not-found and error components, production-only service-worker registration | SW only |
| `src/routes/index.tsx` | Landing page: create-room button, WebGL MoltenMetal background, inline failure copy, missing-relay Panel | `createRoom()` -> POST /room/create |
| `src/routes/r.$roomId.tsx` | Room screen: connect on mount, message list + composer, share card, desktop drawer / mobile Vaul sheet, leave modal, file send/download, closed screens, `useIsDesktop` | WS + file grant/PUT/GET |
| `src/server.ts` | SSR entry: per-response CSP built from hashes of the inline scripts it emits, `nosniff`/`no-referrer`/`X-Frame-Options: DENY`, h3-swallowed-500 normalisation into `renderErrorPage()` | no |
| `src/start.ts` | TanStack Start instance: `errorMiddleware` + `createCsrfMiddleware` filtered to server functions | no |
| `src/styles.css` | Entire token system + base layer + all component classes (see [07]) | no |
| `src/lib/utils.ts` | `cn()` = `twMerge(clsx(...))` | no |
| `src/lib/error-capture.ts` | Records the last Error out-of-band (5 s TTL), wraps `console.error` to expand cause chains, listens for `error`/`unhandledrejection` | no |
| `src/lib/error-page.ts` | `renderErrorPage()` returns standalone HTML with inline styles (no tokens; hardcoded greys) | no |
| `src/lib/lovable-error-reporting.ts` | Forwards errors to Lovable editor hooks (`window.__lovableEvents`, `__lovableReportRuntimeError`) | editor only |
| `src/lib/husk/config.ts` | Client constants mirroring the Worker config + `WORKER_URL` from `import.meta.env` | n/a |
| `src/lib/husk/crypto.ts` | AES-256-GCM seal/open, base64url helpers, key import/generation, `DecryptionFailedError` | no |
| `src/lib/husk/protocol.ts` | Wire types + `parseServerMessage()` boundary parser | no |
| `src/lib/husk/api.ts` | `generateRoomId`, `createRoom`, `joinRoom` over HTTP | POST /room/create, POST /room/join |
| `src/lib/husk/connection.ts` | `RoomConnection`: join-token fetch, socket lifecycle, bounded reconnect, outbox, ping/pong liveness, `roomSocketUrl` | GET /room/<id>/socket (WS) |
| `src/lib/husk/store.ts` | Zustand room store: entries, participants, machine driver, delivery/ack lifecycle, grace timers, system notes, file cancel | via connection.ts + api.ts |
| `src/lib/husk/files.ts` | Chunked encrypt/upload, streamed download/decrypt, size guards, typed errors, `ByteQueue` | POST grant, PUT chunks, GET file |
| `src/lib/husk/room-machine.ts` | Pure state machine: 14 states, 15 events, terminal-state immutability | no |
| `src/lib/husk/backoff.ts` | `backoffDelay(attempt, random)` bounded exponential with 20 percent jitter | no |
| `src/lib/husk/linkify.ts` | `tokenize()` returns text/link tokens; never produces HTML | no |
| `src/lib/husk/theme.ts` | Theme hard-locked to dark: `type Theme = dark`, `useTheme()` returns a no-op `setTheme` | no |
| `src/components/husk/primitives.tsx` | `Button`, `IconButton`, `Panel`, `Modal` (Tab trap + focus restore + scrim close), `ToastProvider`/`useToast` | no |
| `src/components/husk/chat.tsx` | `MessageText`, `FileCard`, `DeliveryNote`, memoised `MessageItem`, `MessageList`, `Composer`, `shouldSubmitOnEnter` | via store callbacks |
| `src/components/husk/room-info.tsx` | `ConnectionIndicator`, `RoomInfoPanel` (copy link, security blurb, leave button) | no |
| `src/components/husk/icons.tsx` | Custom icon set (1.5 px stroke on a 24 px grid), `HuskMark` 3D cube, `WaitingMark`, `ErrorMark` | no |
| `src/components/husk/Grainient.tsx` + `.css` | WebGL gradient/noise background; **imported by no route or component in the current tree** | no |
| `src/components/husk/MoltenMetal.tsx` + `.css` | WebGL molten background, used only by the landing page (`index.tsx:63-84`) | no |

### Structural facts worth carrying forward
- **Only three routes exist** (`routeTree.gen.ts:11-24,26-50`). A new page = one new file in
  `src/routes/`; a new nav entry = a `Link`/`navigate()` call in `index.tsx` or `__root.tsx`.
- **No loaders, no server functions, and no TanStack Query usage anywhere in `src/`** — the
  `QueryClient` is created (`router.tsx:6`) and provided (`__root.tsx:172`) but nothing calls
  `useQuery`/`useMutation`. All state is Zustand + local `useState`.
- The client's complete relay surface: POST /room/create (`api.ts:53`), POST /room/join
  (`api.ts:82`), WS GET /room/<id>/socket?jt= (`connection.ts:61-64`), POST /room/<id>/file
  (`files.ts:88`), PUT chunk URL (`files.ts:160`), GET file (`files.ts:248`). Nothing else.
- State management: one Zustand store (`useRoomStore`, `store.ts:575`) created by
  `createRoomStore()` with an injectable connection spawner for tests (`store.ts:74-76`).
- SSR is live: the server entry is redirected to `src/server.ts` (`vite.config.ts:10-14`), which
  lazily imports the TanStack server entry and wraps every response (`server.ts:138-153`).

---

## [07] Frontend — Components & Design System

Files covered: `src/styles.css` (691 lines), `src/components/husk/primitives.tsx` (260),
`chat.tsx` (461), `room-info.tsx` (196), `icons.tsx` (230), `Grainient.tsx` (207) + `Grainient.css`,
`MoltenMetal.css`, `src/components/husk/chat.enter.test.ts`, `chat.render.test.tsx`,
`src/lib/error-page.ts`, and the class usage inside `src/routes/*.tsx`.
Read in full: `styles.css`, `primitives.tsx`, `room-info.tsx`, `icons.tsx`, `Grainient.tsx`,
both CSS files, both component tests = YES. `chat.tsx` and `MoltenMetal.tsx`: all lines except
`chat.tsx:330-362` (read) and the interior of `MoltenMetal.tsx` (WebGL shader component; props
read from `index.tsx:64-83`, body not read line-by-line).
Length note: exceeds the guidance on purpose — this is the pixel-contract for new UI.
Last verified: 2026-09-17

### The token system (`src/styles.css`) — the only sanctioned source of visual values
- Tailwind v4 with source scoping: `@import tailwindcss source(none)` + `@source ../src`
  (lines 1-2), and a custom variant `dark` bound to the `.dark` class (line 4).
- Self-hosted Inter, variable 400-600, latin subset, with an explicit `unicode-range`
  (lines 7-16), loaded from `/fonts/inter-latin.woff2`. **No Google Fonts anywhere.**
- Brand palette documented as comments (lines 18-30) AND emitted as raw variables
  `--husk-primary #7de925`, `--husk-dark #172112`, `--husk-surface #f6faf4`,
  `--husk-accent #3ce767`, `--husk-highlight #f2d8c4` (lines 98-102). These match the README
  table exactly; the variables are otherwise unused by components (they are the brand contract).
- `@theme inline` (lines 32-95) maps semantic tokens to Tailwind colour utilities:
  `canvas, surface, surface-raised, surface-sunken, line, line-strong, ink, ink-muted,
  ink-faint, accent, accent-hover, accent-ink, accent-soft, ok, warn, danger, info, focus,
  scrim, highlight` -> usable as `bg-*`, `text-*`, `border-*` etc.
- Radii (lines 54-59): `xs 6px`, `sm 8px`, `md 12px`, `lg 16px`, `xl 24px`, `pill 999px` --
  matches the spec scale exactly. Spacing (61-68): `1/2/3/4/6/8/12/24` = 4/8/12/16/24/32/48/96px,
  plus two blessed touch sizes `--spacing-touch 44px` and `--spacing-touch-lg 56px` (70-72).
- Type scale (77-89): `display 32/38/-0.02em/600`, `title 20/27/-0.01em/600`, `body 15/23`,
  `caption 12.5/18/+0.01em`. Fonts: `--font-sans` = Inter stack, `--font-mono` = system mono.
- Other tokens: `--shadow-panel` (91), `--ease-out-brand cubic-bezier(0.23,1,0.32,1)`,
  `--ease-in-out-brand cubic-bezier(0.77,0,0.175,1)` (93-94).
- **Both palettes are fully authored** (not inverted): `:root` light values at lines 97-124 and
  `.dark` at 126-147. Light `--canvas oklch(0.98 0.009 134.9)`, dark `oklch(0.233 0.031 135.6)`;
  light `--warn oklch(0.5 0.09 78)` and `--ink-faint oklch(0.507 0.042 135.3)` -- these are the
  exact values the Phase-5 audit recommended for AA contrast (`phase-5-design-accessibility.md:23`),
  i.e. that fix is in the code.
- **The app is dark-only today.** `theme.ts:1-15` locks `Theme` to the literal `dark` and makes
  `setTheme` a no-op, and `__root.tsx:20,147` injects
  `document.documentElement.classList.add(dark)` before first paint. The light palette in
  `:root` is therefore dead configuration that no route can reach. See [12] -- the README still
  advertises a light/dark toggle and a `dark` class swap (`README.md:380-382`).
- Base layer (149-177): global `border-color: var(--line)`, `body` background/colour/Inter/
  antialiasing/`overscroll-behavior-y: none`, a global `:focus-visible` outline of 2px
  `var(--focus)` with 2px offset, and `::selection` using `--accent-soft`.

### Component-level CSS classes you must reuse for new UI (all in `@layer components`)
- `.press` / `.press-sm` -- 160 ms transform transition, `scale(0.97)` / `scale(0.95)` on
  `:active:not(:disabled)` (185-197). Every interactive element in the app carries `press`.
- `.btn-tactile-primary` (224-268): 3-stop emerald gradient, `border 1px rgba(255,255,255,0.4)`,
  inset highlight + drop shadow, hover only under `@media (hover:hover) and (pointer:fine)`
  (brightness 1.05 + translateY(-1px)), active `scale(0.97) translateY(1px)`, and a
  `:disabled:not([aria-busy=true])` flat state. **`Button` in `primitives.tsx:52` composes
  this class** -- new buttons should use `<Button>` rather than raw classes.
- `.btn-tactile-quiet` (271-312), `.btn-tactile-danger` (315-355), `.btn-tactile-icon` (358-395)
  -- same tactile treatment in dark-forest / crimson / icon variants.
- Glass surfaces: `.modal-panel` (`oklch(0.26 0.034 137 / 0.92)` + `blur(20px) saturate(1.4)`, 430-435),
  `.toast-in` (`/0.88`, 448-452), `.chat-header` (`/0.85`, 562-567), `.share-card` (`/0.75` + animated
  shimmer border via `mask-composite: exclude`, 570-608), `.composer-bar` (`/0.88`, 611-616),
  `.drawer-panel` (`/0.92`, 636-648). New panels should match this glass recipe.
- Bubbles (530-543): `.bubble-mine` = `color-mix(in oklch, var(--accent) 14%, var(--surface))` with
  radius `16px 16px 4px 16px`; `.bubble-theirs` = `var(--surface-raised)` with `16px 16px 16px 4px`.
  Note the tails are corner-radii, not shapes.
- `.system-marker` (546-559): centred flex label with 1px gradient rules on both sides.
- Motion vocabulary: `.enter` + `--enter-delay` stagger (398-412), `.fade-in` (414-424),
  `.modal-scrim`/`.modal-panel` (427-445), `.toast-in` (448-462), `.dot-pulse` (465-478),
  `.waiting-glow` (481-501), `.upload-bar` indeterminate slide (504-527), `.drawer-panel`
  (636-648), `.collapse-out` (651-663), `.swap-check` (666-678), `.empty-rings` (681-691).
- Reduced motion is honoured only for the WebGL backgrounds (`Grainient.css:16-19`,
  `MoltenMetal.css:9-12` set `visibility: hidden` on the canvas); **no `prefers-reduced-motion`
  guard exists for the CSS keyframe animations above** (gap worth noting for new motion work).

### Component inventory and API surface
- `primitives.tsx`: `Button` (props `tone: primary|quiet|danger`, `full`, `loading`, `ref`;
  sets `aria-busy` when loading and forces `disabled`; 35-63), `IconButton`
  (`label` -> `aria-label` + `title`, 44px square; 65-81), `Panel` (rounded glass section; 83-100),
  `Modal` (`open,title,description,confirmLabel,onConfirm,onCancel`; focus trap wrapping at both
  ends, Escape/scrim close, focus restored to the invoker on unmount; 102-210),
  `ToastProvider` + `useToast()` (toasts auto-dismiss after 4500 ms, `aria-live=polite`,
  tones `info|danger`; 212-259). `useToast` throws outside a provider.
- `icons.tsx`: 16 icons, all `aria-hidden`, 20x20 default, `viewBox 0 0 24 24`, `strokeWidth 1.5`,
  `stroke=currentColor` (base factory lines 8-21). Exceptions: `WaitingMark`/`ErrorMark` are
  96x96 illustrations (97-122) and `HuskMark` is a 3-face gradient cube with `useId()`-scoped
  gradient ids (182-230).
- `chat.tsx`: `MessageText` renders `tokenize()` output as React text/anchors with
  `rel=noopener noreferrer` (57-77); `FileCard` (80-126) shows name/size, download/retry and an
  indeterminate `.upload-bar` while in flight; `DeliveryNote` (144-180) renders Sending spinner /
  Not sent + Retry / timestamp; `MessageItem` is `memo`ised (181-219) and short-circuits system
  notes and `unverified` entries to centred `.system-marker` rows; `MessageList` (224-316) keeps
  a `NEAR_BOTTOM_PX = 120` sticky-scroll rule; `Composer` (319-461) uses a `sr-only` file input
  triggered by `IconButton`, an auto-growing textarea capped at `MAX_TEXTAREA_HEIGHT = 5*28+20`
  (line 317), and a failed-upload banner with Retry/Discard.
- `room-info.tsx`: `ConnectionIndicator` (offline / connected / reconnecting copy, pulsing dot,
  grace suffix; 18-48) and `RoomInfoPanel` (room id in `tabular`, participant count, invite link,
  copy button with 2 s checkmark, fallback copy instructions, a 3-item security blurb, leave
  button; 54-196).
- `r.$roomId.tsx` local components: `ShareCard` (auto-collapse on first peer join, 354-450),
  `ClosedScreen` (branded terminal screen with optional Reconnect, 452-493), `useIsDesktop`
  (matchMedia `min-width: 1024px`, 336-347).
- Backgrounds: `MoltenMetal` (props `color1..3, speed, scale, detail, glow, coreSize, swirl, fold,
  blackPoint, brightness, colorMode: molten, grain, grainIntensity, mouseInteraction,
  mouseStrength, opacity` -- 17 props, all supplied inline at `index.tsx:64-83`) and `Grainient`
  (`colors`, `speed`, `grain`; RAF driven, paused offscreen/hidden, WebGL-absent fallback, and a
  `WEBGL_lose_context` teardown; 98-207). **`Grainient` is imported by nothing** in the tracked
  tree -- dead component with its own CSS, contradicting `implementation_plan.md:12-17`
  (which specified Grainient as the landing background; the landing page now uses MoltenMetal).

### Design-system deviations found (logged, not fixed)
- `room-info.tsx:130` uses `text-emerald-950` -- a **Tailwind default-palette class**, which the
  spec forbids and which the Phase-5 audit claimed was clean (`phase-5-design-accessibility.md:61`).
  This is the only default-palette hit I found in shipped components (grep for
  `emerald|slate|gray|zinc|neutral|stone|red-[0-9]|blue-[0-9]` is otherwise empty).
- Raw hex literals appear where a token exists or should: `text-[#04180c]` on primary buttons
  (`primitives.tsx:30`, `index.tsx:109`-adjacent, `r.$roomId.tsx:426`, `__root.tsx:40,82`),
  `#3ce767` in `primitives.tsx:243` (`border-l-[#3ce767]`) and `r.$roomId.tsx:234`
  (`ring-[#3ce767]`), `#48eb73/#2ec158/#1ea347` inside the button gradients, and the crimson
  `#ef4444/#dc2626/#b91c1c` gradient in `.btn-tactile-danger`.
- Raw oklch literals in class bodies instead of tokens: the glass recipes above plus
  `.system-marker` gradient, `.bubble` borders, `.waiting-glow` glow, `.empty-rings`. They are
  consistent, but they are not tokenised.
- Off-scale utilities: `h-13` (`index.tsx:109`, `r.$roomId.tsx:426`), `w-88` (`r.$roomId.tsx:276`),
  `w-13/h-13` (`r.$roomId.tsx:426`), `h-14`, `max-h-\[160px\]`, `rounded-xs` (a token), `min-h-11`.
  Phase-5 blessed 44/56 px as `--spacing-touch`/`--spacing-touch-lg`, but 52px (`h-13`) and 88px
  (`w-88`) are outside the documented scale.
- `error-page.ts` and `error-capture.ts` use inline hardcoded greys (`#fafafa`, `#111`, `#4b5563`,
  `#d1d5db`) and a system-ui font stack -- the only two files that bypass the design system
  entirely (acceptable for a last-resort page that must render without CSS, but worth knowing).
- Inline `style={{ ... }}` is used in the mobile drawer for `backdropFilter`/`background`
  (`r.$roomId.tsx:298-301`) duplicating `.drawer-panel`; and `--enter-delay` inline styles are
  the documented stagger mechanism (`index.tsx:32-34`).

### Design rules that any new UI must follow (derived from the above)
1. Only semantic token utilities (`bg-surface`, `text-ink-muted`, `border-line`, `text-danger`, ...)
   -- never Tailwind palette names, never new hex values in components.
2. Build controls from `primitives.tsx` (`Button`/`IconButton`/`Panel`/`Modal`), which already
   supply the tactile classes, `press`, `touch-target` and ARIA.
3. Use `text-display|title|body|caption` for type and the 4/8/12/16/24/32/48/96 scale for spacing;
   use `--spacing-touch`/`--spacing-touch-lg` for hit targets.
4. Surfaces are glass: translucent `oklch(0.26 0.034 137 / ~0.85-0.92)` + `backdrop-blur` +
   1px `--line`-ish border; accents are lime `--accent`, success `--ok`, warning `--warn`,
   danger `--danger`.
5. Motion uses the two brand easings and the existing class vocabulary; add a
   `prefers-reduced-motion` guard if you introduce anything longer than a fade.
6. No emoji in copy; the only non-ASCII glyph used is U+2715 in dismiss buttons
   (`room-info.tsx:110`, `r.$roomId.tsx:423`).

---

## [08] Frontend — Routing & State

Files covered: `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/routes/r.$roomId.tsx`,
`src/router.tsx`, `src/routeTree.gen.ts`, `src/routes/README.md`,
`src/lib/husk/{store,connection,room-machine,protocol,api,files,config,linkify}.ts`, and all 10
client test files (titles enumerated; bodies read for `chat.*`, `backoff`, `crypto`, `files`,
`linkify`, `protocol`, `room-machine`; `connection.test.ts` (360 lines) and `store.test.ts`
(463 lines) read by test title + structure only).
Read in full: the routes, store, connection, room-machine, protocol, api, config, linkify files = YES.
Last verified: 2026-09-17

### How routes are declared and how you add a new page or nav entry (exact pattern)
1. Create `src/routes/<name>.tsx` exporting `Route = createFileRoute("/<path>")({ head: () => ({meta}),
   component: <Component> })` -- the closest real example is `src/routes/index.tsx:10-30`
   (`createFileRoute("/")` + `head()` meta block + `component: Landing`) and
   `src/routes/r.$roomId.tsx:23-43` (`createFileRoute("/r/$roomId")` with `head({params})` and
   `component: RoomScreen`). Dynamic segments use a bare `$` (`r.$roomId.tsx` -> `/r/$roomId`).
2. The route tree is generated: `src/routeTree.gen.ts` currently lists exactly
   `__root__`, `/`, `/r/$roomId` (lines 11-24, 71-77) and is marked do-not-edit
   (`routeTree.gen.ts:7-9`, `routes/README.md:21`). TanStack Router regenerates it when the dev
   server runs, so a new route file is picked up automatically.
3. Navigation patterns actually used:
   - programmatic, with params + fragment: `navigate({ to: "/r/$roomId", params: {roomId}, hash: fragment })`
     (`index.tsx:49`) -- the room key is passed as the `hash` option so it never enters a server
     request; this is the single most important routing convention in the app.
   - declarative back-home: `<Link to="/" className=...>` (`__root.tsx:38-43`).
   - banner/back buttons use `void navigate({ to: "/" })` (`r.$roomId.tsx:204,215,233`).
   - **There is no nav bar, no header menu and no button list** -- the app has one entry point
     (the landing page button) and one exit (back home). A new chat mode would add either a
     second `Button` next to `Create a Room` in `index.tsx:104-129` or a new route file plus a
     `Link`; there is no registry to update.
4. Root shell responsibilities (`__root.tsx`): `<html>/<head>` with the pre-paint dark script
   (line 147), `HeadContent`/`Scripts`, meta + manifest/icon links (100-134),
   `QueryClientProvider` + `ToastProvider` + `<Outlet/>` (172-178), `notFoundComponent`
   (22-48), `errorComponent` with `router.invalidate()` + `reset()` (50-96), and the
   production-only service-worker registration (161-169).

### Room page lifecycle (`r.$roomId.tsx`)
- Reads the key from `window.location.hash.slice(1)` in a mount effect, stores it in state and
  calls `connect(roomId, fragment)`; the effect cleanup calls `leave()` so unmounting the route
  disconnects (lines 120-131). If the fragment is empty the page renders the branded
  "This link has no key" `ClosedScreen` (199-207).
- Terminal room states short-circuit to `ClosedScreen` with copy from `CLOSED_COPY`
  (47-92) and pass `onRetry` **only** for `closed_disconnected` (216) -- the fix recorded in
  `FINDINGS.md:11`.
- Layout: sticky glass header with room id + `ConnectionIndicator` + info `IconButton` (229-252);
  share card + `MessageList` in a `min-h-0 flex-1` column (254-261); `Composer` with
  `disabled={status !== "open"}` (263); desktop info drawer vs mobile Vaul `Drawer.Root`
  (265-318); leave confirmation `Modal` (320-332).
- File send path (`onSendFile`, 132-177): `assertFileSendable` first, hard requirement of
  `status === "open" && selfId !== ""` (otherwise a typed `UploadFailedError` with a
  user-facing message), `requestFileUpload` -> `encryptAndUpload` -> `sendFileMessage(body)`;
  on `UploadFailedError` with a `fileId` it fires `cancelFile(fileId)` to refund the reservation.
- File download path (`onDownload`, 179-197): `downloadAndDecrypt` -> `URL.createObjectURL` ->
  temporary anchor click -> `revokeObjectURL` after 10 s (the `FINDINGS.md:26` fix) -> toast.

### Store surface and delivery lifecycle (`store.ts`)
- State fields (45-68): `state`, `status`, `online`, `roomId`, `selfId`, `participants`,
  `entries`, `lastLeaveAt`, `malformedCount`, `error`; actions `connect`, `retry`,
  `notifyOnline`, `notifyOffline`, `sendText`, `sendFileMessage`, `markFailed`, `retryMessage`,
  `cancelFile`, `leave`.
- Module-private (non-reactive) state: `connection`, `roomKey`, `keyFragment`, `graceTimer`,
  `ackTimers` map, `seenRelays` (capped at `SEEN_RELAYS_LIMIT = 1000`, oldest-delete), `lastSeenSeq`.
- `CHATENTRY` shape (23-32): `id`, `seq`, `mine`, `senderId`, `ts`, `delivery
  (sending|sent|failed|unverified)`, `body: SealedBody | null`, optional `system` note.
- Local-only entries use **fractional sequences** so they sit chronologically between server
  messages: system notes take `lastSeenSeq + 0.5` (157) and in-flight own messages take
  `lastSeenSeq + 0.75` (378), later replaced by the
  server-assigned seq (257). This is the
  mechanism that satisfies "system notes keep their chronological position" (commit e7caa88).
- `orderedEntries()` (583-585) sorts by `seq`, tie-broken by `ts`. Rendering is display-only for
  time (`formatTime` in `chat.tsx:30-32`), so ordering never depends on client clocks.
- Send path `publish()` (361-394): append entry with `delivery: sending` -> `seal()` ->
  `connection.send(id, sealed)` -> `armAckTimer(id)`; a `seal` failure calls `markFailed`.
  `ACK_TIMEOUT_MS = 10_000` then flips `sending` -> `failed` (124-133).
- `retryMessage(id)` (509-536) requires `mine && delivery === failed && body !== null`, re-seals
  the **same plaintext** and resends with the **same localId** so the DO dedupe path re-acks the
  original seq.
- Inbound handling `handleServerMessage` (225-353):
  - `welcome`: clears grace, records `selfId`/`participants`, applies `CONNECTED` + `RECONNECTED`.
  - `presence`: updates participants; join clears grace and applies `PEER_JOINED`; leave sets
    `lastLeaveAt = Date.now()`, applies `PEER_LEFT` and arms the grace timer.
  - `ack`: clears the ack timer, records seq, marks the entry `sent`.
  - `relay`: **receiver-side dedupe by `localId`** via `seenRelays` (269-285, registered before
    the async decrypt); own frames (`senderId === selfId`) are resolved to `sent` rather than
    re-inserted (the DO echoes relays to the sender); foreign frames are decrypted with
    `open()`, and a `DecryptionFailedError` inserts a centred `unverified` entry instead of
    dropping silently (316-333); a stale-room guard (`isStale`, 356-359) prevents a late decrypt
    from writing into a reset room.
  - `closed`: applies `EXPIRED` or `IDLE_CLOSED`, clears ack timers/grace and **closes the
    connection** (336-343) -- the `FINDINGS.md:11` fix for the infinite reconnect loop.
  - `error` and `pong` are intentionally ignored (344-349); malformed frames only bump
    `malformedCount` and `console.warn` (446-451).
- Grace window: `armGraceTimer`/`checkGrace` (169-197) re-derive from `lastLeaveAt` so a newer
  leave always wins; on expiry with <= 1 peer it pushes the system note
  "A participant left the room." and applies `GRACE_EXPIRED`. `inGraceWindow(lastLeaveAt, now)`
  (577-580) is exported for the connection indicator.
- `retry()` (457-471) is guarded to terminal states or `reconnecting` (the `FINDINGS.md:15` fix).
- `notifyOnline` (477-486) clears the backoff budget and, from `closed_disconnected`, calls
  `retry()`. Window `online`/`offline` listeners are registered only when `window` exists
  (565-568).
- `leave()` (542-558) closes the connection, nulls the key/fragment, clears dedupe + timers and
  sets `closed_by_host` with an emptied transcript.

### Connection behaviour (`connection.ts`) -- the contract a new real-time feature must match
- `roomSocketUrl(roomId, joinToken)` (51-65) builds `<WORKER_URL>/room/<id>/socket`, rewrites
  `https:->wss:`, and puts the token in `?jt=`. The comment (56-60) explains the query string is
  forced by the browser WebSocket API (no custom handshake headers) and that the token is
  one-time, IP-bound and short-lived.
- `connect()` (89-124): sets `inFlightConnect`, reports `connecting` (first attempt) or
  `reconnecting`, fetches a join token; a refused join ends the connection **permanently** with
  `join_refused_rate_limited` / `join_refused_unavailable`; a thrown fetch schedules a normal
  reconnect.
- `open()` (148-208): creates the socket, closes and supersedes any previous one (per-socket
  identity check in the close listener at line 186), resets `handshakeFailures` on open, flushes
  the outbox, and starts liveness.
- Terminal conditions: `RECONNECT_HANDSHAKE_FAILURES = 3` consecutive failed upgrades end as
  `join_refused_unavailable` (189-196); `RECONNECT_MAX_ATTEMPTS = 10` ends as `attempts_exhausted`
  (210-214); a connection open >= `RECONNECT_STABLE_MS = 10_000` resets the budget (197-200).
- Backoff: `backoffDelay(attempt)` = `RECONNECT_MIN_MS * 2**attempt` capped at
  `RECONNECT_MAX_MS = 15_000`, with +/-20 percent jitter (`backoff.ts:7-12`).
- Liveness: ping after `PING_INTERVAL_MS = 20_000` of silence, close the socket if no frame
  arrives within `PONG_TIMEOUT_MS = 10_000`; **any** inbound frame reschedules the ping
  (226-263). This exists because a half-open socket keeps `readyState === OPEN`.
- Outbox: frames buffered while disconnected, capped at `MAX_OUTBOX_FRAMES = 50` with
  oldest-drop (304-310), pruned against the room expiry learned from `welcome.expiresAt`
  (284-292, 176-178). Only `send` frames are buffered; `cancel` control frames are dropped when
  offline by design (327-333).
- Error surfaces: `onStatus`, `onEnded(reason)`, `onMalformed()` -- the store translates these
  into machine events and UI state; there is no exception thrown to the UI layer.

### User-feedback patterns (what a new feature must copy)
- Transient confirmations and failures -> **toast** via `useToast()` (`RoomInfoPanel.copy`
  "Invite link copied.", `onDownload` "File decrypted and downloaded.", clipboard refusal
  with `danger` tone). Toasts are bottom-centred, `aria-live=polite`, 4.5 s.
- Persistent connection state -> **inline `ConnectionIndicator`** with `aria-live=polite`, a
  pulsing dot, colour + text (offline, Connecting, Connected, Reconnecting, Disconnected) and a
  grace suffix (`room-info.tsx:18-48`).
- Message-level failures -> **inline per-message** `DeliveryNote` (Sending spinner / Not sent +
  Retry link / timestamp) (`chat.tsx:144-180`); undecryptable messages -> a centred system note.
- Upload failures -> **inline banner in the composer** with Retry and Discard
  (`chat.tsx:373-402`) plus an indeterminate `.upload-bar` while busy; download failures flip the
  icon button to "Retry download" (`chat.tsx:104-113`).
- Destructive confirmations -> custom `Modal` (never `window.confirm`), with focus trap and
  focus restoration (`primitives.tsx:102-210`).
- Terminal room states -> branded `ClosedScreen` with optional Reconnect (`r.$roomId.tsx:452-493`).
- Landing-page failures -> inline `role=alert` paragraph (`index.tsx:130-134`) or a warning
  `Panel` when the relay is unconfigured (147-156).

### Client test inventory (24 `it()` blocks across 10 files, counted)
- `backoff.test.ts` (3): starts near minimum, grows exponentially, never exceeds cap.
- `connection.test.ts` (14): terminal join refusals, attempts_exhausted, repeated handshake
  failures -> terminal not-found, no terminal on a failure after a successful open, malformed
  counting, outbox cap of 50, expiry pruning, `resetBackoff` immediate reconnect, ping/pong
  liveness both directions, any-frame liveness, no second connect while a join is in flight, no
  parallel reconnect from a superseded socket.
- `contrast.test.ts` (3 per-theme + pinned tokens): a permanent WCAG AA gate over the token
  palette generated from `styles.css`; this is the Phase-5 contrast fix living as a test.
- `crypto.test.ts` (7): base64url round-trip, 256-bit key, wrong-length rejection, JSON
  round-trip, fresh IV, wrong-key failure, tamper detection via the GCM tag.
- `files.test.ts` (4): 0-byte rejection, >25 MB rejection, 1-byte accept, exact-cap accept.
- `linkify.test.ts` (4): plain text, http/https extraction, `javascript:` never linked, XSS
  payload inert.
- `protocol.test.ts` (7): every valid tag parsed; protocol surface the relay never sends is
  rejected; unparseable/unknown tags rejected; malformed relay payload rejected; wrong-typed
  scalars rejected; malformed participant lists rejected; out-of-range enum fields rejected.
- `room-machine.test.ts` (9): happy path, grace entry, multiple peers stay active,
  drop/reconnect, capacity rejection, expiry + rate limit, exhausted budget, terminal
  immutability, illegal transitions are no-ops.
- `store.test.ts` (21): server closed frame disposes the connection, refused join ->
  `closed_not_found`, throttled join -> `closed_rate_limited`, exhausted budget ->
  `closed_disconnected` + `retry()` works, `retry()` from a live state is a no-op,
  terminal end marks sending entries failed, 10 s ack timeout then `retryMessage` reuses the
  localId, ack clears the timeout, duplicate relays insert once, own duplicate resolves,
  grace follows the latest leave, a late decrypt does not write, malformed frames counted,
  offline event sets the flag, online resets backoff, online reconnects a disconnected room,
  plus 5 ordering tests (`orderedEntries` out-of-order, seq ties, system-note placement,
  note stability, and out-of-order relay rendering).
- `chat.enter.test.ts` (5): Enter submits, Shift+Enter does not, other keys do not, IME
  composition does not, missing `isComposing` treated as not composing.
- `chat.render.test.tsx` (4 payloads): `<script>`, `<img onerror>`, quote-breaking and
  suffix-script filenames all render escaped via `renderToStaticMarkup`.
- **Coverage gaps in the client suite**: no test drives `files.ts` upload/download streaming
  (only the size guards), no test covers `api.ts` `createRoom`/`joinRoom`/`generateRoomId`
  (including the 409 retry loop), and no test covers `store.ts` `sendText`/`sendFileMessage`
  happy paths end-to-end.

### Reusability answers for a future real-time feature (the special-focus questions)
- **Is there a WebSocket/DO abstraction to reuse?** Yes, and it is clean: the Worker DO
  (`HuskRoom`) already holds hibernatable sockets in one object per room with a JSON frame
  protocol, server-assigned sequencing and per-socket dedupe; the client side is
  `RoomConnection` behind a 5-method `ConnectionLike` interface (`store.ts:35-41`) that is
  injectable (`store.ts:43,74-76`). A new mode can add frame types in `protocol.ts` +
  `room.ts` `parseClientFrame`/`webSocketMessage` and reuse the same socket, join token, dedupe
  and ack machinery. **However**, the message path is single-purpose: 
  `parseServerMessage` rejects unknown tags (protocol tests pin that), and the DO relays opaque
  `payload` -- so a new frame type is a protocol change in both directions, not a plugin.
- **How to exchange session-setup info before audio starts**: the existing encrypted relay is
  the natural signalling channel (it is already E2EE, ordered and deduped); alternatively the
  file-ticket pattern (membership check in the DO -> HMAC ticket -> short-lived URL) is reusable
  for a one-shot handshake payload. **Do not** plan on WebRTC/STUN/TURN: the original spec
  explicitly rejects them (`HUSK-lovable-prompt.md:30`).
- **Microphone/audio/permissions handling that exists today: none.** A repo-wide,
  case-insensitive grep for `audio|sound|volume|microphone|mediaDevices|getUserMedia|AudioContext|
  MediaRecorder|permissions` across `src/`, `worker/`, `public/`, `tools/`, `e2e/`, `live-tests/`
  and config files returns **zero application hits** (the only matches are the word "sound" in a
  vendored lint-rule docstring). There is also no `Permissions-Policy` header and no
  permission-request UI anywhere; CSP (`server.ts:35-52`) has no `media-src`/`microphone`
  directive. Any audio feature starts from zero and must add: permission UX, `Permissions-Policy`,
  and probably a CSP `media-src`/`connect-src` allowance.
- **Real-time test utilities to extend**: `FrameQueue` + `openSocket` + per-test unique
  `CF-Connecting-IP` + `runInDurableObject`/`runDurableObjectAlarm` in
  `worker/tests/integration.test.ts:33-170,693-697` (see [05]); client-side, the injectable
  `spawnConnection` seam in `createRoomStore` plus the fake connection used by `store.test.ts`
  let real-time client logic be tested under Node without jsdom.

---

## [09] Public Assets & PWA

Files covered: `public/manifest.webmanifest` (18 lines), `public/sw.js` (122),
`public/_headers` (18), `public/robots.txt` (14), `public/fonts/OFL.txt` (88),
`public/fonts/inter-latin.woff2`, `public/favicon.ico`, `public/icons/husk-mark.svg` (27),
`husk-mark-maskable.svg` (28), `husk-mark-light.svg` (27), `icons/husk-logo.svg`,
`public/husk-logo-3d.svg`, and the four PNG icons. 18 files total under `public/`.
Read in full: `manifest.webmanifest`, `sw.js`, `_headers`, `robots.txt`, `OFL.txt`,
`husk-mark.svg`, `husk-mark-maskable.svg`, `husk-mark-light.svg` = YES.
Intentionally not read line-by-line: the 4 PNGs, `favicon.ico` and the `.woff2` (binary —
verified by magic bytes/size instead: all four PNGs carry the `89 50 4E 47 0D 0A 1A 0A`
signature; `favicon.ico` is a 4,009-byte multi-size ICO with 3 entries); `husk-logo.svg` and
`husk-logo-3d.svg` (read only the first 4 lines each: both are 320-unit-wide combined
light+dark logo lockups, not referenced by any code — grep shows no importer).
Last verified: 2026-09-17

### `manifest.webmanifest` — every field
`name` = Husk — ephemeral encrypted rooms; `short_name` = Husk;
`description` = Ephemeral, end-to-end encrypted rooms for chat and file sharing;
`id` = `/`; `start_url` = `/`; `scope` = `/`; `display` = `standalone`;
`background_color` = `#172112`; `theme_color` = `#172112`; `icons` = 5 entries:
`husk-icon-192.png` (192, image/png), `husk-icon-512.png` (512, image/png),
`husk-maskable-192.png` (192, purpose maskable), `husk-maskable-512.png` (512, purpose maskable),
`husk-mark.svg` (sizes `any`, image/svg+xml).
- **Installability: yes.** The manifest has name, short_name, start_url, scope, display
  standalone, 192+512 PNG icons (including maskable) and theme/background colours. The page
  links it (`__root.tsx:122`) and registers a service worker in production
  (`__root.tsx:161-169`), and `theme-color` is set in both head and manifest (`#172112`).
- Absent fields worth knowing: no `orientation`, no `lang`, no `dir`, no `shortcuts`, no
  `screenshots`, no `display_override`, no `categories`, no `prefer_related_applications`.
  Adding an audio chat mode would likely want `Permissions-Policy` rather than manifest changes.

### `sw.js` — the complete caching policy
- `CACHE_VERSION = v2`; two caches: `husk-shell-v2`, `husk-bundles-v2` (19-21).
- Precache list (23-34): `/`, `/manifest.webmanifest`, `/favicon.ico`, `/robots.txt`,
  `/icons/husk-mark.svg`, all four PNG icons, `/fonts/inter-latin.woff2` — i.e. the landing shell
  only.
- `install` -> `cache.addAll(PRECACHE_URLS)` + `skipWaiting()` (38-46); `activate` deletes any
  cache that is neither of the two current ones and calls `clients.claim()` (48-60).
- `fetch` rules (62-92), in order: ignore non-GET; **ignore cross-origin entirely** (so the
  production relay on `*.workers.dev` is never intercepted); ignore `/room/*` and `/api/*`;
  navigations: only `/` is handled (network-first with cache fallback via `serveHomeShell`,
  94-109), **any other navigation including `/r/<id>` is left to the network**; precached paths
  are cache-first; `/assets/*` is cache-first into the bundle cache; everything else is
  network-only (no `respondWith`).
- **Consequences:** the app is installable and the landing page renders offline; a room URL
  offline shows the browser error page (deliberate — rooms are per-request SSR and must never be
  served stale); the relay, WebSocket upgrade and file transfers are untouched by the SW; the
  SW itself is served `no-cache`.

### `public/_headers` — static-file header rules (applies to the frontend Worker)
Two rule blocks total (the comment at lines 1-3 explains that CSP must NOT be set here because
browsers intersect multiple CSP headers and `src/server.ts` already emits a per-response one):
- `/*` -> `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY` (lines 4-7).
- `path`-specific: `/assets/*` and `/fonts/*` -> `public, max-age=31536000, immutable`;
  `/icons/*` -> `public, max-age=604800`; `/sw.js` and `/manifest.webmanifest` -> `no-cache`.
- That is **6 rule blocks** (5 path-specific + 1 wildcard). `LIVE_TEST_SESSION_PROMPT.md:259`
  refers to "all 7 rules" — off by one against the file (minor doc drift, noted in [12]).

### Other public files
- `robots.txt`: explicitly allows Googlebot, Bingbot, Twitterbot, facebookexternalhit and `*`;
  per-route `noindex` is enforced in the room route head instead (`r.$roomId.tsx:39`).
- `fonts/inter-latin.woff2` (48,256 bytes) + `fonts/OFL.txt` (the SIL OFL 1.1 text plus origin
  URL and copyright) — the licence obligation for the self-hosted font is satisfied.
- Icons: `husk-mark.svg` is the 3-face gradient cube on an 84x96 viewBox (matching the in-app
  `HuskMark` geometry exactly: same polygon points, gradients and highlight polyline);
  `husk-mark-maskable.svg` puts the same cube in a 96x96 `#172112` square scaled 0.52 for the
  safe circle; `husk-mark-light.svg` is a darker green variant for light surfaces (currently
  unreachable because the app is dark-only — see [07]); all three are unreferenced by code except
  `husk-mark.svg`, which is used as an `<img src>` in `__root.tsx:127`, `index.tsx:89`,
  `r.$roomId.tsx:238,467`, `chat.tsx:268,291` and as the manifest SVG icon.
- PNG icons are generated, not hand-made: `tools/generate-icons.mjs` renders explicit-pixel
  hexagons with Playwright Chromium (transparent icons at 78 percent height, maskable ones at
  68 percent on a full-bleed `#172112` square). Regenerate with `node tools/generate-icons.mjs`
  from the repo root.

### PWA capability summary (the direct answers)
| Question | Answer |
|---|---|
| Installable? | Yes — complete manifest + 192/512 + maskable + SVG icon + standalone display + theme colour, and a SW registered in production |
| Service worker present? | Yes, hand-written `public/sw.js` (no Workbox, no `vite-plugin-pwa` — verified absent from the lockfile in [01]) |
| Offline support? | Landing shell only (`/` network-first with cached fallback + precached icons/font/manifest). Rooms, relay calls and assets other than precache/`/assets/*` are network-only by design |
| Offline UX in-app? | Yes — `ConnectionIndicator` renders "You are offline — messages can't send while offline" driven by `navigator.onLine` + window events (`store.ts:565-568`, `room-info.tsx:28-42`) |
| Native-feel features | Safe-area insets (`safe-top`/`safe-bottom` utilities used in the header/composer), `viewport-fit=cover` (`__root.tsx:102`), `overscroll-behavior-y: none`, standalone display, iOS `apple-touch-icon` |

---

## [10] Testing — e2e & live-tests

Files covered: `e2e/a11y.spec.ts` (55 lines), `e2e/modal.spec.ts` (109), `playwright.config.ts`
(read in [01]), and all 24 files in `live-tests/`. Fully read: `probe-lib.mjs` (194 lines) and
`drive-lib.mjs` (169). The other 22 live scripts were read as complete header blocks (first 12
lines of each, which carry the scenario id, intent and join-budget cost) but **not**
line-by-line — stated here so nothing is over-claimed.
Last verified: 2026-09-17

### e2e (Playwright + axe) — what runs and how
- Frameworks: `@playwright/test ^1.62.1` + `@axe-core/playwright ^4.13.0`; config in
  `playwright.config.ts` (see [01]). Tests run against the **production `.output/` build served by
  wrangler/workerd**, never the dev server, and require `pnpm build:a11y` first (.env.a11y points
  VITE_WORKER_URL at http://127.0.0.1:8787, the same origin Playwright serves). Command:
  `pnpm test:a11y`.
- `e2e/a11y.spec.ts` = **4 tests** (2 screens x 2 themes): landing `/` and room `/r/ab3xk9m2`
  with no fragment, which renders the branded This-link-has-no-key closed screen. Each asserts an
  AxeBuilder run with tags wcag2a, wcag2aa, wcag21a, wcag21aa returns zero violations, after a
  700 ms settle wait for the staggered entrance animations.
- `e2e/modal.spec.ts` = **6 tests** (3 behaviours x 2 themes) and is the only spec that exercises
  interactive app state: it fulfils **/room/create and **/room/join with mock JSON and stubs the
  socket via `page.routeWebSocket(/\/socket/, () => undefined)` (lines 25-36), then drives
  create -> open the room-info drawer -> click Leave room and asserts: Tab is trapped and wraps at
  both ends (confirm -> Cancel -> Leave -> Cancel -> Leave); Escape closes and restores focus to
  the invoking Leave room button; clicking the scrim closes the dialog while axe stays clean.
- **Stale assumption worth flagging:** both specs seed `localStorage[husk-theme]` to pick a theme,
  but `src/lib/husk/theme.ts` no longer reads or writes any key (theme is locked to dark) and the
  pre-paint script unconditionally adds the `dark` class. The light-theme variants therefore
  measure the **dark** theme twice: the suite reports 2 themes but has real coverage for one.
  (`a11y.spec.ts:32` even cites `src/lib/husk/theme.ts` as the reader of that key.)
- Not covered by e2e: no real WebSocket, no relay, no file transfer, no reconnect, no presence.
  Real-time behaviour is covered by the workerd integration suite ([05]) and the live scripts.### live-tests — the deployment battery (24 scripts, run manually)
- Two shared libraries define two styles:
  - `probe-lib.mjs` -- **raw protocol driver** against the deployed relay.
    `BASE = https://husk.ns8pc1.workers.dev`; helpers `createRoom`, `joinRoom`,
    `requestFileGrant`, `putChunk`, `getFile`, `randomRoomId`, `fetchRetry` (4 attempts with
    linear backoff, added because the audit network dropped TLS connects), and
    `connect(pin, joinToken, label)` which opens `wss://.../socket?jt=...`, buffers every frame and
    exposes `waitFor(matchStringOrPredicate, timeoutMs)`. It also reimplements the browser crypto
    (`importRoomKeySync`, `seal`, `openSealed`, base64url helpers) so raw tests can decrypt.
    `assert` throws on failure and logs PASS lines.
  - `drive-lib.mjs` -- **Playwright driver** against the deployed frontend
    (`FRONTEND = https://ns81000-husk.ns8pc1.workers.dev`): `launch`, `monitor(page)` (collects
    console messages, page errors, failed requests, >=400 responses and POST bodies),
    `createRoomViaUi`, `joinViaLink`, `participantCount`/`waitForParticipants`, `sendText`,
    `messageCount`, `attachFile`, `statusLine`.
- Runner: **Node >= 24** (global fetch/WebSocket), invoked from the repo root as
  `node live-tests/<script>.mjs`. No runner, no report format, no CI (there is no CI at all).
- **Join-budget discipline is part of every script header.** `/room/join` is 10 per 5 min per IP,
  so each script documents how many joins it spends: `probe-capacity.mjs` plans 9 joins, a
  5-minute pause, then 2; `stress-conn.mjs` documents the ceiling when hit; `stress-security.mjs`
  runs its create burst last because it exhausts the create budget. A new live script must follow
  the same accounting.
- Inventory and intent (from each header):
  - Raw probes: `probe-a-core.mjs` (create, two sockets, bidirectional relay, acks, ordering,
    presence, resend dedup); `probe-capacity.mjs` (10 participants; simultaneous edge join admits
    exactly one; 11th refused); `probe-d-files.mjs` (multi-chunk upload, streamed GET byte
    equality, GET replay, download after sender closes, cancel + budget refund, 507);
    `probe-e-security.mjs` (security group + file-ticket edges); `probe-eviction.mjs` (hibernation
    wake and isolate eviction with seq continuity); `probe-reconnect.mjs` (true socket-drop
    semantics; no backfill by design); `probe-debug.mjs` (two joins with full event logging);
    `probe-g-live.mjs` (live axe + mobile snapshots + `_headers` contract; header notes the PIN
    flow is gone); `probe-g-static.mjs` (CSP/hash coverage, console cleanliness, error paths,
    manifest/SW/_headers on the live frontend, zero joins).
  - Browser drives: `drive-a.mjs` (both-way messaging, small + mid file byte equality, XSS inert);
    `drive-b.mjs` (host killed -> grace window -> waiting-for-peer + system note; guest closed
    screen); `drive-b10.mjs` (reconnect termination via exhausted budget, recovery on the online
    event); `drive-c.mjs` (rapid double-send; duplicate tab as a distinct participant);
    `drive-f.mjs` (offline PWA shell; ~50 kB/s throttle during a 3 MB upload); `drive-g.mjs`
    (in-room axe + keyboard-only walkthrough); `drive-h.mjs` (0-byte / 1-byte / over-25 MB files,
    XSS filename, wrong-key link, F5 reset honesty); `drive-i48.mjs` (redeploy the relay while a
    room is active); `drive-reconnect.mjs` (offline banner -> online -> auto-reconnect -> queued
    flush); `debug-single.mjs` (UI create + state dump).
  - Stress: `stress-conn.mjs` (5a connection churn + message survival across reconnect),
    `stress-msg.mjs` (5b 50 rapid messages, ordering, empty/invalid/oversized payloads),
    `stress-lifecycle.mjs` (5c invalid room ids, join on a nonexistent room, rate-limit shape,
    expiresAt sanity), `stress-files.mjs` (5d boundary sizes, tampered/expired tickets, replayed
    chunks), `stress-security.mjs` (5e/5f spoofed senderId, client-sent server-only frames, token
    reuse, path traversal, same-millisecond sends, create-rate-limit burst).
- Network caveat recorded in `FINDINGS.md:54-55`: these scripts are sensitive to the path between
  this machine and `*.workers.dev`; flaky failures were re-run twice before being judged real.
- **Reusable patterns for a future audio/real-time feature:** `probe-lib.connect()` +
  `waitFor()` is a ready-made raw-socket harness for a new frame type, and `drive-lib.monitor()`
  is the ready-made way to prove a browser feature produces no console errors, failed requests or
  bad responses while a peer exchanges data.

---

## [11] Tools & Dev Scripts

Files covered: `tools/commit.txt` (12 lines), `tools/generate-icons.mjs` (74 lines), and all 21
files of `tools/oxlint/anti-slop/**` (hash-verified byte-identical to the 21 files under
`.agents/skills/install-anti-slop/assets/anti-slop/**`; the rule inventory and severities are
documented in [00]).
Read in full: `commit.txt`, `generate-icons.mjs`; for the vendored plugin, `index.ts`
(41 lines) and `rules/require-safety-comment-for-type-assertion.ts` (62 lines) in full and the
remaining 19 files were hash-compared rather than read line-by-line (they are third-party
skill assets, identical to the copy described in the install skill).
Last verified: 2026-09-17

### `tools/generate-icons.mjs` — the only generator in the repo
- Uses `chromium` from `@playwright/test` to rasterise SVG geometry into the four PNG icons; run
  as `node tools/generate-icons.mjs` from the repo root (it resolves `../public/icons` itself).
- Constants: `HEX = #3ce767`, `BG = #172112`, hexagon polygon `42,0 84,24 84,72 42,96 0,72 0,24`
  on an 84x96 viewBox (lines 21-24).
- `transparentIcon` renders the hexagon at **78 percent** of the canvas height (husk-icon-192/512,
  `omitBackground: true`, lines 42-53); `maskableIcon` renders it at **68 percent** on a
  full-bleed `#172112` square (husk-maskable-192/512, lines 56-66). The header explains both are
  drawn at explicit pixel sizes because the SVG intrinsic width/height previously overran the
  canvas.
- Note: this generator emits a **flat green hexagon**, whereas the shipped brand mark is the
  3-face gradient cube (`public/icons/husk-mark.svg` / `HuskMark`). The PNGs are therefore a
  simplified mark, not a pixel-identical rendering of the SVG.

### `tools/commit.txt` — a captured log, not a script
- 12 lines of `git commit` output for the redesign commit `542f2bd`
  ("Redesign frontend: remove PIN flow, new design system, Grainient landing, room-id slugs";
  44 files changed, 1386 insertions, 675 deletions). It records the deletions of
  `src/components/husk/keypad.tsx`, `src/lib/husk/pin.ts`, `pin.test.ts` and the
  `r.$pin.tsx -> r.$roomId.tsx` rename, plus the creation of `Grainient.*`, `husk-logo.svg`,
  `husk-mark-light.svg` and `generate-icons.mjs`. Useful as provenance for the PIN-removal phase;
  it is inert data with no build role (verified: nothing imports or reads it).

### `tools/oxlint/anti-slop/**` — the vendored lint plugin
- Entry `tools/oxlint/anti-slop/index.ts`: imports `eslintCompatPlugin` from `@oxlint/plugins`,
  wires the 15 rule modules, and default-exports the plugin at lines 20-41.
- Registered exactly once as a JS plugin in `.oxlintrc.json:26-28`; the Effect sub-plugin in
  `tools/oxlint/anti-slop/effect/` exists but is **not registered** (see [00]).
- The rule that most affects day-to-day code style is
  `require-safety-comment-for-type-assertion` (severity `warn`): it walks up from a `TSAsExpression`
  or `TSTypeAssertion` to the nearest statement that can own a comment and requires a `SAFETY:`
  comment before it, ignoring `as const`. Every existing cast in `src/` and `worker/src/` complies
  (13 files, listed in [02]).
- Nothing in this tree is imported by application code, and both lint gates ignore it.

### What a change-agent must actually run (exact commands, from package.json + docs)
Prerequisites: Node 24+ (`README.md:292`), pnpm only, and two separate installs (the packages are
independent; see [01]):
```sh
pnpm install                 # repo root
pnpm --dir worker install    # worker (own lockfile)
```
Verification gates, with the exact flags:
```sh
pnpm test                                  # root vitest: client units + worker/src units + worker/tests (workerd)
cd worker; pnpm test                       # 26 workerd integration tests only
pnpm exec tsc --noEmit                     # root typecheck (src + vite/eslint configs only)
cd worker; pnpm exec tsc --noEmit          # worker typecheck (src + tests)
pnpm run lint                              # eslint .  (includes prettier via eslint-plugin-prettier)
pnpm run lint:anti-slop                    # oxlint --type-aware (anti-slop plugin)
pnpm run build                             # vite build -> .output (nitro cloudflare)
pnpm run test:a11y                         # build:a11y + playwright (axe + modal specs)
node live-tests/<script>.mjs               # live battery, Node >= 24, manual only
node tools/generate-icons.mjs              # only when icons/mark geometry changes
```
- There is **no** root `typecheck` script, **no** `pnpm test` alias for the worker suite,
  **no** git hooks (no husky/lint-staged/commitlint anywhere in package.json or `.git` config
  hooks), **no** CI workflow, **no** `.editorconfig`, and **no** monorepo task runner. Everything
  is manual, and the docs' verification battery ([00]) is the only enforcement mechanism.
- Formatting: `pnpm run format` = `prettier --write .` and its ignore list omits `.agents/` and
  `tools/`, so running it will rewrite the vendored anti-slop sources. Use `pnpm run lint`
  (eslint + prettier-as-a-rule) for change verification instead.

---

## [12] Risks & Observations

Files covered: no new files are read here; this section synthesises sections [00]-[11] plus the
follow-up greps run this session (ROOM_FULL/closed_full references, unused-export probes,
dependency-import usage across src, Grainient and malformedCount references).
Read in full: N/A (synthesis of material already cited above).
Last verified: 2026-09-17

Everything below is **read-only observation**: nothing was changed. Each item names the
evidence line so it can be verified or dismissed. Severity is my judgement and is labelled.

### A. Documentation vs code contradictions (code wins in every case)
| # | Sev | Claim | Reality | Evidence |
|---|---|---|---|---|
| A1 | MED | README: light and dark themes swap tokens through a `dark` class, and `implementation_plan.md:21` specifies a segmented Light/Dark toggle | The app is **dark-only**: `theme.ts` locks `Theme` to `dark` and `setTheme` is a no-op; `__root.tsx:20,147` unconditionally adds the `dark` class pre-paint. The full light palette in `styles.css:97-124` is unreachable | `src/lib/husk/theme.ts:1-15`; `README.md:380-382`; `src/routes/__root.tsx:20,147` |
| A2 | MED | Both e2e specs test the light and dark themes | They seed `localStorage[husk-theme]`, which no code reads, so the light runs measure the dark theme again | `e2e/a11y.spec.ts:31-36`; `e2e/modal.spec.ts:16-20`; `src/lib/husk/theme.ts` |
| A3 | LOW | `room-info.tsx` tells users "Instant Dissolution: When all participants leave, the room vanishes forever" | A room with zero participants persists for `ROOM_IDLE_TIMEOUT_MS = 30 min` before the alarm purges it; the DO keeps the room-state row and any file rows in the meantime | `src/components/husk/room-info.tsx:175-177`; `worker/src/config.ts:9`; `worker/src/room.ts:600-603` |
| A4 | MED | README/findings quote 121 unit tests, 147 passing, 26 integration | Five mutually inconsistent counts exist across docs; my file-content count is 26 integration + 12 worker unit + 24 client unit; nothing was executed to confirm actual pass counts | `README.md:17,318-319`; `FINDINGS.md:33-39,46` |
| A5 | LOW | Third-party audit prompt says root and `worker/` form a pnpm workspace | `worker/pnpm-workspace.yaml` is an `allowBuilds` list, not a workspace definition; the two installs are independent | `worker/pnpm-workspace.yaml:1-6`; `prompts/audit/Husk audit prompt.md:22` |
| A6 | LOW | `LIVE_TEST_SESSION_PROMPT.md:259` refers to "all 7 `_headers` rules" | `public/_headers` contains 6 rule blocks | `public/_headers:4-17` |
| A7 | LOW | `LIVE_TEST_SESSION_PROMPT.md:43` says rooms purge after 31 min idle | Code uses 30 min idle + an alarm cadence of up to 60 s | `worker/src/config.ts:9,12` |
| A8 | LOW | Prompt docs and their outputs live under `docs/audit/` and `docs/implementation/` | No `docs/` directory exists; the documented phase logs and SUMMARY.md are absent, and every prompt hardcodes `C:\Users\Ns8pc\Pictures\HUSK` while the checkout is `...\Videos\HUSK` | [00] path-drift block |
| A9 | LOW | `implementation_plan.md:12-17` specifies Grainient as the landing background | The landing page uses `MoltenMetal`; `Grainient` is imported by nothing | `src/routes/index.tsx:64-83`; Grainient grep = own files only |
| A10 | LOW | `components.json` describes a shadcn setup with `src/components/ui` and `src/hooks` aliases | Both directories were deleted; the aliases point at nothing | `components.json:14-20`; `FINDINGS.md:21` |

### B. Security observations (no exploitation attempted; all read-only)
- B1 (LOW): **CORS is response-readable-only, not request-side enforcement.** The allowlist at
  `index.ts:24-38` only decides whether `Access-Control-Allow-Origin` is emitted; the Worker still
  processes any request and returns identical status codes. WebSocket upgrades are not
  CORS-preflighted at all, so the one-time join token is the sole gate on `/socket`.
- B2 (LOW): **`/room/<id>/socket` has no edge rate limit.** A caller without a token gets a generic
  404 (`room.ts:226-228`) but still costs one Worker invocation plus one DO invocation per attempt
  (`index.ts:157-169`). On the Free plan (100k requests/day per the audit docs) this is a cheap
  request-quota amplifier.
- B3 (MED): **No rate limit or size cap on WebSocket frames.** `parseClientFrame` (`room.ts:59-89`)
  coerces via `String(data)` and `webSocketMessage` (`room.ts:504-552`) relays whatever parses;
  there is no per-socket message budget, so a joined participant can force one SQLite write
  (`persistState`) plus N socket sends per frame as fast as the platform allows. Relevant if a
  future audio mode adds high-frequency signalling on the same socket.
- B4 (LOW): **Download capability cannot be revoked** before room expiry: the `get` ticket expires
  at `expiresAt()` (up to 24 h) and the only revocation is room closure (`room.ts:372-378,
  432-471`).
- B5 (LOW): **`/room/<id>/file` reservations are unthrottled** beyond the 25 MB per-file cap and
  the 100 MB room budget (`room.ts:323-345`); a member can reservation/cancel in a loop, and each
  reservation writes a meta row plus N chunk signatures.
- B6 (LOW, by design): **Room ids are not secrets.** `/room/create` accepts a caller-supplied id
  validated only by pattern, and the client regenerates on 409, so ids are enumerable; security
  rests entirely on the fragment key (`index.ts:86-91`, `api.ts:47-72`).
- B7 (LOW): **If `CF-Connecting-IP` were ever absent, all such callers share one rate-limit
  bucket** per namespace (`index.ts:94,117`, `rate-limit.ts:100`).
- B8 (INFO): **No `Permissions-Policy` header anywhere** and no `media-src`/`microphone` directive in
  the CSP (`server.ts:35-52`). A future microphone feature must extend both, and CSP is currently
  `default-src self` with hashed inline scripts, so any new origin/API has to be added deliberately.
- B9 (INFO, good news): the cryptography contract holds up under reading — AES-256-GCM with fresh
  random IVs (`crypto.ts:69-77`), non-extractable imported key (`crypto.ts:59-62`), fragment-key
  routing (`index.ts:49` + `index.ts:9` comment), HMAC tickets with operation domain separation
  (`tickets.ts:44`), constant-time comparison (`tickets.ts:61-68`), and an integration test that
  pins the relay frame's exact key set to routing metadata plus `{iv, ct}`
  (`integration.test.ts:671-675`). I found no plaintext-leak or key-leak path in the code I read.### C. Reliability / race observations
- C1 (MED): **The `closed_full` state is unreachable.** `RoomEvent` defines `ROOM_FULL` and the
  machine maps it to `closed_full` (`room-machine.ts:34,89-90`), but nothing dispatches it: the
  store only emits `ROOM_NOT_FOUND`, `RATE_LIMITED`, `CONNECTION_LOST`, `EXPIRED`, `IDLE_CLOSED`
  from `handleEnded` (`store.ts:199-215`). Meanwhile the DO answers a full room during socket
  upgrade with `403 room_full` (`room.ts:248-252`), which the client can only see as a failed
  handshake (`connection.ts:189-196`) and therefore reports as **`closed_not_found`** — copy:
  "The room does not exist, is full, or the link is missing its key." So the specific
  "Room full" screen (`r.$roomId.tsx:60,83-84`) can never render. Verified by grep: `ROOM_FULL`
  appears only in `room-machine.ts`.
- C2 (MED): **`recentSends` is in-memory only**, so duplicate relays are possible after an isolate
  eviction (the LO finding at `FINDINGS.md:312` was only partially addressed by raising the cap to
  1000). `room.ts:100,528-562`.
- C3 (MED): **One SQLite write per chat message.** `webSocketMessage` awaits `persistState()`
  before broadcasting (`room.ts:541,134-140`), so every message updates the whole room-state row on
  the same object that holds 1 MiB file rows. This is what makes `seq` survive eviction; it is also
  the dominant per-message cost and latency contributor on a 10 ms-CPU plan.
- C4 (LOW): **The `/join` capacity check is advisory.** `/join` reports `enabled` from a count that
  does not include the caller (`room.ts:193-196`), and admission happens later at the socket
  (`room.ts:248-252`); two concurrent joins can both pass and only one socket opens. The client
  surfaces this as an unavailable room (see C1).
- C5 (LOW): **`alarm()` closes sockets with normal close code 1000** (`room.ts:609`). A client that
  keys off the close code rather than the preceding `{t:closed}` frame would treat expiry as a blip;
  the shipped client does use the frame (`store.ts:336-343`), so this is a contract fragility for
  future clients.
- C6 (LOW): **`retry()` wipes the transcript** (`connect()` resets `entries` at `store.ts:411-418`)
  — intended for terminal states, but it means a user pressing Reconnect on
  `closed_disconnected` loses local history. The guard added in fix #7 prevents it from firing in
  live states only.
- C7 (LOW): **Outbox drop is silent.** When the outbox exceeds `MAX_OUTBOX_FRAMES = 50` the oldest
  frame is discarded (`connection.ts:304-310`) while the corresponding entry may still read
  `sending` until the 10 s ack timeout flips it to `failed`.
- C8 (LOW): Two `useEffect` cleanups and the grace timers are all module-scope-but-per-store; the
  singleton store never unregisters its `online`/`offline` window listeners (commented as
  intentional, `store.ts:561-568`) — fine for a page-lifetime singleton, but a future test or
  multi-store usage will leak listeners.
- C9 (INFO): `persistState`/`restoreVolatileState` correctly rehydrate `seq`, deadlines and the byte
  budget, and the integration suite proves the room survives eviction (`integration.test.ts:229`)
  and that the alarm purge removes file rows (`:680-706`). This part of the design is solid.

### D. Dead or unreachable code and unused surface (all verified by grep)
- D1: `src/components/husk/Grainient.tsx` + `Grainient.css` — referenced only by themselves.
- D2: `WaitingMark` (`icons.tsx:97`) — zero references. `ErrorMark` (`icons.tsx:114`) is imported
  by `__root.tsx:13` but never rendered (unused import; eslint does not flag it because
  `@typescript-eslint/no-unused-vars` is off).
- D3: `ROOM_FULL` event + `closed_full` state + `CLOSED_COPY.closed_full` — unreachable (see C1).
- D4: `store.error` — written once (`store.ts:426`) and never read by any component, so the
  more precise "This link is missing a valid room key." text is never shown; the user sees the
  generic closed_not_found copy instead.
- D5: `store.malformedCount` — incremented and `console.warn`ed (`store.ts:446-451`) but never
  rendered anywhere; only `store.test.ts:361` reads it.
- D6: `TicketOperation` includes `put` (`tickets.ts:32`) which no caller uses.
- D7: `Public/icons/husk-logo.svg`, `public/husk-logo-3d.svg`, `public/icons/husk-mark-light.svg`,
  `public/icons/husk-mark-maskable.svg` — zero references from code (only `husk-mark.svg` and the
  PNGs are used). They ship in the bundle as dead assets.
- D8: 14+ runtime dependencies are never imported by `src/`: every `@radix-ui/*` package,
  `recharts`, `sonner` (the app has its own toast system), `cmdk`, `zod`, `date-fns`,
  `lucide-react` (custom icon set instead), `react-hook-form`, `embla-carousel-react`, `input-otp`,
  `react-day-picker`, `react-resizable-panels`, `class-variance-authority`, `tw-animate-css`.
  `@tanstack/react-query` appears only as a provider with no query usage (`router.tsx:6`,
  `__root.tsx:172`). Tree-shaking keeps them out of the bundle, but they are install/audit surface
  and a supply-chain surface. (`vaul`, `ogl`, `clsx`, `tailwind-merge` are genuinely used.)
- D9: `src/lib/lovable-error-reporting.ts` is only reachable in dev (`__root.tsx:54-58` guards it
  with `import.meta.env.DEV`) — intentional, not dead.
- D10: `error.ts` helpers are all used (`describeError`, `consumeLastCapturedError`).

### E. Tooling / configuration risks
- E1 (LOW): **`.env` is not gitignored** (`.gitignore:1-42`), while `README.md:305-309` tells you
  to create one. It only ever holds a public relay URL today, but the omission is a foot-gun for
  any future secret.
- E2 (LOW): `pnpm format` (prettier) does not exclude `.agents/**` or `tools/**`, so it will
  rewrite vendored lint assets that eslint deliberately ignores — a diff-noise machine.
- E3 (LOW): The anti-slop gate does not cover `worker/tests/**`, `live-tests/**`, `e2e/**` or any
  `src/**/*.test.ts(x)` (`.oxlintrc.json:17-24`); eslint does cover `worker/tests` but not
  `live-tests`/`e2e`/`tools`/`.agents` (`eslint.config.js:10-19`).
- E4 (LOW): **No CI, no git hooks, no `packageManager` pin.** Every gate in [11] is manual and
  nothing enforces that they ran.
- E5 (LOW): No Worker-side logging or tracing (`grep console. = zero hits under worker/`), so a
  gatekeeper outage that fails closed (`rate-limit.ts:108-110`) is indistinguishable from normal
  throttling in any operational sense.
- E6 (INFO): Three conflicting deploy recipes exist across README, the phase-2 template and the
  live-test prompt ([01]); none was executed here, so the current authoritative recipe is UNVERIFIED.

### F. Design-system deviations (details in [07])
- F1: `text-emerald-950` (Tailwind default palette) at `room-info.tsx:130` — the only
  default-palette violation I found; Phase 5 claimed the grep was clean.
- F2: raw hex such as `#04180c` / `#3ce767` / `#ef4444` in components and class bodies instead of
  tokens; off-scale utilities (`h-13`, `w-88`, `w-13`) outside 4/8/12/16/24/32/48/96 or the
  blessed 44/56 touch tokens.
- F3: `prefers-reduced-motion` is honoured for the WebGL canvases but **not** for any CSS keyframe
  animation (rotating ring, shimmer, collapse, slide).
- F4: `error-page.ts` bypasses the design system entirely (hardcoded greys) — defensible for a
  last-resort page, but it means one screen will look off-brand if it ever renders.

### G. Capability gaps relative to the planned chat mode
- G1: **No microphone/audio/permission code exists at all** — grep for
  audio|sound|volume|microphone|mediaDevices|getUserMedia|AudioContext|MediaRecorder|permissions
  over the whole tracked tree returns zero application hits. There is nothing to extend; the
  feature is net-new on the client.
- G2: **No `Permissions-Policy` header and no media CSP directives** (`server.ts:35-52`); a mic
  feature must add both plus a pre-prompt UX (the app currently has no permission-request UI of any
  kind).
- G3: **The WebSocket/DO abstraction is reusable for signalling but not a plugin system.**
  `parseServerMessage` rejects unknown tags by design (and `protocol.test.ts:46-51` pins that), so
  a new frame type is a coordinated change in `protocol.ts` + `room.ts` (+ the frame-key-set test
  in `integration.test.ts:671-675`), with the relay, dedupe, ack and ordering machinery reused as-is.
- G4: **Reusable patterns that already exist**: membership-gated HMAC capability minting
  (`room.ts:323-387`), one-time token minting with a nonce and burn record (`index.ts:136-154`,
  `room.ts:229-244`), chunked 1 MiB storage with a streamed GET (`room.ts:389-472`),
  injectable connection for client tests (`store.ts:43,74-76`), `FrameQueue` raw-socket harness
  (`integration.test.ts:63-115`) and `probe-lib.connect/waitFor` for live probes.
- G5: **No existing UI surface for a second mode.** The app has one button, one route family and no
  navigation; a new mode needs an explicit entry point in `index.tsx` and its own route file, with
  the route tree regenerated by the dev server.

---

## [13] Open Questions for Human

Files covered: none (questions and a file-accounting table derived from git ls-files).
Read in full: N/A.
Last verified: 2026-09-17

1. **Light theme: resurrect or retire?** `theme.ts` is a hard no-op and the pre-paint script always
   adds `dark`, yet README, `implementation_plan.md` and both e2e specs still assume a Light/Dark
   toggle (A1/A2). Should the light palette in `styles.css:97-124` stay as dead configuration, or
   should theme selection be re-implemented (and the e2e specs made real again)?
2. **Was `closed_full` intended to work?** Nothing dispatches `ROOM_FULL`, so a genuinely full room
   is reported as "Room unavailable" and the "Room full" screen is unreachable (C1). Wire it
   (translate the DO's 403 into `ROOM_FULL`) or delete the state?
3. **Idle retention vs UI copy.** A room sits for 30 minutes after the last participant leaves,
   but the in-app security blurb says it vanishes when everyone leaves (A3). Which is the intended
   contract — shorten the timer, or correct the copy?
4. **Which deploy recipe is authoritative** for relay and frontend (three disagree, E6), and is the
   `<root>/.wrangler/deploy/config.json` deletion step still required?
5. **Should the 14+ unused runtime dependencies be removed** (`@radix-ui/*`, `recharts`, `sonner`,
   `cmdk`, `zod`, `date-fns`, `lucide-react`, `react-hook-form`, `embla-carousel-react`,
   `input-otp`, `react-day-picker`, `react-resizable-panels`, `class-variance-authority`,
   `tw-animate-css`, D8), or are any of them planned for the new feature?
6. **Where are the missing implementation logs?** `prompts/implementation/` references
   `SUMMARY.md` and `phase-N-log.md` files that do not exist in this checkout (A8). Do they exist
   under the old `Pictures\HUSK` path and should they be ported in?
7. **For the planned audio mode — transport decision.** The original spec bans WebRTC/STUN/TURN
   (`HUSK-lovable-prompt.md:30`) and every existing capability is server-relayed. Should audio be
   relayed through the room DO (reusing tickets/storage/membership), or does this feature require
   revisiting that ban? The answer decides whether G3/G4 are reused or replaced.
8. **Permission UX expectations.** There is no permission-request UI and no `Permissions-Policy`
   header today (G1/G2). Should the new mode own the mic prompt and header policy, or should that
   live in `server.ts` / `_headers` alongside CSP?
9. **Test counts.** Every doc quotes a different number (A4) and nothing was executed in this
   read-only session. Do you want the suites actually run (`pnpm test`, `cd worker; pnpm test`,
   `pnpm test:a11y`) to pin the real counts before feature work starts?
10. **One unread range.** `prompts/audit/Husk audit prompt.md` lines ~161-234 (the Phase 4/5/6
    checklist blocks) were not opened. If those sections contain requirements that still bind the
    project, they should be read before implementation planning.

### File accounting — all 186 tracked files
| Group | Count | Where covered |
|---|---|---|
| `.agents/**` (SKILL.md, scripts/install.mjs, assets/anti-slop 21) | 23 | [00] (hash-verified duplicate of `tools/oxlint/anti-slop/**`) |
| `tools/**` (commit.txt, generate-icons.mjs, oxlint/anti-slop 21) | 23 | [11], [00] |
| `prompts/**` (17 documents) | 17 | [00] |
| Root config/meta (18: package.json, tsconfig, vite/vitest/playwright configs, eslint, .oxlintrc, prettier x2, git x2, components.json, skills-lock, 2 env files, LICENSE, README, pnpm-lock) | 18 | [01] |
| `worker/**` (6 root + 10 src + 2 tests) | 18 | [02] `wrangler.toml`/`config.ts`/`types.ts`/`globals.d.ts`/`index.ts`; [03] `room.ts`; [04] `gate.ts`/`rate-limit.ts`/`tickets.ts`; [05] all tests + `test-types.d.ts`; [01] `package.json`/`tsconfig`/`vitest.config`/`pnpm-workspace.yaml`/`pnpm-lock.yaml` |
| `src/**` | 43 | [06] (all 43 filed by role), [07] (components + styles), [08] (routes, store, connection, tests) |
| `public/**` | 18 | [09] (binary assets verified by magic bytes/size; 2 logo SVGs read partially) |
| `e2e/**` | 2 | [10] |
| `live-tests/**` | 24 | [10] (2 libraries read fully; 22 scripts read header-deep — stated explicitly there) |
| **Total** | **186** | matches `git ls-files` count exactly |

### What was read fully vs partially (so nothing is over-claimed)
- **Read fully**: all of `worker/src/**`, `worker/wrangler.toml`, `worker/tests/test-types.d.ts`,
  all 21 root config/meta files, `src/routes/**`, `src/server.ts`, `src/start.ts`,
  `src/router.tsx`, `src/routeTree.gen.ts`, `src/styles.css`, `src/lib/**` (including all 10 client
  test files), `src/components/husk/{primitives,room-info,icons,chat,Grainient}.tsx`,
  `chat.enter.test.ts`, `chat.render.test.tsx`, `e2e/**`, `live-tests/{probe-lib,drive-lib}.mjs`,
  `tools/{commit.txt,generate-icons.mjs}`, `public/{manifest.webmanifest,sw.js,_headers,robots.txt,
  fonts/OFL.txt,icons/husk-mark*.svg}`.
- **Read partially, with the gap named in-section**: `prompts/audit/Husk audit prompt.md`
  (~lines 161-234) in [00]; `worker/tests/integration.test.ts` (~350 of 839 lines) in [05];
  `src/components/husk/MoltenMetal.tsx` (props only) in [06]/[07]; `connection.test.ts` and
  `store.test.ts` (titles + structure) in [08]; the 22 non-library live-test scripts (headers) in
  [10]; `public/icons/husk-logo.svg` and `public/husk-logo-3d.svg` (first lines) in [09].
- **Not read line-by-line by design**: `pnpm-lock.yaml`, `worker/pnpm-lock.yaml` (generated),
  the 4 PNG icons + `favicon.ico` + `inter-latin.woff2` (binary), and 19 of the 21 vendored
  anti-slop rule files (covered by SHA-256 comparison against the identical `.agents` copy).
- **Nothing was executed**: no test, build, lint, deploy or network request was run in this
  session, so every number quoted from the docs remains a doc claim rather than a measurement.
