/**
 * Prototyp etapu 2 (§11, ADR-16): uruchamia Copilot CLI w PTY tak jak zrobi to daemon, pokazuje go w bieżącym
 * terminalu, nagrywa sesję i na bieżąco liczy stan zadania. Służy do sprawdzenia detektorów na prawdziwym
 * Windowsie i macOS oraz do zbierania nagrań, z których po anonimizacji powstają fixture'y testów. Skrypt sięga
 * do plików modułu `agents` wprost, bo moduł nie ma jeszcze miejsca w fasadzie; zmieni się to razem z PTY w `procs`.
 *
 *   bun packages/daemon/scripts/copilot-record.ts record [--out <katalog>] [--copilot <program>] [-- <argumenty copilot>]
 *   bun packages/daemon/scripts/copilot-record.ts replay <session.cast>
 *
 * `record` zapisuje w katalogu: `session.cast` (wyjście i znaczniki hooków), `states.jsonl` (zmiany stanu),
 * `hooks.jsonl` (rekordy hooków) i `plugin/` (wtyczka sesji). Na końcu drukuje listę zmian stanu.
 * `replay` liczy stan jeszcze raz z nagrania, np. po zmianie reguł. Trzecia komenda, `hook`, jest wywoływana
 * przez Copilot CLI z wtyczki sesji, nie przez człowieka.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TaskStateChange } from "@trackwall/protocol";
import { trackwallHome } from "../src/home.ts";
import { AsciicastWriter, parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { CopilotHookEvent, CopilotHookRecord, hookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { writeCopilotPlugin } from "../src/modules/agents/copilot-plugin.ts";
import { encodeMarker, replayCopilotRecording, type StatesLine } from "../src/modules/agents/copilot-recording.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";
import { jsonOf } from "../src/modules/agents/json.ts";

/** Ten sam próg na żywo i przy odtwarzaniu, żeby `replay` dawał to samo co `record`. */
const STALE_AFTER_MS = 60_000;
const HOOK_POLL_MS = 200;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const USAGE = "użycie: copilot-record.ts record [--out <katalog>] [--copilot <program>] [-- <argumenty>] | replay <session.cast>";

async function record(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, copilot: { type: "string" } },
    allowPositionals: true,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(values.out ?? join(trackwallHome(), "recordings", stamp));
  mkdirSync(out, { recursive: true });
  const hooksPath = join(out, "hooks.jsonl");
  writeFileSync(hooksPath, "");
  const pluginDir = join(out, "plugin");
  const script = fileURLToPath(import.meta.url);
  writeCopilotPlugin(pluginDir, (event) => ({
    exec: process.execPath,
    args: ["--no-env-file", script, "hook", event, hooksPath],
    cwd: pluginDir,
  }));

  // Bez terminala (przekierowane wyjście) albo w `script` rozmiar bywa 0, a PTY 0×0 rozkłada TUI.
  const size = () => ({ cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS });
  const { cols, rows } = size();
  const recording = new Recording(out, { cols, rows });
  const hooks = new HookTail(hooksPath);
  const pumpHooks = () => {
    for (const r of hooks.read()) recording.hook(r);
  };

  const decoder = new TextDecoder();
  const proc = Bun.spawn(copilotCommand(values.copilot, [...positionals, "--plugin-dir", pluginDir]), {
    terminal: { cols, rows, data: (_terminal, bytes) => recording.output(bytes, decoder.decode(bytes, { stream: true })) },
  });
  const terminal = proc.terminal;
  if (!terminal) throw new Error("Bun.spawn nie dał PTY; ta wersja Bun nie obsługuje `terminal` na tym systemie");

  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (d: Buffer) => terminal.write(d));
  process.stdout.on("resize", () => {
    const now = size();
    terminal.resize(now.cols, now.rows);
    recording.resize(now.cols, now.rows);
  });
  const timer = setInterval(() => {
    pumpHooks();
    recording.tick();
  }, HOOK_POLL_MS);

  try {
    const code = await proc.exited;
    // Hook `sessionEnd` mógł dopisać rekord tuż przed wyjściem procesu.
    pumpHooks();
    recording.exit(code);
    return code;
  } finally {
    clearInterval(timer);
    hooks.close();
    terminal.close();
    recording.close();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    printChanges(recording.changes);
    console.error(`\nNagranie i stany: ${out}`);
  }
}

function replay(argv: string[]): void {
  const file = argv[0];
  if (!file) throw new Error(USAGE);
  const cast = parseAsciicast(readFileSync(resolve(file), "utf8"));
  printChanges(replayCopilotRecording(cast, { staleAfterMs: STALE_AFTER_MS }));
}

/**
 * Wywoływane przez Copilot CLI dla każdego zdarzenia. Błąd jest połykany i nic nie trafia na stdout: hook stanu
 * nie może zatrzymać agenta ani podać mu decyzji, a zgubiony rekord to tylko gorszy stan.
 */
