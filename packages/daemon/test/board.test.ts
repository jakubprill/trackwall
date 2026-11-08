import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, MAX_BOARD_ITEMS } from "../src/modules/board/board.ts";
import { writeItemFile } from "../src/modules/board/board-file.ts";

const USER = { kind: "user" } as const;

function board(): { board: Board; folder: string } {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-board-"));
  return { board: new Board({ projectsDir: async () => projects }), folder: join(projects, ".trackwall", "board") };
}

const NEW = { body: "", parent: null, repos: [] as string[], link: null, column: "ideas" as const };

describe("the board (ADR-133)", () => {
  test("an idea goes into the inbox as a Markdown file of its own, and each change raises the revision", async () => {
    const { board: b, folder } = board();
    expect(await b.board()).toEqual({ items: [], problems: [] });

    const idea = await b.create({ ...NEW, kind: "item", title: "Retry the invoice export", body: "after a timeout" }, USER);

    expect(idea).toMatchObject({ kind: "item", parent: null, column: "ideas", order: 1, createdBy: USER });
    expect(readdirSync(folder)).toEqual([`${idea.id}.md`]);
    expect(readFileSync(join(folder, `${idea.id}.md`), "utf8")).toEndWith("---\nafter a timeout");
    expect((await b.board()).items).toEqual([idea]);
    expect(b.revision()).toBe(1);
  });

  test("a project is a root and items split under it come last among their siblings", async () => {
    const { board: b } = board();
    const project = await b.create({ ...NEW, kind: "project", title: "Order history", column: "ready" }, USER);
    const first = await b.create({ ...NEW, kind: "item", title: "Endpoint in the BFF", parent: project.id }, USER);
    const second = await b.create({ ...NEW, kind: "item", title: "List on the account page", parent: project.id }, USER);
    const below = await b.create({ ...NEW, kind: "item", title: "Paging like invoices", parent: first.id }, USER);

    expect([first.order, second.order, below.order]).toEqual([1, 2, 1]);
    await expect(b.create({ ...NEW, kind: "project", title: "Nested", parent: project.id }, USER)).rejects.toThrow(
      "a project has no parent",
    );
    await expect(b.create({ ...NEW, kind: "item", title: "Orphan", parent: "5b0c6a7e-0000-4000-8000-0000000000ff" }, USER)).rejects.toThrow(
      "no board item",
    );
  });

  test("an item moves before a sibling or under another item, never under itself, below itself or a project", async () => {
    const { board: b } = board();
    const project = await b.create({ ...NEW, kind: "project", title: "Order history", column: "ready" }, USER);
    const a = await b.create({ ...NEW, kind: "item", title: "A", parent: project.id }, USER);
    const c = await b.create({ ...NEW, kind: "item", title: "C", parent: project.id }, USER);
    const idea = await b.create({ ...NEW, kind: "item", title: "B" }, USER);

    const filed = await b.move(idea.id, project.id, c.id);
    expect(filed.parent).toBe(project.id);
    expect(filed.order).toBe((a.order + c.order) / 2);

    const under = await b.move(c.id, a.id, null);
    expect(under).toMatchObject({ parent: a.id, order: 1 });
    await expect(b.move(a.id, c.id, null)).rejects.toThrow("cannot go under itself or under an item below it");
    await expect(b.move(a.id, a.id, null)).rejects.toThrow("cannot go under itself");
    await expect(b.move(project.id, null, null)).rejects.toThrow("a project does not move");
  });

  test("moving into the same gap again and again renumbers the siblings instead of losing the move", async () => {
    const { board: b } = board();
    const first = await b.create({ ...NEW, kind: "item", title: "First" }, USER);
    const last = await b.create({ ...NEW, kind: "item", title: "Last" }, USER);
    const moving = [];
    for (let at = 0; at < 60; at++) moving.push(await b.create({ ...NEW, kind: "item", title: `Moved ${at}` }, USER));
    // Each one goes right before the one moved before it, so the gap after "First" halves every time.
    let before = last.id;
    for (const it of moving) {
      await b.move(it.id, null, before);
      before = it.id;
    }

    const titles = (await b.board()).items.sort((x, y) => x.order - y.order).map((it) => it.title);
    expect(titles).toEqual([first.title, ...moving.map((it) => it.title).reverse(), last.title]);
  });

  test("the board takes at most MAX_BOARD_ITEMS items, so ideas written in a loop never push the user's own out of it", async () => {
    const { board: b, folder } = board();
    await b.create({ ...NEW, kind: "item", title: "The first" }, USER);
    const now = "2026-10-29T20:00:00.000Z";
    for (let at = 1; at < MAX_BOARD_ITEMS; at++) {
      const id = `5b0c6a7e-0000-4000-8000-${at.toString().padStart(12, "0")}`;
      const item = { ...NEW, id, kind: "item" as const, title: `Idea ${at}`, order: at, createdBy: USER, createdAt: now, updatedAt: now };
      writeFileSync(join(folder, `${id}.md`), writeItemFile(item));
    }

    await expect(b.create({ ...NEW, kind: "item", title: "One more" }, { kind: "agent", task: null })).rejects.toThrow(
      `the board holds ${MAX_BOARD_ITEMS} items`,
    );
    expect((await b.board()).items).toHaveLength(MAX_BOARD_ITEMS);
  });

  test("an item with items under it is not removed, so a subtree is never lost by one click", async () => {
    const { board: b, folder } = board();
    const parent = await b.create({ ...NEW, kind: "item", title: "Parent" }, USER);
    const child = await b.create({ ...NEW, kind: "item", title: "Child", parent: parent.id }, USER);

    await expect(b.remove(parent.id)).rejects.toThrow("has 1 item(s) under it");
    await b.remove(child.id);
    await b.remove(parent.id);
    expect(readdirSync(folder)).toEqual([]);
  });

  test("an agent changes an item's text and moves it between ideas and ready, but not a project or work in progress", async () => {
    const { board: b } = board();
    const project = await b.create({ ...NEW, kind: "project", title: "Order history", column: "ready" }, USER);
    const idea = await b.create({ ...NEW, kind: "item", title: "Cache the customer lookup" }, USER);
    const started = await b.create({ ...NEW, kind: "item", title: "Endpoint", column: "in_progress" }, USER);

    expect(await b.updateByAgent(idea.id, { body: "the lookup takes 300 ms", column: "ready" })).toMatchObject({
      body: "the lookup takes 300 ms",
      column: "ready",
    });
    await expect(b.updateByAgent(project.id, { title: "Renamed" })).rejects.toThrow("an agent changes items, not projects");
    await expect(b.updateByAgent(started.id, { column: "ideas" })).rejects.toThrow("only the user moves it from there");
    expect(await b.updateByAgent(started.id, { body: "notes" })).toMatchObject({ body: "notes", column: "in_progress" });
  });

  test("a user's save that names an older version than the item's is refused and writes nothing (ADR-232)", async () => {
    const { board: b, folder } = board();
    const opened = await b.create({ ...NEW, kind: "item", title: "Retry the export", body: "Plan: retry three times." }, USER);
    const byAgent = await b.updateByAgent(opened.id, { body: "Plan: retry three times.\n\nFound: the job runs at 02:00." });
    const revision = b.revision();
    const file = readFileSync(join(folder, `${opened.id}.md`), "utf8");

    await expect(b.update(opened.id, { title: "Retry the invoice export", body: opened.body }, opened.updatedAt)).rejects.toThrow(
      "the item changed since you read it",
    );

    expect(byAgent.updatedAt > opened.updatedAt).toBe(true);
    expect(readFileSync(join(folder, `${opened.id}.md`), "utf8")).toBe(file);
    expect(b.revision()).toBe(revision);
    expect(await b.update(opened.id, { title: "Retry the invoice export" }, byAgent.updatedAt)).toMatchObject({
      title: "Retry the invoice export",
      body: "Plan: retry three times.\n\nFound: the job runs at 02:00.",
    });
  });

  test("every write gives the item a later updatedAt, also several within one millisecond, so no two versions share one", async () => {
    const { board: b } = board();
    const item = await b.create({ ...NEW, kind: "item", title: "Cache the lookup" }, USER);
    const times = [item.updatedAt];
    for (let i = 0; i < 20; i++) times.push((await b.update(item.id, { body: `note ${i}` })).updatedAt);

    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort()).toEqual(times);
  });

  test("a file edited by hand counts at once, and a broken one is a problem while the rest of the board stays", async () => {
    const { board: b, folder } = board();
    const idea = await b.create({ ...NEW, kind: "item", title: "Retry the export" }, USER);
    const path = join(folder, `${idea.id}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("title: Retry the export", "title: Retry the export twice"));
    writeFileSync(join(folder, "5b0c6a7e-0000-4000-8000-000000000009.md"), "no frontmatter\n");
    writeFileSync(join(folder, "notes.txt"), "not an item\n");

    const { items, problems } = await b.board();
    expect(items.map((it) => it.title)).toEqual(["Retry the export twice"]);
    expect(problems).toEqual([
      { file: "5b0c6a7e-0000-4000-8000-000000000009.md", message: "the file does not start with --- and its frontmatter" },
    ]);
  });

  test.skipIf(process.platform === "win32")("a link in place of the board folder is refused, so nothing is written elsewhere", async () => {
    const projects = mkdtempSync(join(tmpdir(), "trackwall-board-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "trackwall-elsewhere-"));
    mkdirSync(join(projects, ".trackwall"));
    symlinkSync(elsewhere, join(projects, ".trackwall", "board"));
    const b = new Board({ projectsDir: async () => projects });

    await expect(b.create({ ...NEW, kind: "item", title: "An idea" }, USER)).rejects.toThrow("is not a folder (a link?)");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("the work of tasks moves an item to in progress and in review, but never out of done or dropped, nor a project (ADR-213)", async () => {
    const { board: b } = board();
    const project = await b.create({ ...NEW, kind: "project", title: "Order history", column: "ready" }, USER);
    const item = await b.create({ ...NEW, kind: "item", title: "Endpoint in the BFF", parent: project.id, column: "ready" }, USER);

    expect((await b.followTasks(item.id, "in_progress"))?.column).toBe("in_progress");
    expect((await b.followTasks(item.id, "review"))?.column).toBe("review");
    expect((await b.followTasks(item.id, "in_progress"))?.column).toBe("in_progress");
    const revision = b.revision();
    expect(await b.followTasks(item.id, "in_progress")).toBeNull();
    // Nothing moved, so the Plan view is not told to reload.
    expect(b.revision()).toBe(revision);

    await b.update(item.id, { column: "done" });
    expect(await b.followTasks(item.id, "in_progress")).toBeNull();
    expect(await b.followTasks(item.id, "review")).toBeNull();
    await b.update(item.id, { column: "dropped" });
    expect(await b.followTasks(item.id, "review")).toBeNull();
    expect((await b.item(item.id)).column).toBe("dropped");

    expect(await b.followTasks(project.id, "in_progress")).toBeNull();
    expect((await b.item(project.id)).column).toBe("ready");
    expect(await b.followTasks("5b0c6a7e-0000-4000-8000-0000000000ff", "review")).toBeNull();
  });

  test("an item goes back to ready only from in progress: work in review, done or dropped stays where it is (ADR-213)", async () => {
    const { board: b } = board();
    const item = await b.create({ ...NEW, kind: "item", title: "Fix README typo", column: "in_progress" }, USER);

    expect((await b.followTasks(item.id, "ready"))?.column).toBe("ready");
    expect(await b.followTasks(item.id, "ready")).toBeNull();
    for (const column of ["review", "done", "dropped", "ideas"] as const) {
      await b.update(item.id, { column });
      expect(await b.followTasks(item.id, "ready")).toBeNull();
      expect((await b.item(item.id)).column).toBe(column);
    }
  });

  test("a read beside the daemon's own writes in the background still finds every item (ADR-213)", async () => {
    const { board: b } = board();
    const items = [];
    for (let i = 0; i < 30; i++) items.push(await b.create({ ...NEW, kind: "item", title: `Item ${i}`, column: "ready" }, USER));
    const moves = [];
    for (let round = 0; round < 10; round++)
      for (const item of items) moves.push(b.followTasks(item.id, round % 2 === 0 ? "in_progress" : "review"));
    const counts: number[] = [];
    for (let i = 0; i < 20; i++) counts.push((await b.board()).items.length);
    await Promise.all(moves);
    expect(counts).toEqual(Array.from({ length: 20 }, () => 30));
  });
});
