/**
 * The Sound Chat route's eager entry point, and the only module of this feature
 * in the bundle every page loads.
 *
 * WHY a hand-rolled dynamic import here instead of TanStack Router's
 * `lazyRouteComponent`: measured, not assumed. `lazyRouteComponent` loads fine,
 * but its presence makes the bundler hoist the existing `/r/$roomId` route chunk
 * (104 kB raw) into the entry's *static* import set, so every visit to Husk —
 * including the landing page, which never touches Sound Chat — started paying
 * for it. Three builds were measured:
 *
 * - baseline (no Sound Chat route): entry 307.00 kB / 95.75 kB gzip, and the
 *   104 kB room chunk was not statically referenced;
 * - a stub third route using `lazyRouteComponent`: entry 371.94 kB /
 *   116.61 kB gzip, with the 104 kB room chunk now statically referenced —
 *   identical to the real screen, so the trigger is `lazyRouteComponent`
 *   itself and nothing in Sound Chat's code;
 * - this shape, a direct `component:` reference whose body uses a plain
 *   `import()`: entry 307.35 kB / 95.84 kB gzip, same chunk set as the baseline.
 *
 * The difference between the two is 0.09 kB of gzip against 20.86 kB, and the
 * bundler configuration that would fix it properly (`build.rollupOptions`) lives
 * in `vite.config.ts`, which this feature does not own.
 *
 * So the heavy graph — components, copy, the session driver, the protocol, the
 * crypto and the codec loader — is behind this one `import()`, fetched when the
 * user actually opens Sound Chat, which is what the master plan's bundle
 * strategy asks for.
 */

import { useEffect, useState, type ComponentType, type ReactElement } from "react";
import { SOUND_CHAT_ENTRY_COPY } from "@/lib/sound-chat/ui/entry-copy";

export function SoundChatEntry(): ReactElement {
  const [Screen, setScreen] = useState<ComponentType | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // `live` guards the one race this effect has: the user navigating away
    // before the chunk lands. Without it the import would resolve onto an
    // unmounted component, which React 19 tolerates but which would leave a
    // stray state update behind.
    let live = true;
    void import("@/components/sound-chat/sound-chat-screen")
      .then((module) => {
        if (live) setScreen(() => module.SoundChatScreen);
      })
      .catch(() => {
        // A chunk that will not load is a network or cache failure. Retrying is
        // the user's own reload, so this says so rather than offering a button
        // that cannot help.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-6" role="alert">
        <p className="text-center text-body text-danger">{SOUND_CHAT_ENTRY_COPY.failed}</p>
      </div>
    );
  }
  if (Screen === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-6" role="status">
        <p className="text-body text-ink-muted">{SOUND_CHAT_ENTRY_COPY.loading}</p>
      </div>
    );
  }
  return <Screen />;
}
