import base from "../stryker.config.base.mjs";

export default {
  ...base,
  mutate: [
    ...base.mutate,
    "!test-harness.ts",
    "!entrypoint.ts",
    "!run-task.ts",
    "!run-judge.ts",
    "!session.ts",
  ],
  thresholds: { high: 100, low: 0, break: 95.3 },
};
