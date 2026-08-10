import { EventEmitter } from "node:events";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}

// A ChildProcess stand-in for the spawn mock: EventEmitters in place of the
// stdio streams, so a test drives a child by emitting on it. Typed as the
// stdio: ["ignore", "pipe", "pipe"] child both packages' code spawns; the runner
// wraps this to add the stdin it also pipes.
export function fakeChild(): ChildProcessByStdio<null, Readable, Readable> {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
}
