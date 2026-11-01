/**
 * Packs the daemon built for Linux (`pnpm --filter @trackwall/daemon build --target <triple>`) and the built page
 * (`pnpm --filter @trackwall/ui build`) into the Linux release archive in `out/` (ADR-163, `linux-archive.ts`).
 *
 *   bun apps/desktop/scripts/package-linux.ts <x64|arm64>
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO, run } from "./lib.ts";
import {
  isLinuxArch,
  LINUX_ARCHIVE_ENTRIES,
  LINUX_ARCHIVE_FOLDER,
  LINUX_ARCHIVES,
  LINUX_ARCHS,
  linuxArchiveName,
  linuxReadme,
  strayLinuxArchiveEntries,
} from "./linux-archive.ts";

const arch = Bun.argv[2] ?? "";
if (!isLinuxArch(arch)) throw new Error(`usage: bun apps/desktop/scripts/package-linux.ts <${LINUX_ARCHS.join("|")}>`);
const version = assertVersionsMatch();

function need(path: string, how: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing; run ${how} first`);
  return path;
}

const daemon = need(
  join(REPO, "packages", "daemon", "dist", `trackwall-daemon-${LINUX_ARCHIVES[arch]}`),
  `pnpm --filter @trackwall/daemon build --target ${LINUX_ARCHIVES[arch]}`,
);
const ui = need(join(REPO, "packages", "ui", "dist", "index.html"), "pnpm --filter @trackwall/ui build");

const out = join(REPO, "out");
const stageRoot = join(out, `stage-linux-${arch}`);
const stage = join(stageRoot, LINUX_ARCHIVE_FOLDER);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(daemon, join(stage, "trackwall-daemon"));
chmodSync(join(stage, "trackwall-daemon"), 0o755);
cpSync(join(ui, ".."), join(stage, "ui"), { recursive: true });
writeFileSync(join(stage, "README.txt"), linuxReadme(version));
const staged = readdirSync(stage).sort();
if (staged.join() !== [...LINUX_ARCHIVE_ENTRIES].join()) {
  throw new Error(`the archive has ${staged.join(", ")}; update LINUX_ARCHIVE_ENTRIES in linux-archive.ts`);
}

const archive = join(out, linuxArchiveName(version, arch));
run(["tar", "-czf", archive, "-C", stageRoot, LINUX_ARCHIVE_FOLDER], REPO);
const stray = strayLinuxArchiveEntries(run(["tar", "-tzf", archive], REPO, true).split("\n").filter(Boolean));
if (stray.length > 0) throw new Error(`${archive} has entries outside ${LINUX_ARCHIVE_FOLDER}/: ${stray.slice(0, 5).join(", ")}`);
rmSync(stageRoot, { recursive: true, force: true });
console.log(archive);
