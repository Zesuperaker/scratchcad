import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "web/src/**/*.test.ts"],
    // Integration tests start processes and a real scratchcad binary.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      include: ["src/**", "web/src/lib/**", "web/src/api/**", "web/src/editor/rhai.ts"],
      // main.ts only parses the environment and calls start(); it is run as a
      // process by the integration tests, which coverage can't see into.
      exclude: ["src/main.ts"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
