import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      // decide.ts is the whole unit-testable surface: every other module is a
      // thin wrapper over EC2, Secrets Manager or Supabase, and covering it
      // would only assert the mocks.
      include: ["decide.ts"],
      exclude: [...coverageConfigDefaults.exclude],
      thresholds: { 100: true },
    },
  },
});
