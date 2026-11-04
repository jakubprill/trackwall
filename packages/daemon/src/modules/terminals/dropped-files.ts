import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DomainError } from "../../infra/errors.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";

/**
 * Dropped files (§4.23, ADR-196): a file dropped on a terminal from a computer that is not the daemon's (the daemon in a
 * dev container) reaches the daemon as its bytes and is saved under `.trackwall/drops` of the projects folder, so that
 * the terminal can paste a path that exists where its program runs. Each file gets a new folder of its own with a random
 * name, so two drops of one name never meet and no name the page sends can point anywhere else; the name itself is
 * checked by `DroppedFileName` before it gets here. The file is created, never overwritten, and a body over
 * `maxBytes` (`MAX_DROP_BYTES`) is cut off and removed. Drops older than `KEEP_MS` are removed at the next drop. No MCP tool.
 */

/** A week: long enough to finish what the file was dropped for, short enough not to fill the disk with dumps. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The prefix of each drop's folder; anything else in `drops` is left alone. */
const DROP_PREFIX = "drop-";

export interface DroppedFilesDeps {
  /** The projects folder; refused (`bad_request`) while it is not set. */
  projectsDir: () => Promise<string>;
  now: () => Date;
  maxBytes: number;
}

export class DroppedFiles {
  readonly #deps: DroppedFilesDeps;

  constructor(deps: DroppedFilesDeps) {
    this.#deps = deps;
  }

  /** Saves `body` as `name` in a new folder of `.trackwall/drops` and returns its full path. */
  async save(name: string, body: Readable): Promise<string> {
    const drops = await ensureTrackwallDir(await this.#deps.projectsDir(), "drops");
    await this.#removeOld(drops);
    const folder = await mkdtemp(join(drops, DROP_PREFIX));
    const path = join(folder, name);
    try {
      await pipeline(body, limited(this.#deps.maxBytes), createWriteStream(path, { flags: "wx", mode: 0o600 }));
    } catch (err) {
      await rm(folder, { recursive: true, force: true });
      throw err;
    }
    return path;
  }

  /** Folders of drops older than `KEEP_MS`, by their own change time; one that cannot be read or removed stays. */
  async #removeOld(drops: string): Promise<void> {
    const oldest = this.#deps.now().getTime() - KEEP_MS;
    const names = await readdir(drops).catch(() => []);
    await Promise.all(
      names
        .filter((name) => name.startsWith(DROP_PREFIX))
        .map(async (name) => {
          const folder = join(drops, name);
          const stat = await lstat(folder).catch(() => undefined);
          if (stat?.isDirectory() && stat.mtimeMs < oldest) await rm(folder, { recursive: true, force: true }).catch(() => {});
        }),
    );
  }
}

/** A step of `pipeline` that passes at most `max` bytes on; one more fails the copy with what to do instead. */
function limited(max: number): (source: AsyncIterable<Buffer>) => AsyncGenerator<Buffer> {
  return async function* (source) {
    let size = 0;
    for await (const chunk of source) {
      size += chunk.length;
      if (size > max)
        throw new DomainError(
          "bad_request",
          `the file is larger than ${max / 1024 ** 2} MB; copy it into the container with docker cp instead`,
        );
      yield chunk;
    }
  };
}
