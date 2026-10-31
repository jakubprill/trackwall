import { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CardProblem } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { isInside } from "../../infra/path-inside.ts";
import { readRegularFile } from "../../infra/regular-file.ts";
import { readsSpringConfigFile, springLoadOrder } from "./spring-config.ts";

/**
 * The Spring configuration files of a working directory (ADR-153), for `get_app_config`: unlike the card (ADR-14), what
 * a run there reads now, with uncommitted changes and the files git ignores (`application-local.yml`). The resource
 * folders are those of the configuration files git tracks, and each is listed on disk, so an ignored file next to a
 * tracked one is found without walking `node_modules` or `target`. Every file is read as one a repo may have planted:
 * a regular file within the size limit, never a link, in a folder that resolves inside the read directory.
 */

/** What reading needs from `vcs`: the tracked paths matching globs. */
export interface WorkingConfigVcs {
  trackedFiles(dir: string, globs: readonly string[], maxBytes: number): Promise<{ paths: string[]; truncated: boolean }>;
}

export interface WorkingConfig {
  /** The files read, relative to the directory, with `/`, in the order Spring reads them. */
  paths: string[];
  text(path: string): string | undefined;
  problems: CardProblem[];
}

const CONFIG_GLOBS = ["**/src/main/resources/application*", "**/src/main/resources/bootstrap*"];
/** The name list of a repo with a few hundred modules is a few KB. */
const MAX_LIST_BYTES = 1024 * 1024;
/** A Spring configuration file larger than this is not hand-written configuration. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Resource folders and files read at most: a monorepo has dozens of modules, each with a few profiles. */
const MAX_FOLDERS = 200;
const MAX_FILES = 500;
/** All files of one request together: a repo's whole configuration is a few hundred KB. */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** Names looked at in one resource folder: templates and static files may share it, millions are planted. */
const MAX_FOLDER_NAMES = 10_000;
const RESOURCES = "src/main/resources";
/** Folders listed and files read at once: each is one system call, and on Windows the antivirus looks at every file. */
const READ_CONCURRENCY = 8;

export async function readWorkingConfig(vcs: WorkingConfigVcs, dir: string): Promise<WorkingConfig> {
  const problems: CardProblem[] = [];
  const tracked = await vcs.trackedFiles(dir, CONFIG_GLOBS, MAX_LIST_BYTES);
  if (tracked.truncated) problems.push(notRead("", "git's list of configuration files was cut at its size limit"));
  const folders = [...new Set(tracked.paths.filter(readsSpringConfigFile).map(folderOf))].sort();
  if (folders.length > MAX_FOLDERS)
    problems.push(notRead("", `more resource folders than the limit of ${MAX_FOLDERS}; the rest were not read`));
  const root = await realpath(dir);
  const listed = await mapLimit(folders.slice(0, MAX_FOLDERS), READ_CONCURRENCY, (f) => configFilesIn(root, f, problems));
  const files = listed.flat().sort((a, b) => springLoadOrder(a.path, b.path));
  if (files.length > MAX_FILES)
    problems.push(notRead("", `more configuration files than the limit of ${MAX_FILES}; the rest were not read`));
  const budget = { left: MAX_TOTAL_BYTES };
  const read = await mapLimit(files.slice(0, MAX_FILES), READ_CONCURRENCY, async (file) => {
    const text = await readConfigFile(file, budget, problems);
    return text === undefined ? [] : [[file.path, text] as const];
  });
  const texts = new Map(read.flat());
  return { paths: [...texts.keys()], text: (path) => texts.get(path), problems };
}

/** A configuration file: its path relative to the read directory, and where it is on disk, in its folder resolved inside the root. */
interface ConfigFile {
  path: string;
  file: string;
}

function notRead(path: string, message: string): CardProblem {
  return { code: "files-not-read", path, message };
}

/** `orders/src/main/resources` for `orders/src/main/resources/application.yml`. */
function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf(RESOURCES) + RESOURCES.length);
}

/**
 * The configuration files in a resource folder on disk, also those git ignores, at most `MAX_FOLDER_NAMES` names looked
 * at; none when the folder is gone or resolves outside the root. The files are opened in the resolved folder, so a
 * link put in place of a parent folder after the check does not lead out of it.
 */
async function configFilesIn(root: string, folder: string, problems: CardProblem[]): Promise<ConfigFile[]> {
  const real = await realpath(join(root, ...folder.split("/"))).catch(() => undefined);
  if (real === undefined) return [];
  if (!isInside(root, real)) {
    problems.push(notRead(folder, "the folder leads outside the repo through a link"));
    return [];
  }
  const files: ConfigFile[] = [];
  try {
    let seen = 0;
    for await (const entry of await opendir(real)) {
      if (++seen > MAX_FOLDER_NAMES) {
        problems.push(notRead(folder, `more than ${MAX_FOLDER_NAMES} names in the folder; the rest were not looked at`));
        break;
      }
      const path = `${folder}/${entry.name}`;
      if (readsSpringConfigFile(path)) files.push({ path, file: join(real, entry.name) });
    }
  } catch (err) {
    problems.push(notRead(folder, messageOf(err).replaceAll(real, folder)));
  }
  return files;
}

/** The file's text within the size limits; a problem without the folder's path on this computer when it cannot be read. */
async function readConfigFile({ path, file }: ConfigFile, budget: { left: number }, problems: CardProblem[]): Promise<string | undefined> {
  if (budget.left <= 0) {
    problems.push(notRead(path, `the files read before it reached the limit of ${MAX_TOTAL_BYTES / 1024 / 1024} MB`));
    return undefined;
  }
  try {
    const content = await readRegularFile(file, Math.min(MAX_FILE_BYTES, budget.left));
    if (content === undefined) return undefined;
    budget.left -= content.length;
    return content.toString("utf8");
  } catch (err) {
    problems.push(notRead(path, messageOf(err).replaceAll(file, path)));
    return undefined;
  }
}
