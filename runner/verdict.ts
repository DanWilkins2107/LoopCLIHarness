export type Verdict = "proceed" | "not_yet";

// Last well-formed flat JSON object mentioning "verdict"; null if none valid.
export function extractVerdict(
  text: string,
): { verdict: Verdict; reason: string } | null {
  const matches = text.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  if (!matches) return null;
  for (const candidate of matches.reverse()) {
    try {
      const obj = JSON.parse(candidate);
      if (obj.verdict === "proceed" || obj.verdict === "not_yet") {
        const reason =
          typeof obj.reason === "string" && obj.reason.trim()
            ? obj.reason.trim()
            : "(no reason given)";
        return { verdict: obj.verdict, reason };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
