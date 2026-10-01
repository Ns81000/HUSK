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
 * **Why the wall-clock floor is conditional rather than opt-in.** It costs real
 * time — 25 ms a call, measured — so making every caller pay it blew a 5 s
 * per-test timeout in the drain-heavy suites, and making it opt-in instead left
 * four suites still able to return early (measured: 3 flakes in 5 sequential
 * `pnpm test` runs, a different test each time). The resolution is that the floor
 * is for work that is *already outstanding* on the threadpool, and a drain that
 * watched its own signature and saw nothing move has nothing outstanding. So it
 * is the default, skipped when nothing moved. A suite whose problem is that it
 * asserts on a *specific* fact should still be using a condition-wait on that
 * fact; this is the barrier, not the assertion.
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
 * The wall-clock floor, applied by default and skipped when the drain saw no
 * activity at all (see `drainAsync`).
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
  const { activity, floorTurns = FLOOR_TURNS, quietMs = DRAIN_QUIET_MS } = options;
  const deadline = Date.now() + 20_000;
  let quiet = 0;
  let quietSince = Date.now();
  let moved = false;
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
      moved = true;
      quietSince = Date.now();
    }
    turn += 1;
  }
  // The wall-clock floor, and only when there is something it is for.
  //
  // Its whole purpose is to let a job already handed to libuv's threadpool finish
  // being delivered. A job is only outstanding if something *changed* — so a drain
  // that watched its own signature and saw nothing move had nothing outstanding,
  // and paying 25 ms to prove it turned every drain in a render-only suite into a
  // fixed cost. That is what made this opt-in, and opt-in is what left four
  // suites still able to return early. The default is now the floor, skipped when
  // nothing moved.
  if (!moved && activity !== undefined) return;
  // Bounded exactly like the first loop, and for the same reason. A suite that
  // installs vitest's *default* fake timers fakes `Date`, so `Date.now()` never
  // reaches `quietSince + quietMs` and an unbounded loop here would spin until the
  // test's own timeout fires — a hang reported as a timeout rather than as the
  // clock problem it is. Phase 4V deep-dive, finding M3.
  for (let turn = 0; turn < MAX_TURNS && Date.now() < quietSince + quietMs; turn += 1) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
}
