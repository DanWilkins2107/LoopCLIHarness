export type ErrorClass = "usage_limited" | "api_error" | "unknown";

export interface EnvelopeClass {
  outcome: ErrorClass;
  reset_at?: number;
}

const USAGE_LIMIT_RE = /Claude AI usage limit reached\|(\d+)/;
const API_ERROR_RE =
  /overloaded_error|(?:\b|_)529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection error|network error/i;

export function classifyError(stdout: string): EnvelopeClass {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    let env: { result?: unknown } | undefined;
    try {
      env = JSON.parse(line);
    } catch {}
    if (!env || typeof env.result !== "string") continue;
    const limit = USAGE_LIMIT_RE.exec(env.result);
    if (limit) return { outcome: "usage_limited", reset_at: Number(limit[1]) };
    if (API_ERROR_RE.test(env.result)) return { outcome: "api_error" };
    break;
  }
  return { outcome: "unknown" };
}
