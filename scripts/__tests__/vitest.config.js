import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.test.js"],
    // Script tests shell out and some share fixture directories on disk, so
    // run files sequentially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 60000,
    env: {
      // Keep script output free of ANSI codes so assertions can match literals.
      NO_COLOR: "1",
    },
  },
});
