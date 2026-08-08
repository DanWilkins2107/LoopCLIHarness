import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["**/*.ts"],
      exclude: [...coverageConfigDefaults.exclude],
      thresholds: { 100: true },
    },
  },
});
