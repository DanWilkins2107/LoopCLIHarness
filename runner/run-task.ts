import { spawn } from "node:child_process";
import { wireSessionOutput, sessionReportedError } from "./session";
import { parseSandboxEnv, buildBwrapArgs, type SandboxEnv } from "./sandbox";
import {
  CLAUDE_ARGS,
  makeLog,
  emitResult,
  parseNodeIdArg,
  preflight,
} from "./entrypoint";
import { classifyError, type EnvelopeClass } from "./classify-error";

type Outcome =
  "completed" | "asked_user" | "errored" | "usage_limited" | "api_error";

const EXIT_CODES: Record<Outcome, number> = {
  completed: 0,
  asked_user: 10,
  errored: 20,
  usage_limited: 21,
  api_error: 22,
};

const ASKED_USER_STATUS = "awaiting_human_response";

function emitAndExit(
  nodeId: string | null,
  outcome: Outcome,
  detail: string,
  resetAt?: number,
): never {
  emitResult(nodeId, EXIT_CODES[outcome], {
    outcome,
    detail,
    reset_at: resetAt,
  });
}

const log = makeLog("run-task");

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

function runSession(
  nodeId: string,
  sandboxEnv: SandboxEnv,
): Promise<{
  exitCode: number | null;
  sessionIsError: boolean;
  stdout: string;
}> {
  const bwrapArgs = buildBwrapArgs("claude", CLAUDE_ARGS, { env: sandboxEnv });
  log(
    `session sandboxed via bwrap (workdir=${sandboxEnv.LOOP_SESSION_WORKDIR})`,
  );
  return new Promise((resolve) => {
    const child = spawn("bwrap", bwrapArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    child.stdin.write(buildPrompt(nodeId));
    child.stdin.end();

    const getStdout = wireSessionOutput(child);

    child.on("error", (err) => {
      log(`failed to spawn session: ${err.message}`);
      resolve({ exitCode: null, sessionIsError: true, stdout: getStdout() });
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code,
        sessionIsError: sessionReportedError(getStdout()),
        stdout: getStdout(),
      });
    });
  });
}

function sandboxPreflight(): Promise<
  { ok: true } | { ok: false; detail: string }
> {
  return new Promise((resolve) => {
    const child = spawn("bwrap", ["--version"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      resolve({
        ok: false,
        detail: `\`bwrap\` is not runnable (${e.message}). Install bubblewrap — sessions are never run unconfined.`,
      }),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve({ ok: true })
        : resolve({
            ok: false,
            detail: `\`bwrap --version\` exit=${code}: ${err.trim()}`,
          }),
    );
  });
}

function queryNodeStatus(nodeId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("aj", ["context", nodeId, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
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

function sessionErrorDetail(
  exitCode: number | null,
  sessionIsError: boolean,
  postStatus: string | null,
): string {
  const isError = sessionIsError ? " is_error=true" : "";
  return `session exit=${exitCode}${isError}, node status=${postStatus ?? "unknown"}`;
}

function classify(
  {
    exitCode,
    sessionIsError,
  }: { exitCode: number | null; sessionIsError: boolean },
  postStatus: string | null,
): { outcome: Outcome; detail: string } {
  if (exitCode !== 0 || sessionIsError) {
    return {
      outcome: "errored",
      detail: sessionErrorDetail(exitCode, sessionIsError, postStatus),
    };
  }
  if (postStatus == null) {
    return {
      outcome: "errored",
      detail: "clean exit but node status lookup failed",
    };
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
      "  completed     (exit 0)",
      "  asked_user    (exit 10)",
      "  errored       (exit 20)",
      "  usage_limited (exit 21)  + reset_at epoch in the result line",
      "  api_error     (exit 22)",
      "",
    ].join("\n") + "\n",
  );
}

function exitFailed(nodeId: string, stage: string, detail: string): never {
  log(`${stage} failed: ${detail}`);
  emitAndExit(nodeId, "errored", `${stage}: ${detail}`);
}

async function checkSandboxEnv(nodeId: string): Promise<SandboxEnv> {
  const parsed = parseSandboxEnv(process.env);
  if (!parsed.ok) exitFailed(nodeId, "env", parsed.detail);

  const pre = await preflight();
  if (!pre.ok) exitFailed(nodeId, "preflight", pre.detail);

  const sandbox = await sandboxPreflight();
  if (!sandbox.ok) exitFailed(nodeId, "sandbox", sandbox.detail);

  return parsed.env;
}

async function main(): Promise<void> {
  const nodeId = parseNodeIdArg(process.argv.slice(2), printUsage);
  log(`running node ${nodeId}`);

  const env = await checkSandboxEnv(nodeId);

  const result = await runSession(nodeId, env);
  const postStatus = await queryNodeStatus(nodeId);
  const { outcome, detail } = classify(result, postStatus);
  const sub: EnvelopeClass =
    outcome === "errored"
      ? classifyError(result.stdout)
      : { outcome: "unknown" };

  const final = sub.outcome === "unknown" ? outcome : sub.outcome;
  log(`outcome=${final} (${detail})`);
  emitAndExit(nodeId, final, detail, sub.reset_at);
}

main().catch((err: unknown) => {
  const nodeId = process.argv[2] ?? null;
  const message = err instanceof Error ? err.message : String(err);
  emitAndExit(nodeId, "errored", `runner error: ${message}`);
});
