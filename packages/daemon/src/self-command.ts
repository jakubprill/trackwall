import { resolve } from "node:path";
import { isCompiledBinary, runtimeInfo } from "./platform/runtime.ts";

/**
 * Komenda, która uruchamia ten sam daemon z podkomendą (np. hook wtyczki sesji), do podania innemu programowi.
 * Binarka z wydania to sama ścieżka binarki; uruchomienie ze źródeł dokłada runtime i skrypt. Bun dostaje
 * `--no-env-file`, bo inaczej wczytałby `.env` z katalogu, w którym uruchomi go tamten program; Node dostaje flagi
 * daemona, bo bez nich nie uruchomi TypeScriptu.
 */
export function selfCommand(args: readonly string[]): string[] {
  const script = process.argv[1];
  const runtimeArgs = runtimeInfo().name === "node" ? process.execArgv : ["--no-env-file"];
  const fromSource = !isCompiledBinary() && script !== undefined ? [...runtimeArgs, resolve(script)] : [];
  return [process.execPath, ...fromSource, ...args];
}
