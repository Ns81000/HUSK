# Vendored codec: ggwave (data-over-sound)

`ggwave.js` in this directory is the prebuilt Emscripten artifact from the
upstream ggwave repository, carrying **one deliberate, documented patch**
(see below).

- Upstream: https://github.com/ggerganov/ggwave
- Source path: `bindings/javascript/ggwave.js`
- Upstream commit: `060aec73dd7123ccac200442f75bdc7369795ffe`
  (`ggwave-v0.4.3-2-g060aec7`, branch `master`, 2026-04-16)
- License: MIT — Copyright (c) 2020 Georgi Gerganov (full text in
  `LICENSE.ggwave`, byte-identical to upstream's `LICENSE`, blob
  `db7a934edc443ee05cdea6786e5f1f800c1a6fe5`).

## Hashes

The unpatched numbers below were **verified once**, in the research clone, and
that clone is gitignored and no longer a git repository — so they cannot be
re-derived from this repository alone. Re-verify before relying on them:

```sh
git clone https://github.com/ggerganov/ggwave
git -C ggwave checkout 060aec73dd7123ccac200442f75bdc7369795ffe
git -C ggwave cat-file -s :bindings/javascript/ggwave.js   # 148131
```

`provenance.test.ts` asserts that these strings are *recorded*; only the
patched file's size, SHA-256 and both blob ids are checked against real bytes.

- Unpatched upstream bytes: 148131 bytes,
  SHA-256 `D5FDB0A11B390D357D67163311C064FFD8CD90476911DCCA3C689A98EA11AB6B`,
  git blob `b9ca22672b85ebe916ec7baa344bde983421751c` — identical to upstream's
  stored blob for that path. The upstream hash is the LF form; the research
  clone's CRLF working-tree copy (148150 bytes, SHA-256
  `F4BD5E9E3B79DB9C599D197C83D250E1A514C0295F4856A26065B6E427C252F3`) is the
  same content. Only the first hash survives a fresh checkout.
- **Current (patched) file: 147139 bytes,
  SHA-256 `B097B3294D478B13C6693C33303C86F02BC9FFFD5DDE03698490A124E01E577F`,
  git blob `50fa40a4367e3d4cb4f3f9186ca67b89d1bd433e`.**

## The patch: CSP-safe embind invokers

Upstream's embind glue ends `craftInvokerFunction` with
`return newFunc(Function, args1).apply(null, args2)` — the _global_ `Function`
constructor compiles one invoker per registered binding at init, which HUSK's
Content-Security-Policy forbids (`script-src 'self' 'wasm-unsafe-eval'`, no
`'unsafe-eval'`). Measured in Phase 0 (see
`prompts/sound-chat/SOUND_CHAT_LOG.md`): the very first codec call throws an
EvalError under that CSP.

The patch replaces the generated-source invoker inside `craftInvokerFunction`
with a plain closure that performs exactly the same steps (argument-count
check, `toWireType` conversion of `this` and every argument into a wired list,
optional destructor stack, `runDestructors`, `retType.fromWireType` return) and
is named via the artifact's own CSP-safe `createNamedFunction`. No dynamic code
execution remains in the file (`newFunc` itself is now unreferenced).

Re-derive this patch on any artifact upgrade; the Phase 0 fuzz and the harness
`codec loading vs HUSK's CSP` test are the regression guards for it.

The exact region replaced is one contiguous hunk, 1803 bytes of upstream source
becoming 811 bytes, inside `craftInvokerFunction`. Note that no export name of
this artifact appears anywhere as text in `ggwave.js` — embind registers the
bindings from inside the wasm binary — so the surface declared in `ggwave.d.ts`
can only be checked by *executing* the module, never by grepping the file.

`package.json` here is not a package — it only marks this directory as
CommonJS so Node and the bundler treat the UMD artifact as CJS. HUSK's root
`package.json` is `"type": "module"`.
