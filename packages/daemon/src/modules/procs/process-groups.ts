import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RunState } from "@trackwall/protocol";
import { DomainError, SpawnFailure, spawnFailure } from "../../errors.ts";
import { type GroupControl, type GroupLeader, type GroupPlatform, waitUntil } from "../../platform/process-group.ts";
import type { TerminalPlatform, TerminalProcess } from "../../platform/terminal.ts";
import { OutputTail } from "./output-tail.ts";
import type { RuntimeFile, RuntimeGroup } from "./runtime-file.ts";

/**
 * Moduł `procs` (§4.1, ADR-20): każdy proces startuje jako grupa procesów i jako grupa się kończy. Stan jest
 * obserwowany: uruchomienie jest `exited` dopiero wtedy, gdy system potwierdził, że żaden proces grupy nie żyje.
 * Lider, który zakończył się sam, zabiera ze sobą resztę grupy, więc nic nie zostaje w tle bez nadzoru.
 *
 * Właściciel (`owner`) to klucz wołającego, np. task mise w repo; na właściciela przypada jedna żywa grupa,
 * a po jej końcu zostaje ostatni stan, do następnego startu.
 */

/**
 * Ile czekać na koniec grupy po zabiciu; dłużej znaczy proces, którego system nie umie zakończyć. Czas łaski
 * (5 s na POSIX) plus ten limit mieszczą się w 10 s, które powłoka Tauri czeka na zatrzymanie daemona (§5.4).
 */
const KILL_WAIT_MS = 3000;

export interface GroupSpec {
  owner: string;
  /** Program i argumenty, bez powłoki. */
  command: readonly string[];
  /** Pełna ścieżka istniejącego katalogu: korzeń repo albo worktree, sprawdzony przez wołającego. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Grupa z liderem w PTY: rozmiar terminala i odbiorca jego wyjścia. */
export interface TerminalGroupSpec extends GroupSpec {
  cols: number;
  rows: number;
  onData: (bytes: Uint8Array) => void;
}

/** Terminal lidera grupy: wejście z klawiatury i rozmiar okna. */
export interface GroupTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface ProcessGroupsDeps {
  runtime: RuntimeFile;
  platform: Promise<GroupPlatform>;
  /** PTY dla `startTerminal`; `null` albo brak, gdy runtime go nie ma (Node) albo wołający go nie używa. */
  terminals?: Promise<TerminalPlatform | null>;
  log: (msg: string) => void;
}

interface Exit {
  code: number | null;
  signal: string | null;
  at: string;
}

/**
 * `live`: lider żyje. `draining`: lider skończył, ale część grupy jeszcze żyje (zabijanie trwa albo się nie udało).
 * `exited`: system potwierdził, że grupa jest pusta; tylko ta faza zwalnia właściciela dla nowego startu.
 */
type Phase = { kind: "live" } | { kind: "draining"; exit: Exit } | { kind: "exited"; exit: Exit };

interface Group {
  readonly record: RuntimeGroup;
  readonly control: GroupControl;
  readonly tail: OutputTail;
  readonly leaderExit: Promise<Exit>;
  phase: Phase;
  /**
   * Stop zlecił użytkownik albo wyjście daemona, zanim lider skończył się sam; zostaje w stanie `exited` jako
   * `stoppedByUser`. Stop po końcu lidera nie zmienia wyniku: liczy się kod wyjścia lidera.
   */
  stopRequested: boolean;
  stopping?: Promise<RunState>;
  /** Zabijanie reszty grupy po końcu lidera; stop w tym czasie czeka na nie zamiast zabijać drugi raz. */
  draining?: Promise<boolean>;
  /** Spełniana w `finish`, czyli po potwierdzeniu pustej grupy; grupa, której nie da się zabić, nie kończy się nigdy. */
  readonly ended: { promise: Promise<void>; resolve: () => void };
}

export class ProcessGroups {
  private readonly deps: ProcessGroupsDeps;
  private readonly groups = new Map<string, Group>();
  private readonly starting = new Map<string, Promise<RunState>>();
  /** Sieroty, których sprzątanie przy starcie się nie udało: zostają w `runtime.json` do następnego startu. */
  private orphans: RuntimeGroup[] = [];
  /** Daemon się zatrzymuje: nowe grupy powstałyby już po `stopAll` i przeżyłyby daemon. */
  private closing = false;

  constructor(deps: ProcessGroupsDeps) {
    this.deps = deps;
  }

