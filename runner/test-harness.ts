import { EventEmitter } from "node:events";
import { expect, vi, type Mock } from "vitest";
import type { PipedChild } from "./session";

export interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}

// A ChildProcess stand-in for the spawn mock: EventEmitters in place of the
// three stdio streams, so a test drives a child by emitting on it. Typed as a
// fully piped child — fds the caller ignored are simply never listened to.
export function fakeChild(): PipedChild {
  const child = new EventEmitter();
  return Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    // The no-op "error" listener keeps an unhandled emit from throwing on the
    // spawns whose caller ignores stdin.
    stdin: Object.assign(
      new EventEmitter().on("error", () => {}),
      {
        write: () => true,
        end: () => {},
      },
    ),
  }) as unknown as PipedChild;
}

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
  const spawns: [string, string[]][] = [];
  const impl = (bin: string, args: string[]) => {
    spawns.push([bin, args]);
    const child = fakeChild();
    // Callers supply exactly one script per expected spawn; an unscripted spawn
    // is a bug in the test, and blows up here rather than passing silently.
    const s = remaining.shift() as Script;
    setImmediate(() => {
      child.stdin.emit("error", new Error("EPIPE"));
      if (s.error) return void child.emit("error", new Error(s.error));
      if (s.stdout) child.stdout.emit("data", s.stdout);
      if (s.stderr) child.stderr.emit("data", s.stderr);
      child.emit("close", s.code ?? 0);
    });
    return child;
  };
  return { spawns, impl };
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
  const { spawns, impl } = scriptedSpawn(opts.scripts ?? []);
  spawnMock.mockImplementation(impl);

  vi.resetModules();
  await load();
  await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));

  return {
    code: exits[0],
    stderr: err.join(""),
    spawns,
    result: JSON.parse(out[0]),
  };
}
