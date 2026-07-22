import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Deterministic supervisor loop. No LLM, no accumulating context: each task is
// handed to a fresh single-session runner process, and this loop only decides —
// mechanically — which task runs next and when to stop.

type Outcome = "completed" | "asked_user" | "errored";

// Runner exit codes (mirror ../runner/run-task.ts). Used only as a fallback when
// the runner's stdout JSON can't be parsed.
const RUNNER_EXIT_OUTCOME: Record<number, Outcome> = {
  0: "completed",
  10: "asked_user",
  20: "errored",
};

const USAGE_EXIT = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_ENTRY = resolve(HERE, "..", "runner", "run-task.ts");

function log(...args: string[]): void {
  process.stderr.write("[supervisor] " + args.join(" ") + "\n");
}

interface RecommendedTask {
  id: string;
  title?: string;
  status?: string;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

function fetchRecommended(projectId: string | null): Promise<Result<RecommendedTask[]>> {
  const args = ["tasks", "--json"];
  if (projectId) args.push("-p", projectId);
  return new Promise((resolvePromise) => {
    const child = spawn("aj", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) =>
      resolvePromise({ data: null, error: `\`aj tasks\` not runnable: ${e.message}` })
    );
    child.on("close", (code) => {
      if (code !== 0) {
        resolvePromise({ data: null, error: `\`aj tasks\` exited ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(out);
        const rec = Array.isArray(parsed?.recommended) ? parsed.recommended : [];
        resolvePromise({ data: rec as RecommendedTask[], error: null });
      } catch {
        resolvePromise({ data: null, error: "`aj tasks --json` returned unparseable output" });
      }
    });
  });
}

// Parse the runner's single stdout JSON line: { node_id, outcome, detail }.
function parseRunnerOutput(stdout: string): { outcome: Outcome; detail: string } | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj.outcome === "string") {
        return { outcome: obj.outcome as Outcome, detail: String(obj.detail ?? "") };
      }
    } catch {
      // not the JSON line; keep scanning backwards
    }
  }
  return null;
}

// Run one node via the single-session runner. Forward the runner's stderr;
// capture its stdout to read the outcome. Trust the runner's classification,
// falling back to the exit code, then to `errored`.
function runNode(nodeId: string): Promise<{ outcome: Outcome; detail: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("tsx", [RUNNER_ENTRY, nodeId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => {
      resolvePromise({ outcome: "errored", detail: `failed to spawn runner: ${e.message}` });
    });
    child.on("close", (code) => {
      const parsed = parseRunnerOutput(stdout);
      if (parsed) {
        resolvePromise(parsed);
        return;
      }
      const byExit = code != null ? RUNNER_EXIT_OUTCOME[code] : undefined;
      resolvePromise({
        outcome: byExit ?? "errored",
        detail: `runner produced no parseable outcome (exit=${code})`,
      });
    });
  });
}

const USAGE = "Usage: loop [--project <id>]";

function parseProjectArg(argv: string[]): string | null {
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stderr.write(USAGE + "\n");
    process.exit(0);
  }
  if (argv.length === 0) return null;
  if ((argv[0] === "--project" || argv[0] === "-p") && argv[1] && argv.length === 2) {
    return argv[1];
  }
  process.stderr.write(USAGE + "\n");
  process.exit(USAGE_EXIT);
}

async function main(): Promise<void> {
  const projectId = parseProjectArg(process.argv.slice(2));

  const attempted = new Set<string>();
  const counts: Record<Outcome, number> = { completed: 0, asked_user: 0, errored: 0 };
  const erroredNodes: string[] = [];

  log(`starting${projectId ? ` (project ${projectId})` : ""}`);

  for (;;) {
    const { data: recommended, error } = await fetchRecommended(projectId);
    if (error !== null) {
      // Can't see the board — surface and stop rather than spin blindly.
      log(`aborting: ${error}`);
      break;
    }

    const next = recommended.find((t) => t && typeof t.id === "string" && !attempted.has(t.id));
    if (!next) {
      log("no unattempted recommended task remains — done");
      break;
    }

    attempted.add(next.id);
    log(`running ${next.id}${next.title ? ` — ${next.title}` : ""}`);

    const { outcome, detail } = await runNode(next.id);
    counts[outcome] += 1;
    log(`${next.id} -> ${outcome} (${detail})`);

    if (outcome === "errored") {
      erroredNodes.push(next.id);
      // No retry this run: the node stays in `attempted`, so a subsequent
      // `aj tasks` that still lists it won't re-pick it.
    }
    // completed -> loop re-queries fresh; asked_user -> left with the human.
  }

  const summary = {
    attempted: attempted.size,
    completed: counts.completed,
    asked_user: counts.asked_user,
    errored: counts.errored,
    errored_node_ids: erroredNodes,
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`fatal: ${message}`);
  // Even on an unexpected fault, emit a summary shape so consumers can parse.
  process.stdout.write(
    JSON.stringify({
      attempted: 0,
      completed: 0,
      asked_user: 0,
      errored: 0,
      errored_node_ids: [],
      fatal: message,
    }) + "\n"
  );
  process.exit(1);
});
