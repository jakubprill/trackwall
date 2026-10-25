/**
 * Stage 2 prototype (§11, ADR-17): runs Copilot CLI in a PTY the way the daemon does (ADR-26), shows it in the current
 * terminal, records the session and computes the task state live. It is for checking the detectors on real Windows
 * and macOS machines and for collecting recordings that become test fixtures after anonymisation; the daemon does not record
 * sessions. The script reaches into the `agents` module's files directly, because it runs without the daemon.
 *
 *   bun packages/daemon/scripts/copilot-record.ts record [--out <directory>] [--copilot <program>] [-- <copilot arguments>]
 *   bun packages/daemon/scripts/copilot-record.ts replay <session.cast>
 *
 * `record` writes to the directory: `session.cast` (output and markers of hooks and the kind of key), `states.jsonl` (state changes),
 * `hooks.jsonl` (hook records) and `plugin/` (the session plugin). At the end it prints the list of state changes.
 * `replay` computes the state again from a recording, e.g. after the rules change. A third command, `hook`, is called
 * by Copilot CLI from the session plugin, not by a human.
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TaskStateChange } from "@trackwall/protocol";
import { trackwallHome } from "../src/infra/home.ts";
import { AsciicastWriter, parseAsciicast } from "../src/modules/agents/asciicast.ts";
import { findCopilot } from "../src/modules/agents/copilot-command.ts";
import { runCopilotHook } from "../src/modules/agents/copilot-hook-command.ts";
import type { CopilotHookRecord } from "../src/modules/agents/copilot-hook-record.ts";
import { type SessionKey, sessionKey } from "../src/modules/agents/copilot-keys.ts";
import { writeCopilotPlugin } from "../src/modules/agents/copilot-plugin.ts";
import { encodeMarker, replayCopilotRecording, type StatesLine } from "../src/modules/agents/copilot-recording.ts";
import { CopilotSessionState } from "../src/modules/agents/copilot-session-state.ts";
import { HookTail } from "../src/modules/agents/hook-tail.ts";
import { STALE_AFTER_MS } from "../src/modules/agents/live-session.ts";

const HOOK_POLL_MS = 200;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const USAGE = "usage: copilot-record.ts record [--out <directory>] [--copilot <program>] [-- <arguments>] | replay <session.cast>";

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

  // Without a terminal (redirected output) or in `script` the size is sometimes 0, and a 0×0 PTY breaks the TUI.
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
  if (!terminal) throw new Error("Bun.spawn gave no PTY; this Bun version does not support `terminal` on this system");

  process.stdin.setRawMode?.(true);
  process.stdin.on("data", (d: Buffer) => {
    terminal.write(d);
    const key = sessionKey(d.toString("utf8"));
    if (!key) return;
    // Hooks that have already arrived go to the recording before the key, as in the daemon (`LiveSession.input`).
    pumpHooks();
    recording.key(key);
  });
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
    // The `sessionEnd` hook may have appended a record just before the process exited.
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
    console.error(`\nRecording and states: ${out}`);
  }
}

function replay(argv: string[]): void {
  const file = argv[0];
  if (!file) throw new Error(USAGE);
  const cast = parseAsciicast(readFileSync(resolve(file), "utf8"));
  printChanges(replayCopilotRecording(cast, { staleAfterMs: STALE_AFTER_MS }));
}

/** Called by Copilot CLI for every event; the same hook as in the daemon (`runCopilotHook`). */
async function hook(argv: string[]): Promise<void> {
  const [event, log] = argv;
  runCopilotHook(event, log, await Bun.stdin.text());
}

/**
 * The files of one recorded session and the state computed live: output goes to the terminal, the recording and the
 * detectors, a hook record and the kind of key (without the input content) go to the recording as a marker and to the
 * detectors, and every state change goes to `states.jsonl`.
 */
class Recording {
  readonly changes: TaskStateChange[] = [];
  readonly #cast: AsciicastWriter;
  readonly #session: CopilotSessionState;
  readonly #statesFd: number;
  /**
   * The time the session computes the state from: the time of the last written event, not the moment of computing. The
   * replay sees only event times, so otherwise a state change live and from the recording would differ by the time
   * between writing and computing.
   */
  #clock: number;

  constructor(out: string, size: { cols: number; rows: number }) {
    this.#cast = new AsciicastWriter(join(out, "session.cast"), { width: size.cols, height: size.rows });
    this.#clock = this.#cast.startedAt;
    this.#session = new CopilotSessionState({ now: () => this.#clock, staleAfterMs: STALE_AFTER_MS, promptOnStart: false });
    this.#statesFd = openSync(join(out, "states.jsonl"), "w");
  }

  output(bytes: Uint8Array, text: string): void {
    process.stdout.write(bytes);
    this.#clock = this.#cast.output(text);
    for (const change of this.#session.output(text)) this.#report(change);
  }

  hook(r: CopilotHookRecord): void {
    this.#clock = this.#cast.marker(encodeMarker({ kind: "hook", record: r }));
    for (const change of this.#session.hook(r)) this.#report(change);
  }

  key(key: SessionKey): void {
    this.#clock = this.#cast.marker(encodeMarker({ kind: "key", key }));
    for (const change of this.#session.key(key)) this.#report(change);
  }

  resize(cols: number, rows: number): void {
    this.#clock = this.#cast.resize(cols, rows);
  }

  tick(): void {
    this.#clock = this.#cast.now();
    this.#report(this.#session.tick());
  }

  exit(code: number): void {
    this.#clock = this.#cast.marker(encodeMarker({ kind: "exit", code }));
    for (const change of this.#session.exit(code)) this.#report(change);
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

/** The Copilot CLI program with arguments; the same rule as in the daemon (`findCopilot`). */
function copilotCommand(program: string | undefined, args: string[]): string[] {
  const found = findCopilot(program ?? "copilot", process.env);
  if (!found)
    throw new Error(`${program ?? "copilot"} not found in PATH (on Windows also copilot.exe next to copilot.cmd); give it with --copilot`);
  return [found, ...args];
}

function printChanges(changes: TaskStateChange[]): void {
  console.error("\nState changes (time, state, source, confidence, reason):");
  for (const c of changes) {
    console.error(`  ${c.at.slice(11, 23)}  ${c.state.padEnd(8)}  ${c.source.padEnd(8)}  ${c.confidence.padEnd(6)}  ${c.reason}`);
  }
}

// At the end of the file, because the classes and constants above must already be initialised when the command starts.
const [command, ...rest] = Bun.argv.slice(2);
if (command === "record") process.exit(await record(rest));
else if (command === "replay") replay(rest);
else if (command === "hook") await hook(rest);
else throw new Error(USAGE);
