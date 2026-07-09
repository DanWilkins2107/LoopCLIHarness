#!/usr/bin/env node
// run-task <node-id>
//
// Spawn ONE fresh headless auto-mode Claude Code session (AgentJira plugin +
// authenticated `aj` CLI preconfigured) against a single AgentJira node, run it
// to completion, and classify how it finished:
//
//   completed  — session exited cleanly; node is in a non-error state
//                (pr_raised / spec_review / split_proposed / broken_down / done / …)
//   asked_user — session exited cleanly; node is now awaiting_human_response
//                (the plugin question flow handed it back to a human)
//   errored    — session crashed / non-zero exit / usage-limit or API error /
//                no clean finish
//
// Every run is a brand-new process with fresh context: no --continue/--resume,
// no session persisted, no state carried between runs.
//
// Output contract (consumed by the deterministic supervisor, sibling c312861e):
//   * exactly one JSON object on stdout: { "node_id", "outcome", "detail" }
//   * a distinct process exit code per outcome (see EXIT_CODES below)
// All diagnostics and the child session's own output go to stderr, so stdout
// stays machine-parseable.

import { spawn } from "node:child_process";

// ---- Outcome ⇄ exit-code mapping -------------------------------------------

const EXIT_CODES = {
  completed: 0,
  asked_user: 10,
  errored: 20,
};
const USAGE_EXIT = 2; // bad invocation (not a run outcome)

// Node status that deterministically means "handed back to a human by the
// plugin question flow".
const ASKED_USER_STATUS = "awaiting_human_response";

// ---- Config (auth + binaries are preconditions, not this node's job) --------

const config = {
  claudeBin: process.env.CLAUDE_BIN || "claude",
  ajBin: process.env.AJ_BIN || "aj",
  // If set, the AgentJira plugin is explicitly loaded for the session from this
  // directory. If unset, the session relies on the plugin already being
  // installed for the user.
  pluginDir: process.env.AGENTJIRA_PLUGIN_DIR || "",
  // Optional model override (alias like "opus"/"sonnet" or a full model name).
  model: process.env.RUN_TASK_MODEL || "",
  // Optional wall-clock cap; on timeout the session is killed and the run is
  // classified as errored. 0 = no timeout.
  timeoutMs: Number(process.env.RUN_TASK_TIMEOUT_MS || 0),
};

// ---- Helpers ----------------------------------------------------------------

function emitAndExit(nodeId, outcome, detail) {
  // The ONLY thing written to stdout: the machine-readable outcome.
  process.stdout.write(
    JSON.stringify({ node_id: nodeId, outcome, detail }) + "\n"
  );
  process.exit(EXIT_CODES[outcome]);
}

function log(...args) {
  // Everything human-facing goes to stderr to keep stdout clean.
  process.stderr.write("[run-task] " + args.join(" ") + "\n");
}

