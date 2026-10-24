import type { TerminalPlatform, TerminalProcess, TerminalSpec } from "./terminal.ts";

/**
 * PTY z `Bun.spawn({ terminal })` (ADR-1, ADR-26): ConPTY na Windowsie, PTY z `setsid` na macOS i Linuksie.
 * Ładowany tylko pod Bun.
 */

/**
 * Ile po końcu lidera czekać na koniec strumienia PTY. Na POSIX przychodzi, gdy żaden proces nie trzyma już
 * terminala; ConPTY nie kończy strumienia, dopóki pseudokonsola jest otwarta, więc tam zamyka ją ten limit.
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
  // Terminal zamyka się dopiero po końcu lidera i jego wyjścia: inaczej każda sesja zostawiałaby otwarty PTY
  // (deskryptor na POSIX, pseudokonsolę z procesem conhost na Windowsie) do wyjścia daemona.
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
