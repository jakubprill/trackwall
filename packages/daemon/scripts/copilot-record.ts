/**
 * Prototyp etapu 2 (§11, ADR-16): uruchamia Copilot CLI w PTY tak jak zrobi to daemon, pokazuje go w bieżącym
 * terminalu, nagrywa sesję i na bieżąco liczy stan zadania. Służy do sprawdzenia detektorów na prawdziwym
 * Windowsie i macOS oraz do zbierania nagrań, z których po anonimizacji powstają fixture'y testów.
 *
 *   bun packages/daemon/scripts/copilot-record.ts record [--out <katalog>] [--copilot <program>] [-- <argumenty copilot>]
 *   bun packages/daemon/scripts/copilot-record.ts replay <session.cast>
 *
 * `record` zapisuje w katalogu: `session.cast` (wyjście i znaczniki hooków), `states.jsonl` (zmiany stanu),
 * `hooks.jsonl` (rekordy hooków) i `plugin/` (wtyczka sesji). Na końcu drukuje listę zmian stanu.
 * `replay` liczy stan jeszcze raz z nagrania, np. po zmianie reguł. Trzecia komenda, `hook`, jest wywoływana
 * przez Copilot CLI z wtyczki sesji, nie przez człowieka.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TaskStateChange } from "@trackwall/protocol";
import { AsciicastWriter, parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { CopilotHookEvent, CopilotHookRecord, hookRecord } from "../src/modules/agents/copilot-hooks.ts";
import { writeCopilotPlugin } from "../src/modules/agents/copilot-plugin.ts";
import { markerLabel, replayCopilotRecording } from "../src/modules/agents/copilot-recording.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";

/** Ten sam próg na żywo i przy odtwarzaniu, żeby `replay` dawał to samo co `record`. */
const STALE_AFTER_MS = 60_000;
const HOOK_POLL_MS = 200;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const USAGE = "użycie: copilot-record.ts record [--out <katalog>] [--copilot <program>] [-- <argumenty>] | replay <session.cast>";

const [command, ...rest] = Bun.argv.slice(2);
if (command === "record") process.exit(await record(rest));
else if (command === "replay") replay(rest);
else if (command === "hook") await hook(rest);
else throw new Error(USAGE);

async function record(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, copilot: { type: "string" } },
    allowPositionals: true,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(values.out ?? join(homedir(), ".trackwall", "recordings", stamp));
  mkdirSync(out, { recursive: true });
  const hooksPath = join(out, "hooks.jsonl");
  writeFileSync(hooksPath, "");
  const script = fileURLToPath(import.meta.url);
  const pluginDir = join(out, "plugin");
  writeCopilotPlugin(pluginDir, (event) => ({ exec: process.execPath, args: [script, "hook", event, hooksPath] }));

  // Bez terminala (przekierowane wyjście) albo w `script` rozmiar bywa 0, a PTY 0×0 rozkłada TUI.
  const cols = process.stdout.columns || DEFAULT_COLS;
  const rows = process.stdout.rows || DEFAULT_ROWS;
  const cast = new AsciicastWriter(join(out, "session.cast"), { width: cols, height: rows, now: Date.now });
  const session = new CopilotSessionState({ now: Date.now, staleAfterMs: STALE_AFTER_MS });
  const statesFd = openSync(join(out, "states.jsonl"), "w");
  const changes: TaskStateChange[] = [];
  const report = (change: TaskStateChange | undefined) => {
    if (!change) return;
    changes.push(change);
    writeSync(statesFd, `${JSON.stringify({ ...change, intent: session.intent })}\n`);
  };

  const hooks = new HookTail(hooksPath);
  const pumpHooks = () => {
    for (const r of hooks.read()) {
      cast.marker(markerLabel({ kind: "hook", record: r }));
      report(session.hook(r));
    }
  };

  const decoder = new TextDecoder();
  const proc = Bun.spawn(copilotCommand(values.copilot, [...positionals, "--plugin-dir", pluginDir]), {
    env: process.env,
    terminal: {
      cols,
      rows,
      data: (_terminal, bytes) => {
        process.stdout.write(bytes);
        const text = decoder.decode(bytes, { stream: true });
        cast.output(text);
        for (const change of session.output(text)) report(change);
      },
    },
  });
  const terminal = proc.terminal;
  if (!terminal) throw new Error("Bun.spawn nie dał PTY; ta wersja Bun nie obsługuje `terminal` na tym systemie");

  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (d: Buffer) => terminal.write(d));
  process.stdout.on("resize", () => {
    const c = process.stdout.columns || DEFAULT_COLS;
    const r = process.stdout.rows || DEFAULT_ROWS;
    terminal.resize(c, r);
    cast.resize(c, r);
  });
  const timer = setInterval(() => {
    pumpHooks();
    report(session.tick());
  }, HOOK_POLL_MS);

  const code = await proc.exited;
  clearInterval(timer);
  // Hook `sessionEnd` mógł dopisać rekord tuż przed wyjściem procesu.
  pumpHooks();
  cast.marker(markerLabel({ kind: "exit", code }));
  report(session.exit(code));
  cast.close();
  closeSync(statesFd);
  terminal.close();
  process.stdin.setRawMode?.(false);
  process.stdin.pause();

  printChanges(changes);
  console.error(`\nNagranie i stany: ${out}`);
  return code;
}

