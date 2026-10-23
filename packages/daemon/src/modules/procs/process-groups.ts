import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RunState } from "@trackwall/protocol";
import { DomainError } from "../../errors.ts";
import { type GroupControl, type GroupPlatform, waitUntil } from "../../platform/process-group.ts";
import { OutputTail } from "./output-tail.ts";
import type { RuntimeFile, RuntimeGroup } from "./runtime-file.ts";

/**
 * Moduł `procs` (§4.1, ADR-20): każdy proces startuje jako grupa procesów i jako grupa się kończy. Stan jest
 * obserwowany: uruchomienie jest `exited` dopiero wtedy, gdy system potwierdził, że żaden proces grupy nie żyje.
 * Lider, który zakończył się sam, zabiera ze sobą resztę grupy, więc nic nie zostaje w tle bez nadzoru.
 *
 * Właściciel (`owner`) to klucz wołającego, np. task mise w repo; na właściciela przypada jedno żywe uruchomienie,
 * a po jego końcu zostaje ostatni stan, do następnego startu.
 */

/** Ile czekać na koniec grupy po zabiciu; dłużej znaczy proces, którego system nie umie zakończyć. */
const KILL_WAIT_MS = 5000;

export interface GroupSpec {
  owner: string;
  /** Program i argumenty, bez powłoki. */
  command: readonly string[];
  /** Pełna ścieżka istniejącego katalogu: korzeń repo albo worktree, sprawdzony przez wołającego. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessGroupsDeps {
  runtime: RuntimeFile;
  platform: Promise<GroupPlatform>;
  log: (msg: string) => void;
}

interface Exit {
  code: number | null;
  signal: string | null;
  at: string;
}

interface Group {
  readonly record: RuntimeGroup;
  readonly child: ChildProcess;
  readonly control: GroupControl;
  readonly tail: OutputTail;
  /** Spełniona po końcu lidera i sprzątnięciu grupy; `true`, gdy grupa na pewno nie żyje. */
  readonly finished: Promise<boolean>;
  exit?: Exit;
  /** System potwierdził, że żaden proces grupy nie żyje; dopiero wtedy grupa znika z `runtime.json`. */
  confirmedEmpty: boolean;
  stopRequested: boolean;
  stopping?: Promise<RunState>;
}

export class ProcessGroups {
  private readonly deps: ProcessGroupsDeps;
  private readonly groups = new Map<string, Group>();
  private readonly starting = new Map<string, Promise<RunState>>();

  constructor(deps: ProcessGroupsDeps) {
    this.deps = deps;
  }

  /** Uruchamia grupę; gdy właściciel ma już żywą, zwraca jej stan zamiast drugiej. */
  start(spec: GroupSpec): Promise<RunState> {
    const live = this.groups.get(spec.owner);
    if (live && !live.exit) return Promise.resolve(stateOf(live));
    let started = this.starting.get(spec.owner);
    if (!started) {
      started = this.spawnGroup(spec).finally(() => this.starting.delete(spec.owner));
      this.starting.set(spec.owner, started);
    }
    return started;
  }

  state(owner: string): RunState | undefined {
    const group = this.groups.get(owner);
    return group && stateOf(group);
  }

  /** Właściciele z ostatnim stanem, także zakończeni. */
  owners(): string[] {
    return [...this.groups.keys()];
  }

  /**
   * Łagodny stop, po czasie łaski zabicie całej grupy. Wraca dopiero po potwierdzeniu, że grupa nie żyje;
   * inaczej `stop_unconfirmed`, a uruchomienie zostaje `stopping`, więc stop można ponowić.
   */
  stop(owner: string): Promise<RunState> | undefined {
    const group = this.groups.get(owner);
    if (!group) return undefined;
    if (group.exit) return Promise.resolve(stateOf(group));
    group.stopping ??= this.escalate(group).finally(() => {
      group.stopping = undefined;
    });
    return group.stopping;
  }

  /** Wyjście daemona: zatrzymuje wszystkie żywe grupy równolegle; grupy, których nie udało się zatrzymać, zgłasza w logu. */
  async stopAll(): Promise<void> {
    const live = [...this.groups.entries()].filter(([, g]) => !g.exit);
    const results = await Promise.allSettled(live.map(([owner]) => this.stop(owner)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.deps.log(`nie zatrzymano ${live[i]?.[0]}: ${String(r.reason)}`);
    });
  }

