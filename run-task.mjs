#!/usr/bin/env node

import { spawn } from "node:child_process";

const EXIT_CODES = {
  completed: 0,
  asked_user: 10,
  errored: 20,
};
const USAGE_EXIT = 2;

const ASKED_USER_STATUS = "awaiting_human_response";

function emitAndExit(nodeId, outcome, detail) {
  process.stdout.write(
    JSON.stringify({ node_id: nodeId, outcome, detail }) + "\n"
  );
  process.exit(EXIT_CODES[outcome]);
}

function log(...args) {
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

function buildClaudeArgs() {
  return [
    "--print",
    "--permission-mode", "auto",
    "--no-session-persistence",
    "--output-format", "json",
  ];
}

const IS_WINDOWS = process.platform === "win32";

function spawnTool(bin, args, stdio) {
  const finalArgs = IS_WINDOWS
    ? args.map((a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  return spawn(bin, finalArgs, { stdio, shell: IS_WINDOWS });
}

function runSession(nodeId) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs();
    log(`spawning: claude ${args.join(" ")} <prompt via stdin>`);

    const child = spawnTool("claude", args, ["pipe", "pipe", "pipe"]);
    child.stdin.on("error", () => {});
    child.stdin.write(buildPrompt(nodeId));
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      process.stderr.write(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));

    child.on("error", (err) => {
      log(`failed to spawn session: ${err.message}`);
      resolve({ exitCode: null, sessionIsError: true });
    });

    child.on("close", (code) => {
      let sessionIsError = false;
      try {
        const result = JSON.parse(stdout);
        if (result && result.is_error === true) sessionIsError = true;
      } catch {}
      resolve({ exitCode: code, sessionIsError });
    });
  });
}

function queryNodeStatus(nodeId) {
  return new Promise((resolve) => {
    const child = spawnTool("aj", ["context", nodeId, "--json"], [
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

function classify({ exitCode, sessionIsError }, postStatus) {
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
  const nodeId = process.argv[2] || null;
  emitAndExit(nodeId, "errored", `runner error: ${err.message}`);
});
