import base from "../stryker.config.base.mjs";

export default {
  ...base,
  mutate: [...base.mutate, "!test-harness.ts", "!run-task.ts", "!run-judge.ts"],
  thresholds: { high: 100, low: 0, break: 100 },
};
