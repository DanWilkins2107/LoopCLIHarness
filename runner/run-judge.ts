import { spawnTool, wireSessionOutput, sessionReportedError } from "./session.js";

// Per-node soft-block judge: reads one node and prints one verdict JSON.
// Never `proceed` on doubt — every non-`proceed` path resolves to `not_yet`.

type Verdict = "proceed" | "not_yet";

const EXIT_CODES: Record<Verdict, number> = {
  proceed: 0,
  not_yet: 10,
};
const USAGE_EXIT = 2;

function emitAndExit(nodeId: string | null, verdict: Verdict, reason: string): never {
  process.stdout.write(
    JSON.stringify({ node_id: nodeId, verdict, reason }) + "\n"
  );
  process.exit(EXIT_CODES[verdict]);
}

function log(...args: string[]): void {
  process.stderr.write("[run-judge] " + args.join(" ") + "\n");
}

function buildPrompt(nodeId: string): string {
  return [
    `You are a headless, READ-ONLY AgentJira soft-block judge session. You judge`,
    `exactly one node: ${nodeId}. The board has already moved it into`,
    `\`evaluating_soft_block\`.`,
    ``,
    `Load the agentjira-workflow skill first and follow its block-judgment rules.`,
    `Then run \`aj context ${nodeId}\` and read everything: the node, its spec, its`,
    `soft-block edges, its settled \`reassess_after\` set, and enough surrounding`,
    `graph (blockers, ancestors) to understand the shared decisions this node`,
    `depends on. Read any downloaded canvas PNG paths with the Read tool.`,
    ``,
    `Decide ONE thing: are the blocker's shared decisions settled enough that`,
    `picking this node up now is NOT a guess?`,
    `  - proceed  — the decisions are settled; pickup would not have to guess at`,
    `               anything the blocker still owns.`,
    `  - not_yet  — pickup would require guessing at unsettled shared decisions,`,
    `               or you are unsure.`,
    `When in doubt, choose not_yet. Never proceed on doubt.`,
    ``,
    `You are strictly READ-ONLY. Do NOT claim, edit, post, comment, or change`,
    `anything on the board or in any repo. Use only read commands`,
    `(\`aj context\`, \`aj search\`, \`aj tasks\`, \`aj whoami\`) and read-only tools.`,
    ``,
    `Emit your verdict as the LAST line of your final message: exactly one JSON`,
    `object, nothing after it, of the form:`,
    `  {"node_id": "${nodeId}", "verdict": "proceed" | "not_yet", "reason": "<one line>"}`,
    `The reason must be a single short line. Do not wrap it in code fences.`,
  ].join("\n");
}

const CLAUDE_ARGS = [
  "--print",
  "--permission-mode", "auto",
  "--no-session-persistence",
  "--output-format", "json",
];

function runSession(nodeId: string): Promise<{ exitCode: number | null; sessionIsError: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawnTool("claude", CLAUDE_ARGS, ["pipe", "pipe", "pipe"]);
    child.stdin?.on("error", () => {});
    child.stdin?.write(buildPrompt(nodeId));
    child.stdin?.end();

    const getStdout = wireSessionOutput(child);

    child.on("error", (err) => {
      log(`failed to spawn session: ${err.message}`);
      resolve({ exitCode: null, sessionIsError: true, stdout: "" });
    });

    child.on("close", (code) => {
      const stdout = getStdout();
      resolve({ exitCode: code, sessionIsError: sessionReportedError(stdout), stdout });
    });
  });
}

// Final assistant text from the `--output-format json` envelope; raw stdout on
// parse failure so a malformed envelope still gets a shot at verdict extraction.
function sessionResultText(stdout: string): string {
  try {
    const result = JSON.parse(stdout)?.result;
    if (typeof result === "string") return result;
  } catch {
    /* fall through to raw */
  }
  return stdout;
}

// Last well-formed flat JSON object mentioning "verdict"; null if none valid.
function extractVerdict(text: string): { verdict: Verdict; reason: string } | null {
  const matches = text.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]);
      if (obj?.verdict === "proceed" || obj?.verdict === "not_yet") {
        const reason = typeof obj.reason === "string" && obj.reason.trim()
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

function preflight(): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    const child = spawnTool("aj", ["whoami", "--json"], ["ignore", "pipe", "pipe"]);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) =>
      resolve({ ok: false, detail: `\`aj\` not runnable: ${e.message}` })
    );
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          detail: `\`aj\` not authenticated (whoami exit=${code}): ${err.trim() || "no auth resolved from env vars or ~/.agentjira/config.json"}`,
        });
        return;
      }
      try {
        JSON.parse(out);
        resolve({ ok: true });
      } catch {
        resolve({ ok: false, detail: "`aj whoami` returned unparseable output" });
      }
    });
  });
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: run-judge <node-id>",
      "",
      "Runs one read-only AgentJira soft-block judge session against exactly one",
      "node (already in `evaluating_soft_block`) and prints a verdict to stdout:",
      '  { "node_id", "verdict", "reason" }',
      "",
      "Verdicts and exit codes:",
      "  proceed  (exit 0)   shared decisions are settled; pickup is not a guess",
      "  not_yet  (exit 10)  pickup would guess, or error/unsure/malformed",
      "",
      "READ-ONLY: the session cannot claim, edit, or post. Every non-proceed",
      "path resolves to not_yet — never proceed on doubt.",
      "",
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printUsage();
    process.exit(argv.length === 0 ? USAGE_EXIT : 0);
  }

  const nodeId = argv[0];
  log(`judging node ${nodeId}`);

  const pre = await preflight();
  if (!pre.ok) {
    log(`preflight failed: ${pre.detail}`);
    emitAndExit(nodeId, "not_yet", `preflight: ${pre.detail}`);
  }

  const result = await runSession(nodeId);
  if (result.exitCode !== 0 || result.sessionIsError) {
    emitAndExit(
      nodeId,
      "not_yet",
      `session error (exit=${result.exitCode}${result.sessionIsError ? " is_error=true" : ""})`
    );
  }

  const verdict = extractVerdict(sessionResultText(result.stdout));
  if (!verdict) {
    emitAndExit(nodeId, "not_yet", "no well-formed verdict in session output");
  }

  log(`verdict=${verdict.verdict} (${verdict.reason})`);
  emitAndExit(nodeId, verdict.verdict, verdict.reason);
}

main().catch((err: unknown) => {
  const nodeId = process.argv[2] ?? null;
  const message = err instanceof Error ? err.message : String(err);
  emitAndExit(nodeId, "not_yet", `runner error: ${message}`);
});
