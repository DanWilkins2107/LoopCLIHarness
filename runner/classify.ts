export type ErrorClass = "usage_limited" | "api_error";

export interface EnvelopeClass {
  outcome: ErrorClass;
  reset_at?: number;
}

const USAGE_LIMIT_RE = /Claude AI usage limit reached\|(\d+)/;
const API_ERROR_RE = /overloaded_error|(?:\b|_)529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection error|network error/i;

function lastResult(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const env = JSON.parse(line);
      if (env && typeof env === "object" && typeof env.result === "string") return env.result;
    } catch {}
  }
  return null;
}

export function classifyEnvelope(stdout: string): EnvelopeClass | null {
  const result = lastResult(stdout);
  if (result == null) return null;
  const limit = USAGE_LIMIT_RE.exec(result);
  if (limit) return { outcome: "usage_limited", reset_at: Number(limit[1]) };
  if (API_ERROR_RE.test(result)) return { outcome: "api_error" };
  return null;
}
