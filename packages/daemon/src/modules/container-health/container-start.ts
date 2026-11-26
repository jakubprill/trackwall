import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * When the container started: the start of its first process, from `/proc/1/stat` (clock ticks since boot) and the
 * boot time in `/proc/stat`. Linux reports both in `USER_HZ`, which is 100 on every architecture Docker runs on.
 *
 * The ticks count only the time the kernel ran. In the virtual machine of Docker on Windows (WSL) or macOS the clock
 * of ticks stops while the host sleeps, but the wall clock is set again on waking, so `btime` (the wall clock minus
 * the ticks) moves forward by the time slept, and so does this start (`ps` shows the same). The daemon runs inside the
 * container, so its own start, taken from the wall clock, is the latest the container can have started.
 */

const USER_HZ = 100;

/** The start of process 1 from the two files' text, no later than the daemon's start; `null` when either does not say it. */
export function containerStart(procOneStat: string, procStat: string, daemonStartedAt: Date): Date | null {
  // The process name in parentheses may hold spaces; the fields after its closing parenthesis start at field 3.
  const fields = procOneStat.slice(procOneStat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  const boot = /^btime (\d+)$/m.exec(procStat)?.[1];
  if (!Number.isFinite(ticks) || boot === undefined) return null;
  const start = (Number(boot) + ticks / USER_HZ) * 1000;
  return new Date(Math.min(start, daemonStartedAt.getTime()));
}

export async function readContainerStart(daemonStartedAt: Date, proc = join("/", "proc")): Promise<Date | null> {
  try {
    const [one, all] = await Promise.all([readFile(join(proc, "1", "stat"), "utf8"), readFile(join(proc, "stat"), "utf8")]);
    return containerStart(one, all, daemonStartedAt);
  } catch {
    return null;
  }
}
