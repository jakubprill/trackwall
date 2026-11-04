import { lstat, mkdtemp, open, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dropTooLarge } from "@trackwall/protocol";
import { DomainError } from "../../infra/errors.ts";
import { ensureTrackwallDir, trackwallDir } from "../../infra/trackwall-dir.ts";

/**
 * Dropped files (§4.23, ADR-201): a file dropped on a terminal from a computer that is not the daemon's (the daemon in a
 * dev container) reaches the daemon as its bytes and is saved under `.trackwall/drops` of the projects folder, so that
 * the terminal can paste a path that exists where its program runs. Each file gets a new folder of its own with a random
 * name, so two drops of one name never meet and the name only labels the file; it is made safe to paste first
 * (`savedName`). The file is created, never overwritten, and a body over `maxBytes` (`MAX_DROP_BYTES`) is cut off and
 * removed. Drops older than `KEEP_MS` are removed at the next drop, one known file at a time, never recursively, since
 * an agent can write in the projects folder (§8). No MCP tool.
 */

/** A day: long enough to hand the file to an agent, short enough not to leave the user's files lying where agents work. */
const KEEP_MS = 24 * 60 * 60 * 1000;
/** The prefix of each drop's folder; anything else in `drops` is left alone. */
const DROP_PREFIX = "drop-";
/** Room under the 255 bytes most file systems allow for a name. */
const MAX_NAME_BYTES = 200;
/** Device names Windows will not take as a file name, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

export interface DroppedFilesDeps {
  /** The projects folder; refused (`bad_request`) while it is not set. */
  projectsDir: () => Promise<string>;
  now: () => Date;
  maxBytes: number;
}

/**
 * The name a dropped file is saved under: letters, digits, `.`, `_`, `+`, `-` and spaces kept, anything else (a
 * separator, a quote, `$`, a backtick, a control or bidi character) becomes `_`, so the pasted path is never read as a
 * command by a shell; no trailing dot or space, no Windows device name, at most `MAX_NAME_BYTES` with the extension kept.
 */
export function savedName(dropped: string): string {
  const kept = dropped.normalize("NFC").replace(/[^\p{L}\p{N}\p{M}._+ -]/gu, "_");
  const extension = /\.[^.]{1,16}$/.exec(kept)?.[0] ?? "";
  // Each character is at least a byte, so no more than `MAX_NAME_BYTES` of them are measured.
  const stem = [...kept.slice(0, kept.length - extension.length)].slice(0, MAX_NAME_BYTES);
  while (stem.length > 0 && Buffer.byteLength(stem.join("") + extension) > MAX_NAME_BYTES) stem.pop();
  let name = (stem.join("") + extension).replace(/^ +|[ .]+$/g, "");
  if (name === "") name = "dropped-file";
  return WINDOWS_DEVICE.test(name) ? `_${name}` : name;
}

export class DroppedFiles {
  readonly #deps: DroppedFilesDeps;

  constructor(deps: DroppedFilesDeps) {
    this.#deps = deps;
  }

  /** Saves `body` in a new folder of `.trackwall/drops` under `savedName(name)` and returns its full path. */
  async save(name: string, body: AsyncIterable<Buffer>): Promise<string> {
    const projects = await this.#deps.projectsDir();
    const drops = await realpath(await ensureTrackwallDir(projects, "drops"));
    await this.#removeOld(drops);
    const made = await mkdtemp(join(drops, DROP_PREFIX));
    // A link swapped in for `.trackwall` or `drops` after they were resolved would put the user's file where an agent chose.
    const folder = await realpath(made);
    if (dirname(folder) !== drops)
      throw new DomainError("bad_request", `${trackwallDir(projects, "drops")} changed while the file was saved`);
    const path = join(folder, savedName(name));
    try {
      await this.#write(path, body);
    } catch (err) {
      await removeDrop(drops, folder);
      throw err;
    }
    return path;
  }

  async #write(path: string, body: AsyncIterable<Buffer>): Promise<void> {
    const file = await open(path, "wx", 0o600);
    try {
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > this.#deps.maxBytes) throw new DomainError("bad_request", dropTooLarge("the file"));
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
  }

  /** Folders of drops older than `KEEP_MS`, by when they were last changed; one that cannot be removed stays. */
  async #removeOld(drops: string): Promise<void> {
    const oldest = this.#deps.now().getTime() - KEEP_MS;
    const entries = await readdir(drops, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(DROP_PREFIX))
        .map(async (entry) => {
          const folder = join(drops, entry.name);
          const changed = await stat(folder).catch(() => undefined);
          if (changed && changed.mtimeMs < oldest) await removeDrop(drops, folder);
        }),
    );
  }
}

/**
 * A drop's folder in the resolved `drops`: its files and links unlinked one by one, then the folder, which fails, and is
 * left, if anything else is in it. Only a real folder that still resolves to a child of `drops`, and no recursive
 * removal, so a folder an agent swapped for a link is not followed (§8 names the moment left between check and unlink).
 */
async function removeDrop(drops: string, folder: string): Promise<void> {
  const own = await lstat(folder).catch(() => undefined);
  if (!own?.isDirectory() || dirname(await realpath(folder).catch(() => "")) !== drops) return;
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => !entry.isDirectory()).map((entry) => unlink(join(folder, entry.name)).catch(() => {})));
  await rmdir(folder).catch(() => {});
}
