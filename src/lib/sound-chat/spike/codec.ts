/**
 * Phase 1 promotion marker: the real codec module is `../codec.ts`.
 *
 * This file used to hold the Phase 0 spike scaffold; it is now a re-export so
 * the Phase 0 harness (`harness/page.ts`, `harness/fake-mic.spec.ts`) and the
 * spike suites keep exercising the *real* module through their Phase 0 import
 * paths, instead of a drifting copy of it.
 */
export * from "../codec";
