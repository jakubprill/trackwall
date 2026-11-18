import { z } from "zod";
import { apiEndpoints } from "./api.ts";

/**
 * Contract of the `container-health` module (§4.30, ADR-279): how the container Trackwall runs in is doing, as read from
 * inside it (the control group's files, `/proc`, the disk), with a day of history, so that "the build died for no reason"
 * gets one: the memory limit, a process killed for memory, a full disk, a restart. Read only; only in a container.
 */

/** A count against its limit; `limit` is `null` when the container has none of its own (it then has the machine's). */
const Usage = z.object({ used: z.number().nonnegative(), limit: z.number().positive().nullable() });

/** A process the kernel killed because the container ran out of memory, as the control group counted it. */
export const OomKill = z.object({
  /** When the daemon saw the count rise: within one sample of the kill. */
  at: z.iso.datetime(),
  /** How many kills the rise counted. */
  count: z.number().int().positive(),
});
export type OomKill = z.infer<typeof OomKill>;

/** A start of the daemon after it crashed, by the supervisor in the container (ADR-164). */
export const DaemonRestart = z.object({
  at: z.iso.datetime(),
  /** The crashed daemon's exit code, `null` after a signal. */
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type DaemonRestart = z.infer<typeof DaemonRestart>;

/** One point of the day's history: what a sample read, the processor's share since the sample before. */
export const HealthSample = z.object({
  at: z.iso.datetime(),
  memoryBytes: z.number().nonnegative().nullable(),
  /** Processors in use, as a share of the container's limit or of the machine's processors (0–1). */
  cpu: z.number().nonnegative().nullable(),
});
export type HealthSample = z.infer<typeof HealthSample>;

/** Something in the container that needs the user, the same rules as the warnings on Home. */
export const HealthWarning = z.object({
  id: z.enum(["memory-full", "oom-kill", "cpu-throttled", "disk-low", "processes-full", "daemon-restarted", "backup-old"]),
  text: z.string().min(1),
});
export type HealthWarning = z.infer<typeof HealthWarning>;

export const ContainerHealth = z.object({
  inContainer: z.boolean(),
  /** The control group's files can be read (cgroup v2); without them the rows that need them are not available here. */
  controlGroup: z.boolean(),
  /** When the container started (its first process) and when the daemon did. */
  containerStartedAt: z.iso.datetime().nullable(),
  daemonStartedAt: z.iso.datetime(),
  memory: Usage.nullable(),
  /** The highest memory the samples of the last day saw. */
  memoryPeak: z.number().nonnegative().nullable(),
  /** The machine Docker runs on (WSL, Colima): its memory and processors, which a container without limits shares. */
  machine: z.object({ memoryBytes: z.number().positive(), processors: z.number().int().positive() }),
  /** Processors: the container's limit (`null` without one), the share in use and the share of time the kernel held it back. */
  cpu: z
    .object({
      limit: z.number().positive().nullable(),
      used: z.number().nonnegative().nullable(),
      throttled: z.number().nonnegative().nullable(),
    })
    .nullable(),
  processes: Usage.nullable(),
  /** Free and whole space of the disk the projects folder is on, which is the Docker machine's disk. */
  disk: z.object({ free: z.number().nonnegative(), total: z.number().positive() }).nullable(),
  /** Kills for memory in the last day, oldest first; `oomKillsTotal` counts every one since the container started. */
  oomKills: z.array(OomKill),
  oomKillsTotal: z.number().int().nonnegative().nullable(),
  /** Restarts after a crash in the last day, oldest first. */
  restarts: z.array(DaemonRestart),
  /** When the last work backup was made, and how many repos have work on no remote now. */
  backup: z.object({ lastAt: z.iso.datetime().nullable(), reposWithUnpushedWork: z.number().int().nonnegative() }),
  /** The last day, one point per five minutes. */
  history: z.array(HealthSample),
  warnings: z.array(HealthWarning),
});
export type ContainerHealth = z.infer<typeof ContainerHealth>;

const endpoint = apiEndpoints("container-health");

export const containerHealthApi = {
  state: endpoint("state", z.object({}).strict(), ContainerHealth),
};
