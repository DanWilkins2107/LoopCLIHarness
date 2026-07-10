import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

type Outcome = "completed" | "asked_user" | "errored";

const EXIT_CODES: Record<Outcome, number> = {
  completed: 0,
  asked_user: 10,
  errored: 20,
};
const USAGE_EXIT = 2;

const ASKED_USER_STATUS = "awaiting_human_response";

function emitAndExit(nodeId: string | null, outcome: Outcome, detail: string): never {
  process.stdout.write(
    JSON.stringify({ node_id: nodeId, outcome, detail }) + "\n"
  );
  process.exit(EXIT_CODES[outcome]);
}

function log(...args: string[]): void {
  process.stderr.write("[run-task] " + args.join(" ") + "\n");
}

function buildPrompt(nodeId: string): string {
  return [
    `You are a headless AgentJira worker session. Work exactly one node: ${nodeId}.`,
    ``,
    `Load the agentjira-workflow skill first, then the stage-appropriate`,
    `AgentJira skill, and follow them. Claim the node, load its full context`,
    `with the aj CLI, and do the stage-appropriate work to completion`,
    `(break down, spec, or implement + raise a PR).`,
    ``,
    `Do not ask for confirmation on routine steps — you are running`,
    `non-interactively. If the direction is genuinely ambiguous, post a`,
    `question with \`aj post ${nodeId} --type question\` (which hands the node`,
    `back to the human) instead of guessing, then stop. If you stop without`,
    `finishing the stage, run \`aj unclaim ${nodeId}\`.`,
  ].join("\n");
}

const CLAUDE_ARGS = [
  "--print",
  "--permission-mode", "auto",
  "--no-session-persistence",
  "--output-format", "json",
];

const IS_WINDOWS = process.platform === "win32";

function spawnTool(bin: string, args: string[], stdio: StdioOptions) {
  // On Windows we spawn through the shell (so `.cmd` shims like `claude`/`aj`
  // resolve), which means each arg is re-parsed by cmd.exe. Quote any arg
  // containing whitespace or a cmd metacharacter so it survives that second
  // parse intact; POSIX shells get the args untouched via the array form.
  const finalArgs = IS_WINDOWS
    ? args.map((a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  return spawn(bin, finalArgs, { stdio, shell: IS_WINDOWS });
}

function wireSessionOutput(child: ChildProcess): () => string {
  let stdout = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
    process.stderr.write(d);
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));
  return () => stdout;
}

function sessionReportedError(stdout: string): boolean {
  try {
    return JSON.parse(stdout)?.is_error === true;
  } catch {
    return false;
  }
}

function runSession(nodeId: string): Promise<{ exitCode: number | null; sessionIsError: boolean }> {
  return new Promise((resolve) => {
    const child = spawnTool("claude", CLAUDE_ARGS, ["pipe", "pipe", "pipe"]);
    child.stdin?.on("error", () => {});
    child.stdin?.write(buildPrompt(nodeId));
    child.stdin?.end();

    const getStdout = wireSessionOutput(child);

    child.on("error", (err) => {
      log(`failed to spawn session: ${err.message}`);
      resolve({ exitCode: null, sessionIsError: true });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code, sessionIsError: sessionReportedError(getStdout()) });
    });
  });
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

function queryNodeStatus(nodeId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnTool("aj", ["context", nodeId, "--json"], ["ignore", "pipe", "pipe"]);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out).node.status);
      } catch {
        resolve(null);
      }
    });
  });
}

function classify(
  { exitCode, sessionIsError }: { exitCode: number | null; sessionIsError: boolean },
  postStatus: string | null
): { outcome: Outcome; detail: string } {
  if (exitCode !== 0 || sessionIsError) {
    return {
      outcome: "errored",
      detail: `session exit=${exitCode}${sessionIsError ? " is_error=true" : ""}, node status=${postStatus ?? "unknown"}`,
    };
  }
  if (postStatus == null) {
    return { outcome: "errored", detail: "clean exit but node status lookup failed" };
  }
  if (postStatus === ASKED_USER_STATUS) {
    return { outcome: "asked_user", detail: `node status=${postStatus}` };
  }
  return { outcome: "completed", detail: `node status=${postStatus}` };
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: run-task <node-id>",
      "",
      "Runs one AgentJira node in one fresh headless auto-mode Claude Code",
      "session and prints a machine-readable outcome to stdout:",
      '  { "node_id", "outcome", "detail" }',
      "",
      "Outcomes and exit codes:",
      "  completed  (exit 0)",
      "  asked_user (exit 10)",
      "  errored    (exit 20)",
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
  log(`running node ${nodeId}`);

  const pre = await preflight();
  if (!pre.ok) {
    log(`preflight failed: ${pre.detail}`);
    emitAndExit(nodeId, "errored", `preflight: ${pre.detail}`);
  }

  const result = await runSession(nodeId);
  const postStatus = await queryNodeStatus(nodeId);
  const { outcome, detail } = classify(result, postStatus);

  log(`outcome=${outcome} (${detail})`);
  emitAndExit(nodeId, outcome, detail);
}

main().catch((err: unknown) => {
  const nodeId = process.argv[2] ?? null;
  const message = err instanceof Error ? err.message : String(err);
  emitAndExit(nodeId, "errored", `runner error: ${message}`);
});
