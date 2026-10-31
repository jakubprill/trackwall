import {
  type AppConfig,
  type CardWarmupProgress,
  type EndpointChanges,
  MISE_CONFIG_FILE,
  type RepoCard,
  type RepoCardResult,
  type RepoTag,
  type RepoTagRules,
  type RepoTags,
} from "@trackwall/protocol";
import { configOrProblem, DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { type AppConfigEnv, type AppConfigQuery, appConfigView } from "./app-config.ts";
import { CallReads, readCallFiles } from "./call-files.ts";
import type { CardCache } from "./card-cache.ts";
import { CardWarmup, type WarmupRepo } from "./card-warmup.ts";
import { endpointChanges } from "./endpoint-changes.ts";
import { CALL_SOURCES, CARD_DOCUMENTS, CARD_SOURCES, extractCard, readsCardFile } from "./extract-card.ts";
import { localMiseTasks } from "./local-mise.ts";
import { readSnapshot, type SnapshotVcs } from "./read-snapshot.ts";
import { readSpringConfigs } from "./spring-config.ts";
import { CARD_PARSE_BUDGET_MS, loadSyntaxParsers, type SyntaxParsers, unavailableParsers, withParseBudget } from "./syntax-tree.ts";
import { repoTags } from "./tags.ts";
import { readWorkingConfig, type WorkingConfigVcs } from "./working-config.ts";

/**
 * The `cards` module (§4, §4.6, ADR-25, ADR-30): the repo card from build, configuration and HTTP code files in the HEAD
 * commit, computed once per commit (`CardCache`), and repo tags from the card and from the rules in `workspace.yaml`. No
 * LLM: every field has evidence. The `graph` module computes the graph from the cards with `all()` (ADR-29).
 */

/** What `cards` needs from `vcs`; wired in the facade. */
interface CardsVcs extends SnapshotVcs, WorkingConfigVcs {
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
   * the local mise config (ADR-86, ADR-110) and from the rules.
   */
  private async tagged(id: string, dir: string, rules: RepoTagRules): Promise<TaggedCard> {
    const [card, remote] = await Promise.all([this.cardOf(dir), this.deps.vcs.remote(dir).catch(() => null)]);
    const localMise = await localMiseTasks(dir, card?.mise.configFiles.includes(MISE_CONFIG_FILE) ?? false);
    return { card, remote, tags: repoTags(card, { id, remote, localMiseTasks: localMise }, rules) };
  }

  /** The card of the HEAD commit of the repo in directory `dir`; `null` in a repo without commits. */
  private async cardOf(dir: string): Promise<RepoCard | null> {
    const commit = await this.deps.vcs.headCommit(dir);
    return commit === null ? null : this.cardAt(dir, commit);
  }

  /**
   * The endpoints the commits of the worktree in `dir`, a worktree of repo `repo`, change against commit `base` (ADR-145),
   * from the cards of both commits, with both cards' problems; uncommitted work is not in a card (ADR-14).
   */
  async endpointChanges(repo: string, dir: string, base: string): Promise<EndpointChanges> {
    const { head, before, after } = await this.cardsOfWorktree(repo, dir, base).catch((err: unknown) => {
      throw err instanceof DomainError ? err : new DomainError("repo_unavailable", `${repo}: ${messageOf(err)}`);
    });
    const problems = [
      ...before.problems.map((p) => ({ ...p, commit: "base" as const })),
      ...after.problems.map((p) => ({ ...p, commit: "head" as const })),
    ];
    return { head, ...endpointChanges(before, after), problems };
  }

  /** The cards of commit `base` and of the HEAD of the worktree in `dir`; git's failures as they come. */
  private async cardsOfWorktree(repo: string, dir: string, base: string): Promise<{ head: string; before: RepoCard; after: RepoCard }> {
    const head = await this.deps.vcs.headCommit(dir);
    if (head === null) throw new DomainError("repo_unavailable", `${repo}: the task's worktree has no commit`);
    const [before, after] = await Promise.all([this.cardAt(dir, base), this.cardAt(dir, head)]);
    return { head, before, after };
  }

  /**
   * The Spring configuration in the working directory `dir` (a repo root or a task's worktree) in one profile's view,
   * judged against the environment of a run there (ADR-153). Not cached: the files change without a commit.
   */
  async appConfig(
    dir: string,
    query: AppConfigQuery,
    env: AppConfigEnv,
  ): Promise<Pick<AppConfig, "files" | "modules" | "truncated" | "problems">> {
    const files = await readWorkingConfig(this.deps.vcs, dir);
    const out = { problems: [...files.problems] };
    const { expansionCut, ...view } = appConfigView(readSpringConfigs(files, out), query, env);
    if (expansionCut)
      out.problems.push({ code: "truncated", path: "", message: "too many placeholders to expand; the rest are left unexpanded" });
    return { files: files.paths, ...view, problems: out.problems.map((p) => ({ ...p, message: env.mask(p.message) })) };
  }

  private async cardAt(dir: string, commit: string): Promise<RepoCard> {
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
