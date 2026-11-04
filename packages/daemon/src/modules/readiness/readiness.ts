import {
  type ConventionTasksState,
  type GraphProblem,
  type MiseTasks,
  type ReadinessReport,
  type RepoCard,
  type RepoReadiness,
  readinessState,
} from "@trackwall/protocol";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { type CardState, repoGaps } from "./repo-gaps.ts";

/**
 * The `readiness` module (§4.25, ADR-201): how ready each repo is for agents, as the gaps that stand in their way. It joins
 * what other modules already know (`mise tasks ls`, the card, the graph's unresolved HTTP clients) and changes nothing.
 * `mise tasks ls` is the one costly part, a program start per repo, so its answer is kept per commit until the user
 * trusts the repo's config in Trackwall (`forget`) or asks for a fresh check, as the UI does after writing the convention
 * tasks; a change made outside Trackwall without a commit (`mise trust` in a terminal, a new `mise.local.toml`) shows
 * after a fresh check.
 */

/** A repo's card as `cards` gives it. */
export type ReadinessCard = { kind: "ok"; repo: string; card: RepoCard | null } | { kind: "unavailable"; repo: string; message: string };

export interface ReadinessDeps {
  cards: () => Promise<ReadinessCard[]>;
  graphProblems: () => Promise<GraphProblem[]>;
  mise: {
    tasks(repo: string): Promise<MiseTasks>;
    conventionTasks(): Promise<ConventionTasksState>;
  };
  now: () => Date;
}

/** mise starts per repo at once: enough to check a hundred repos in seconds without crowding a slow Windows machine. */
const MISE_AT_ONCE = 4;

export class Readiness {
  private readonly deps: ReadinessDeps;
  /** `mise tasks ls` per repo with the commit it was asked at; a repo without a card is asked every time. */
  private readonly miseByRepo = new Map<string, { commit: string; tasks: MiseTasks }>();

  constructor(deps: ReadinessDeps) {
    this.deps = deps;
  }

  async all(fresh: boolean): Promise<ReadinessReport> {
    if (fresh) this.miseByRepo.clear();
    const [cards, problems, convention] = await Promise.all([
      this.deps.cards(),
      this.deps.graphProblems(),
      this.deps.mise.conventionTasks(),
    ]);
    const repos = await mapLimit(cards, MISE_AT_ONCE, (card) => this.readiness(card, problems));
    return { repos, conventionTasks: convention.state, checkedAt: this.deps.now().toISOString() };
  }

  async repo(repo: string): Promise<RepoReadiness> {
    this.miseByRepo.delete(repo);
    const [cards, problems] = await Promise.all([this.deps.cards(), this.deps.graphProblems()]);
    const card = cards.find((c) => c.repo === repo);
    if (card === undefined) throw new DomainError("not_found", `no repo "${repo}" in the projects folder`);
    return this.readiness(card, problems);
  }

  /** The user trusted the repo's mise config in Trackwall, which changes its answer without a new commit. */
  forget(repo: string): void {
    this.miseByRepo.delete(repo);
  }

  private async readiness(card: ReadinessCard, problems: readonly GraphProblem[]): Promise<RepoReadiness> {
    const state: CardState = card.kind === "ok" ? { kind: "ok", card: card.card } : { kind: "unavailable", message: card.message };
    const commit = card.kind === "ok" ? (card.card?.commit ?? null) : null;
    const gaps = repoGaps({
      mise: await this.miseTasks(card.repo, commit),
      card: state,
      unresolvedCalls: problems.filter((p) => p.repo === card.repo && p.code === "unresolved-call-target").length,
    });
    return { repo: card.repo, state: readinessState(gaps), gaps };
  }

  private async miseTasks(repo: string, commit: string | null): Promise<MiseTasks> {
    const known = this.miseByRepo.get(repo);
    if (known !== undefined && commit !== null && known.commit === commit) return known.tasks;
    // A repo removed between the card list and this question is not a reason to fail the whole report.
    const tasks = await this.deps.mise
      .tasks(repo)
      .catch((err: unknown): MiseTasks => ({ kind: "error", message: messageOf(err), running: [] }));
    if (commit !== null) this.miseByRepo.set(repo, { commit, tasks });
    return tasks;
  }
}
