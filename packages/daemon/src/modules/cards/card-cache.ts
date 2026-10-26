import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CommitHash, RepoCard } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * Repo card cache by commit hash (ADR-25): a card depends only on the commit's tree and the extractor version, so
 * once computed it does not change. In daemon memory and in `<state directory>/cards/<commit>.json` files, so that a
 * daemon restart does not read hundreds of repos again. A file with another extractor version or a damaged one counts as
 * missing. A card that partly depended on the time of computing (ADR-38) stays only in memory, so the next daemon start
 * computes it again.
 */

/**
 * The extractor version saved with a card. A change to what an extractor takes from the same files must bump it,
 * or old cards on disk keep the old result.
 */
const EXTRACTOR_VERSION = 6;
/** This many card files stay on disk; older ones (by write time) are deleted at daemon start. */
const MAX_FILES = 2000;
/** This many cards stay in daemon memory; older ones drop out in the order they were added. */
const MAX_IN_MEMORY = 1000;

/** A computed card; `persist: false` when the result depended on the moment of computing and should not survive a restart. */
export interface ComputedCard {
  card: RepoCard;
  persist: boolean;
}

const CacheFile = z.object({ extractorVersion: z.literal(EXTRACTOR_VERSION), card: RepoCard });

export class CardCache {
  private readonly dir: string;
  private readonly log: (msg: string) => void;
  private readonly memory = new Map<string, RepoCard>();
  /** Cards being computed, by commit: two requests for the same commit (the list and the card at once) read git once. */
  private readonly computing = new Map<string, Promise<RepoCard>>();

  constructor(dir: string, log: (msg: string) => void) {
    this.dir = dir;
    this.log = log;
  }

  /**
   * The commit's card from memory or from disk, or without it computed by `compute` and stored (on disk only with
   * `persist`). The whole job (disk read and computing) goes into `computing` before the first `await`, so a concurrent
   * request for the same commit gets the same job.
   */
  getOrCompute(commit: string, compute: () => Promise<ComputedCard>): Promise<RepoCard> {
    const running = this.computing.get(commit);
    if (running) return running;
    const job = (async () => {
      const cached = await this.get(commit);
      if (cached) return cached;
      const { card, persist } = await compute();
      this.remember(card);
      if (persist) this.save(card);
      return card;
    })().finally(() => this.computing.delete(commit));
    this.computing.set(commit, job);
    return job;
  }

  private async get(commit: string): Promise<RepoCard | undefined> {
    const cached = this.memory.get(commit);
    if (cached) return cached;
    // Only a full hash goes into the file name.
    if (!CommitHash.safeParse(commit).success) return undefined;
    let text: string;
    try {
      text = await readFile(this.file(commit), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = CacheFile.safeParse(JSON.parse(text));
      if (!parsed.success) return undefined;
      this.remember(parsed.data.card);
      return parsed.data.card;
    } catch {
      return undefined;
    }
  }

  /** A failed write to disk goes to the log: the card in memory keeps working, at worst a restart computes it again. */
  private save(card: RepoCard): void {
    if (!CommitHash.safeParse(card.commit).success) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(this.file(card.commit), JSON.stringify({ extractorVersion: EXTRACTOR_VERSION, card }));
    } catch (err) {
      this.log(`failed to save card ${card.commit}: ${String(err)}`);
    }
  }

  /** Deletes the oldest files beyond `MAX_FILES`; every new commit of a repo is a new file, so without this the directory only grows. */
  async prune(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [])).filter((n) => n.endsWith(".json"));
    if (names.length <= MAX_FILES) return;
    const files = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await stat(join(this.dir, name)).catch(() => undefined))?.mtimeMs ?? 0 })),
    );
    files.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(files.slice(MAX_FILES).map((f) => rm(join(this.dir, f.name), { force: true })));
  }

  private remember(card: RepoCard): void {
    this.memory.delete(card.commit);
    this.memory.set(card.commit, card);
    const oldest = this.memory.keys().next();
    if (this.memory.size > MAX_IN_MEMORY && !oldest.done) this.memory.delete(oldest.value);
  }

  private file(commit: string): string {
    return join(this.dir, `${commit}.json`);
  }
}
