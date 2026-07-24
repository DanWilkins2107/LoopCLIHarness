import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Outcome = "completed" | "asked_user" | "errored";

interface RecommendedTask {
  id: string;
  title?: string;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_ENTRY = resolve(HERE, "..", "runner", "run-task.ts");
const USAGE = "Usage: loop [--project <id>]";

function log(...args: string[]): void {
  process.stderr.write("[supervisor] " + args.join(" ") + "\n");
}

function fetchRecommended(projectId: string | null): Promise<Result<RecommendedTask[]>> {
  const args = ["tasks", "--json"];
  if (projectId) args.push("-p", projectId);
  return new Promise((done) => {
    const child = spawn("aj", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => done({ data: null, error: `aj tasks not runnable: ${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return done({ data: null, error: `aj tasks exited ${code}` });
      try {
        done({ data: JSON.parse(out).recommended ?? [], error: null });
      } catch {
        done({ data: null, error: "aj tasks --json returned unparseable output" });
      }
    });
  });
}

function runNode(nodeId: string): Promise<{ outcome: Outcome; detail: string }> {
  return new Promise((done) => {
    const child = spawn("tsx", [RUNNER_ENTRY, nodeId], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => done({ outcome: "errored", detail: `failed to spawn runner: ${e.message}` }));
    child.on("close", () => {
      try {
        const { outcome, detail } = JSON.parse(out.trim().split(/\r?\n/).at(-1)!);
        done({ outcome, detail: String(detail ?? "") });
      } catch {
        done({ outcome: "errored", detail: "runner produced no parseable outcome" });
      }
    });
  });
}

function parseProjectArg(argv: string[]): string | null {
  if (argv.length === 0) return null;
  if ((argv[0] === "--project" || argv[0] === "-p") && argv.length === 2) return argv[1];
  process.stderr.write(USAGE + "\n");
  process.exit(2);
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
      log(`aborting: ${error}`);
      break;
    }
    const next = recommended.find((t) => !attempted.has(t.id));
    if (!next) {
      log("no unattempted recommended task remains — done");
      break;
    }

    attempted.add(next.id);
    log(`running ${next.id}${next.title ? ` — ${next.title}` : ""}`);

    const { outcome, detail } = await runNode(next.id);
    counts[outcome] += 1;
    if (outcome === "errored") erroredNodes.push(next.id);
    log(`${next.id} -> ${outcome} (${detail})`);
  }

  process.stdout.write(
    JSON.stringify({
      attempted: attempted.size,
      completed: counts.completed,
      asked_user: counts.asked_user,
      errored: counts.errored,
      errored_node_ids: erroredNodes,
    }) + "\n"
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
