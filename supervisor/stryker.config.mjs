import base from "../stryker.config.base.mjs";

export default {
  ...base,
  mutate: [...base.mutate, "!loop.ts"],
  thresholds: { high: 100, low: 0, break: 100 },
};
