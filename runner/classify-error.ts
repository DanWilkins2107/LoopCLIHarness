export type ErrorClass = "usage_limited" | "api_error" | "unknown";

export interface EnvelopeClass {
  outcome: ErrorClass;
  reset_at?: number;
}

const USAGE_LIMIT_RE = /Claude AI usage limit reached\|(\d+)/;
const API_ERROR_RE =
  /overloaded_error|(?:\b|_)529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection error|network error/i;

function resultField(line: string): string | null {
  let env;
  try {
    env = JSON.parse(line);
  } catch {
    return null;
  }
  if (env === null) return null;
  return typeof env.result === "string" ? env.result : null;
}

function classifyResult(result: string): EnvelopeClass {
  const limit = USAGE_LIMIT_RE.exec(result);
  if (limit) return { outcome: "usage_limited", reset_at: Number(limit[1]) };
  if (API_ERROR_RE.test(result)) return { outcome: "api_error" };
  return { outcome: "unknown" };
}

export function classifyError(stdout: string): EnvelopeClass {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const result = resultField(line);
    if (result !== null) return classifyResult(result);
  }
  return { outcome: "unknown" };
}
