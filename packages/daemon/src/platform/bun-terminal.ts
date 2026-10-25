import type { TerminalPlatform, TerminalProcess, TerminalSpec } from "./terminal.ts";

/**
 * A PTY from `Bun.spawn({ terminal })` (ADR-1, ADR-26): ConPTY on Windows, a PTY with `setsid` on macOS and Linux.
 * Loaded only under Bun.
 */

/**
 * How long to wait after the leader's end for the end of the PTY stream. On POSIX it arrives when no process holds the
 * terminal any more; ConPTY does not end the stream while the pseudoconsole is open, so there this limit closes it.
 */
const DRAIN_MS = 500;

function spawn(spec: TerminalSpec): TerminalProcess {
  let ended: () => void = () => {};
  const streamEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const proc = Bun.spawn([...spec.command], {
    cwd: spec.cwd,
    env: spec.env,
    terminal: { cols: spec.cols, rows: spec.rows, data: (_terminal, bytes) => spec.onData(bytes), exit: () => ended() },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill("SIGKILL");
    throw new Error("Bun.spawn did not provide a PTY; this Bun version does not support `terminal` on this system");
  }
  const close = () => {
    if (!terminal.closed) terminal.close();
  };
  // The terminal closes only after the leader and its output end: otherwise every session would leave an open PTY
  // (a descriptor on POSIX, a pseudoconsole with a conhost process on Windows) until the daemon exits.
  const exited = proc.exited.then(async (code) => {
    await Promise.race([streamEnded, Bun.sleep(DRAIN_MS)]);
    close();
    const signal = proc.signalCode;
    return signal === null ? { code, signal: null } : { code: null, signal: String(signal) };
  });
  return {
    pid: proc.pid,
    exited,
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    closeInput: close,
    hasExited: () => proc.exitCode !== null || proc.signalCode !== null,
    kill: () => proc.kill("SIGKILL"),
  };
}

export const bunTerminals: TerminalPlatform = { spawn };
