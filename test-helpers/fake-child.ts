import { EventEmitter } from "node:events";

export interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}

export interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

// A ChildProcess stand-in for the spawn mock: EventEmitters in place of the
// stdio streams, so a test drives a child by emitting on it. stdin is left to
// the caller — only the runner spawns with it piped.
export function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}