  /** Uruchamia grupę; gdy właściciel ma już grupę, która nie skończyła się na pewno, zwraca jej stan zamiast drugiej. */
  start(spec: GroupSpec): Promise<RunState> {
    if (this.closing) return Promise.reject(new SpawnFailure("spawn_failed", "daemon się zatrzymuje"));
    const current = this.groups.get(spec.owner);
    if (current && current.phase.kind !== "exited") return Promise.resolve(stateOf(current));
    let started = this.starting.get(spec.owner);
    if (!started) {
      started = this.spawnGroup(spec, (cwd, platform) => launchPiped(spec, cwd, platform.detached))
        .then(({ group }) => stateOf(group))
        .finally(() => this.starting.delete(spec.owner));
      this.starting.set(spec.owner, started);
    }
    return started;
  }

  /**
   * Uruchamia grupę, której lider działa w PTY (§4.4, ADR-26), i zwraca terminal do pisania i zmiany rozmiaru.
   * Właściciel musi być nowy: sesja w terminalu nie ma „drugiego startu”, który oddałby istniejącą.
   */
  async startTerminal(spec: TerminalGroupSpec): Promise<{ run: RunState; terminal: GroupTerminal }> {
    if (this.closing) throw new SpawnFailure("spawn_failed", "daemon się zatrzymuje");
    if (this.groups.has(spec.owner) || this.starting.has(spec.owner)) throw new Error(`właściciel ${spec.owner} ma już grupę`);
    const terminals = await this.deps.terminals;
    if (!terminals) throw new SpawnFailure("terminal_unavailable", "ten runtime daemona nie ma PTY (daemon pod Node)");
    const started = this.spawnGroup(spec, async (cwd) => launchTerminal(terminals, spec, cwd));
    const run = started.then(({ group }) => stateOf(group));
    // Błąd startu odbiera wołający przez `started`; `starting` służy tylko innym do czekania na koniec startu.
    run.catch(() => {});
    this.starting.set(spec.owner, run);
    try {
      const { group, launched } = await started;
      return { run: stateOf(group), terminal: launched.leader };
    } finally {
      this.starting.delete(spec.owner);
    }
  }

  state(owner: string): RunState | undefined {
    const group = this.groups.get(owner);
    return group && stateOf(group);
  }

  /**
   * Stan `exited` bieżącej grupy właściciela, gdy system potwierdzi jej koniec; `undefined`, gdy właściciel nie ma
   * grupy. Dla wołającego, który czeka na wynik (komenda zbiorcza), a nie tylko pokazuje stan.
   */
  async ended(owner: string): Promise<RunState | undefined> {
    await this.starting.get(owner)?.catch(() => undefined);
    const group = this.groups.get(owner);
    if (!group) return undefined;
    await group.ended.promise;
    return stateOf(group);
  }

  /**
   * Łagodny stop, po czasie łaski zabicie całej grupy. Wraca dopiero po potwierdzeniu, że grupa nie żyje;
   * inaczej `stop_unconfirmed`, a uruchomienie zostaje `stopping`, więc stop można ponowić.
   */
  async stop(owner: string): Promise<RunState | undefined> {
    // Start w toku (np. czekanie na `ps`) jeszcze nie ma grupy w mapie; stop czeka na niego zamiast zgłosić brak.
    // Nieudany start nie zostawia grupy, więc stop kończy się jak dla właściciela bez grupy.
    await this.starting.get(owner)?.catch(() => undefined);
    const group = this.groups.get(owner);
    if (!group) return undefined;
    if (group.phase.kind === "exited") return stateOf(group);
    group.stopping ??= this.stopGroup(group).finally(() => {
      group.stopping = undefined;
    });
    return group.stopping;
  }

