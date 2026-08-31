import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests run in Node; the Worker integration tests run in workerd via
    // their own project config in worker/vitest.config.ts. The deprecated
    // vite-tsconfig-paths plugin is replaced by Vite's native resolution.
    projects: [
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "worker/src/**/*.test.ts"],
        },
      },
      "worker/vitest.config.ts",
    ],
  },
});
