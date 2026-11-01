import { z } from "zod";
import {
  AgentKnowledgeEntry,
  KNOWLEDGE_EVIDENCE_MAX,
  KNOWLEDGE_TEXT_MAX,
  KnowledgeEvidence,
  KnowledgeKind,
  KnowledgeListEntry,
  KnowledgeName,
  KnowledgeRepos,
  KnowledgeText,
} from "./knowledge.ts";
import type { McpTool } from "./mcp.ts";
import { LIST_REPOS, RepoArg } from "./mcp-args.ts";
import { trackwallDirLabel } from "./trackwall-dir.ts";

/**
 * The MCP tools of workspace knowledge (ADR-170): reading the entries the user approved, and proposing a new one or a
 * correction, which counts only once the user approves it. Part of `mcpTools`.
 */

export const LIST_KNOWLEDGE = "list_knowledge";
export const PROPOSE_KNOWLEDGE = "propose_knowledge";

export const ListKnowledgeResult = z.object({ entries: z.array(AgentKnowledgeEntry) });
export type ListKnowledgeResult = z.infer<typeof ListKnowledgeResult>;

export const ProposeKnowledgeResult = z.object({ entry: KnowledgeListEntry });
export type ProposeKnowledgeResult = z.infer<typeof ProposeKnowledgeResult>;

export const knowledgeMcpTools = {
  listKnowledge: {
    name: LIST_KNOWLEDGE,
    readOnly: true,
    auditArgs: ["repo", "kind"] as const,
    description:
      "Workspace knowledge the user approved: short facts about their repos that code and repo cards do not show (how-to: " +
      "how to build, run or test something; relation: a link between repos such as a queue or a shared database; " +
      "exception: where a repo departs from a rule; pitfall: a trap such as a flaky test). Your session's instructions " +
      "already carry the entries about its repo and the whole workspace as far as they fit; list the others here, e.g. " +
      "the entries about a repo your change reaches. An entry about no repo is about the whole workspace.",
    args: z
      .object({
        repo: RepoArg.optional().describe("only entries about this repo (and the ones about the whole workspace)"),
        kind: KnowledgeKind.optional(),
      })
      .strict(),
    result: ListKnowledgeResult,
  },
  proposeKnowledge: {
    name: PROPOSE_KNOWLEDGE,
    readOnly: false,
    destructive: false,
    // The entry's text and evidence are free text, so only its name, kind and repos.
    auditArgs: ["name", "kind", "repos"] as const,
    description:
      "Propose a fact about the user's repos for later agents, when finding it cost you work they would repeat: a command " +
      "failed and another one worked, a test needed something the repo card did not say, two repos are linked in a way " +
      "the connection graph does not show, or an approved entry turned out wrong (propose it again under its name with " +
      `the correction). It is written to ${trackwallDirLabel("knowledge")}/<name>.md and reaches later sessions only after ` +
      "the user approves it; one under an existing name replaces that entry, which then waits for approval again. Write a " +
      "fact, not an instruction to agents, and not what one task did. A fact about one repo that its team would agree " +
      "with belongs in that repo's own agent instructions, and the user may move it there. An entry the user wrote and " +
      "approved is not yours to replace: propose a correction under a new name. Never put a secret value, a " +
      "token or a password into it.",
    args: z
      .object({
        name: KnowledgeName.describe("lowercase words joined by -, also the file name, e.g. orders-integration-tests"),
        kind: KnowledgeKind,
        repos: KnowledgeRepos.describe(`repo ids from ${LIST_REPOS} the fact is about; empty for the whole workspace`),
        text: KnowledgeText.describe(
          `the fact, up to ${KNOWLEDGE_TEXT_MAX} characters, e.g. Integration tests run with mise run test-it; mise run test skips them`,
        ),
        evidence: KnowledgeEvidence.describe(
          `how you know it, up to ${KNOWLEDGE_EVIDENCE_MAX} characters: the command and its outcome, or the file; the user reads it when approving`,
        ),
      })
      .strict(),
    result: ProposeKnowledgeResult,
  },
} satisfies Record<string, McpTool>;