  /** Wyjście daemona: zatrzymuje wszystkie żywe grupy równolegle; grupy, których nie udało się zatrzymać, zgłasza w logu. */
  async stopAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.starting.values());
    const live = [...this.groups.entries()].filter(([, g]) => g.phase.kind !== "exited");
    const results = await Promise.allSettled(live.map(([owner]) => this.stop(owner)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.deps.log(`nie zatrzymano ${live[i]?.[0]}: ${String(r.reason)}`);
    });
  }

  /**
   * Start daemona: grupy z `runtime.json` zostały po poprzednim działaniu (awaria, twarde zabicie). Sprzątana jest
   * tylko grupa, która na pewno jest nasza (§4.1, `GroupPlatform.reattach`), tym samym stopem co żywe grupy.
   */
  async sweepOrphans(): Promise<void> {
    const platform = await this.deps.platform;
    const left: RuntimeGroup[] = [];
    for (const orphan of this.readRuntime()) {
      const what = `${orphan.owner} (pid ${orphan.pid}, ${orphan.command.join(" ")})`;
      const target = await platform.reattach(orphan.pid, orphan.identity);
      if (target === "unverified")
        this.deps.log(`pid ${orphan.pid} żyje, ale nie wiadomo, czy to sierota ${what}; zostawiono i usunięto z runtime.json`);
      if (typeof target === "string") continue;
      if (await terminate(target, platform.graceMs)) {
        target.release();
        this.deps.log(`sprzątnięto sierotę ${what}`);
      } else {
        this.deps.log(`sierota ${what} przeżyła zabicie; spróbuję przy następnym starcie`);
        left.push(orphan);
      }
    }
    this.orphans = left;
    this.persist();
  }

  private async spawnGroup<L extends Launched>(
    spec: GroupSpec,
    launch: (cwd: string, platform: GroupPlatform) => Promise<L>,
  ): Promise<{ group: Group; launched: L }> {
    await requireDirectory(spec.cwd);
    const platform = await this.deps.platform;
    const launched = await launch(spec.cwd, platform);
    const { leader, leaderExit, tail } = launched;
    let control: GroupControl;
    try {
      control = platform.adopt(leader);
    } catch (err) {
      leader.kill();
      throw err;
    }
    const record: RuntimeGroup = {
      runId: randomUUID(),
      owner: spec.owner,
      command: [...spec.command],
      cwd: spec.cwd,
      startedAt: new Date().toISOString(),
      pid: leader.pid,
      identity: await platform.identity(leader.pid),
    };
    const group: Group = { record, control, tail, leaderExit, phase: { kind: "live" }, stopRequested: false, ended: deferred() };
    this.groups.set(spec.owner, group);
    this.persist();
    leaderExit
      .then((exit) => this.onLeaderExit(group, exit))
      .catch((err: unknown) => this.deps.log(`koniec grupy ${spec.owner}: ${String(err)}`));
    return { group, launched };
  }

  /** Lider skończył sam albo po stopie: reszta grupy jest zabijana, a uruchomienie kończy się dopiero przy pustej grupie. */
  private async onLeaderExit(group: Group, exit: Exit): Promise<void> {
    group.phase = { kind: "draining", exit };
    if (group.stopping) return; // stop sam potwierdzi koniec
    group.draining = (group.control.isEmpty() ? Promise.resolve(true) : killAndWait(group.control)).finally(() => {
      group.draining = undefined;
    });
    if (await group.draining) this.finish(group);
    else this.deps.log(`grupa ${group.record.owner} (pid ${group.record.pid}) żyje po zabiciu; zostaje w runtime.json`);
  }

  private async stopGroup(group: Group): Promise<RunState> {
    // Lider, który skończył sam, nie został zatrzymany przez użytkownika: jego kod wyjścia jest wynikiem.
    if (group.phase.kind === "live") group.stopRequested = true;
    const platform = await this.deps.platform;
    const empty = group.draining ? await group.draining : await terminate(group.control, platform.graceMs);
    if (!empty) {
      throw new DomainError(
        "stop_unconfirmed",
        `${group.record.command.join(" ")} (pid ${group.record.pid}): część procesów grupy nadal działa po zabiciu`,
      );
    }
    // Pusta grupa znaczy, że lider nie żyje; zdarzenie `exit` przychodzi najpóźniej chwilę później.
    if (group.phase.kind === "live") group.phase = { kind: "draining", exit: await group.leaderExit };
    this.finish(group);
    return stateOf(group);
  }

  /** Grupa potwierdzona jako pusta: koniec uruchomienia i zniknięcie z `runtime.json`. */
  private finish(group: Group): void {
    if (group.phase.kind !== "draining") return;
    group.phase = { kind: "exited", exit: group.phase.exit };
    group.control.release();
    this.persist();
    group.ended.resolve();
  }

  /**
   * Jedyny zapis `runtime.json`: sieroty, których nie udało się sprzątnąć, i grupy bez potwierdzonego końca.
   * Nieudany zapis (np. plik trzymany przez antywirusa) nie zmienia stanu w pamięci; następny zapis go nadrobi.
   */
  private persist(): void {
    const live = [...this.groups.values()].filter((g) => g.phase.kind !== "exited").map((g) => g.record);
    try {
      this.deps.runtime.write([...this.orphans, ...live]);
    } catch (err) {
      this.deps.log(`zapis ${this.deps.runtime.path}: ${String(err)}`);
    }
  }

  /** Plik, którego nie da się odczytać, jest odkładany obok, żeby następny zapis nie skasował zapisanych w nim grup. */
  private readRuntime(): RuntimeGroup[] {
    try {
      return this.deps.runtime.read();
    } catch (err) {
      const aside = this.deps.runtime.moveAside();
      this.deps.log(`${String(err)}; plik odłożony jako ${aside}, sieroty z niego nie zostaną sprzątnięte`);
      return [];
    }
  }
}

