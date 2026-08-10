import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>;

// Accumulate a child's stdout (returned via the getter) while mirroring both
// streams to our stderr so the session's own output stays visible as
// diagnostics. stdout of the runner is reserved for the one machine-readable
// result line.
export function wireSessionOutput(child: PipedChild): () => string {
  let stdout = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    process.stderr.write(d);
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return () => stdout;
}

// The `--output-format json` envelope Claude Code prints sets `is_error: true`
// when the session itself failed. Unparseable output is treated as no error
// here; callers decide what a missing/garbled envelope means for them.
export function sessionReportedError(stdout: string): boolean {
  try {
    return JSON.parse(stdout).is_error === true;
  } catch {
    return false;
  }
}