async function hook(argv: string[]): Promise<void> {
  try {
    const [eventArg, log] = argv;
    const event = CopilotHookEvent.safeParse(eventArg);
    if (!event.success || !log) return;
    const r = hookRecord(event.data, await Bun.stdin.text(), Date.now());
    if (r) appendFileSync(log, `${JSON.stringify(r)}\n`);
  } catch {
    // patrz komentarz funkcji
  }
}

/**
 * Pliki jednej nagrywanej sesji i stan liczony na bieżąco: wyjście trafia do terminala, nagrania i detektorów,
 * rekord hooka do nagrania jako znacznik i do detektorów, każda zmiana stanu do `states.jsonl`.
 */
class Recording {
  readonly changes: TaskStateChange[] = [];
  readonly #cast: AsciicastWriter;
  readonly #session = new CopilotSessionState({ now: Date.now, staleAfterMs: STALE_AFTER_MS });
  readonly #statesFd: number;

  constructor(out: string, size: { cols: number; rows: number }) {
    this.#cast = new AsciicastWriter(join(out, "session.cast"), { width: size.cols, height: size.rows });
    this.#statesFd = openSync(join(out, "states.jsonl"), "w");
  }

  output(bytes: Uint8Array, text: string): void {
    process.stdout.write(bytes);
    this.#cast.output(text);
    for (const change of this.#session.output(text)) this.#report(change);
  }

  hook(r: CopilotHookRecord): void {
    this.#cast.marker(encodeMarker({ kind: "hook", record: r }));
    this.#report(this.#session.hook(r));
  }

  resize(cols: number, rows: number): void {
    this.#cast.resize(cols, rows);
  }

  tick(): void {
    this.#report(this.#session.tick());
  }

  exit(code: number): void {
    this.#cast.marker(encodeMarker({ kind: "exit", code }));
    this.#report(this.#session.exit(code));
  }

  close(): void {
    this.#cast.close();
    closeSync(this.#statesFd);
  }

  #report(change: TaskStateChange | undefined): void {
    if (!change) return;
    this.changes.push(change);
    const line: StatesLine = { ...change, windowTitle: this.#session.windowTitle };
    writeSync(this.#statesFd, `${JSON.stringify(line)}\n`);
  }
}

/**
 * Program Copilot CLI z argumentami. `npm install -g` daje na Windowsie `copilot.cmd`, a uruchomienie go przez
 * `cmd.exe` psuje argumenty ze spacjami i `&` (inne reguły cytowania), więc zamiast niego idzie loader z paczki npm
 * uruchomiony przez Bun.
 */
function copilotCommand(program: string | undefined, args: string[]): string[] {
  const found = Bun.which(program ?? "copilot");
  if (!found) throw new Error(`nie znaleziono ${program ?? "copilot"} w PATH; podaj ścieżkę przez --copilot`);
  if (!/\.(cmd|bat)$/i.test(found)) return [found, ...args];
  const loader = join(dirname(found), "node_modules", "@github", "copilot", "npm-loader.js");
  if (!existsSync(loader)) throw new Error(`${found} to skrypt cmd, a obok nie ma ${loader}; podaj copilot.exe przez --copilot`);
  return [process.execPath, loader, ...args];
}

const HookLine = jsonOf(CopilotHookRecord);

/** Czyta linie dopisywane do `hooks.jsonl` przez procesy hooków, od miejsca, w którym skończył poprzednio. */
class HookTail {
  readonly #fd: number;
  readonly #buffer = Buffer.alloc(64 * 1024);
  readonly #decoder = new StringDecoder("utf8");
  #offset = 0;
  #partial = "";

  constructor(path: string) {
    this.#fd = openSync(path, "r");
  }

  read(): CopilotHookRecord[] {
    if (fstatSync(this.#fd).size === this.#offset) return [];
    let text = this.#partial;
    let n = readSync(this.#fd, this.#buffer, 0, this.#buffer.length, this.#offset);
    while (n > 0) {
      this.#offset += n;
      text += this.#decoder.write(this.#buffer.subarray(0, n));
      n = readSync(this.#fd, this.#buffer, 0, this.#buffer.length, this.#offset);
    }
    const lines = text.split("\n");
    this.#partial = lines.pop() ?? "";
    // Linia, która nie jest rekordem (np. dwa hooki dopisały się naraz), jest pomijana: to tylko gorszy stan.
    return lines.flatMap((line) => HookLine.safeParse(line).data ?? []);
  }

  close(): void {
    closeSync(this.#fd);
  }
}

function printChanges(changes: TaskStateChange[]): void {
  console.error("\nZmiany stanu (czas, stan, źródło, pewność, powód):");
  for (const c of changes) {
    console.error(`  ${c.at.slice(11, 23)}  ${c.state.padEnd(8)}  ${c.source.padEnd(7)}  ${c.confidence.padEnd(6)}  ${c.reason}`);
  }
}

// Na końcu pliku, bo klasy i stałe wyżej muszą być już zainicjowane, gdy komenda ruszy.
const [command, ...rest] = Bun.argv.slice(2);
if (command === "record") process.exit(await record(rest));
else if (command === "replay") replay(rest);
else if (command === "hook") await hook(rest);
else throw new Error(USAGE);
