import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // `npm test` stays fast and browser-free. The end-to-end test that drives a
    // real browser against ParaBank arrives with the Surface implementation;
    // the exclusion is here first so it cannot land in the default run by
    // accident, and `test:e2e` is added alongside it.
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
  },
});