/** Uruchomiony lider, zanim stanie się grupą: wyjście i koniec są już podłączone. */
interface Launched {
  leader: GroupLeader & { kill(): void };
  leaderExit: Promise<Exit>;
  tail: OutputTail;
}

/** Lider z rurami (stdin, stdout, stderr), jak task mise. */
async function launchPiped(spec: GroupSpec, cwd: string, detached: boolean): Promise<Launched> {
  const [program, ...args] = spec.command;
  if (program === undefined) throw new Error("pusta komenda");
  const child = spawn(program, args, { cwd, env: spec.env, detached, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // Wyjście i koniec procesu są podłączone od razu: krótki task może skończyć się, zanim padnie pierwszy `await`.
  const tail = new OutputTail();
  attachOutput(child, tail);
  const leaderExit = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, at: new Date().toISOString() }));
  });
  await spawned(child, program);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`${program} nie dostał PID-u`);
  const leader = {
    pid,
    closeInput: () => void child.stdin?.end(),
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    kill: () => void child.kill("SIGKILL"),
  };
  return { leader, leaderExit, tail };
}

/** Lider w PTY jest zarazem terminalem; jego wyjście idzie do wołającego i do ostatnich linii stanu `exited`. */
function launchTerminal(terminals: TerminalPlatform, spec: TerminalGroupSpec, cwd: string): Launched & { leader: TerminalProcess } {
  const [program] = spec.command;
  if (program === undefined) throw new Error("pusta komenda");
  const tail = new OutputTail();
  let leader: TerminalProcess;
  try {
    leader = terminals.spawn({
      command: spec.command,
      cwd,
      env: spec.env,
      cols: spec.cols,
      rows: spec.rows,
      onData: (bytes) => {
        tail.push("stdout", Buffer.from(bytes));
        spec.onData(bytes);
      },
    });
  } catch (err) {
    throw spawnFailure(program, err as NodeJS.ErrnoException);
  }
  const leaderExit = leader.exited.then((exit) => ({ ...exit, at: new Date().toISOString() }));
  return { leader, leaderExit, tail };
}

/**
 * stdout i stderr są czytane zawsze, bo nieczytana rura blokuje proces po kilkudziesięciu KB (§4.1).
 * Tu podłączy się moduł `logs`; na razie zostają ostatnie linie dla stanu `exited`.
 */
function attachOutput(child: ChildProcess, tail: OutputTail): void {
  child.stdout?.on("data", (chunk: Buffer) => tail.push("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => tail.push("stderr", chunk));
  // Proces, który nie czyta stdin, może go zamknąć; EPIPE przy łagodnym stopie nie jest błędem.
  child.stdin?.on("error", () => {});
  // Błąd po starcie (np. nieudany `kill`) bez słuchacza zakończyłby daemon; stan i tak wynika z `exit`.
  child.on("error", () => {});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stateOf(group: Group): RunState {
  const { runId, startedAt, pid } = group.record;
  const { phase } = group;
  if (phase.kind === "live") return { kind: group.stopRequested ? "stopping" : "running", runId, startedAt, pid };
  if (phase.kind === "draining") return { kind: "stopping", runId, startedAt, pid };
  return {
    kind: "exited",
    runId,
    startedAt,
    endedAt: phase.exit.at,
    exitCode: phase.exit.code,
    signal: phase.exit.signal,
    stoppedByUser: group.stopRequested,
    lastLines: group.tail.snapshot(),
  };
}

/** Jedna droga zatrzymania dla żywych grup i sierot: łagodnie, po czasie łaski zabicie, potem czekanie na pustą grupę. */
async function terminate(control: GroupControl, graceMs: number): Promise<boolean> {
  control.askToStop();
  return (await waitUntil(() => control.isEmpty(), graceMs)) || killAndWait(control);
}

async function killAndWait(control: GroupControl): Promise<boolean> {
  control.kill();
  return waitUntil(() => control.isEmpty(), KILL_WAIT_MS);
}

async function requireDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new SpawnFailure("cwd_invalid", `katalog roboczy musi być pełną ścieżką: ${cwd}`);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new SpawnFailure("cwd_invalid", `katalog roboczy nie istnieje: ${cwd}`);
}

/** Czeka na `spawn` albo `error`: dopiero wtedy wiadomo, czy program w ogóle wystartował. */
function spawned(child: ChildProcess, program: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: NodeJS.ErrnoException) => reject(spawnFailure(program, err)));
  });
}
