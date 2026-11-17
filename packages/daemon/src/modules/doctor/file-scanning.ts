import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorCheck } from "@trackwall/protocol";

/**
 * Whether something scans the files Trackwall and builds write (§4.15, ADR-255): an antivirus's real-time scanning holds
 * every new file until it has read it, so a folder it scans writes files many times slower than one it leaves out. No
 * API says which folders are excluded without administrator rights, so the doctor measures: it writes and reads small
 * files in a temporary folder of each place and compares the places with each other, never with a fixed number, since
 * disks differ more than a scanner does. Only a difference between folders is named; a scanner that slows every folder
 * alike shows only in the times.
 */

/** A folder the doctor measures, as the report names it. */
export interface ScanFolder {
  name: string;
  path: string;
}

/** Milliseconds one file takes in a folder: written, closed and read back. */
export interface FolderCost {
  folder: ScanFolder;
  msPerFile: number;
}

/** Files in one round of one folder: enough for a median-like minimum, few enough for a second on a scanned folder. */
export const FILES_PER_ROUND = 40;
/** Rounds after the warm-up; the fastest one counts, since a scanner slows every round and other work only some. */
const ROUNDS = 3;
/** A folder this many times slower than the fastest one is scanned (ClamAV on-access: ~25 times, Defender: several times). */
const SLOW_RATIO = 4;
/** Below this a folder is fast whatever the ratio: a tenth of a millisecond against a hundredth is two fast disks. */
const SLOW_MS_PER_FILE = 0.5;

/** One round in one folder: a temporary folder with `files` files of source-like text, removed afterwards. */
export async function measureFileWrites(folder: string, files: number): Promise<number> {
  const dir = await mkdtemp(join(folder, ".trackwall-file-check-"));
  try {
    const start = performance.now();
    for (let i = 0; i < files; i++) {
      const file = join(dir, `Check${i}.java`);
      // Fresh content each time, so that a scanner's cache of files it has seen cannot skip the scan.
      await writeFile(file, randomBytes(3072).toString("base64"));
      await readFile(file);
    }
    return (performance.now() - start) / files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Each folder's fastest round, the folders taking turns so that a busy moment falls on all of them; a warm-up round
 * first, which pays for the disk's and the scanner's first touch. A folder that cannot be written is left out.
 */
export async function folderCosts(
  folders: readonly ScanFolder[],
  measure: (folder: string, files: number) => Promise<number>,
): Promise<FolderCost[]> {
  const best = new Map<ScanFolder, number>();
  const writable = new Set(folders);
  for (let round = 0; round <= ROUNDS; round++) {
    for (const folder of [...writable]) {
      const cost = await measure(folder.path, FILES_PER_ROUND).catch(() => null);
      if (cost === null) {
        writable.delete(folder);
        best.delete(folder);
        continue;
      }
      if (round === 0) continue;
      best.set(folder, Math.min(best.get(folder) ?? Number.POSITIVE_INFINITY, cost));
    }
  }
  return [...best].map(([folder, msPerFile]) => ({ folder, msPerFile }));
}

/** Folders much slower than the fastest one are named, slowest first, with their paths; `null` without a folder to measure. */
export function fileScanningOutcome(costs: readonly FolderCost[]): Omit<DoctorCheck, "id"> | null {
  const sorted = [...costs].sort((a, b) => a.msPerFile - b.msPerFile);
  const fastest = sorted[0];
  if (fastest === undefined) return null;
  const slow = sorted.filter((c) => c.msPerFile >= SLOW_MS_PER_FILE && c.msPerFile >= SLOW_RATIO * fastest.msPerFile).reverse();
  if (slow.length === 0) return { status: "ok", summary: `Writing a file takes ${timesIn(sorted)}.`, fix: null };
  const one = slow.length === 1;
  return {
    status: "warn",
    summary: `Writing a file takes ${timesIn(slow)}, against ${timesIn([fastest])}: an antivirus probably scans ${one ? "it" : "them"}, which slows git, builds and tasks.`,
    fix: `Have ${one ? "this folder" : "these folders"} left out of the antivirus's real-time scanning, like ${fastest.folder.name} (at work, IT does that): ${slow.map((c) => c.folder.path).join(", ")}. A folder on a network drive is slow as well; then move it to this computer's disk.`,
  };
}

/** `3.1 ms in Maven's cache, 0.12 ms in the projects folder`: two decimals under a millisecond. */
function timesIn(costs: readonly FolderCost[]): string {
  return costs.map((c) => `${c.msPerFile < 1 ? c.msPerFile.toFixed(2) : c.msPerFile.toFixed(1)} ms in ${c.folder.name}`).join(", ");
}
