import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type Script } from "../test-helpers/fake-child";
import { driveEntry } from "./test-harness";

const { spawnMock, preflightMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  preflightMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./entrypoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./entrypoint")>()),
  preflight: preflightMock,
}));

const NODE = "n1";
const ARGV = process.argv;

// Literal, not built from buildPrompt: the prompt is the contract with the
// session, so a change here should be a deliberate edit to both sides.
const PROMPT = `You are a headless AgentJira worker session. Work exactly one node: n1.

Load the agentjira-workflow skill first, then the stage-appropriate
AgentJira skill, and follow them. Claim the node, load its full context
with the aj CLI, and do the stage-appropriate work to completion
(break down, spec, or implement + raise a PR).

Do not ask for confirmation on routine steps — you are running
non-interactively. If the direction is genuinely ambiguous, post a
question with \`aj post n1 --type question\` (which hands the node
back to the human) instead of guessing, then stop. If you stop without
finishing the stage, run \`aj unclaim n1\`.`;

const USAGE = `Usage: run-task <node-id>

Runs one AgentJira node in one fresh headless auto-mode Claude Code
session and prints a machine-readable outcome to stdout:
  { "node_id", "outcome", "detail" }

Outcomes and exit codes:
  completed     (exit 0)
  asked_user    (exit 10)
  errored       (exit 20)
  usage_limited (exit 21)  + reset_at epoch in the result line
  api_error     (exit 22)

`;

interface RunOptions {
  argv?: string[];
  scripts?: Script[];
  preflight?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  unwind?: boolean;
}

async function run(opts: RunOptions = {}) {
  preflightMock.mockImplementation(
    opts.preflight ?? (() => Promise.resolve({ ok: true })),
  );
  process.argv = ["node", "run-task.ts", ...(opts.argv ?? [NODE])];
  return driveEntry(() => import("./run-task"), spawnMock, opts);
}

const envelope = (result: string) => JSON.stringify({ result });
const OK_BWRAP: Script = { code: 0 };
const OK_SESSION: Script = { stdout: envelope("done"), code: 0 };
const status = (s: string): Script => ({
  stdout: JSON.stringify({ node: { status: s } }),
  stderr: "aj chatter\n",
  code: 0,
});

beforeEach(() => {
  vi.stubEnv("LOOP_SESSION_PROXY", "http://127.0.0.1:3128");
  vi.stubEnv("LOOP_SESSION_WORKDIR", "/srv/session-work");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = ARGV;
});

describe("usage", () => {
  it("prints usage and exits 2 with no arguments", async () => {
    const { code, stderr } = await run({ argv: [] });
    expect(code).toBe(2);
    expect(stderr).toBe(USAGE);
  });

  it("prints usage and exits 0 for --help", async () => {
    const { code, stderr } = await run({ argv: ["--help"] });
    expect(code).toBe(0);
    expect(stderr).toContain("Usage: run-task <node-id>");
  });
});

describe("preflight gates", () => {
  it("errors when the sandbox env is invalid", async () => {
    vi.stubEnv("LOOP_SESSION_PROXY", "127.0.0.1:3128");
    const { code, result } = await run();
    expect(code).toBe(20);
    expect(result.outcome).toBe("errored");
    expect(result.detail).toContain("env: LOOP_SESSION_PROXY");
  });

  it("errors when the aj preflight fails", async () => {
    const { code, result, stderr } = await run({
      preflight: () => Promise.resolve({ ok: false, detail: "no auth" }),
    });
    expect(code).toBe(20);
    expect(result.detail).toBe("preflight: no auth");
    expect(stderr).toContain("[run-task] preflight failed: no auth");
  });

  it("errors when bwrap is not runnable", async () => {
    const { result } = await run({ scripts: [{ error: "ENOENT" }] });
    expect(result.detail).toContain("`bwrap` is not runnable (ENOENT)");
  });

  it("errors when bwrap --version exits nonzero", async () => {
    const { result } = await run({
      scripts: [{ stderr: "broken\n", code: 3 }],
    });
    expect(result.detail).toBe("sandbox: `bwrap --version` exit=3: broken");
  });
});

