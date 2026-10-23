/**
 * Spike: PTY pod Bun. Jeden przebieg = jeden backend, w osobnym procesie, bo natywny addon może zabić proces.
 *
 *   spike.ts <backend>    backend ∈ node-pty | bun-pty | bun-terminal
 *
 * Scenariusz jak w zadaniu agenta: interaktywna powłoka w PTY, wpisanie komendy, odczyt wyniku, zmiana rozmiaru,
 * wyjście z kodem. Wynik to jedna linia JSON na stdout. Plik ma tylko składnię usuwalną przez Node
 * (type stripping), żeby ten sam kod dało się uruchomić `node src/spike.ts node-pty` jako punkt odniesienia.
 */

interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface Result {
  backend: string;
  runtime: string;
  compiled: boolean;
  platform: string;
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string; ms?: number }[];
}

const backend = process.argv[2] ?? "node-pty";
const isWin = process.platform === "win32";
const bunVersion = (process.versions as Record<string, string | undefined>).bun;
const result: Result = {
  backend,
  runtime: bunVersion ? `bun ${bunVersion}` : `node ${process.versions.node}`,
  compiled: import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN"),
  platform: `${process.platform}-${process.arch}`,
  ok: false,
  steps: [],
};
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const step = (name: string, ok: boolean, detail?: string) => result.steps.push({ step: name, ok, detail, ms: ms() });

// Komenda liczy wynik, więc echo samego wejścia (40+2) nie da fałszywego trafienia (42).
const shell = isWin ? "cmd.exe" : "/bin/sh";
const compute = isWin ? "set /a 40+2\r" : "echo $((40+2))\r";
const exitCmd = "exit 7\r";

let output = "";
let exitCode: number | undefined;
let exited: () => void = () => {};
const exitPromise = new Promise<void>((r) => {
  exited = r;
});
const onData = (d: string) => {
  output += d;
};
const onExit = (code: number) => {
  exitCode = code;
  exited();
};

function finish(): never {
  result.ok = result.steps.every((s) => s.ok);
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
  process.exit(0);
}

const watchdog = setTimeout(() => {
  step("timeout", false, `brak zakończenia po 20 s; wyjście: ${JSON.stringify(output.slice(-300))}`);
  finish();
}, 20_000);

let pty: Pty;
try {
  pty = await open(backend);
  step("spawn", true, shell);
} catch (err) {
  step("spawn", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  finish();
}

await sleep(800);
pty.write(compute);
const sawOutput = await waitFor(() => /(^|[^0-9+])42([^0-9]|$)/m.test(output.replace(/40\+2/g, "")), 5000);
step("odczyt wyniku komendy", sawOutput, sawOutput ? undefined : JSON.stringify(output.slice(-300)));

try {
  pty.resize(120, 40);
  step("resize", true);
} catch (err) {
  step("resize", false, String(err));
}

pty.write(exitCmd);
await Promise.race([exitPromise, sleep(8000)]);
clearTimeout(watchdog);
step("kod wyjścia", exitCode === 7, `exitCode=${exitCode}`);
step("bajty wyjścia", output.length > 0, `${output.length} znaków`);
finish();

async function open(name: string): Promise<Pty> {
  const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
  const opts = { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env };
  if (name === "node-pty") {
    const mod = await import("node-pty");
    const p = mod.spawn(shell, [], { ...opts, useConpty: true });
    p.onData(onData);
    p.onExit((e) => onExit(e.exitCode));
    return p;
  }
  if (name === "bun-pty") {
    const mod = await import("bun-pty");
    const p = mod.spawn(shell, [], opts);
    p.onData(onData);
    p.onExit((e) => onExit(e.exitCode));
    return p;
  }
  if (name === "bun-terminal") {
    const B = (globalThis as { Bun?: typeof Bun }).Bun;
    if (!B) throw new Error("to nie jest Bun");
    const decoder = new TextDecoder();
    const proc = B.spawn([shell], {
      cwd: opts.cwd,
      env,
      terminal: { cols: 80, rows: 24, data: (_t: unknown, d: Uint8Array) => onData(decoder.decode(d, { stream: true })) },
    } as Parameters<typeof Bun.spawn>[1]);
    const terminal = (proc as unknown as { terminal?: { write(d: string): void; resize(c: number, r: number): void } }).terminal;
    if (!terminal) throw new Error("Bun.spawn nie zwrócił terminala (brak wsparcia na tej platformie?)");
    void proc.exited.then((code) => onExit(code));
    return { write: (d) => terminal.write(d), resize: (c, r) => terminal.resize(c, r), kill: () => proc.kill() };
  }
  throw new Error(`nieznany backend ${name}`);
}

function sleep(n: number): Promise<void> {
  return new Promise((r) => setTimeout(r, n));
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}
