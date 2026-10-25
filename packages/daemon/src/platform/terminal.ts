import type { GroupLeader } from "./process-group.ts";
import { runtimeInfo } from "./runtime.ts";

/**
 * A PTY (§4.4, ADR-26): a process in a pseudoterminal owned by the daemon, from which the terminal window in the UI gets the screen
 * and to which it sends keys. On Windows it is ConPTY, on macOS and Linux an ordinary PTY in which the process is the leader
 * of a new POSIX session, so its PID is also the process group identifier (§4.1). `Bun.spawn({ terminal })` provides it
 * (the stage 1 spike, ADR-1); Node has no PTY without a native addon, so there are no agent sessions under Node.
 */

export interface TerminalSpec {
  /** The program (full path) and arguments, without a shell. */
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  /** Terminal output in chunks, as it came; UTF-8 may be split between chunks. */
  onData: (bytes: Uint8Array) => void;
}

interface TerminalExit {
  code: number | null;
  signal: string | null;
}

/**
 * A process in a PTY is a group leader (`GroupLeader`): `closeInput` closes the terminal, and on Windows ConPTY then sends
 * `CTRL_CLOSE_EVENT` to the console processes, so it is a gentle request to end, like closing a terminal window.
 */
export interface TerminalProcess extends GroupLeader {
  /** The leader's end, once all its output has reached `onData` and the terminal is closed. */
  exited: Promise<TerminalExit>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Kills only the leader (SIGKILL) when the platform did not accept it into a group. */
  kill(): void;
}

export interface TerminalPlatform {
  /** Throws the `spawn` error (with `code`, e.g. `ENOENT`) when the program did not start. */
  spawn(spec: TerminalSpec): TerminalProcess;
}

let platform: Promise<TerminalPlatform | null> | undefined;

/** The PTY of the current runtime, or `null` under Node; loaded once. */
export function terminalPlatform(): Promise<TerminalPlatform | null> {
  platform ??= runtimeInfo().name === "bun" ? import("./bun-terminal.ts").then((m) => m.bunTerminals) : Promise.resolve(null);
  return platform;
}
