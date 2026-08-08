import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      // decide.ts and recommended.ts hold every rule worth testing. The rest is
      // thin wrapping over EC2, Secrets Manager and Supabase, where a test would
      // only assert the mocks.
      include: ["decide.ts", "recommended.ts"],
      exclude: [...coverageConfigDefaults.exclude],
      thresholds: { 100: true },
    },
  },
});
