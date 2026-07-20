import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

// Generic session-spawn plumbing shared by the runner entrypoints
// (`run-task`, `run-judge`). Nothing task- or judge-specific lives here — just
// the cross-platform spawn and the stdout/stderr wiring both entrypoints reuse.

export const IS_WINDOWS = process.platform === "win32";

export function spawnTool(bin: string, args: string[], stdio: StdioOptions): ChildProcess {
  // On Windows we spawn through the shell (so `.cmd` shims like `claude`/`aj`
  // resolve), which means each arg is re-parsed by cmd.exe. Quote any arg
  // containing whitespace or a cmd metacharacter so it survives that second
  // parse intact; POSIX shells get the args untouched via the array form.
  const finalArgs = IS_WINDOWS
    ? args.map((a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    : args;
  return spawn(bin, finalArgs, { stdio, shell: IS_WINDOWS });
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
