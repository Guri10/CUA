import { defineConfig } from "vitest/config";

/**
 * The end-to-end run: a real browser against a real ParaBank. Separate from the
 * default config so that `npm test` cannot pick these up by accident — the fast
 * suite staying fast is what keeps it worth running.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    // A browser launch plus a login against a Java application in a container.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
