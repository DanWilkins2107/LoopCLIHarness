export type ErrorClass = "usage_limited" | "api_error" | "unknown";

export interface EnvelopeClass {
  outcome: ErrorClass;
  reset_at?: number;
}

const USAGE_LIMIT_RE = /Claude AI usage limit reached\|(\d+)/;
const API_ERROR_RE =
  /overloaded_error|(?:\b|_)529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection error|network error/i;

function lastResult(stdout: string): string {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const env = JSON.parse(line);
      if (env && typeof env.result === "string") return env.result;
    } catch {}
  }
  // Stryker disable next-line StringLiteral: any sentinel classifies as unknown
  return "";
}

export function classifyError(stdout: string): EnvelopeClass {
  const result = lastResult(stdout);
  const limit = USAGE_LIMIT_RE.exec(result);
  if (limit) return { outcome: "usage_limited", reset_at: Number(limit[1]) };
  if (API_ERROR_RE.test(result)) return { outcome: "api_error" };
  return { outcome: "unknown" };
}
