import { z } from "zod";
import { Task, visibleText } from "./agents.ts";
import {
  AgentBoardColumn,
  BOARD_ITEM_BODY_MAX,
  BOARD_ITEM_TITLE_MAX,
  BoardColumn,
  BoardItem,
  BoardItemBody,
  BoardItemId,
  BoardItemKind,
  BoardItemRepos,
  BoardItemTitle,
} from "./board.ts";
import type { McpTool } from "./mcp.ts";
import { LIST_REPOS, RepoArg } from "./mcp-args.ts";
import { ExternalLink } from "./workspace.ts";

/**
 * The MCP tools of the board (ADR-133, §4.18): reading the user's projects, items and ideas, and writing ideas and the
 * text of items. Part of `mcpTools`; a project, the tree and the columns past `ready` stay the user's.
 */

export const LIST_ITEMS = "list_items";
export const GET_ITEM = "get_item";
export const CREATE_ITEM = "create_item";
export const UPDATE_ITEM = "update_item";
export const ItemArg = BoardItemId.describe(`board item id from ${LIST_ITEMS} or ${GET_ITEM} (the id field)`);

/** How much of an item's body `list_items` returns; `get_item` gives the whole body. */
export const BOARD_EXCERPT_MAX = 280;

/** A board item in a list (ADR-133): without its body, but with its start and how many items and tasks hang under it. */
export const BoardItemSummary = BoardItem.omit({ body: true }).extend({
  excerpt: z.string(),
  children: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
});
export type BoardItemSummary = z.infer<typeof BoardItemSummary>;

export const ListItemsResult = z.object({ items: z.array(BoardItemSummary) });
export type ListItemsResult = z.infer<typeof ListItemsResult>;

export const GetItemResult = z.object({
  item: BoardItem,
  /** The items above it, from its project (or the first item without a parent) down to its parent. */
  path: z.array(BoardItem.pick({ id: true, kind: true, title: true })),
  children: z.array(BoardItemSummary),
  /** The tasks started on it, newest first. */
  tasks: z.array(Task),
});
export type GetItemResult = z.infer<typeof GetItemResult>;

export const BoardItemResult = z.object({ item: BoardItem });
export type BoardItemResult = z.infer<typeof BoardItemResult>;

export const boardMcpTools = {
  listItems: {
    name: LIST_ITEMS,
    readOnly: true,
    auditArgs: ["kind", "parent", "inbox", "column", "repo"] as const,
    description:
      "The user's board: business projects (kind project), the work split under them as a tree of items (kind item, " +
      "parent: the item or project above), and ideas in the inbox (items with no parent). Each comes with its column " +
      `(ideas, ready, in_progress, review, done, dropped), repos, link to the issue tracker, the first ${BOARD_EXCERPT_MAX} ` +
      "characters of its body (excerpt) and how many items (children) and tasks hang under it. Every argument narrows the " +
      `list: parent lists the items right under one item or project, inbox: true only the ideas without a place. Read one with ${GET_ITEM}.`,
    args: z
      .object({
        kind: BoardItemKind.optional(),
        parent: ItemArg.optional().describe("only the items right under this item or project"),
        inbox: z.boolean().optional().describe("true: only ideas in the inbox (items with no parent)"),
        column: BoardColumn.optional(),
        repo: RepoArg.optional().describe("only items about this repo"),
        query: z.string().trim().min(1).max(200).optional().describe("only items whose title or body contains this text, any case"),
      })
      .strict(),
    result: ListItemsResult,
  },
  getItem: {
    name: GET_ITEM,
    readOnly: true,
    auditArgs: ["item"] as const,
    description:
      "One board item with its whole body (Markdown: the plan, notes, acceptance criteria), the path from its project down " +
      "to it, the items right under it and the tasks started on it. Use it before you split an item or propose a task for it.",
    args: z.object({ item: ItemArg }).strict(),
    result: GetItemResult,
  },
  createItem: {
    name: CREATE_ITEM,
    readOnly: false,
    destructive: false,
    auditArgs: ["parent", "repos"] as const,
    description:
      "Write an idea or a piece of work on the user's board so it is not lost: when the user asks you to note something " +
      "for later, when you find work outside your task (a bug, a follow-up, a part that turns out bigger), or to split an " +
      `item into smaller ones under it (parent). It lands in the ideas column, marked as written by an agent; nothing starts ` +
      `from it, and the user files, starts or drops it. Without parent: a task session's item goes under the item of its ` +
      `own task, anyone else's into the inbox. Give a title that says what, up to ${BOARD_ITEM_TITLE_MAX} characters, and ` +
      "in body why and what you know, so the user can judge it later without you.",
    args: z
      .object({
        title: visibleText(BoardItemTitle).describe("one line, e.g. Retry the invoice export after a timeout"),
        body: visibleText(BoardItemBody)
          .default("")
          .describe(`Markdown, up to ${BOARD_ITEM_BODY_MAX} characters: why, what you found, where in the code`),
        parent: ItemArg.optional().describe("the item or project it belongs under"),
        repos: BoardItemRepos.optional().describe(`repo ids from ${LIST_REPOS} it is about`),
        link: ExternalLink.optional().describe("its ticket or page in the issue tracker, when there is one"),
      })
      .strict(),
    result: BoardItemResult,
  },
  updateItem: {
    name: UPDATE_ITEM,
    readOnly: false,
    destructive: false,
    auditArgs: ["item", "column"] as const,
    description:
      "Change a board item's title, body, repos or link, or move it between ideas and ready, for example after the user " +
      "agreed on its plan with you. Only the fields given change. Projects, other columns, moving in the tree and removing " +
      "are the user's, in Trackwall's Plan view.",
    args: z
      .object({
        item: ItemArg,
        title: visibleText(BoardItemTitle).optional(),
        body: visibleText(BoardItemBody).optional().describe("the whole new body, Markdown"),
        repos: BoardItemRepos.optional(),
        link: ExternalLink.nullable().optional(),
        column: AgentBoardColumn.optional(),
      })
      .strict(),
    result: BoardItemResult,
  },
} satisfies Record<string, McpTool>;
