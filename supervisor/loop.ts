import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sleepMs, apiBackoffMs } from "./backoff";
import {
  RESET_MARGIN_S,
  LIMIT_COOLDOWN_S,
  MAX_RETRIES,
  IDLE_INTERVAL_S,
  IDLE_SHUTDOWN_S,
} from "./constants";

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

function fetchRecommended(
  projectId: string | null,
): Promise<Result<RecommendedTask[]>> {
  const args = ["tasks", "--json"];
  if (projectId) args.push("-p", projectId);
  return new Promise((done) => {
    const child = spawn("aj", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) =>
      done({ data: null, error: `aj tasks not runnable: ${e.message}` }),
    );
    child.on("close", (code) => {
      if (code !== 0)
        return done({ data: null, error: `aj tasks exited ${code}` });
      try {
        done({ data: JSON.parse(out).recommended ?? [], error: null });
      } catch {
        done({
          data: null,
          error: "aj tasks --json returned unparseable output",
        });
      }
    });
  });
}

function runNode(
  nodeId: string,
): Promise<{ outcome: Outcome; detail: string; reset_at?: number }> {
  return new Promise((done) => {
    const child = spawn("tsx", [RUNNER_ENTRY, nodeId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) =>
      done({
        outcome: "errored",
        detail: `failed to spawn runner: ${e.message}`,
      }),
    );
    child.on("close", () => {
      try {
        const lines = out.trim().split(/\r?\n/);
        const { outcome, detail, reset_at } = JSON.parse(
          lines[lines.length - 1],
        );
        done({ outcome, detail: String(detail ?? ""), reset_at });
      } catch {
        done({
          outcome: "errored",
          detail: "runner produced no parseable outcome",
        });
      }
    });
  });
}

function parseProjectArg(argv: string[]): string | null {
  if (argv.length === 0) return null;
  if ((argv[0] === "--project" || argv[0] === "-p") && argv.length === 2)
    return argv[1];
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

interface Tally {
  attempted: Set<string>;
  erroredNodes: Set<string>;
  apiRetries: Map<string, number>;
  counts: Record<TerminalOutcome, number>;
}

function newTally(): Tally {
  return {
    attempted: new Set(),
    erroredNodes: new Set(),
    apiRetries: new Map(),
    counts: { completed: 0, asked_user: 0, errored: 0 },
  };
}

function printSummary(tally: Tally): void {
  process.stdout.write(
    JSON.stringify({
      attempted: tally.attempted.size,
      completed: tally.counts.completed,
      asked_user: tally.counts.asked_user,
      errored: tally.counts.errored,
      errored_node_ids: [...tally.erroredNodes],
    }) + "\n",
  );
}

function onStopSignal(stop: () => void): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received — stopping after current node`);
      stop();
    });
  }
}

async function waitOutUsageLimit(
  nodeId: string,
  resetAt: number | undefined,
): Promise<void> {
  const target =
    resetAt != null ? resetAt + RESET_MARGIN_S : nowS() + LIMIT_COOLDOWN_S;
  const waitS = Math.max(0, target - nowS());
  log(`${nodeId} usage-limited; sleeping ${waitS}s until reset`);
  await sleepMs(waitS * 1000);
}

async function backOffApiError(
  nodeId: string,
  apiRetries: Map<string, number>,
): Promise<boolean> {
  const n = apiRetries.get(nodeId) ?? 0;
  if (n >= MAX_RETRIES) return false;
  apiRetries.set(nodeId, n + 1);
  const ms = apiBackoffMs(n);
  log(`${nodeId} api-error; backoff ${ms}ms (retry ${n + 1}/${MAX_RETRIES})`);
  await sleepMs(ms);
  return true;
}

function recordTerminal(
  tally: Tally,
  nodeId: string,
  outcome: TerminalOutcome,
  detail: string,
): void {
  tally.apiRetries.delete(nodeId);
  tally.counts[outcome] += 1;
  tally.attempted.add(nodeId);
  if (outcome === "errored") tally.erroredNodes.add(nodeId);
  log(`${nodeId} -> ${outcome} (${detail})`);
}

async function handleOutcome(
  tally: Tally,
  nodeId: string,
  {
    outcome,
    detail,
    reset_at,
  }: { outcome: Outcome; detail: string; reset_at?: number },
): Promise<void> {
  if (outcome === "usage_limited") return waitOutUsageLimit(nodeId, reset_at);
  if (outcome !== "api_error")
    return recordTerminal(tally, nodeId, outcome, detail);
  if (await backOffApiError(nodeId, tally.apiRetries)) return;
  log(`${nodeId} api-error; exhausted ${MAX_RETRIES} retries — errored`);
  tally.counts.errored += 1;
  tally.erroredNodes.add(nodeId);
  tally.apiRetries.delete(nodeId);
}

interface IdleTimer {
  wait: (attempted: Set<string>) => Promise<boolean>;
  reset: () => void;
}

// wait() resolves true when the idle window has expired and the loop should stop.
function makeIdleTimer(): IdleTimer {
  let since: number | null = null;
  return {
    wait: (attempted) => {
      since ??= nowS();
      return waitWhileIdle(since, attempted);
    },
    reset: () => {
      since = null;
    },
  };
}

async function waitWhileIdle(
  idleSince: number,
  attempted: Set<string>,
): Promise<boolean> {
  if (nowS() - idleSince >= IDLE_SHUTDOWN_S) {
    // exit 0 is the stop signal; deploy/supervisor-loop.service turns it into an
    // actual VM stop (ExecStopPost poweroff). AgentJira node 86295af4.
    log(
      `idle ${IDLE_SHUTDOWN_S}s with nothing in progress — shutting down (exit 0 signals VM stop)`,
    );
    return true;
  }
  log(`idle — no recommended task; sleeping ${IDLE_INTERVAL_S}s`);
  attempted.clear();
  await sleepMs(IDLE_INTERVAL_S * 1000);
  return false;
}

function pickNext(
  recommended: RecommendedTask[],
  tally: Tally,
): RecommendedTask | undefined {
  return recommended.find(
    (t) => !tally.attempted.has(t.id) && !tally.erroredNodes.has(t.id),
  );
}

function describe(task: RecommendedTask): string {
  return task.title ? `${task.id} — ${task.title}` : task.id;
}

// Resolves false when the loop should stop.
async function runOnce(
  projectId: string | null,
  tally: Tally,
  idle: IdleTimer,
): Promise<boolean> {
  const { data: recommended, error } = await fetchRecommended(projectId);
  if (error !== null) {
    log(`aborting: ${error}`);
    return false;
  }
  const next = pickNext(recommended, tally);
  if (!next) return !(await idle.wait(tally.attempted));

  idle.reset();
  log(`running ${describe(next)}`);
  await handleOutcome(tally, next.id, await runNode(next.id));
  return true;
}

async function main(): Promise<void> {
  const projectId = parseProjectArg(process.argv.slice(2));
  const tally = newTally();

  let stopping = false;
  onStopSignal(() => {
    stopping = true;
  });

  log(`starting${projectId ? ` (project ${projectId})` : ""}`);

  const idle = makeIdleTimer();
  while (!stopping) {
    if (!(await runOnce(projectId, tally, idle))) break;
  }

  printSummary(tally);
  process.exit(0);
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
