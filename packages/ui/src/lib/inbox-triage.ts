import { type BoardItem, childrenOf, type Task } from "@trackwall/protocol";
import { isArchived, projectsOf } from "./board-tree.ts";

/**
 * The inbox of Plan as a place to sort ideas (ADR-214): the open ideas newest first in groups by the day they were
 * written, who wrote each, the projects to file one in with those that work in its repos first, and the keys that sort
 * them. A dropped idea stays on the board, folded under the open ones, until the user removes it. Nothing here guesses
 * with a model: a project is offered first only when its items name one of the idea's repos.
 */

/** Which ideas the inbox shows: all, the ones agents wrote while working, or the user's own. */
export type InboxFilter = "all" | "agents" | "mine";

export const INBOX_FILTERS: readonly { filter: InboxFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "agents", label: "From agents" },
  { filter: "mine", label: "Mine" },
];

/** The inbox's ideas: items without a parent, open ones and dropped ones apart. */
export function inboxIdeas(items: readonly BoardItem[]): { open: BoardItem[]; dropped: BoardItem[] } {
  const ideas = childrenOf(items, null).sort(newestFirst);
  return { open: ideas.filter((it) => it.column !== "dropped"), dropped: ideas.filter((it) => it.column === "dropped") };
}

function newestFirst(a: BoardItem, b: BoardItem): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export function matchesFilter(idea: BoardItem, filter: InboxFilter): boolean {
  if (filter === "all") return true;
  return (idea.createdBy.kind === "agent") === (filter === "agents");
}

export type IdeaAge = "today" | "week" | "older";

export const IDEA_AGE_LABELS: Record<IdeaAge, string> = { today: "Today", week: "This week", older: "Older" };

const WEEK_DAYS = 7;

/** Today by the local calendar, this week within the last seven local days, older before that. */
export function ideaAge(createdAt: string, now: Date): IdeaAge {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const written = new Date(createdAt);
  if (written >= startOfToday) return "today";
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - (WEEK_DAYS - 1));
  return written >= startOfWeek ? "week" : "older";
}

/** Ideas in their age groups, newest group first, and only groups that have an idea. */
export function ideaGroups(ideas: readonly BoardItem[], now: Date): { age: IdeaAge; ideas: BoardItem[] }[] {
  const ages: IdeaAge[] = ["today", "week", "older"];
  return ages
    .map((age) => ({ age, ideas: ideas.filter((idea) => ideaAge(idea.createdAt, now) === age) }))
    .filter((group) => group.ideas.length > 0);
}

/**
 * Who wrote an idea, as its row says it: "you", or an agent with the title of the task it worked on; a task that has
 * ended since is no longer listed, so its title is gone too.
 */
export function ideaAuthor(idea: BoardItem, tasks: readonly Task[]): { agent: false } | { agent: true; task: Task | undefined } {
  if (idea.createdBy.kind === "user") return { agent: false };
  const id = idea.createdBy.task;
  return { agent: true, task: id === null ? undefined : tasks.find((t) => t.id === id) };
}

/** The first line of the notes, for the row under the title; empty without notes. */
export function noteLine(body: string): string {
  return body.trim().split("\n")[0]?.trim() ?? "";
}

/** A project to file an idea in, with the idea's repos that already have work in it. */
export interface FilingChoice {
  project: BoardItem;
  sharedRepos: string[];
}

/**
 * The active projects to file `idea` in: those whose items name one of the idea's repos first (more shared repos
 * first), then the rest in the order of the left column.
 */
export function filingChoices(items: readonly BoardItem[], idea: BoardItem): FilingChoice[] {
  const choices = projectsOf(items)
    .filter((project) => !isArchived(project))
    .map((project) => ({ project, sharedRepos: reposInProject(items, project.id).filter((repo) => idea.repos.includes(repo)) }));
  return choices
    .map((choice, at) => ({ choice, at }))
    .sort((x, y) => y.choice.sharedRepos.length - x.choice.sharedRepos.length || x.at - y.at)
    .map(({ choice }) => choice);
}

function reposInProject(items: readonly BoardItem[], project: string): string[] {
  const repos = new Set<string>();
  const seen = new Set<string>([project]);
  const walk = (parent: string) => {
    for (const item of childrenOf(items, parent)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      for (const repo of item.repos) repos.add(repo);
      walk(item.id);
    }
  };
  walk(project);
  return [...repos];
}

/** What a key on a focused inbox row does; `undefined` for any other key, which the row leaves alone. */
export type TriageKey =
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "file" }
  | { kind: "start" }
  | { kind: "drop" }
  | { kind: "file-in"; choice: number };

/** J or ↓, K or ↑, F, S, D, and with the project list open 1–9; only without Ctrl, Alt or ⌘, which other shortcuts use. */
export function triageKey(press: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey">, filing: boolean): TriageKey | undefined {
  if (press.ctrlKey || press.altKey || press.metaKey) return undefined;
  const key = press.key.toLowerCase();
  if (filing && /^[1-9]$/.test(key)) return { kind: "file-in", choice: Number(key) - 1 };
  if (key === "j" || key === "arrowdown") return { kind: "next" };
  if (key === "k" || key === "arrowup") return { kind: "previous" };
  if (key === "f") return { kind: "file" };
  if (key === "s") return { kind: "start" };
  if (key === "d") return { kind: "drop" };
  return undefined;
}

/** The idea one step from `current` in the shown order, staying at either end; the first one without a current. */
export function stepIdea(ideas: readonly BoardItem[], current: string | undefined, step: 1 | -1): string | undefined {
  const at = ideas.findIndex((idea) => idea.id === current);
  if (at === -1) return ideas[0]?.id;
  return ideas[Math.min(Math.max(at + step, 0), ideas.length - 1)]?.id;
}

/** The idea to select once `leaving` leaves the shown list: the one after it, or before it at the end. */
export function ideaAfter(ideas: readonly BoardItem[], leaving: string): string | undefined {
  const at = ideas.findIndex((idea) => idea.id === leaving);
  if (at === -1) return ideas[0]?.id;
  return ideas[at + 1]?.id ?? ideas[at - 1]?.id;
}
