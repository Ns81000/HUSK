import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Panel, Switch, useToast } from "@/components/husk/primitives";
import { Keypad, PinDisplay } from "@/components/husk/keypad";
import { ShieldIcon } from "@/components/husk/icons";
import { createRoom, joinRoom, WorkerNotConfiguredError } from "@/lib/husk/api";
import { generateRoomKeyFragment } from "@/lib/husk/crypto";
import { PIN_LENGTH, WORKER_URL } from "@/lib/husk/config";
import { isValidPin } from "@/lib/husk/pin";
import { useTheme } from "@/lib/husk/theme";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Husk — ephemeral encrypted rooms" },
      {
        name: "description",
        content:
          "Husk creates temporary end-to-end encrypted rooms for chat and files. Nothing is stored: when everyone leaves, the room is gone.",
      },
      { property: "og:title", content: "Husk — ephemeral encrypted rooms" },
      {
        property: "og:description",
        content:
          "Temporary end-to-end encrypted chat and file sharing. The relay never holds your key.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

type Mode = "choose" | "join";

function Landing() {
  const navigate = useNavigate();
  const notify = useToast();
  const { theme, setTheme } = useTheme();
  const [mode, setMode] = useState<Mode>("choose");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const configured = WORKER_URL.length > 0;

  async function onCreate() {
    setBusy("create");
    setFailure(null);
    try {
      const created = await createRoom();
      const fragment = generateRoomKeyFragment();
      await navigate({ to: "/r/$pin", params: { pin: created }, hash: fragment });
    } catch (error) {
      setFailure(
        error instanceof WorkerNotConfiguredError
          ? "This build has no relay configured. Set VITE_WORKER_URL to your deployed Worker."
          : "The room could not be created. Check your connection and try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function onJoin() {
    if (!isValidPin(pin)) {
      setFailure("Enter the full six digit PIN.");
      return;
    }
    setBusy("join");
    setFailure(null);
    try {
      const result = await joinRoom(pin);
      if (result === "rate_limited") {
        setFailure("Too many attempts. Wait a few minutes before trying again.");
        return;
      }
      if (result === "unavailable") {
        setFailure("That room is not available.");
        return;
      }
      notify("Room found. Paste the invite link if you do not have the key yet.");
      await navigate({ to: "/r/$pin", params: { pin }, hash: window.location.hash.slice(1) });
    } catch (error) {
      setFailure(
        error instanceof WorkerNotConfiguredError
          ? "This build has no relay configured. Set VITE_WORKER_URL to your deployed Worker."
          : "Could not reach the relay.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-display text-ink">Husk</h1>
          <p className="mt-2 max-w-md text-[15px] text-ink-muted">
            A room that exists only while you are in it. Messages and files are encrypted in your
            browser; the relay sees ciphertext and nothing else.
          </p>
        </div>
        <Switch
          checked={theme === "dark"}
          onChange={(next) => setTheme(next ? "dark" : "light")}
          label="Dark"
        />
      </header>

      {!configured ? (
        <Panel className="border-warn">
          <h2 className="text-title text-ink">Relay not configured</h2>
          <p className="mt-2 text-[14px] text-ink-muted">
            Husk needs its Cloudflare Worker deployed before rooms can be created. Follow the
            deployment steps in the project README, then set VITE_WORKER_URL. Nothing here is
            simulated: without the relay there is no room to join.
          </p>
        </Panel>
      ) : null}

      {mode === "choose" ? (
        <Panel className="space-y-4">
          <Button full disabled={busy !== null || !configured} onClick={() => void onCreate()}>
            {busy === "create" ? "Creating room" : "Create a room"}
          </Button>
          <Button
            tone="quiet"
            full
            disabled={busy !== null || !configured}
            onClick={() => setMode("join")}
          >
            Join with a PIN
          </Button>
          {failure !== null ? <p className="text-[14px] text-danger">{failure}</p> : null}
        </Panel>
      ) : (
        <Panel className="space-y-6">
          <div className="space-y-4">
            <h2 className="text-title text-ink">Enter the room PIN</h2>
            <PinDisplay value={pin} />
            <Keypad
              onDigit={(digit) => setPin((current) => (current + digit).slice(0, PIN_LENGTH))}
              onBackspace={() => setPin((current) => current.slice(0, -1))}
            />
          </div>
          {failure !== null ? <p className="text-[14px] text-danger">{failure}</p> : null}
          <div className="flex gap-2">
            <Button tone="quiet" full onClick={() => setMode("choose")}>
              Back
            </Button>
            <Button full disabled={busy !== null} onClick={() => void onJoin()}>
              {busy === "join" ? "Joining" : "Join"}
            </Button>
          </div>
          <p className="text-caption text-ink-muted">
            A PIN alone cannot decrypt a room. You also need the invite link, which carries the
            key in its fragment.
          </p>
        </Panel>
      )}

      <section className="flex items-start gap-3 text-caption text-ink-muted">
        <ShieldIcon className="mt-0.5 shrink-0 text-ok" />
        <p>
          Husk is a relayed architecture, not peer to peer. Its privacy comes from client-side
          AES-256-GCM encryption and from holding room state only in memory at the edge.
        </p>
      </section>
    </main>
  );
}
