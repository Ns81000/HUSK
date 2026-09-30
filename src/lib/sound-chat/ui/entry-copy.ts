/**
 * The two sentences the lazy boundary itself needs.
 *
 * WHY this is its own module rather than two strings in the entry component:
 * every user-visible sentence in this feature lives under
 * `src/lib/sound-chat/ui/` so one test can assert the no-emoji and
 * no-false-inaudibility rules across all of them at once. But
 * `sound-chat-entry.tsx` is the one module that must be in the *eager* bundle —
 * it is what the route renders before the screen chunk has arrived — so it
 * cannot import `copy.ts`, which pulls the protocol and the session in with it.
 * This file has no imports at all, which is what keeps the landing page's
 * download unchanged (measured: entry 307.35 kB / 95.84 kB gzip against a
 * 307.00 kB / 95.75 kB baseline).
 */

export const SOUND_CHAT_ENTRY_COPY = {
  loading: "Loading Sound Chat.",
  failed: "Sound Chat could not be loaded. Check your connection and reload the page.",
} as const;
