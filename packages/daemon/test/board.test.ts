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
});
