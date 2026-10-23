import type { RepoCard, RepoCardResult, RepoTag, RepoTagRules, RepoTags } from "@trackwall/protocol";
import { DomainError, messageOf } from "../../errors.ts";
import { mapLimit } from "../../map-limit.ts";
import type { CardCache } from "./card-cache.ts";
import { extractCard, readsCardFile } from "./extract-card.ts";
import { readSnapshot, type SnapshotVcs } from "./read-snapshot.ts";
import { repoTags } from "./tags.ts";

/**
 * Moduł `cards` (§4, §4.6, ADR-25): karta repo z plików buildu i konfiguracji w commicie HEAD, liczona raz na commit
 * (`CardCache`), i tagi repo z karty oraz z reguł w `workspace.yaml`. Bez LLM: każde pole ma dowód. Graf z kart
 * (moduł `graph`) przyjdzie osobno.
 */

/** Czego `cards` potrzebuje od `vcs`; podłączane w fasadzie. */
interface CardsVcs extends SnapshotVcs {
  headCommit(dir: string): Promise<string | null>;
  remote(dir: string): Promise<string | null>;
}

/** Czego `cards` potrzebuje od `workspace`: repo z folderu z projektami i reguły tagów z `workspace.yaml`. */
interface CardsRepos {
  repoEntries(): Promise<{ id: string; path: string }[]>;
  repoPath(id: string): Promise<string>;
  tagRules(): RepoTagRules;
}

export interface CardsDeps {
  vcs: CardsVcs;
  repos: CardsRepos;
  cache: CardCache;
}

/**
 * Ile repo naraz czyta przy liście tagów: pierwsze liczenie kart to dwa procesy `git` na repo, a na Windowsie start
 * procesu i skan antywirusa są drogie.
 */
const TAGS_CONCURRENCY = 4;

export class Cards {
  private readonly deps: CardsDeps;

  constructor(deps: CardsDeps) {
    this.deps = deps;
  }

  async card(id: string): Promise<RepoCardResult> {
    const dir = await this.deps.repos.repoPath(id);
    try {
      return { repo: id, ...(await this.tagged(id, dir, this.deps.repos.tagRules())) };
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("repo_unavailable", `${id}: ${messageOf(err)}`);
    }
  }

  /** Tagi wszystkich repo z folderu z projektami; repo, którego git nie czyta, ma powód zamiast tagów. */
  async tags(): Promise<RepoTags[]> {
    const rules = this.deps.repos.tagRules();
    const entries = await this.deps.repos.repoEntries();
    return mapLimit(entries, TAGS_CONCURRENCY, async ({ id, path }): Promise<RepoTags> => {
      try {
        return { kind: "ok", repo: id, tags: (await this.tagged(id, path, rules)).tags };
      } catch (err) {
        return { kind: "unavailable", repo: id, message: messageOf(err) };
      }
    });
  }

  /** Karta repo i tagi z niej, z adresu repo zdalnego (bez niego tylko z identyfikatora) i z reguł. */
  private async tagged(id: string, dir: string, rules: RepoTagRules): Promise<{ card: RepoCard | null; tags: RepoTag[] }> {
    const [card, remote] = await Promise.all([this.cardOf(dir), this.deps.vcs.remote(dir).catch(() => null)]);
    return { card, tags: repoTags(card, { id, remote }, rules) };
  }

  /** Karta commita HEAD repo w katalogu `dir`; `null` w repo bez commitów. */
  private async cardOf(dir: string): Promise<RepoCard | null> {
    const commit = await this.deps.vcs.headCommit(dir);
    if (commit === null) return null;
    return this.deps.cache.getOrCompute(commit, async () => extractCard(await readSnapshot(this.deps.vcs, dir, commit, readsCardFile)));
  }
}
