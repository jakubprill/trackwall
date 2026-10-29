import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentBoardColumn,
  ancestorsOf,
  type BoardColumn,
  type BoardItem,
  type BoardItemAuthor,
  type BoardItemChange,
  type BoardItemKind,
  type BoardProblem,
  childrenOf,
} from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { readRegularFile } from "../../infra/regular-file.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { itemFileName, itemIdOfFile, readItemFile, writeItemFile } from "./board-file.ts";

/**
 * The board (ADR-133, §4.18): board items as files in `.trackwall/board` of the projects folder, beside the repos, so they
 * survive a rebuilt container with the repos and the user can read them in an editor. The daemon reads the folder on every
 * request, so an item edited by hand counts at once; its own writes go one at a time and raise the revision `/ws` sends.
 * The tree rules hold here: a project is a root, an item lies under a project or an item or in the inbox, never under
 * itself; nothing in an item starts work (ADR-9).
 */

/** Enough for a body of `BOARD_ITEM_BODY_MAX` characters in any script, with its frontmatter. */
const MAX_ITEM_FILE_BYTES = 128 * 1024;
/** Files read at most; a folder with more is a sign of something other than the user's board, and the rest is a problem. */
const MAX_ITEM_FILES = 5000;
/**
 * Items the board takes at most, well below the files it reads, so an agent writing ideas in a loop is refused before
 * the board stops reading the user's own items (§8).
 */
export const MAX_BOARD_ITEMS = 2000;
/** Files read at the same time: enough to hide the disk's latency, few enough to leave file handles for the rest. */
const READ_AT_ONCE = 16;

export interface BoardDeps {
  /** The projects folder; refused (`bad_request`, `projects_dir_unavailable`) when it is not set or not there. */
  projectsDir: () => Promise<string>;
}

export interface NewBoardItem {
  kind: BoardItemKind;
  title: string;
  body: string;
  parent: string | null;
  repos: string[];
  link: string | null;
  column: BoardColumn;
}

export class Board {
  readonly #deps: BoardDeps;
  #revision = 0;
  /** The write in progress: a write reads the board, so two at once would each miss the other's item. */
  #writing: Promise<unknown> = Promise.resolve();

  constructor(deps: BoardDeps) {
    this.#deps = deps;
  }

  /** Grows with every change the daemon makes, for the `board.changed` topic. */
  revision(): number {
    return this.#revision;
  }

  async board(): Promise<{ items: BoardItem[]; problems: BoardProblem[] }> {
    return readBoard(await this.#dir());
  }

  async item(id: string): Promise<BoardItem> {
    return found((await this.board()).items, id);
  }

  async has(id: string): Promise<boolean> {
    return (await this.board()).items.some((it) => it.id === id);
  }

  create(input: NewBoardItem, author: BoardItemAuthor): Promise<BoardItem> {
    return this.#write(async (items, dir) => {
      if (input.kind === "project" && input.parent !== null) throw new DomainError("bad_request", "a project has no parent");
      if (input.parent !== null) found(items, input.parent);
      if (items.length >= MAX_BOARD_ITEMS)
        throw new DomainError("bad_request", `the board holds ${MAX_BOARD_ITEMS} items, its limit; remove some in Plan first`);
      const now = new Date().toISOString();
      const item: BoardItem = {
        id: randomUUID(),
        ...input,
        order: lastOrder(items, input.kind, input.parent) + 1,
        createdBy: author,
        createdAt: now,
        updatedAt: now,
      };
      save(dir, item);
      return item;
    });
  }

  update(id: string, change: BoardItemChange): Promise<BoardItem> {
    return this.#write(async (items, dir) => {
      const item: BoardItem = { ...found(items, id), ...change, updatedAt: new Date().toISOString() };
      save(dir, item);
      return item;
    });
  }

  /** An agent's change (ADR-133): an item, not a project, and its column only between ideas and ready. */
  updateByAgent(id: string, change: Omit<BoardItemChange, "column"> & { column?: AgentBoardColumn }): Promise<BoardItem> {
    return this.#write(async (items, dir) => {
      const current = found(items, id);
      if (current.kind === "project") throw new DomainError("bad_request", "an agent changes items, not projects; ask the user");
      if (change.column !== undefined && current.column !== "ideas" && current.column !== "ready")
        throw new DomainError("bad_request", `item ${id} is ${current.column}; only the user moves it from there`);
      const item: BoardItem = { ...current, ...change, updatedAt: new Date().toISOString() };
      save(dir, item);
      return item;
    });
  }

  move(id: string, parent: string | null, before: string | null): Promise<BoardItem> {
    return this.#write(async (items, dir) => {
      const current = found(items, id);
      if (current.kind === "project") throw new DomainError("bad_request", "a project does not move");
      const target = parent === null ? null : found(items, parent);
      if (target !== null && (target.id === id || ancestorsOf(items, target).some((it) => it.id === id)))
        throw new DomainError("bad_request", "an item cannot go under itself or under an item below it");
      const siblings = childrenOf(items, parent).filter((it) => it.id !== id);
      const order = placeBefore(dir, siblings, before);
      const item: BoardItem = { ...current, parent, order, updatedAt: new Date().toISOString() };
      save(dir, item);
      return item;
    });
  }

  remove(id: string): Promise<void> {
    return this.#write(async (items, dir) => {
      found(items, id);
      const children = childrenOf(items, id).length;
      if (children > 0) throw new DomainError("bad_request", `item ${id} has ${children} item(s) under it; move or remove them first`);
      await rm(join(dir, itemFileName(id)), { force: true });
    });
  }

  /** The folder, made where missing; a link in its place is refused (`ensureTrackwallDir`). */
  async #dir(): Promise<string> {
    return ensureTrackwallDir(await this.#deps.projectsDir(), "board");
  }

  /** One write at a time, on the board as it is now; a failed write does not stop the next one. */
  #write<T>(change: (items: BoardItem[], dir: string) => Promise<T>): Promise<T> {
    const run = this.#writing.then(async () => {
      const dir = await this.#dir();
      const result = await change((await readBoard(dir)).items, dir);
      this.#revision++;
      return result;
    });
    this.#writing = run.catch(() => {});
    return run;
  }
}

