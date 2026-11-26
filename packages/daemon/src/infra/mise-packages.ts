import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MISE_CONFIG_NAME } from "@trackwall/protocol";

/**
 * The packages of a monorepo for mise (§4.7, ADR-305): folders below a repo root or a task worktree that hold a mise
 * config of their own (`packages/client/mise.toml`), which mise run from the root never reads. The `mise` module lists and
 * runs their mise tasks in the folder, and `agents` adds their config to the snapshot of a task worktree the user trusts
 * (ADR-59), so both see the same packages. Only real folders are walked, never a link, and the search stays shallow and
 * skips the folders a build or a package manager fills, which can hold thousands of folders and other projects' configs.
 */

/** How deep below the root a package can be: `apps/web`, `services/orders/api`, `modules/backend/orders/core`. */
const MAX_DEPTH = 4;
/** More packages than this is a generated tree, not a repo's own; the first ones in name order are kept. */
const MAX_MISE_PACKAGES = 32;
/** Folders of build output, dependencies and tools, matched without regard to case; hidden folders are skipped too. */
const SKIPPED = new Set(["node_modules", "target", "build", "dist", "out", "bin", "obj", "vendor", "coverage", "tmp"]);

/** The packages under `root` as paths relative to it with `/`, sorted; the root itself is never one. */
export async function findMisePackages(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, [], found);
  return found.sort().slice(0, MAX_MISE_PACKAGES);
}

async function walk(root: string, dir: readonly string[], found: string[]): Promise<void> {
  if (found.length >= MAX_MISE_PACKAGES * 4) return;
  const list = await entries(join(root, ...dir));
  if (dir.length > 0 && list.some((e) => !e.isDirectory() && MISE_CONFIG_NAME.test(e.name))) found.push(dir.join("/"));
  if (dir.length >= MAX_DEPTH) return;
  for (const entry of list) {
    if (entry.isDirectory() && !skipped(entry.name)) await walk(root, [...dir, entry.name], found);
  }
}

/** The folder of package `pkg` (a path with `/` that `findMisePackages` gave) under `root`. */
export function packageDir(root: string, pkg: string): string {
  return join(root, ...pkg.split("/"));
}

function skipped(name: string): boolean {
  return name.startsWith(".") || SKIPPED.has(name.toLowerCase());
}

/** Entries of a folder; one that is gone or cannot be read has none, as a package that is not there. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return [];
    throw err;
  }
}
