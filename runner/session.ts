import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

// Generic session-spawn plumbing shared by the runner entrypoints
// (`run-task`, `run-judge`). Nothing task- or judge-specific lives here — just
// the spawn and the stdout/stderr wiring both entrypoints reuse.

export function spawnTool(bin: string, args: string[], stdio: StdioOptions): ChildProcess {
  return spawn(bin, args, { stdio });
}

// Accumulate a child's stdout (returned via the getter) while mirroring both
// streams to our stderr so the session's own output stays visible as
// diagnostics. stdout of the runner is reserved for the one machine-readable
// result line.
export function wireSessionOutput(child: ChildProcess): () => string {
  let stdout = "";
  child.stdout?.on("data", (d) => {
    stdout += d;
    process.stderr.write(d);
  });
  child.stderr?.on("data", (d) => process.stderr.write(d));
  return () => stdout;
}

// The `--output-format json` envelope Claude Code prints sets `is_error: true`
// when the session itself failed. Unparseable output is treated as no error
// here; callers decide what a missing/garbled envelope means for them.
export function sessionReportedError(stdout: string): boolean {
  try {
    return JSON.parse(stdout)?.is_error === true;
  } catch {
    return false;
  }
}
