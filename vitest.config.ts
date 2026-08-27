import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  test: {
    // Unit tests run in Node; the Worker integration tests run in workerd via
    // their own project config in worker/vitest.config.ts.
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "worker/src/**/*.test.ts"],
        },
      },
      "worker/vitest.config.ts",
    ],
  },
});