async function readItem(path: string, id: string): Promise<{ item: BoardItem } | { problem: string }> {
  try {
    const bytes = await readRegularFile(path, MAX_ITEM_FILE_BYTES);
    if (bytes === undefined) return { problem: "the file disappeared while the board was read" };
    return readItemFile(id, bytes.toString("utf8"));
  } catch (err) {
    return { problem: messageOf(err) };
  }
}

function save(dir: string, item: BoardItem): void {
  writeFileAtomic(join(dir, itemFileName(item.id)), writeItemFile(item));
}

function found(items: readonly BoardItem[], id: string): BoardItem {
  const item = items.find((it) => it.id === id);
  if (!item) throw new DomainError("not_found", `no board item ${id}`);
  return item;
}

function lastOrder(items: readonly BoardItem[], kind: BoardItemKind, parent: string | null): number {
  const siblings = kind === "item" ? childrenOf(items, parent) : items.filter((it) => it.kind === "project");
  return siblings.reduce((max, it) => Math.max(max, it.order), 0);
}

/**
 * The order that puts an item just before `before` among `siblings` (in their order), or after the last when `before` is
 * `null`. Halving a gap runs out after some fifty moves into it, so then the siblings are numbered 1, 2, 3… again first.
 */
function placeBefore(dir: string, siblings: readonly BoardItem[], before: string | null): number {
  const order = orderBefore(siblings, before);
  if (order !== undefined) return order;
  const renumbered = siblings.map((it, at) => ({ ...it, order: at + 1 }));
  for (const it of renumbered) save(dir, it);
  const again = orderBefore(renumbered, before);
  if (again === undefined) throw new DomainError("internal", "renumbered siblings have no gap");
  return again;
}

/** `undefined` when the two neighbours are too close for a number between them. */
function orderBefore(siblings: readonly BoardItem[], before: string | null): number | undefined {
  if (before === null) return (siblings.at(-1)?.order ?? 0) + 1;
  const at = siblings.findIndex((it) => it.id === before);
  if (at === -1) throw new DomainError("bad_request", `item ${before} is not a sibling there`);
  const next = siblings[at];
  const previous = siblings[at - 1];
  if (next === undefined) throw new DomainError("internal", "a found sibling is missing");
  if (previous === undefined) return next.order - 1;
  const between = (previous.order + next.order) / 2;
  return previous.order < between && between < next.order ? between : undefined;
}

/** Every item file of the folder, read a few at a time; a file that holds no item is a problem, the rest still loads. */
async function readBoard(dir: string): Promise<{ items: BoardItem[]; problems: BoardProblem[] }> {
  const files = (await readdir(dir)).sort().flatMap((name) => {
    const id = itemIdOfFile(name);
    return id === undefined ? [] : [{ name, id }];
  });
  const read = await mapLimit(files.slice(0, MAX_ITEM_FILES), READ_AT_ONCE, async ({ name, id }) => ({
    name,
    file: await readItem(join(dir, name), id),
  }));
  const items: BoardItem[] = [];
  const problems: BoardProblem[] = [];
  for (const { name, file } of read) {
    if ("item" in file) items.push(file.item);
    else problems.push({ file: name, message: file.problem });
  }
  if (files.length > MAX_ITEM_FILES)
    problems.push({ file: files[MAX_ITEM_FILES]?.name ?? "", message: `the board reads at most ${MAX_ITEM_FILES} files` });
  return { items, problems };
}
