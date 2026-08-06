export type Verdict = "proceed" | "not_yet";

interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

function reasonText(raw: unknown): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || "(no reason given)";
}

function parseCandidate(json: string): VerdictResult | null {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  const verdict = obj?.verdict;
  if (verdict !== "proceed" && verdict !== "not_yet") return null;
  return { verdict, reason: reasonText(obj.reason) };
}

// Last well-formed flat JSON object mentioning "verdict"; null if none valid.
export function extractVerdict(text: string): VerdictResult | null {
  const matches = text.match(/\{[^{}]*"verdict"[^{}]*\}/g) ?? [];
  for (const json of [...matches].reverse()) {
    const parsed = parseCandidate(json);
    if (parsed) return parsed;
  }
  return null;
}
