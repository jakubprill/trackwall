import { z } from "zod";
import { Done, type Endpoint } from "./api.ts";
import { ExternalLink, RepoId } from "./workspace.ts";

/**
 * Contract of the `board` module (ADR-133): the user's own layer of work under the issue tracker. A board item is an idea,
 * a piece of work or a business project; items form a tree, the way the user splits a project into business tasks, those
 * into technical ones and those again while working, and a leaf becomes an agent task (`Task.item`). Nothing starts from
 * an item by itself and items have no dependencies (ADR-9): the tree only records how the user split the work. Every
 * action is `POST /api/board/<action>`.
 */

export const BoardItemId = z.uuid();
export type BoardItemId = z.infer<typeof BoardItemId>;

/**
 * `project`: a business project, a root of the tree, made only in the UI. `item`: everything below it, and an idea in
 * the inbox (an item without a parent), which waits there until the user files it under a project.
 */
export const BoardItemKind = z.enum(["project", "item"]);
export type BoardItemKind = z.infer<typeof BoardItemKind>;

/**
 * Where an item stands. A project uses `done` and `dropped` for "archived". Since ADR-133 only stored; later stages
 * derive `in_progress` and `review` from the item's tasks.
 */
export const BoardColumn = z.enum(["ideas", "ready", "in_progress", "review", "done", "dropped"]);
export type BoardColumn = z.infer<typeof BoardColumn>;

/** The columns an agent may move an item between: the user decides when work starts, ends or is dropped. */
export const AgentBoardColumn = z.enum(["ideas", "ready"]);
export type AgentBoardColumn = z.infer<typeof AgentBoardColumn>;

export const BOARD_ITEM_TITLE_MAX = 120;
/** One line without control characters, like a task title: the tree and the inbox show it on a single line. */
export const BoardItemTitle = z
  .string()
  .trim()
  .min(1)
  .max(BOARD_ITEM_TITLE_MAX)
  // `refine` instead of `regex`, as in `TaskTitle`.
  .refine((value) => !/\p{Cc}/u.test(value), { message: "the title must be a single line without control characters" });

/** Markdown: the plan, notes, acceptance criteria. Longer than a task prompt; "Start task" offers its start. */
export const BOARD_ITEM_BODY_MAX = 20_000;
export const BoardItemBody = z.string().max(BOARD_ITEM_BODY_MAX);

/** Repos an item is about, so "Start task" offers them first; a task still chooses one. */
export const BOARD_ITEM_REPOS_MAX = 20;
export const BoardItemRepos = z.array(RepoId).max(BOARD_ITEM_REPOS_MAX);

/** Who wrote an item: the user in the UI, or an agent over MCP (`task`: the task whose session wrote it, if any). */
export const BoardItemAuthor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  // A task id; `TaskId` lives in `agents.ts`, which imports this file for `Task.item`.
  z.object({ kind: z.literal("agent"), task: z.uuid().nullable() }),
]);
export type BoardItemAuthor = z.infer<typeof BoardItemAuthor>;

export const BoardItem = z.object({
  id: BoardItemId,
  kind: BoardItemKind,
  // The same limits as when it is written, since a file in the projects folder can also be written by hand (§8).
  title: BoardItemTitle,
  body: BoardItemBody,
  /** The item above it; `null` for a project and for an idea in the inbox. */
  parent: BoardItemId.nullable(),
  column: BoardColumn,
  /** The place among its siblings, smallest first; ties by `createdAt`. */
  order: z.number(),
  repos: BoardItemRepos,
  /** The item's ticket or page in the issue tracker; Trackwall only links to it (ADR-133). */
  link: ExternalLink.nullable(),
  createdBy: BoardItemAuthor,
  /** ISO 8601. */
  createdAt: z.string(),
  /** ISO 8601. */
  updatedAt: z.string(),
});
export type BoardItem = z.infer<typeof BoardItem>;

/** The order of siblings, here and in the Plan view: by `order`, ties by when they were made. */
export function compareSiblings(a: BoardItem, b: BoardItem): number {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
}

/** Items right under `parent` (`null`: the ideas in the inbox) in their order; a project is never anyone's child. */
export function childrenOf(items: readonly BoardItem[], parent: string | null): BoardItem[] {
  return items.filter((it) => it.kind === "item" && it.parent === parent).sort(compareSiblings);
}

/** The items above `item`, from the top (its project) down to its parent; a cycle in hand-edited files ends the walk. */
export function ancestorsOf(items: readonly BoardItem[], item: BoardItem): BoardItem[] {
  const above: BoardItem[] = [];
  const seen = new Set([item.id]);
  for (let at = items.find((it) => it.id === item.parent); at !== undefined && !seen.has(at.id); ) {
    above.unshift(at);
    seen.add(at.id);
    const parent = at.parent;
    at = items.find((it) => it.id === parent);
  }
  return above;
}

/** A file of the board folder the daemon could not read; it is left as it is, and the board goes on without it. */
export const BoardProblem = z.object({ file: z.string(), message: z.string() });
export type BoardProblem = z.infer<typeof BoardProblem>;

export const Board = z.object({
  /** Every item, in no particular order; the tree comes from `parent` and `order`. */
  items: z.array(BoardItem),
  problems: z.array(BoardProblem),
});
export type Board = z.infer<typeof Board>;

/** The board's revision for `/ws` (`board.changed`): it grows with every change the daemon makes. */
export const BoardRevision = z.object({ revision: z.number().int().nonnegative() });
export type BoardRevision = z.infer<typeof BoardRevision>;

const ItemRequest = z.object({ item: BoardItemId }).strict();

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/board/${action}`, request, data };
}

export const boardApi = {
  /** The whole board; `projects_dir_unavailable` or `bad_request` without a projects folder, like the repo list. */
  board: endpoint("board", z.object({}).strict(), Board),
  /**
   * A new project or item at the end of its siblings. A project has no parent; an item's parent is a project or an item,
   * and without one the item is an idea in the inbox.
   */
  create: endpoint(
    "create",
    z
      .object({
        kind: BoardItemKind,
        title: BoardItemTitle,
        body: BoardItemBody.default(""),
        parent: BoardItemId.nullable().default(null),
        repos: BoardItemRepos.default([]),
        link: ExternalLink.nullable().default(null),
        column: BoardColumn.default("ideas"),
      })
      .strict(),
    BoardItem,
  ),
  /** Changes the fields given; the rest stay. */
  update: endpoint(
    "update",
    ItemRequest.extend({
      title: BoardItemTitle.optional(),
      body: BoardItemBody.optional(),
      repos: BoardItemRepos.optional(),
      link: ExternalLink.nullable().optional(),
      column: BoardColumn.optional(),
    }),
    BoardItem,
  ),
  /**
   * Moves an item under `parent` (`null`: back to the inbox), before the sibling `before` (`null`: last). A project does
   * not move, and an item cannot go under itself or its own descendant.
   */
  move: endpoint("move", ItemRequest.extend({ parent: BoardItemId.nullable(), before: BoardItemId.nullable() }), BoardItem),
  /** Deletes an item's file; refused while it has children, so a subtree is never lost by one click. */
  remove: endpoint("remove", ItemRequest, Done),
};

/** What `board/update` changes on an item: only the fields given. */
export type BoardItemChange = Omit<z.infer<typeof boardApi.update.request>, "item">;