function buildPrompt(nodeId) {
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

function buildClaudeArgs(nodeId) {
  const args = [
    "--print", // non-interactive: print result and exit
    "--permission-mode", "auto", // auto mode enforced
    "--no-session-persistence", // stateless: nothing to resume; fresh every run
    "--output-format", "json", // structured result → detect is_error
  ];
  if (config.pluginDir) {
    args.push("--plugin-dir", config.pluginDir); // load AgentJira plugin
  }
  if (config.model) {
    args.push("--model", config.model);
  }
  // NOTE: the prompt is deliberately NOT appended here — it is written to the
  // session's stdin in runSession. A multi-line prompt cannot survive as a CLI
  // argument once we have to launch through a shell on Windows (see spawnTool).
  return args;
}

// On Windows, `claude` and `aj` are installed as `.cmd` shims, which Node
// (since CVE-2024-27980) refuses to launch without a shell — a plain
// spawn("aj", …) fails with ENOENT. So on Windows we spawn through a shell and
// quote each argument (cmd.exe re-parses the command line). Multi-line values
// (i.e. the prompt) can't be passed as a shell argument at all — they get
// truncated at the first newline — so runSession feeds the prompt over stdin.
const IS_WINDOWS = process.platform === "win32";
function spawnTool(bin, args, stdio) {
  const finalArgs = IS_WINDOWS
    ? args.map((a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  return spawn(bin, finalArgs, { stdio, shell: IS_WINDOWS });
}

// Run the fresh headless session to completion. Resolves with the exit code,
// a timed-out flag, and whether the session's own JSON result marked an error.
function runSession(nodeId) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(nodeId);
    log(`spawning: ${config.claudeBin} ${args.join(" ")} <prompt via stdin>`);

    // stdin is piped so the prompt goes to `claude --print` over stdin rather
    // than as a CLI argument (shell-safe on Windows; see spawnTool).
    const child = spawnTool(config.claudeBin, args, ["pipe", "pipe", "pipe"]);
    child.stdin.on("error", () => {}); // ignore EPIPE if the session exits early
    child.stdin.write(buildPrompt(nodeId));
    child.stdin.end();

    let stdout = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      stdout += d;
      process.stderr.write(d); // mirror session output to stderr for observability
    });
    child.stderr.on("data", (d) => process.stderr.write(d));

    let timer = null;
    if (config.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        log(`timeout after ${config.timeoutMs}ms — killing session`);
        child.kill("SIGKILL");
      }, config.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      log(`failed to spawn session: ${err.message}`);
      resolve({ exitCode: null, timedOut, sessionIsError: true, spawnError: err.message });
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      // The session's JSON result may flag an error (max turns, API error, …)
      // even when the process exits 0.
      let sessionIsError = false;
      try {
        const result = JSON.parse(stdout);
        if (result && result.is_error === true) sessionIsError = true;
      } catch {
        // Non-JSON stdout (e.g. crash before producing a result) — the exit
        // code below governs the classification.
      }
      resolve({ exitCode: code, signal, timedOut, sessionIsError });
    });
  });
}

// Read the node's current status via the authenticated aj CLI.
function queryNodeStatus(nodeId) {
  return new Promise((resolve) => {
    const child = spawnTool(config.ajBin, ["context", nodeId, "--json"], [
      "ignore",
      "pipe",
      "pipe",
    ]);
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

// Deterministic classification from the process result + post-run node status.
function classify({ exitCode, timedOut, sessionIsError }, postStatus) {
  if (timedOut) {
    return { outcome: "errored", detail: "session timed out" };
  }
  if (exitCode !== 0 || sessionIsError) {
    return {
      outcome: "errored",
      detail: `session exit=${exitCode}${sessionIsError ? " is_error=true" : ""}, node status=${postStatus ?? "unknown"}`,
    };
  }
  if (postStatus == null) {
    // Clean process exit but we cannot confirm the node state → not a clean finish.
    return { outcome: "errored", detail: "clean exit but node status lookup failed" };
  }
  if (postStatus === ASKED_USER_STATUS) {
    return { outcome: "asked_user", detail: `node status=${postStatus}` };
  }
  return { outcome: "completed", detail: `node status=${postStatus}` };
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
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
        "Environment:",
        "  CLAUDE_BIN            claude binary (default: claude)",
        "  AJ_BIN               aj binary (default: aj)",
        "  AGENTJIRA_PLUGIN_DIR path to the AgentJira plugin to load (optional)",
        "  RUN_TASK_MODEL       model alias/name override (optional)",
        "  RUN_TASK_TIMEOUT_MS  wall-clock cap; timeout → errored (optional)",
        "",
      ].join("\n") + "\n"
    );
    process.exit(argv.length === 0 ? USAGE_EXIT : 0);
  }

  const nodeId = argv[0];
  log(`running node ${nodeId}`);

  const result = await runSession(nodeId);
  const postStatus = await queryNodeStatus(nodeId);
  const { outcome, detail } = classify(result, postStatus);

  log(`outcome=${outcome} (${detail})`);
  emitAndExit(nodeId, outcome, detail);
}

main().catch((err) => {
  // Any unexpected failure in the runner itself is an errored run.
  const nodeId = process.argv[2] || null;
  emitAndExit(nodeId, "errored", `runner error: ${err.message}`);
});
