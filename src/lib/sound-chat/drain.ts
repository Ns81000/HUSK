/**
 * The one async drain every Sound Chat harness shares.
 *
 * Every one of these suites drives a real session against a real wasm codec, so
 * every one of them has to wait for work that ends on libuv's threadpool: an AEAD
 * seal in `FrameCodec.buildMessageFrames`, an open in `FrameCodec.parse`. There
 * were fourteen local copies of this function and they had drifted into three
 * different shapes, which is how one class of flake got into all of them at once.
 *
 * **Why a turn count is not enough.** `setImmediate` turns are not time.
 * Measured on this machine: 256 of them cost about **1 ms** uncontended, which is
 * the same order as one `crypto.subtle` AEAD operation — exactly the work this
 * drain exists to wait for. Under the full suite (68 files sharing four
 * threadpool threads) a queued seal waits many milliseconds while those turns
 * still cost about one, so a turn-only drain can return with the seal still on the
 * pool. Returning early is the one failure direction that matters: the work lands
 * in the *next* drain, where it reads as fresh activity, and the assertion in
 * between is made against a half-finished exchange.
 *
 * **Why the wall-clock floor is opt-in.** It costs real time — 25 ms a call,
 * measured — and most callers drain hundreds of times per test, where it would
 * dominate the run and blow a 5 s per-test timeout for no benefit. The two long
 * single-session simulations are the ones measured to flake under load (2 of 7
 * sequential `pnpm test` runs, each on a different test), so they ask for it. A
 * suite whose problem is that it asserts on a *specific* fact should be using a
 * condition-wait on that fact rather than a longer drain.
 *
 * **Why yielding matters as much as the duration.** A pending libuv completion is
 * delivered on an event-loop turn. The fake timers these suites install do not
 * fake `setImmediate`, so waiting without yielding would be a `Date.now()` busy
 * loop that never gives the completion a chance to land.
 */

const MAX_TURNS = 16_000;
/** The turn floor every caller keeps, so a chain that is already quiet still gets a few turns. */
const FLOOR_TURNS = 256;
/** Consecutive unchanged observations before the drain may consider itself finished. */
const QUIET_STREAK = 32;
/**
 * The wall-clock floor, when a caller asks for one.
 *
 * Sized above the measured cost of the work being waited on: ~1 ms for one
 * uncontended AEAD call, so 25 ms covers a heavily contended threadpool several
 * times over. A larger figure costs only test time; a smaller one reopens the
 * flake.
 */
export const DRAIN_QUIET_MS = 25;

export type DrainOptions = {
  /**
   * A string describing everything a still-pending chain would have to touch. Two
   * consecutive equal values mean nothing happened in between.
   */
  readonly activity?: () => string;
  /** Override the turn floor. */
  readonly floorTurns?: number;
  /**
   * Also wait out this many wall-clock milliseconds of no change. Costs real time;
   * see the file header for who should ask for it.
   */
  readonly quietMs?: number;
};

export async function drainAsync(options: DrainOptions = {}): Promise<void> {
  const { activity, floorTurns = FLOOR_TURNS, quietMs = 0 } = options;
  const deadline = Date.now() + 20_000;
  let quiet = 0;
  let quietSince = Date.now();
  let turn = 0;
  // With an activity signature, "finished" means unchanged for a streak of turns.
  // Without one there is nothing to detect change with, so the streak would be a
  // fixed 32 turns of nothing and the turn floor is the whole condition.
  const streak = activity === undefined ? 0 : QUIET_STREAK;
  while (turn < floorTurns || quiet < streak) {
    if (turn >= MAX_TURNS || Date.now() > deadline) {
      throw new Error("the async chain never settled");
    }
    const before = activity === undefined ? "" : activity();
    await new Promise((resolve) => setImmediate(resolve));
    if (activity === undefined || activity() === before) {
      quiet += 1;
    } else {
      quiet = 0;
      quietSince = Date.now();
    }
    turn += 1;
  }
  while (Date.now() - quietSince < quietMs) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
