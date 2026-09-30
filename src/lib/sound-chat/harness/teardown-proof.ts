/**
 * The browser half of the Gauntlet's double-teardown proof (Phase 4, subagent
 * 8). Loaded only by `gauntlet-teardown.spec.ts`; it is not part of the
 * degradation matrix.
 *
 * It drives the *product's* `teardownAudio` and `createAudioContext` — imported,
 * never copied — against a real Chromium AudioContext, and records what the page
 * actually observed. The interesting measurement is the *premise*: the second
 * `close()` on the same context is called once with its own handler, purely to
 * record that it rejects with `InvalidStateError`. Without that, "no unhandled
 * rejection escaped" could pass vacuously on a browser that never rejects.
 */

import { createAudioContext, teardownAudio } from "../audio-io";

type Outcome = { rejected: boolean; name: string; message: string };

type ProofResult = {
  sampleRate: number;
  secondCloseOutcome: Outcome;
  unhandledRejections: { name: string; message: string }[];
  pageErrors: string[];
  teardownCalls: number;
  stateAfter: string;
};

const unhandledRejections: { name: string; message: string }[] = [];
const pageErrors: string[] = [];

addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  unhandledRejections.push({
    name: reason instanceof Error ? reason.name : "non-error",
    message: reason instanceof Error ? reason.message : String(reason),
  });
  // Swallow it: the assertion is that this list is empty, and leaving the event
  // default would make Chromium log it as well.
  event.preventDefault();
});
addEventListener("error", (event) => {
  pageErrors.push(String(event.message));
});

/** One turn of the event loop, so a pending rejection is reported if it is going to be. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

window.__teardownProof = async (): Promise<ProofResult> => {
  const context = createAudioContext();
  const sampleRate = context.sampleRate;

  // The premise, measured on this browser right now: a second close() on a
  // closed context rejects. This call carries its own handler, so observing the
  // rejection cannot itself be an unhandled rejection.
  await context.close();
  let secondCloseOutcome: Outcome = { rejected: false, name: "", message: "" };
  try {
    await context.close();
    secondCloseOutcome = { rejected: false, name: "resolved", message: "" };
  } catch (error) {
    secondCloseOutcome = {
      rejected: true,
      name: error instanceof Error ? error.name : "non-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // The claim: two teardowns of the same real context, through the product's
  // own idempotent teardown, leak nothing.
  const fresh = createAudioContext();
  await fresh.resume();
  let teardownCalls = 0;
  teardownAudio(undefined, fresh);
  teardownCalls += 1;
  teardownAudio(undefined, fresh);
  teardownCalls += 1;

  await settle();
  await settle();

  return {
    sampleRate,
    secondCloseOutcome,
    unhandledRejections,
    pageErrors,
    teardownCalls,
    stateAfter: fresh.state,
  };
};
