# Vendored codec: ggwave (data-over-sound)

`ggwave.js` in this directory is an unmodified, byte-for-byte copy of the
prebuilt Emscripten artifact from the upstream ggwave repository.

- Upstream: https://github.com/ggerganov/ggwave
- Source path: `bindings/javascript/ggwave.js`
- Upstream commit: `060aec73dd7123ccac200442f75bdc7369795ffe`
  (`ggwave-v0.4.3-2-g060aec7`, branch `master`, 2026-04-16)
- Size: 148131 bytes
- SHA-256: `D5FDB0A11B390D357D67163311C064FFD8CD90476911DCCA3C689A98EA11AB6B`
- Git blob id: `b9ca22672b85ebe916ec7baa344bde983421751c` — **identical to
  upstream's stored blob** for that path, so this copy is byte-for-byte what
  upstream published, not merely hash-equal to a local file.
- License: MIT — Copyright (c) 2020 Georgi Gerganov (full text in
  `LICENSE.ggwave`, likewise byte-identical to upstream's `LICENSE`, blob
  `db7a934edc443ee05cdea6786e5f1f800c1a6fe5`).

The hash above is the LF form, which is what HUSK's `.gitattributes`
(`* text=auto eol=lf`) stores and what a fresh checkout produces. The clone's
working-tree copy is CRLF (the machine runs `core.autocrlf=true`), 148150 bytes,
SHA-256 `F4BD5E9E3B79DB9C599D197C83D250E1A514C0295F4856A26065B6E427C252F3` —
the figure recorded in `GGWAVE_DEEP_DIVE.md`. Same content, different line
endings; only the first hash survives a fresh checkout.

Do not edit `ggwave.js`. The git blob id and SHA-256 above are the only tamper
checks this project has for the artifact; any diff is a bug. See
`prompts/sound-chat/SOUND_CHAT_LOG.md` for why this build was chosen over the
`ggwave` package published on npm.

`package.json` here is not a package — it only marks this directory as
CommonJS so Node and the bundler treat the UMD artifact as CJS. HUSK's root
`package.json` is `"type": "module"`.
