import type { RepoCard, RepoCardResult, RepoTagRules, RepoTags } from "@trackwall/protocol";
import { messageOf } from "../../error-message.ts";
import { DomainError } from "../../errors.ts";
import { mapLimit } from "../../map-limit.ts";
import type { CardCache } from "./card-cache.ts";
import { extractCard } from "./extract-card.ts";
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
  /** Karty w trakcie liczenia po commicie: dwa pytania o ten sam commit (lista i karta naraz) czytają gita raz. */
  private readonly computing = new Map<string, Promise<RepoCard>>();

  constructor(deps: CardsDeps) {
    this.deps = deps;
  }

  async card(id: string): Promise<RepoCardResult> {
    const dir = await this.deps.repos.repoPath(id);
    try {
      const [card, remote] = await Promise.all([this.cardOf(dir), this.deps.vcs.remote(dir).catch(() => null)]);
      return { repo: id, card, tags: repoTags(card, { id, remote }, this.deps.repos.tagRules()) };
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
        const [card, remote] = await Promise.all([this.cardOf(path), this.deps.vcs.remote(path).catch(() => null)]);
        return { kind: "ok", repo: id, tags: repoTags(card, { id, remote }, rules) };
      } catch (err) {
        return { kind: "unavailable", repo: id, message: messageOf(err) };
      }
    });
  }

  /** Karta commita HEAD repo w katalogu `dir`; `null` w repo bez commitów. */
  private async cardOf(dir: string): Promise<RepoCard | null> {
    const commit = await this.deps.vcs.headCommit(dir);
    if (commit === null) return null;
    const cached = await this.deps.cache.get(commit);
    if (cached) return cached;
    const running = this.computing.get(commit);
    if (running) return running;
    const computed = this.compute(dir, commit).finally(() => this.computing.delete(commit));
    this.computing.set(commit, computed);
    return computed;
  }

  private async compute(dir: string, commit: string): Promise<RepoCard> {
    const { snapshot, problems } = await readSnapshot(this.deps.vcs, dir, commit);
    const extracted = extractCard(snapshot);
    const card = { ...extracted, problems: [...problems, ...extracted.problems] };
    this.deps.cache.set(card);
    return card;
  }
}
