import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["**/*.ts"],
      // Everything excluded here is a thin wrapper over EC2, Secrets Manager or
      // Supabase, where a test would only assert the mocks. A new file is
      // covered by default and has to earn its way onto this list.
      exclude: [
        ...coverageConfigDefaults.exclude,
        "handler.ts",
        "board.ts",
        "env.ts",
        "helpers/**",
      ],
      thresholds: { 100: true },
    },
  },
});
