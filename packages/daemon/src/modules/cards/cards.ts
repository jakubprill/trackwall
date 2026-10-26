import type { CardWarmupProgress, RepoCard, RepoCardResult, RepoTag, RepoTagRules, RepoTags } from "@trackwall/protocol";
import { configOrProblem, DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { CallReads, readCallFiles } from "./call-files.ts";
import type { CardCache } from "./card-cache.ts";
import { CardWarmup, type WarmupRepo } from "./card-warmup.ts";
import { CALL_SOURCES, CARD_DOCUMENTS, CARD_SOURCES, extractCard, readsCardFile } from "./extract-card.ts";
import { localMiseTasks } from "./local-mise.ts";
import { readSnapshot, type SnapshotVcs } from "./read-snapshot.ts";
import { CARD_PARSE_BUDGET_MS, loadSyntaxParsers, type SyntaxParsers, unavailableParsers, withParseBudget } from "./syntax-tree.ts";
import { repoTags } from "./tags.ts";

/**
 * The `cards` module (§4, §4.6, ADR-25, ADR-30): the repo card from build, configuration and HTTP code files in the HEAD
 * commit, computed once per commit (`CardCache`), and repo tags from the card and from the rules in `workspace.yaml`. No
 * LLM: every field has evidence. The `graph` module computes the graph from the cards with `all()` (ADR-29).
 */

/** What `cards` needs from `vcs`; wired in the facade. */
interface CardsVcs extends SnapshotVcs {
  headCommit(dir: string): Promise<string | null>;
  remote(dir: string): Promise<string | null>;
}

/** What `cards` needs from `workspace`: repos from the projects folder and the tag rules from `workspace.yaml`. */
interface CardsRepos {
  repoEntries(): Promise<{ id: string; path: string }[]>;
  repoPath(id: string): Promise<string>;
  tagRules(): RepoTagRules;
}

interface TaggedCard {
  card: RepoCard | null;
  /** The remote address (`host/path`); `null` without a remote or when git did not give it. */
  remote: string | null;
  tags: RepoTag[];
}

/** The card of one listed repo or the reason it is missing (git cannot read the repo). */
type CardOfRepo = ({ kind: "ok"; repo: string } & TaggedCard) | { kind: "unavailable"; repo: string; message: string };

export interface CardsDeps {
  vcs: CardsVcs;
  repos: CardsRepos;
  cache: CardCache;
  log: (msg: string) => void;
}

/**
 * How many repos are read at once for the tag list: computing cards for the first time is two `git` processes per
 * repo, and on Windows starting a process and the antivirus scan are expensive.
 */
const TAGS_CONCURRENCY = 4;

export class Cards {
  private readonly deps: CardsDeps;
  private readonly warmup: CardWarmup;
  /** Source files already parsed for the endpoint reach, by blob id, across the repos and commits (ADR-82). */
  private readonly callReads = new CallReads();

  constructor(deps: CardsDeps) {
    this.deps = deps;
    this.warmup = new CardWarmup({ warm: (repo) => this.cardOf(repo.path), log: deps.log });
  }

  /** Computes the cards of these repos in the background (ADR-63), before the ones already waiting. */
  warmUp(repos: readonly WarmupRepo[]): void {
    this.warmup.add(repos);
  }

  /** At daemon stop: the warm-up starts no further card. */
  close(): void {
    this.warmup.close();
  }

  /** The progress of the card warm-up (`cards/warmup`, the `cards.warmup.changed` topic). */
  warmupProgress(): CardWarmupProgress {
    return this.warmup.progress();
  }

  async card(id: string): Promise<RepoCardResult> {
    const dir = await this.deps.repos.repoPath(id);
    try {
      const { card, tags } = await this.tagged(id, dir, this.deps.repos.tagRules());
      return { repo: id, card, tags };
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("repo_unavailable", `${id}: ${messageOf(err)}`);
    }
  }

  /** Tags of all repos in the projects folder; a repo git cannot read has a reason instead of tags. */
  async tags(): Promise<RepoTags[]> {
    return (await this.withRules(this.deps.repos.tagRules())).map((c) =>
      c.kind === "ok" ? { kind: "ok", repo: c.repo, tags: c.tags } : { kind: "unavailable", repo: c.repo, message: c.message },
    );
  }

  /**
   * Cards and tags of all repos in the projects folder in list order (for the graph, §4.6, ADR-29). A bad `repoTags`
   * does not take the cards away: repos then have only the tags from the card, and the message comes back in `tagRulesProblem`.
   */
  async all(): Promise<{ cards: CardOfRepo[]; tagRulesProblem: string | null }> {
    const { value: rules, problem: tagRulesProblem } = configOrProblem(() => this.deps.repos.tagRules(), {});
    return { cards: await this.withRules(rules), tagRulesProblem };
  }

  private async withRules(rules: RepoTagRules): Promise<CardOfRepo[]> {
    const entries = await this.deps.repos.repoEntries();
    return mapLimit(entries, TAGS_CONCURRENCY, async ({ id, path }): Promise<CardOfRepo> => {
      try {
        return { kind: "ok", repo: id, ...(await this.tagged(id, path, rules)) };
      } catch (err) {
        return { kind: "unavailable", repo: id, message: messageOf(err) };
      }
    });
  }

  /**
   * The repo card and its tags, from the remote address (without it only from the identifier), from the mise tasks of
   * `mise.local.toml` (ADR-86) and from the rules.
   */
  private async tagged(id: string, dir: string, rules: RepoTagRules): Promise<TaggedCard> {
    const [card, remote, local] = await Promise.all([this.cardOf(dir), this.deps.vcs.remote(dir).catch(() => null), localMiseTasks(dir)]);
    return { card, remote, tags: repoTags(card, { id, remote, localMiseTasks: local.length }, rules) };
  }

  /** The card of the HEAD commit of the repo in directory `dir`; `null` in a repo without commits. */
  private async cardOf(dir: string): Promise<RepoCard | null> {
    const commit = await this.deps.vcs.headCommit(dir);
    if (commit === null) return null;
    return this.deps.cache.getOrCompute(commit, async () => {
      const known = { accepts: CALL_SOURCES, kept: (oid: string) => this.callReads.get(oid) };
      const snapshot = await readSnapshot(this.deps.vcs, dir, commit, readsCardFile, CARD_SOURCES, known, CARD_DOCUMENTS);
      const syntax = await syntaxParsersOrUnavailable();
      const calls = await readCallFiles(snapshot.callSources, syntax, this.callReads);
      const parsers = withParseBudget(syntax, CARD_PARSE_BUDGET_MS);
      const card = extractCard(snapshot, parsers, calls);
      // A card without some syntax trees (time, no parser) depends on the moment of computing, so it does not go to disk.
      return { card, persist: parsers.complete && calls.complete };
    });
  }
}

/** Without grammars the card is still built, only without endpoint contracts and DTOs. */
async function syntaxParsersOrUnavailable(): Promise<SyntaxParsers> {
  try {
    return await loadSyntaxParsers();
  } catch (err) {
    return unavailableParsers(messageOf(err));
  }
}
