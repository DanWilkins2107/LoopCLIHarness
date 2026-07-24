import { spawnTool } from "./session.js";

// Entrypoint-level plumbing shared by the runner entrypoints (`run-task`,
// `run-judge`): the auth preflight, stderr logging, the machine-readable result
// line, and the base Claude Code args. Spawn/output wiring lives in session.ts.

export const USAGE_EXIT = 2;

export const CLAUDE_ARGS = [
  "--print",
  "--permission-mode", "auto",
  "--no-session-persistence",
  "--output-format", "json",
];

export function makeLog(prefix: string): (...args: string[]) => void {
  return (...args) => process.stderr.write(`[${prefix}] ${args.join(" ")}\n`);
}

// One machine-readable result line to stdout, then exit with the mapped code.
// Callers own the enum→code mapping and the payload's variant fields.
export function emitResult(
  nodeId: string | null,
  exitCode: number,
  payload: Record<string, unknown>
): never {
  process.stdout.write(JSON.stringify({ node_id: nodeId, ...payload }) + "\n");
  process.exit(exitCode);
}

export function preflight(): Promise<{ ok: true } | { ok: false; detail: string }> {
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
