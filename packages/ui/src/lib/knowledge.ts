import type { KnowledgeEntry, KnowledgeKind, KnowledgeListEntry } from "@trackwall/protocol";

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
