import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    name: "workers",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          HUSK_TICKET_SECRET: "integration-test-secret",
        },
      },
    }),
  ],
});
