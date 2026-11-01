import { z } from "zod";
import { visibleText } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { ContentDigest, fileName } from "./approved-file.ts";
import { BoardItemAuthor } from "./board.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `knowledge` module (ADR-170): workspace knowledge, short facts about the user's repos that an agent
 * cannot read cheaply from code or a repo card and that hold across tasks, such as which mise task runs the integration
 * tests or that one service reads another's events from a queue. Each entry is a Markdown file in `.trackwall/knowledge`
 * of the projects folder. The user writes entries, and agents propose them; an entry reaches the instructions of later
 * sessions only in the exact content the user approved, because it is text every later session reads (§8). Every action
 * is `POST /api/knowledge/<action>`.
 */

/** The entry's name, also its file name without `.md`, e.g. `orders-integration-tests`. */
export const KNOWLEDGE_NAME_MAX = 60;
export const KnowledgeName = fileName(KNOWLEDGE_NAME_MAX, "an entry name");
export type KnowledgeName = z.infer<typeof KnowledgeName>;

/**
 * A fixed list of kinds rather than free notes, so the folder stays a set of facts and not a diary: `how-to` (how to
 * build, run or test something when the convention does not say), `relation` (a link between repos the connection graph
 * does not see: a queue, a shared database, a deployment order), `exception` (where a repo departs from a rule it would
 * otherwise follow), `pitfall` (a trap learned the hard way: a flaky test, a step that needs something first).
 */
export const KnowledgeKind = z.enum(["how-to", "relation", "exception", "pitfall"]);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

/**
 * Text the user reads in Plan exactly as a session reads it: no invisible characters (`visibleText`) and no control
 * characters but line breaks and tabs, since a lone carriage return is a line break in the session's Markdown while the
 * UI shows it as a space.
 */
function plainText(text: z.ZodString): z.ZodString {
  return visibleText(text).refine((value) => !/[^\P{Cc}\n\t]/u.test(value), {
    message: "the text must not contain control characters other than line breaks and tabs",
  });
}

/** Short, because every session in the entry's repos reads it in its instructions. */
export const KNOWLEDGE_TEXT_MAX = 500;
export const KnowledgeText = plainText(z.string().trim().min(1).max(KNOWLEDGE_TEXT_MAX));

/** How the writer knows it (a command and its outcome, a file); shown to the user, not to sessions or `list_knowledge`. */
export const KNOWLEDGE_EVIDENCE_MAX = 500;
export const KnowledgeEvidence = plainText(z.string().trim().max(KNOWLEDGE_EVIDENCE_MAX));

/** The repos the entry is about; empty for the whole workspace. */
export const KNOWLEDGE_REPOS_MAX = 20;
export const KnowledgeRepos = z.array(RepoId).max(KNOWLEDGE_REPOS_MAX);

/**
 * An entry as its file holds it. The fields are checked like an agent's proposal (`visibleText`) also when read from the
 * file, since anything with file tools in the projects folder can write it.
 */
export const KnowledgeEntry = z.object({
  name: KnowledgeName,
  kind: KnowledgeKind,
  repos: KnowledgeRepos,
  /** The fact itself: the file's body below the frontmatter. */
  text: KnowledgeText,
  evidence: KnowledgeEvidence,
  /** The user in the UI, or an agent over MCP with the task whose session wrote it. */
  writtenBy: BoardItemAuthor,
  /** ISO 8601. */
  updatedAt: z.string(),
});
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

/** An entry on the list: with its file's digest and whether the user approved exactly that content. */
export const KnowledgeListEntry = KnowledgeEntry.extend({ digest: ContentDigest, approved: z.boolean() });
export type KnowledgeListEntry = z.infer<typeof KnowledgeListEntry>;

/** A file of the knowledge folder the daemon could not read; no session gets it, and the list goes on without it. */
export const KnowledgeProblem = z.object({ file: z.string(), message: z.string() });
export type KnowledgeProblem = z.infer<typeof KnowledgeProblem>;

export const KnowledgeList = z.object({
  /** By name. */
  entries: z.array(KnowledgeListEntry),
  problems: z.array(KnowledgeProblem),
});
export type KnowledgeList = z.infer<typeof KnowledgeList>;

/** An entry as agents read it, in their instructions and from `list_knowledge`: without the evidence, which is for the user. */
export const AgentKnowledgeEntry = KnowledgeEntry.omit({ evidence: true });
export type AgentKnowledgeEntry = z.infer<typeof AgentKnowledgeEntry>;

/** The approved entries a session's instructions carry (ADR-170), and how many more about its place it can list. */
export interface SessionKnowledge {
  entries: readonly AgentKnowledgeEntry[];
  more: number;
}

/** Whether an entry is about `repo`: one about no repo is about the whole workspace. */
export function knowledgeIsAbout(entry: Pick<KnowledgeEntry, "repos">, repo: string): boolean {
  return entry.repos.length === 0 || entry.repos.includes(repo);
}

const endpoint = apiEndpoints("knowledge");

export const knowledgeApi = {
  /** Every entry with whether it is approved; `projects_dir_unavailable` or `bad_request` without a projects folder. */
  list: endpoint("list", z.object({}).strict(), KnowledgeList),
  /** Writes an entry as the user typed it, new or in place of one with the same name; the user's own entry is approved. */
  write: endpoint(
    "write",
    z
      .object({
        name: KnowledgeName,
        kind: KnowledgeKind,
        repos: KnowledgeRepos,
        text: KnowledgeText,
        evidence: KnowledgeEvidence.default(""),
      })
      .strict(),
    KnowledgeListEntry,
  ),
  /** Approves the entry's content as the user read it; refused (`bad_request`) when the file changed since. */
  approve: endpoint("approve", z.object({ name: KnowledgeName, digest: ContentDigest }).strict(), KnowledgeListEntry),
  /** Removes the entry's file and its approval. */
  remove: endpoint("remove", z.object({ name: KnowledgeName }).strict(), Done),
};
