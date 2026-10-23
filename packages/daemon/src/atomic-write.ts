import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Zapis pliku przez plik tymczasowy i `rename`: czytający widzi starą albo nową treść, nigdy uciętą.
 * Na Windowsie `rename` na plik chwilowo otwarty przez antywirusa, indekser albo edytor kończy się EPERM/EBUSY,
 * więc jest ponawiany; po porażce plik tymczasowy jest sprzątany.
 */

const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 40;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/** `mode` ustawia uprawnienia tam, gdzie system je ma (nie na Windowsie). */
export function writeFileAtomic(target: string, text: string, mode?: number): void {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  try {
    if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
    renameWithRetry(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || attempt >= RENAME_ATTEMPTS) throw err;
      // Krótkie czekanie synchroniczne: zapis jest rzadki, a wywołujący nie są asynchroniczni.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS * attempt);
    }
  }
}
