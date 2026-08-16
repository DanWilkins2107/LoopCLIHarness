export default {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  // Tests import ../test-helpers, which a sandboxed package root would not contain.
  inPlace: true,
  reporters: ["progress", "clear-text"],
  mutate: ["*.ts", "!*.test.ts", "!vitest.config.ts"],
};
