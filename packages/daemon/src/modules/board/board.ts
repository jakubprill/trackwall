import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentBoardColumn,
  type BoardColumn,
  type BoardItem,
  type BoardItemAuthor,
  type BoardItemKind,
  type BoardProblem,
  compareSiblings,
} from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError, messageOf } from "../../infra/errors.ts";
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

export type BoardItemChange = Partial<Pick<BoardItem, "title" | "body" | "repos" | "link" | "column">>;

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
    const dir = await this.#dir();
    const names = (await readdir(dir)).sort();
    const items: BoardItem[] = [];
    const problems: BoardProblem[] = [];
    let read = 0;
    for (const name of names) {
      const id = itemIdOfFile(name);
      if (id === undefined) continue;
      if (read++ >= MAX_ITEM_FILES) {
        problems.push({ file: name, message: `the board reads at most ${MAX_ITEM_FILES} files` });
        break;
      }
      const file = await readItem(join(dir, name), id);
      if ("item" in file) items.push(file.item);
      else problems.push({ file: name, message: file.problem });
    }
    return { items, problems };
  }

  async item(id: string): Promise<BoardItem> {
    const item = (await this.board()).items.find((it) => it.id === id);
    if (!item) throw new DomainError("not_found", `no board item ${id}`);
    return item;
  }

  create(input: NewBoardItem, author: BoardItemAuthor): Promise<BoardItem> {
    return this.#write(async (items, dir) => {
      if (input.kind === "project" && input.parent !== null) throw new DomainError("bad_request", "a project has no parent");
      if (input.parent !== null) found(items, input.parent);
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
      if (parent !== null && (parent === id || isBelow(items, parent, id)))
        throw new DomainError("bad_request", "an item cannot go under itself or under an item below it");
      if (parent !== null) found(items, parent);
      const siblings = items.filter((it) => it.kind === "item" && it.parent === parent && it.id !== id).sort(compareSiblings);
      const item: BoardItem = { ...current, parent, order: orderBefore(siblings, before), updatedAt: new Date().toISOString() };
      save(dir, item);
      return item;
    });
  }

  remove(id: string): Promise<void> {
    return this.#write(async (items, dir) => {
      found(items, id);
      const children = items.filter((it) => it.parent === id).length;
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
      const result = await change((await this.board()).items, dir);
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

/** Whether `id` lies somewhere below `ancestor`; a cycle in hand-edited files ends the walk instead of looping. */
function isBelow(items: readonly BoardItem[], id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  for (let at = items.find((it) => it.id === id)?.parent ?? null; at !== null && !seen.has(at); ) {
    if (at === ancestor) return true;
    seen.add(at);
    at = items.find((it) => it.id === at)?.parent ?? null;
  }
  return false;
}

function lastOrder(items: readonly BoardItem[], kind: BoardItemKind, parent: string | null): number {
  const siblings = items.filter((it) => it.kind === kind && it.parent === parent);
  return siblings.reduce((max, it) => Math.max(max, it.order), 0);
}

/** An order that puts an item just before `before` among `siblings`, or after the last when `before` is `null`. */
function orderBefore(siblings: readonly BoardItem[], before: string | null): number {
  if (before === null) return (siblings.at(-1)?.order ?? 0) + 1;
  const at = siblings.findIndex((it) => it.id === before);
  if (at === -1) throw new DomainError("bad_request", `item ${before} is not a sibling there`);
  const next = siblings[at];
  const previous = siblings[at - 1];
  if (next === undefined) throw new DomainError("internal", "a found sibling is missing");
  return previous === undefined ? next.order - 1 : (previous.order + next.order) / 2;
}
