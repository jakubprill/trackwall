import { join } from "node:path";
import type { ContainerHealth as ContainerHealthState, DaemonRestart } from "@trackwall/protocol";
import { RotatingJsonlFile, readRotatingJsonl } from "../../infra/rotating-jsonl-file.ts";
import type { DiskSpace } from "../../platform/disk-space.ts";
import { type ControlGroupReading, readControlGroup } from "./control-group.ts";
import { cpuShare, historyOf, oomKillsIn, Reading, readingOf, throttledShare } from "./health-sample.ts";
import { healthWarnings } from "./health-warnings.ts";

/**
 * The container's health (§4.30, ADR-279): what its control group counts now, a reading every 30 seconds kept for a day
 * in the state folder (so that a restarted daemon still shows the morning), the daemon's restarts, the disk and the last
 * work backup, and the warnings they add up to. Only reads; outside a container it answers that there is nothing to show.
 */

const SAMPLE_EVERY_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A day of readings is about 2,900 lines of under 200 bytes; with one rotation the file always holds the last day. */
const HISTORY_MAX_BYTES = 1024 * 1024;
export const CONTAINER_HEALTH_DIR = "container-health";
const HISTORY_FILE = join(CONTAINER_HEALTH_DIR, "readings.jsonl");

export interface ContainerHealthDeps {
  inContainer: boolean;
  stateDir: string;
  /** Where the control group's files are; `/sys/fs/cgroup` in the daemon, a fixture folder in tests. */
  controlGroupRoot: string;
  /** The machine Docker runs on, which a container without limits shares. */
  machine: () => { memoryBytes: number; processors: number };
  daemonStartedAt: Date;
  containerStartedAt: () => Promise<Date | null>;
  restarts: (since: Date) => DaemonRestart[];
  diskSpace: () => Promise<DiskSpace | null>;
  lowDiskBytes: number;
  lastBackupAt: () => Promise<string | null>;
  reposWithUnpushedWork: () => Promise<number>;
  now: () => Date;
  log: (msg: string) => void;
}

export class ContainerHealth {
  readonly #deps: ContainerHealthDeps;
  readonly #file: RotatingJsonlFile;
  #readings: Reading[] | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: ContainerHealthDeps) {
    this.#deps = deps;
    this.#file = new RotatingJsonlFile(join(deps.stateDir, HISTORY_FILE), HISTORY_MAX_BYTES, (err) =>
      deps.log(`container health: could not rotate the readings file: ${String(err)}`),
    );
  }

  /** Starts a reading every 30 seconds; only in a container, where there is a control group of its own to read. */
  start(): void {
    if (!this.#deps.inContainer || this.#timer) return;
    const sample = () => void this.sample().catch((err) => this.#deps.log(`container health: ${String(err)}`));
    this.#timer = setInterval(sample, SAMPLE_EVERY_MS);
    this.#timer.unref?.();
    sample();
  }

  /** Takes one reading, keeps it in memory and in the file, and lets go of the readings older than a day. */
  async sample(): Promise<void> {
    const group = await readControlGroup(this.#deps.controlGroupRoot);
    const now = this.#deps.now();
    const since = now.getTime() - DAY_MS;
    const reading = readingOf(now, group);
    this.#readings = [...this.#day().filter((r) => Date.parse(r.at) >= since), reading];
    this.#file.append(JSON.stringify(reading));
    try {
      this.#file.flush();
    } catch (err) {
      this.#deps.log(`container health: could not write a reading: ${String(err)}`);
    }
  }

  async state(): Promise<ContainerHealthState> {
    const deps = this.#deps;
    const now = deps.now();
    const since = new Date(now.getTime() - DAY_MS);
    const machine = deps.machine();
    if (!deps.inContainer) return outside(deps, machine);
    const [group, containerStartedAt, disk, lastAt, reposWithUnpushedWork] = await Promise.all([
      readControlGroup(deps.controlGroupRoot),
      deps.containerStartedAt(),
      deps.diskSpace(),
      deps.lastBackupAt(),
      deps.reposWithUnpushedWork(),
    ]);
    const readings = this.#day().filter((r) => Date.parse(r.at) >= since.getTime());
    const processors = group.cpu?.limit ?? machine.processors;
    const facts = {
      memory: group.memory && { used: group.memory.current, limit: group.memory.max },
      processes: group.processes && { used: group.processes.current, limit: group.processes.max },
      disk: disk && { free: disk.free, total: disk.total },
      oomKills: oomKillsIn(readings),
      restarts: deps.restarts(since),
      backup: { lastAt, reposWithUnpushedWork },
    };
    return {
      inContainer: true,
      controlGroup: hasControlGroup(group),
      containerStartedAt: containerStartedAt?.toISOString() ?? null,
      daemonStartedAt: deps.daemonStartedAt.toISOString(),
      machine,
      memoryPeak: peakOf(readings, group),
      cpu: group.cpu && { limit: group.cpu.limit, ...recentCpu(readings, processors) },
      oomKillsTotal: group.oomKills,
      history: historyOf(readings, processors),
      warnings: healthWarnings(facts, readings, deps.lowDiskBytes, now),
      ...facts,
    };
  }

  /** The kept readings, loaded from the state folder on first use; a line that is not a reading is skipped. */
  #day(): Reading[] {
    if (this.#readings) return this.#readings;
    const since = this.#deps.now().getTime() - DAY_MS;
    this.#readings = readRotatingJsonl(this.#file.path, Reading).filter((r) => Date.parse(r.at) >= since);
    return this.#readings;
  }
}

function outside(deps: ContainerHealthDeps, machine: { memoryBytes: number; processors: number }): ContainerHealthState {
  return {
    inContainer: false,
    controlGroup: false,
    containerStartedAt: null,
    daemonStartedAt: deps.daemonStartedAt.toISOString(),
    memory: null,
    memoryPeak: null,
    machine,
    cpu: null,
    processes: null,
    disk: null,
    oomKills: [],
    oomKillsTotal: null,
    restarts: [],
    backup: { lastAt: null, reposWithUnpushedWork: 0 },
    history: [],
    warnings: [],
  };
}

function hasControlGroup(group: ControlGroupReading): boolean {
  return group.memory !== null || group.cpu !== null || group.processes !== null;
}

/** The highest memory the readings of the day and the one now saw. */
function peakOf(readings: Reading[], group: ControlGroupReading): number | null {
  const seen = [...readings.map((r) => r.memoryBytes), group.memory?.current ?? null].flatMap((m) => (m === null ? [] : [m]));
  return seen.length > 0 ? Math.max(...seen) : null;
}

/** The processor share and the held-back share between the last two readings. */
function recentCpu(readings: Reading[], processors: number): { used: number | null; throttled: number | null } {
  const before = readings[readings.length - 2];
  const last = readings[readings.length - 1];
  if (!before || !last) return { used: null, throttled: null };
  return { used: cpuShare(before, last, processors), throttled: throttledShare(before, last) };
}
