import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sleepMs, apiBackoffMs } from "./backoff";
import { RESET_MARGIN_S, LIMIT_COOLDOWN_S, MAX_RETRIES, IDLE_INTERVAL_S } from "./constants";

type TerminalOutcome = "completed" | "asked_user" | "errored";
type Outcome = TerminalOutcome | "usage_limited" | "api_error";

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

function runNode(nodeId: string): Promise<{ outcome: Outcome; detail: string; reset_at?: number }> {
  return new Promise((done) => {
    const child = spawn("tsx", [RUNNER_ENTRY, nodeId], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => done({ outcome: "errored", detail: `failed to spawn runner: ${e.message}` }));
    child.on("close", () => {
      try {
        const { outcome, detail, reset_at } = JSON.parse(out.trim().split(/\r?\n/).at(-1)!);
        done({ outcome, detail: String(detail ?? ""), reset_at });
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

function printSummary(
  attempted: Set<string>,
  counts: Record<TerminalOutcome, number>,
  erroredNodes: Set<string>
): void {
  process.stdout.write(
    JSON.stringify({
      attempted: attempted.size,
      completed: counts.completed,
      asked_user: counts.asked_user,
      errored: counts.errored,
      errored_node_ids: [...erroredNodes],
    }) + "\n"
  );
}

async function main(): Promise<void> {
  const projectId = parseProjectArg(process.argv.slice(2));
  const attempted = new Set<string>();
  const erroredNodes = new Set<string>();
  const apiRetries = new Map<string, number>();
  const counts: Record<TerminalOutcome, number> = { completed: 0, asked_user: 0, errored: 0 };

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received — stopping after current node`);
      stopping = true;
    });
  }

  log(`starting${projectId ? ` (project ${projectId})` : ""}`);

  while (!stopping) {
    const { data: recommended, error } = await fetchRecommended(projectId);
    if (error !== null) {
      log(`aborting: ${error}`);
      break;
    }
    const next = recommended.find((t) => !attempted.has(t.id) && !erroredNodes.has(t.id));
    if (!next) {
      log(`idle — no recommended task; sleeping ${IDLE_INTERVAL_S}s`);
      attempted.clear();
      await sleepMs(IDLE_INTERVAL_S * 1000);
      continue;
    }

    log(`running ${next.id}${next.title ? ` — ${next.title}` : ""}`);
    const { outcome, detail, reset_at } = await runNode(next.id);

    if (outcome === "usage_limited") {
      const target = reset_at != null ? reset_at + RESET_MARGIN_S : nowS() + LIMIT_COOLDOWN_S;
      const waitS = Math.max(0, target - nowS());
      log(`${next.id} usage-limited; sleeping ${waitS}s until reset`);
      await sleepMs(waitS * 1000);
      continue;
    }

    if (outcome === "api_error") {
      const n = apiRetries.get(next.id) ?? 0;
      if (n < MAX_RETRIES) {
        apiRetries.set(next.id, n + 1);
        const ms = apiBackoffMs(n);
        log(`${next.id} api-error; backoff ${ms}ms (retry ${n + 1}/${MAX_RETRIES})`);
        await sleepMs(ms);
        continue;
      }
      log(`${next.id} api-error; exhausted ${MAX_RETRIES} retries — errored`);
      counts.errored += 1;
      erroredNodes.add(next.id);
      apiRetries.delete(next.id);
      continue;
    }

    apiRetries.delete(next.id);
    counts[outcome] += 1;
    attempted.add(next.id);
    if (outcome === "errored") erroredNodes.add(next.id);
    log(`${next.id} -> ${outcome} (${detail})`);
  }

  printSummary(attempted, counts, erroredNodes);
  process.exit(0);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