  /**
   * Start daemona: grupy z `runtime.json` zostały po poprzednim działaniu (awaria, twarde zabicie). Sprzątana jest
   * tylko grupa, której lider to na pewno ten sam proces (§4.1, `GroupPlatform.killOrphan`).
   */
  async sweepOrphans(): Promise<void> {
    const platform = await this.deps.platform;
    const left: RuntimeGroup[] = [];
    for (const orphan of this.deps.runtime.read()) {
      const outcome = await platform.killOrphan(orphan.pid, orphan.identity);
      const what = `${orphan.owner} (pid ${orphan.pid}, ${orphan.command.join(" ")})`;
      if (outcome === "killed") this.deps.log(`sprzątnięto sierotę ${what}`);
      if (outcome === "unverified") this.deps.log(`pid ${orphan.pid} żyje, ale nie wiadomo, czy to sierota ${what}; zostawiono`);
      if (outcome === "alive") {
        this.deps.log(`sierota ${what} przeżyła zabicie; spróbuję przy następnym starcie`);
        left.push(orphan);
      }
    }
    this.deps.runtime.write([...left, ...this.liveRecords()]);
  }

  private async spawnGroup(spec: GroupSpec): Promise<RunState> {
    const [program, ...args] = spec.command;
    if (program === undefined) throw new Error("pusta komenda");
    await requireDirectory(spec.cwd);
    const platform = await this.deps.platform;
    const child = spawn(program, args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: platform.detached,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Wyjście i koniec procesu są podłączone od razu: krótki task może skończyć się, zanim padnie pierwszy `await`.
    const tail = new OutputTail();
    attachOutput(child, tail);
    const exited = new Promise<Exit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal, at: new Date().toISOString() }));
    });
    await spawned(child, program);
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${program} nie dostał PID-u`);
    let control: GroupControl;
    try {
      control = platform.adopt(child);
    } catch (err) {
      child.kill("SIGKILL");
      throw err;
    }
    const record: RuntimeGroup = {
      runId: randomUUID(),
      owner: spec.owner,
      command: [...spec.command],
      cwd: spec.cwd,
      startedAt: new Date().toISOString(),
      pid,
      identity: await platform.identity(pid),
    };
    const group: Group = {
      record,
      child,
      control,
      tail,
      stopRequested: false,
      confirmedEmpty: false,
      finished: exited.then((e) => this.reap(group, e)),
    };
    this.groups.set(spec.owner, group);
    this.deps.runtime.write(this.liveRecords());
    return stateOf(group);
  }

  /** Koniec lidera: reszta grupy jest zabijana, a uruchomienie kończy się dopiero, gdy grupa jest pusta. */
  private async reap(group: Group, exit: Exit): Promise<boolean> {
    const empty = group.control.isEmpty() || (await killAndWait(group.control));
    group.exit = exit;
    group.confirmedEmpty = empty;
    if (empty) {
      group.control.release();
      this.deps.runtime.write(this.liveRecords());
    } else {
      this.deps.log(`grupa ${group.record.owner} (pid ${group.record.pid}) żyje po zabiciu; zostaje w runtime.json`);
    }
    return empty;
  }

  private async escalate(group: Group): Promise<RunState> {
    group.stopRequested = true;
    const platform = await this.deps.platform;
    group.control.askToStop();
    if (!(await within(group.finished, platform.graceMs))) group.control.kill();
    const empty = await within(group.finished, KILL_WAIT_MS * 2);
    if (!empty) {
      throw new DomainError(
        "stop_unconfirmed",
        `${group.record.command.join(" ")} (pid ${group.record.pid}): część procesów grupy nadal działa po zabiciu`,
      );
    }
    return stateOf(group);
  }

  /** Grupy, które mogą jeszcze żyć. */
  private liveRecords(): RuntimeGroup[] {
    return [...this.groups.values()].filter((g) => !g.confirmedEmpty).map((g) => g.record);
  }
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

function stateOf(group: Group): RunState {
  const { runId, startedAt, pid } = group.record;
  if (!group.exit) return { kind: group.stopRequested ? "stopping" : "running", runId, startedAt, pid };
  return {
    kind: "exited",
    runId,
    startedAt,
    endedAt: group.exit.at,
    exitCode: group.exit.code,
    signal: group.exit.signal,
    stoppedByUser: group.stopRequested,
    lastLines: group.tail.snapshot(),
  };
}

async function requireDirectory(cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error(`katalog roboczy musi być pełną ścieżką: ${cwd}`);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`katalog roboczy nie istnieje: ${cwd}`);
}

/** Czeka na `spawn` albo `error`: dopiero wtedy wiadomo, czy program w ogóle wystartował. */
function spawned(child: ChildProcess, program: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === "ENOENT" ? `nie znaleziono programu ${program} w PATH` : `nie udało się uruchomić ${program}: ${err.message}`,
        ),
      );
    });
  });
}

async function killAndWait(control: GroupControl): Promise<boolean> {
  control.kill();
  return waitUntil(() => control.isEmpty(), KILL_WAIT_MS);
}

/** `true`, gdy grupa skończyła się w czasie i jest pusta. */
function within(finished: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([finished, timeout]).finally(() => clearTimeout(timer));
}
