/**
 * The one place React meets the Sound Chat controller.
 *
 * It is deliberately thin: `SoundChatUiController` owns every decision, and this
 * hook only subscribes to it. `useSyncExternalStore` rather than a
 * `useState`/`useEffect` pair because the controller publishes from audio
 * callbacks and timers, not from React events — a missed notification here would
 * be a UI that silently stops tracking the radio.
 *
 * The controller is created once per mount and disposed on unmount. Strict mode's
 * double-mount in development therefore builds a session, tears it down and
 * builds another, which is exactly the lifecycle the teardown path is tested for
 * (`dispose()` is idempotent, and React only ever sees the second one).
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PairingRole } from "@/lib/sound-chat/pairing";
import type { SendResult } from "@/lib/sound-chat/session";
import { SoundChatUiController, type SoundChatUiState } from "@/lib/sound-chat/ui/controller";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

export type SoundChatUi = {
  readonly state: SoundChatUiState;
  /** The composer buffer. Owned here because it is pure view state. */
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly begin: (role: PairingRole, code?: string) => void;
  readonly restart: () => void;
  readonly cancel: () => void;
  readonly submit: () => void;
  /** Why the composer cannot be used right now, or `null` when it can. */
  readonly composerBlock: string | null;
  /** True when the last accepted send was queued behind another. */
  readonly queued: boolean;
  readonly infoOpen: boolean;
  readonly toggleInfo: () => void;
};

export function useSoundChat(): SoundChatUi {
  const controller = useMemo(() => new SoundChatUiController(), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const [draft, setDraft] = useState("");
  const [queued, setQueued] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const begin = useCallback(
    (role: PairingRole, code?: string) => {
      setQueued(false);
      void controller.begin(role, code);
    },
    [controller],
  );

  const restart = useCallback(() => {
    void controller.restart();
  }, [controller]);

  const cancel = useCallback(() => {
    setDraft("");
    setQueued(false);
    controller.cancel();
  }, [controller]);

  const submit = useCallback(() => {
    if (!measureMessage(draft).fits) return;
    const result: SendResult = controller.send(draft);
    if (!result.ok) return;
    // Only clear the buffer on acceptance: a refusal leaves the words in place so
    // the person can still see what they wrote and act on the reason.
    setQueued(result.queued);
    setDraft("");
  }, [controller, draft]);

  return {
    state,
    draft,
    setDraft,
    begin,
    restart,
    cancel,
    submit,
    composerBlock: deriveComposerBlock(state),
    queued,
    infoOpen,
    toggleInfo: useCallback(() => setInfoOpen((open) => !open), []),
  };
}

/**
 * One sentence for why the composer is unusable, and `null` when it is usable.
 *
 * The order is deliberate: an unpaired session is the most common reason and the
 * least alarming, a hidden tab is a temporary hold rather than a fault, and a
 * stopped session outranks both. Nothing here guesses: every value is a fact the
 * controller read off the session's own state.
 */
export function deriveComposerBlock(state: SoundChatUiState): string | null {
  if (state.phase !== "chat") return SOUND_CHAT_COPY.composer.blockedByPairing;
  if (state.transport === "hidden_hold") return SOUND_CHAT_COPY.transport.hidden_hold;
  if (state.transport === "error") return SOUND_CHAT_COPY.transport.error;
  if (state.transport === "module_error") return SOUND_CHAT_COPY.transport.module_error;
  return null;
}
