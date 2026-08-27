import { defineConfig, devices } from "@playwright/test";

// Serves the production nitro output (`.output/`, built by `pnpm build:a11y`)
// under wrangler/workerd, exactly like the Phase 4 manual serving setup.
// The port must match VITE_WORKER_URL in .env.a11y so the app's relay calls
// are same-origin (CSP-allowed) and interceptable in the specs.
const PORT = 8787;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: `pnpm --dir worker exec wrangler dev --config ../.output/server/wrangler.json --compatibility-date 2026-08-01 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
