import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type CSSProperties } from "react";
import { Button, Panel } from "@/components/husk/primitives";
import { MoltenMetal } from "@/components/husk/MoltenMetal";
import { HuskMark, ShieldIcon } from "@/components/husk/icons";
import { createRoom, WorkerNotConfiguredError } from "@/lib/husk/api";
import { generateRoomKeyFragment } from "@/lib/husk/crypto";
import { WORKER_URL } from "@/lib/husk/config";

export const Route = createFileRoute("/")(
  {
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
  },
);

function enter(delayMs: number): CSSProperties {
  return { "--enter-delay": `${delayMs}ms` } as CSSProperties;
}

function Landing() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const configured = WORKER_URL.length > 0;

  async function onCreate() {
    setBusy(true);
    setFailure(null);
    try {
      const created = await createRoom();
      const fragment = generateRoomKeyFragment();
      await navigate({ to: "/r/$roomId", params: { roomId: created }, hash: fragment });
    } catch (error) {
      setFailure(
        error instanceof WorkerNotConfiguredError
          ? "This build has no relay configured. Set VITE_WORKER_URL to your deployed Worker."
          : "The room could not be created. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen flex-col">
      <div className="fixed inset-0 z-0">
        <MoltenMetal
          color1="#0a3f26"
          color2="#1c8a58"
          color3="#3ce767"
          speed={0.3}
          scale={4}
          detail={3}
          glow={1.6}
          coreSize={0.1}
          swirl={1}
          fold={-0.2}
          blackPoint={0.05}
          brightness={1.2}
          colorMode="molten"
          grain={true}
          grainIntensity={0.04}
          mouseInteraction={true}
          mouseStrength={0.25}
          opacity={1.0}
        />
      </div>

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="enter" style={enter(0)}>
          <HuskMark size={64} className="mx-auto sm:hidden" />
          <HuskMark size={48} className="mx-auto hidden sm:block" />
        </div>
        <h1 className="enter text-display mt-8 text-ink" style={enter(50)}>
          HUSK
        </h1>
        <p className="enter text-body mt-2 text-ink-muted" style={enter(100)}>
          Ephemeral encrypted rooms
        </p>

        <div className="enter mt-10 w-full max-w-[320px]" style={enter(150)}>
          <Button
            full
            loading={busy}
            disabled={!configured}
            onClick={() => void onCreate()}
            className="h-12"
          >
            {busy ? "Creating room" : "Create a Room"}
          </Button>
          {failure !== null ? (
            <p className="fade-in mt-4 text-[14px] text-danger" role="alert">
              {failure}
            </p>
          ) : null}
        </div>
        <section
          className="enter mt-16 flex items-start gap-3 text-caption text-ink-muted"
          style={enter(220)}
        >
          <ShieldIcon className="mt-0.5 shrink-0 text-ok" />
          <p className="max-w-sm text-left">
            Messages and files are encrypted with AES-256-GCM in your browser. The relay holds
            ciphertext and nothing else — when the room empties, it is gone.
          </p>
        </section>

        {!configured ? (
          <Panel className="fade-in mt-8 max-w-md border-warn text-left">
            <h2 className="text-title text-ink">Relay not configured</h2>
            <p className="mt-2 text-[14px] text-ink-muted">
              Husk needs its Cloudflare Worker deployed before rooms can be created. Follow the
              deployment steps in the project README, then set VITE_WORKER_URL. Nothing here is
              simulated: without the relay there is no room to join.
            </p>
          </Panel>
        ) : null}
      </div>
    </main>
  );
}
