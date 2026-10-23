import type { TerminalPlatform, TerminalProcess, TerminalSpec } from "./terminal.ts";

/**
 * PTY z `Bun.spawn({ terminal })` (ADR-1, ADR-25): ConPTY na Windowsie, PTY z `setsid` na macOS i Linuksie.
 * Ładowany tylko pod Bun.
 */

function spawn(spec: TerminalSpec): TerminalProcess {
  let exited = false;
  const proc = Bun.spawn([...spec.command], {
    cwd: spec.cwd,
    env: spec.env,
    terminal: { cols: spec.cols, rows: spec.rows, data: (_terminal, bytes) => spec.onData(bytes) },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill("SIGKILL");
    throw new Error("Bun.spawn nie dał PTY; ta wersja Bun nie obsługuje `terminal` na tym systemie");
  }
  return {
    pid: proc.pid,
    exited: proc.exited.then((code) => {
      exited = true;
      const signal = proc.signalCode;
      return signal === null ? { code, signal: null } : { code: null, signal: String(signal) };
    }),
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    close: () => {
      if (!terminal.closed) terminal.close();
    },
    hasExited: () => exited || proc.exitCode !== null || proc.signalCode !== null,
  };
}

export const bunTerminals: TerminalPlatform = { spawn };
