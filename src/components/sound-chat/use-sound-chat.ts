/**
 * The one place React meets the Sound Chat controller.
 *
 * It is deliberately thin: `SoundChatUiController` owns every decision, and this
 * hook only subscribes to it and holds the one piece of state that is pure view
 * state — the composer's draft.
 *
 * `useSyncExternalStore` rather than a `useState`/`useEffect` pair because the
 * controller publishes from audio callbacks, timers and a 100 ms progress ticker,
 * not from React events. A missed notification here would be a UI that silently
 * stops tracking the radio.
 *
 * WHY the controller is created inside the effect and not in `useMemo`. React 19's
 * StrictMode invokes an effect, tears it down, and invokes it again — and
 * `dispose()` is terminal, so a memoised controller whose cleanup ran would leave
 * the screen permanently inert: `begin()` a no-op, `send()` refusing with
 * "stopped", nothing ever rendered again. StrictMode is not enabled in this
 * repo today (measured), so that is latent rather than broken, but the cost of
 * being correct here is one state field and a nullable handle, against a cost
 * there of a permanently dead screen.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PairingRole } from "@/lib/sound-chat/pairing";
import type { SendRefusal } from "@/lib/sound-chat/session";
import { SoundChatUiController, type SoundChatUiState } from "@/lib/sound-chat/ui/controller";
import { measureMessage } from "@/lib/sound-chat/ui/budget";
import { SOUND_CHAT_COPY } from "@/lib/sound-chat/ui/copy";

/** What the screen shows before the effect has created a controller, and after
 *  it has disposed one: nothing is running, and the pre-prompt is the truth. */
const IDLE_STATE: SoundChatUiState = new SoundChatUiController().getState();

function noSubscribe(): () => void {
  return () => {};
}

export type SoundChatUi = {
  readonly state: SoundChatUiState;
  /** The composer buffer. Owned here because it is pure view state. */
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  readonly begin: (role: PairingRole, code?: string) => void;
  readonly restart: () => void;
  readonly cancel: () => void;
  readonly submit: () => void;
  /**
   * Why the composer cannot be used right now, or `null` when it can. A refusal
   * from the last send is folded in, so every one of the six reasons the session
   * can return has somewhere to be seen rather than being silently dropped.
   */
  readonly composerBlock: string | null;
  /**
   * The reason the last send was refused. It clears itself on the next keystroke
   * instead of on a dismissal control: a refusal is a fact about one attempt, and
   * a person who starts typing has moved on from it. A button whose only job was
   * to hide a sentence would be a fourth thing to keep in sync for no gain.
   */
  readonly refusal: string | null;
  readonly infoOpen: boolean;
  readonly toggleInfo: () => void;
  readonly dismissNotices: () => void;
};

export function useSoundChat(): SoundChatUi {
  const [controller, setController] = useState<SoundChatUiController | null>(null);

  useEffect(() => {
    const next = new SoundChatUiController();
    setController(next);
    return () => {
      // Disposes this exact instance, and only ever fires once per instance, so
      // a StrictMode remount builds a fresh one rather than reviving a dead one.
      next.dispose();
    };
  }, []);

  const subscribe = controller?.subscribe ?? noSubscribe;
  const read = controller?.getState ?? ((): SoundChatUiState => IDLE_STATE);
  const state = useSyncExternalStore(subscribe, read, read);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const begin = useCallback(
    (role: PairingRole, code?: string) => {
      setRefusal(null);
      void controller?.begin(role, code);
    },
    [controller],
  );

  const restart = useCallback(() => {
    setRefusal(null);
    void controller?.restart();
  }, [controller]);

  const cancel = useCallback(() => {
    setDraft("");
    setRefusal(null);
    controller?.cancel();
  }, [controller]);

  const toggleInfo = useCallback(() => setInfoOpen((open) => !open), []);
  const dismissNotices = useCallback(() => controller?.clearNotices(), [controller]);

  const submit = useCallback(() => {
    const budget = measureMessage(draft);
    // An over-cap note never reaches the session and never needs a reason read
    // out loud: the composer already says how far over it is, on the field.
    if (!budget.fits) return;
    const result = controller?.send(draft);
    if (result === undefined || !result.ok) {
      setRefusal(sendRefusalText(result?.reason));
      return;
    }
    // Only clear the buffer on acceptance: a refusal leaves the words in place so
    // the person can still see what they wrote and act on the reason.
    setRefusal(null);
    setDraft("");
  }, [controller, draft]);

  const composerBlock = deriveComposerBlock(state);
  return {
    state,
    draft,
    setDraft,
    begin,
    restart,
    cancel,
    submit,
    composerBlock,
    refusal,
    infoOpen,
    toggleInfo,
    dismissNotices,
  };
}

/**
 * The sentence for one of the session's six refusals.
 *
 * Every one of them is reachable and each has its own copy, so a refusal that is
 * dropped is a failure the user cannot act on — which is exactly what master plan
 * constraint 6 forbids. `queue-full` in particular is otherwise invisible: the
 * note simply does not appear.
 */
function sendRefusalText(reason: SendRefusal | undefined): string | null {
  if (reason === undefined) return SOUND_CHAT_COPY.refusal.stopped;
  return SOUND_CHAT_COPY.refusal[reason];
}

/**
 * Why the composer cannot be used at all right now, or `null` when it can.
 *
 * The order is deliberate: an unpaired session is the most common reason and the
 * least alarming, a hidden tab is a temporary hold rather than a fault, and a
 * stopped session outranks both. Nothing here guesses: every value is a fact the
 * controller read off the session's own state. A refusal from the last send is
 * *not* folded in — that one is reported on its own line and clears, because the
 * next attempt may well succeed and a field disabled by one refused note would
 * look broken.
 */
export function deriveComposerBlock(state: SoundChatUiState): string | null {
  if (state.phase !== "chat") return SOUND_CHAT_COPY.composer.blockedByPairing;
  if (state.transport === "hidden_hold") return SOUND_CHAT_COPY.transport.hidden_hold;
  if (state.transport === "error") return SOUND_CHAT_COPY.transport.error;
  if (state.transport === "module_error") return SOUND_CHAT_COPY.transport.module_error;
  return null;
}
