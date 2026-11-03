import { statfs } from "node:fs/promises";

/**
 * Free disk space for the doctor's check (§4.15): where the projects folder is (worktrees, build output) and where the
 * home folder is (build caches such as `~/.m2`). In a container these sit on the disk of Docker's virtual machine,
 * which fills up quietly until builds fail without a clear reason.
 */

/** Below this a build of a bigger project may not fit: a warning. */
export const LOW_DISK_BYTES = 10 * 1024 ** 3;
/** Below this git and builds start failing: a problem. */
export const VERY_LOW_DISK_BYTES = 2 * 1024 ** 3;

export interface DiskSpace {
  /** Bytes the daemon's user may still write. */
  free: number;
  total: number;
}

/** What `statfs` says of the file system a folder is on. */
export async function diskSpace(folder: string): Promise<DiskSpace> {
  const fs = await statfs(folder);
  return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
}

/** `12.3 GB`, in units of 1024³ bytes as file managers show them. */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
