import { expect, vi, type Mock } from "vitest";
import type { SpawnOptions } from "node:child_process";
import { fakeChild, type Script } from "../test-helpers/fake-child";

// process.exit never returns, so the stub throws to unwind main the way the real
// thing does. The module's top-level .catch then exits once more on its way out —
// that second exit must return, or the throw escapes as an unhandled rejection.
// `unwind: false` is for the tests where main throws on its own.
class ExitSignal extends Error {}

export function captureProcess(unwind: boolean) {
  const exits: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code = 0) => {
    exits.push(code);
    if (unwind && exits.length === 1) throw new ExitSignal();
  }) as never);
  return { exits, out, err };
}

// One scripted child per spawn, in call order: each script says what the child
// emits before it closes.
export function scriptedSpawn(scripts: Script[]) {
  const remaining = [...scripts];
  const spawns: [string, string[], SpawnOptions][] = [];
  const stdins: string[] = [];
  const impl = (bin: string, args: string[], opts: SpawnOptions) => {
    const index = spawns.push([bin, args, opts]) - 1;
    stdins[index] = "";
    const child = fakeChild();
    child.stdin.write = ((chunk: unknown) => {
      stdins[index] += String(chunk);
      return true;
    }) as typeof child.stdin.write;
    // fake-child pre-attaches a no-op stdin "error" listener, which would mask
    // a missing guard in the module under test. Drop it so the module's own
    // listener is the only thing keeping the EPIPE below from throwing.
    child.stdin.removeAllListeners("error");
    const pipesStdin = Array.isArray(opts.stdio) && opts.stdio[0] === "pipe";
    // Callers supply exactly one script per expected spawn; an unscripted spawn
    // is a bug in the test, and blows up here rather than passing silently.
    const s = remaining.shift() as Script;
    setImmediate(() => {
      if (pipesStdin) child.stdin.emit("error", new Error("EPIPE"));
      if (s.error) return void child.emit("error", new Error(s.error));
      if (s.stdout) child.stdout.emit("data", s.stdout);
      if (s.stderr) child.stderr.emit("data", s.stderr);
      child.emit("close", s.code ?? 0);
    });
    return child;
  };
  return { spawns, stdins, impl };
}

export interface DriveOptions {
  scripts?: Script[];
  unwind?: boolean;
}

// Run an entry module end to end. The module calls main() at import time, so it
// has to be re-imported per test — hence `load` and the module reset. Caller
// sets process.argv and any module-specific mocks first.
export async function driveEntry(
  load: () => Promise<unknown>,
  spawnMock: Mock,
  opts: DriveOptions,
) {
  const { exits, out, err } = captureProcess(opts.unwind ?? true);
  const { spawns, stdins, impl } = scriptedSpawn(opts.scripts ?? []);
  spawnMock.mockImplementation(impl);

  vi.resetModules();
  await load();
  await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));

  return {
    code: exits[0],
    stderr: err.join(""),
    spawns,
    stdins,
    result: JSON.parse(out[0]),
  };
}
