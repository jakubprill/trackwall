import {
  type ConventionTasksState,
  type GraphProblem,
  type MiseConfigCheck,
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
 * The `readiness` module (§4.26, ADR-208): how ready each repo is for agents, as the gaps that stand in their way. It joins
 * what other modules already know (`mise tasks ls` and mise's check of the config, the card, the graph's unresolved HTTP
 * clients) and changes nothing. mise is the one costly part, three program starts per repo (`tasks ls`, `fmt --check`,
 * `tasks validate`), so a list it gave and its check are kept per commit until a fresh
 * check, which the UI asks for on "Check again" and after writing the convention tasks; a change to the tasks without a
 * commit (a new `mise.local.toml`) shows after one. Any other answer (untrusted, not installed, an error or a timeout) is
 * asked again every time, so trusting a config or installing mise shows at once.
 */

/** A repo's card as `cards` gives it (`Cards.all`), restated here because a module declares what it uses (§4). */
export type ReadinessCard = { kind: "ok"; repo: string; card: RepoCard | null } | { kind: "unavailable"; repo: string; message: string };

export interface ReadinessDeps {
  cards: () => Promise<ReadinessCard[]>;
  graphProblems: () => Promise<GraphProblem[]>;
  mise: {
    tasks(repo: string): Promise<MiseTasks>;
    configCheck(repo: string): Promise<MiseConfigCheck>;
    conventionTasks(): Promise<ConventionTasksState>;
  };
  now: () => Date;
}

/** What mise said about a repo: its task list, and the check of its config when mise could read it. */
interface MiseFacts {
  tasks: MiseTasks;
  config: MiseConfigCheck | null;
}

/** mise starts per repo at once: enough to check a hundred repos in seconds without crowding a slow Windows machine. */
const MISE_AT_ONCE = 4;

export class Readiness {
  private readonly deps: ReadinessDeps;
  /**
   * The task lists mise gave, with its check of the config, per repo with the commit they were asked at; a repo without
   * commits is asked every time.
   */
  private readonly miseByRepo = new Map<string, { commit: string; mise: MiseFacts }>();

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

  private async readiness(card: ReadinessCard, problems: readonly GraphProblem[]): Promise<RepoReadiness> {
    const state: CardState = card.kind === "ok" ? { kind: "ok", card: card.card } : { kind: "unavailable", message: card.message };
    const commit = card.kind === "ok" ? (card.card?.commit ?? null) : null;
    const mise = await this.miseFacts(card.repo, commit);
    const gaps = repoGaps({
      mise: mise.tasks,
      config: mise.config,
      card: state,
      unresolvedCalls: problems.filter((p) => p.repo === card.repo && p.code === "unresolved-call-target").length,
    });
    return { repo: card.repo, state: readinessState(gaps), gaps };
  }

  private async miseFacts(repo: string, commit: string | null): Promise<MiseFacts> {
    const known = this.miseByRepo.get(repo);
    if (known !== undefined && commit !== null && known.commit === commit) return known.mise;
    // A repo removed between the card list and this question is not a reason to fail the whole report.
    const tasks = await this.deps.mise
      .tasks(repo)
      .catch((err: unknown): MiseTasks => ({ kind: "error", message: messageOf(err), running: [] }));
    if (tasks.kind !== "ok") return { tasks, config: null };
    // Only a config mise reads can be checked; for any other the gap of `tasks` already says why.
    const config = await this.deps.mise
      .configCheck(repo)
      .catch((err: unknown): MiseConfigCheck => ({ unformatted: [], problems: [{ severity: "error", message: messageOf(err) }] }));
    const mise = { tasks, config };
    if (commit !== null) this.miseByRepo.set(repo, { commit, mise });
    return mise;
  }
}
