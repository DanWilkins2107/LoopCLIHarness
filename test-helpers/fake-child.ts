import { EventEmitter } from "node:events";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}

// A ChildProcess stand-in for the spawn mock: EventEmitters in place of the
// stdio streams, so a test drives a child by emitting on it. The no-op "error"
// listener on stdin keeps an unhandled emit from throwing for the callers that
// pipe stdin but ignore it.
export function fakeChild(): ChildProcessByStdio<Writable, Readable, Readable> {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter().on("error", () => {}), {
      write: () => true,
      end: () => {},
    }),
  }) as unknown as ChildProcessByStdio<Writable, Readable, Readable>;
}