describe("session outcomes", () => {
  it("completes and sandboxes the session via bwrap", async () => {
    const { code, result, spawns, stdins, stderr } = await run({
      scripts: [OK_BWRAP, OK_SESSION, status("done")],
    });
    expect(code).toBe(0);
    expect(result).toEqual({
      node_id: NODE,
      outcome: "completed",
      detail: "node status=done",
    });
    expect(spawns[0]).toEqual([
      "bwrap",
      ["--version"],
      { stdio: ["ignore", "ignore", "pipe"] },
    ]);
    expect(spawns[1][0]).toBe("bwrap");
    expect(spawns[1][1]).toContain("claude");
    expect(spawns[1][2]).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
    expect(spawns[2]).toEqual([
      "aj",
      ["context", NODE, "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ]);
    expect(stdins[1]).toBe(PROMPT);
    // Whole stream: the run's log lines in order, with the session's own
    // output and `aj`'s stderr passed through untouched between them.
    expect(stderr).toBe(
      "[run-task] running node n1\n" +
        "[run-task] session sandboxed via bwrap (workdir=/srv/session-work)\n" +
        envelope("done") +
        "aj chatter\n" +
        "[run-task] outcome=completed (node status=done)\n",
    );
  });

  it("reports asked_user when the node ends awaiting a human", async () => {
    const { code, result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, status("awaiting_human_response")],
    });
    expect(code).toBe(10);
    expect(result.outcome).toBe("asked_user");
    expect(result.detail).toBe("node status=awaiting_human_response");
  });

  it("errors when the status lookup output is unparseable", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, { stdout: "junk", code: 0 }],
    });
    expect(result.detail).toBe("clean exit but node status lookup failed");
  });

  it("errors when the status lookup cannot be spawned", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, { error: "ENOENT" }],
    });
    expect(result.outcome).toBe("errored");
  });

  it("errors on a nonzero session exit", async () => {
    const { code, result } = await run({
      scripts: [OK_BWRAP, { stdout: envelope("bye"), code: 7 }, status("done")],
    });
    expect(code).toBe(20);
    expect(result.detail).toBe("session exit=7, node status=done");
  });

  it("errors when the session envelope reports is_error", async () => {
    const { result } = await run({
      scripts: [
        OK_BWRAP,
        { stdout: JSON.stringify({ is_error: true, result: "bad" }), code: 0 },
        status("done"),
      ],
    });
    expect(result.detail).toBe(
      "session exit=0 is_error=true, node status=done",
    );
  });

  it("says the status is unknown when both the session and the lookup fail", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, { code: 7 }, { stdout: "junk", code: 0 }],
    });
    expect(result.detail).toBe("session exit=7, node status=unknown");
  });

  it("errors when the session cannot be spawned", async () => {
    const { result, stderr } = await run({
      scripts: [OK_BWRAP, { error: "ENOENT" }, status("done")],
    });
    expect(stderr).toContain("failed to spawn session: ENOENT");
    expect(result.detail).toContain("session exit=null is_error=true");
  });
});

describe("error escalation", () => {
  it("escalates a usage limit to usage_limited with the reset epoch", async () => {
    const { code, result } = await run({
      scripts: [
        OK_BWRAP,
        {
          stdout: envelope("Claude AI usage limit reached|1750000000"),
          code: 1,
        },
        status("done"),
      ],
    });
    expect(code).toBe(21);
    expect(result.outcome).toBe("usage_limited");
    expect(result.reset_at).toBe(1750000000);
  });

  it("escalates a transient API failure to api_error", async () => {
    const { code, result } = await run({
      scripts: [
        OK_BWRAP,
        { stdout: envelope("overloaded_error"), code: 1 },
        status("done"),
      ],
    });
    expect(code).toBe(22);
    expect(result.outcome).toBe("api_error");
    expect(result.reset_at).toBeUndefined();
  });

  it("does not escalate when the session exited cleanly", async () => {
    const { code, result } = await run({
      scripts: [
        OK_BWRAP,
        {
          stdout: envelope("Claude AI usage limit reached|1750000000"),
          code: 0,
        },
        status("done"),
      ],
    });
    expect(code).toBe(0);
    expect(result.outcome).toBe("completed");
  });
});

describe("fatal errors", () => {
  it("reports a thrown Error", async () => {
    const { code, result } = await run({
      unwind: false,
      preflight: () => Promise.reject(new Error("boom")),
    });
    expect(code).toBe(20);
    expect(result).toEqual({
      node_id: NODE,
      outcome: "errored",
      detail: "runner error: boom",
    });
  });

  it("reports a thrown non-Error", async () => {
    const { result } = await run({
      unwind: false,
      preflight: () => Promise.reject("plain"),
    });
    expect(result.detail).toBe("runner error: plain");
  });
});