function replay(argv: string[]): void {
  const file = argv[0];
  if (!file) throw new Error(USAGE);
  const cast = parseAsciicast(readFileSync(resolve(file), "utf8"));
  printChanges(replayCopilotRecording(cast, { staleAfterMs: STALE_AFTER_MS }));
}

/** Wywoływane przez Copilot CLI. Nigdy nie kończy się błędem i nic nie pisze na stdout, bo to blokowałoby agenta. */
async function hook(argv: string[]): Promise<void> {
  const [eventArg, log] = argv;
  const event = CopilotHookEvent.safeParse(eventArg);
  if (!event.success || !log) return;
  const r = hookRecord(event.data, await Bun.stdin.text(), Date.now());
  if (r) appendFileSync(log, `${JSON.stringify(r)}\n`);
}

/** Na Windowsie `npm install -g` daje `copilot.cmd`, którego nie da się uruchomić bez `cmd.exe`. */
function copilotCommand(program: string | undefined, args: string[]): string[] {
  const found = Bun.which(program ?? "copilot");
  if (!found) throw new Error(`nie znaleziono ${program ?? "copilot"} w PATH; podaj ścieżkę przez --copilot`);
  return /\.(cmd|bat)$/i.test(found) ? ["cmd.exe", "/d", "/s", "/c", found, ...args] : [found, ...args];
}

/** Czyta linie dopisywane do `hooks.jsonl` przez procesy hooków, od miejsca, w którym skończył poprzednio. */
class HookTail {
  readonly #path: string;
  #offset = 0;
  #partial = "";

  constructor(path: string) {
    this.#path = path;
  }

  read(): CopilotHookRecord[] {
    const fd = openSync(this.#path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    let text = "";
    for (let n = readSync(fd, buffer, 0, buffer.length, this.#offset); n > 0; n = readSync(fd, buffer, 0, buffer.length, this.#offset)) {
      this.#offset += n;
      text += buffer.toString("utf8", 0, n);
    }
    closeSync(fd);
    const lines = (this.#partial + text).split("\n");
    this.#partial = lines.pop() ?? "";
    return lines.flatMap((line) => {
      const parsed = CopilotHookRecord.safeParse(safeJson(line));
      return parsed.success ? [parsed.data] : [];
    });
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function printChanges(changes: TaskStateChange[]): void {
  console.error("\nZmiany stanu (czas, stan, źródło, pewność, powód):");
  for (const c of changes) {
    console.error(`  ${c.at.slice(11, 23)}  ${c.state.padEnd(8)}  ${c.source.padEnd(7)}  ${c.confidence.padEnd(6)}  ${c.reason}`);
  }
}
