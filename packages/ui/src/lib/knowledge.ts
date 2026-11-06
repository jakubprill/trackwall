import type { KnowledgeEntry, KnowledgeKind, KnowledgeListEntry, Task } from "@trackwall/protocol";

/**
 * The logic of workspace knowledge in Plan (ADR-170): the kinds' names, the order of the list, and what the user should
 * look at twice before approving an agent's proposal. The checks are hints for the user's review, not a filter: the
 * approval is the guard, and these only point at what a misled agent would most likely slip in.
 */

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  "how-to": "How to",
  relation: "Relation",
  exception: "Exception",
  pitfall: "Pitfall",
};

const URL = /\bhttps?:\/\/|\bwww\./i;
/** Words an injected instruction to an agent tends to use, as opposed to a fact about a repo. */
const INSTRUCTION =
  /\b(ignore|disregard|forget|you must|do not tell|don't tell|system prompt|previous instructions|send|upload|exfiltrat\w*)\b/i;
/** A key named like a secret with a value after it, or a long run of token characters. */
const SECRET = /\b(password|passwd|token|secret|api[-_ ]?key)\b\s*[:=]\s*\S|[A-Za-z0-9+/_-]{32,}/i;

/** What the user should check in an entry before approving it; empty when nothing stands out. */
export function knowledgeWarnings(entry: Pick<KnowledgeEntry, "text">): string[] {
  const warnings: string[] = [];
  if (URL.test(entry.text)) warnings.push("It has a web address: check where it points before agents read it.");
  if (INSTRUCTION.test(entry.text)) warnings.push("It reads like an instruction to agents rather than a fact about a repo.");
  if (SECRET.test(entry.text)) warnings.push("It may hold a secret value; agents and their logs would see it.");
  return warnings;
}

/**
 * Whether an entry is about one repo only and not a link between repos: such a fact may belong in that repo's own agent
 * instructions, where its whole team and every agent outside Trackwall would read it.
 */
export function mayBelongInRepo(entry: Pick<KnowledgeEntry, "kind" | "repos">): boolean {
  return entry.repos.length === 1 && entry.kind !== "relation";
}

/** Proposals waiting for the user first, then the approved entries, each by name. */
export function knowledgeOrder(entries: readonly KnowledgeListEntry[]): KnowledgeListEntry[] {
  return [...entries].sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name));
}

/** The repos an entry is about, as the user types them: ids separated by commas or spaces. */
export function parseRepos(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((repo) => repo.trim())
    .filter((repo) => repo !== "");
}

/** What the list of knowledge shows (ADR-216): the words to find, one kind or all, one repo or any. */
export interface KnowledgeFilter {
  query: string;
  kind: KnowledgeKind | "all";
  /** A repo id, or `"any"`; an entry for the whole workspace is about every repo. */
  repo: string;
}

export const NO_KNOWLEDGE_FILTER: KnowledgeFilter = { query: "", kind: "all", repo: "any" };

/** Whether an entry passes the filter: every word of the query in its text, name or repos, ignoring case. */
function matchesKnowledge(entry: KnowledgeListEntry, filter: KnowledgeFilter): boolean {
  if (filter.kind !== "all" && entry.kind !== filter.kind) return false;
  if (filter.repo !== "any" && entry.repos.length > 0 && !entry.repos.includes(filter.repo)) return false;
  const haystack = [entry.text, entry.name, ...entry.repos].join(" ").toLowerCase();
  return filter.query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** The entries the filter lets through, split into those waiting for the user's approval and the approved, each by name. */
export function knowledgeSections(
  entries: readonly KnowledgeListEntry[],
  filter: KnowledgeFilter,
): { toApprove: KnowledgeListEntry[]; approved: KnowledgeListEntry[] } {
  const shown = knowledgeOrder(entries).filter((entry) => matchesKnowledge(entry, filter));
  return { toApprove: shown.filter((entry) => !entry.approved), approved: shown.filter((entry) => entry.approved) };
}

/** How many entries of each kind the search and the repo let through, for the counts on the kind filter. */
export function kindCounts(entries: readonly KnowledgeListEntry[], filter: KnowledgeFilter): Record<KnowledgeKind | "all", number> {
  const counts: Record<KnowledgeKind | "all", number> = { all: 0, "how-to": 0, relation: 0, exception: 0, pitfall: 0 };
  for (const entry of entries) {
    if (!matchesKnowledge(entry, { ...filter, kind: "all" })) continue;
    counts.all += 1;
    counts[entry.kind] += 1;
  }
  return counts;
}

/** The repos the entries name, sorted, for the repo filter. */
export function knowledgeRepos(entries: readonly KnowledgeListEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.repos))].sort((a, b) => a.localeCompare(b));
}

/**
 * Who wrote an entry, as its row says it. The author is in the entry's file, which anything can write: an entry not yet
 * approved that claims the user wrote it was written outside Trackwall, since the user's own entry is approved as
 * written. An agent's names the task it worked on while that task is listed.
 */
export function knowledgeAuthor(entry: KnowledgeListEntry, tasks: readonly Task[]): string {
  if (entry.writtenBy.kind === "user") return entry.approved ? "you" : "written outside Trackwall";
  const id = entry.writtenBy.task;
  const task = id === null ? undefined : tasks.find((t) => t.id === id);
  return task ? `agent in ${task.title ?? task.repo}` : "an agent";
}

/** The entry the right column shows: the selected one while listed, else the first waiting for approval, else the first. */
export function shownEntry(entries: readonly KnowledgeListEntry[], selected: string | undefined): KnowledgeListEntry | undefined {
  return entries.find((entry) => entry.name === selected) ?? knowledgeOrder(entries)[0];
}
