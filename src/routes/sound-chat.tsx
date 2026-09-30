import { createFileRoute } from "@tanstack/react-router";
import { SoundChatEntry } from "@/components/sound-chat/sound-chat-entry";

/**
 * The Sound Chat route.
 *
 * `component` is a direct reference, not `lazyRouteComponent`: the eager entry
 * component does the dynamic import itself, which keeps this route out of the
 * graph every page loads. `sound-chat-entry.tsx` carries the measurement that
 * justifies that choice.
 */
export const Route = createFileRoute("/sound-chat")({
  head: () => ({
    meta: [
      { title: "Sound Chat — Husk" },
      {
        name: "description",
        content:
          "Sound Chat passes short encrypted notes between two devices in the same room as audible tones. No Wi-Fi, no relay, no server.",
      },
      { name: "theme-color", content: "#172112" },
    ],
  }),
  component: SoundChatEntry,
});
