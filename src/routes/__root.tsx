import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { ErrorMark } from "../components/husk/icons";
import { ToastProvider } from "../components/husk/primitives";

/**
 * Applies the persisted (or default) theme before first paint. Dark is the
 * product default: only an explicit stored "light" avoids it. Kept in sync
 * with STORAGE_KEY in src/lib/husk/theme.ts. The inline script is constant,
 * so the per-response CSP hash mechanism in src/server.ts covers it.
 */
const themeBootstrap = `(function(){try{var t=localStorage.getItem("husk-theme");if(t!=="light"){document.documentElement.classList.add("dark")}}catch(e){document.documentElement.classList.add("dark")}})();`;

function NotFoundComponent() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-panel">
        <ErrorMark className="mx-auto text-line-strong" />
        <h1 className="mt-4 text-title text-ink">Page not found</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link
          to="/"
          className="touch-target mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-[15px] font-medium text-accent-ink transition-colors hover:bg-accent-hover"
        >
          Go home
        </Link>
      </section>
    </main>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    // Editor telemetry is dev-only: the dynamic import inside a DEV guard
    // keeps the reporting module (and its third-party hooks) out of
    // production bundles entirely.
    if (import.meta.env.DEV) {
      void import("../lib/lovable-error-reporting").then((m) =>
        m.reportLovableError(error, { boundary: "tanstack_root_error_component" }),
      );
    }
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <section className="max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-panel">
        <ErrorMark className="mx-auto text-line-strong" />
        <h1 className="mt-4 text-title text-ink">This page didn't load</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="touch-target inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 text-[15px] font-medium text-accent-ink transition-colors hover:bg-accent-hover"
          >
            Try again
          </button>
          <a
            href="/"
            className="touch-target inline-flex items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 text-[15px] font-medium text-ink transition-colors hover:bg-surface-sunken"
          >
            Go home
          </a>
        </div>
      </section>
    </main>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Husk" },
      {
        name: "description",
        content: "Ephemeral, end-to-end encrypted rooms for chat and file sharing.",
      },
      { property: "og:title", content: "Husk" },
      {
        property: "og:description",
        content: "Ephemeral, end-to-end encrypted rooms for chat and file sharing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#172112" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      {
        rel: "icon",
        href: "/icons/husk-mark.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
      {
        rel: "icon",
        href: "/icons/husk-mark-light.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: light)",
      },
      {
        rel: "apple-touch-icon",
        href: "/icons/husk-icon-192.png",
        sizes: "192x192",
      },
    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    // Dev serves unbundled sources; a controlling service worker there would
    // shadow HMR. Registration is a production-only, progressive enhancement.
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Offline support is progressive; registration failure is not fatal.
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <Outlet />
      </ToastProvider>
    </QueryClientProvider>
  );
}
