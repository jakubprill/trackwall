import { describe, expect, test } from "bun:test";
import type { BoardItem } from "@trackwall/protocol";
import { itemIdOfFile, readItemFile, writeItemFile } from "../src/modules/board/board-file.ts";

const ITEM: BoardItem = {
  id: "5b0c6a7e-0000-4000-8000-000000000001",
  kind: "item",
  title: "History endpoint in the BFF",
  body: "GET /orders/history\n\n- paging like invoices\n",
  parent: "5b0c6a7e-0000-4000-8000-000000000000",
  column: "ready",
  order: 2.5,
  repos: ["orders-bff"],
  link: "https://tracker.example/browse/SHOP-412",
  createdBy: { kind: "agent", task: null },
  createdAt: "2026-10-29T20:00:00.000Z",
  updatedAt: "2026-10-29T20:05:00.000Z",
};

describe("a board item's file", () => {
  test("is YAML frontmatter with the fields and the body below it, and reads back as the same item", () => {
    const text = writeItemFile(ITEM);
    expect(text.startsWith("---\nid: 5b0c6a7e-0000-4000-8000-000000000001\n")).toBe(true);
    expect(text.endsWith("---\nGET /orders/history\n\n- paging like invoices\n")).toBe(true);
    expect(readItemFile(ITEM.id, text)).toEqual({ item: ITEM });
  });

  test("edited by hand on Windows, with CRLF line ends and nothing after the frontmatter, it still reads", () => {
    const text = writeItemFile({ ...ITEM, body: "" })
      .replace(/\n/g, "\r\n")
      .replace(/---\r\n$/, "---");
    expect(readItemFile(ITEM.id, text)).toEqual({ item: { ...ITEM, body: "" } });
  });

  test("a file whose frontmatter names another item, has no frontmatter or breaks the schema holds no item", () => {
    expect(readItemFile("5b0c6a7e-0000-4000-8000-0000000000ff", writeItemFile(ITEM))).toEqual({
      problem: "the frontmatter names item 5b0c6a7e-0000-4000-8000-000000000001, not the file's 5b0c6a7e-0000-4000-8000-0000000000ff",
    });
    expect(readItemFile(ITEM.id, "# just notes\n")).toEqual({ problem: "the file does not start with --- and its frontmatter" });
    expect(readItemFile(ITEM.id, "---\nid: x\n")).toEqual({ problem: "the frontmatter has no closing ---" });
    expect(readItemFile(ITEM.id, writeItemFile(ITEM).replace("column: ready", "column: someday"))).toMatchObject({
      problem: expect.stringContaining("column"),
    });
  });

  test("only <uuid>.md files in the folder are items", () => {
    expect(itemIdOfFile(`${ITEM.id}.md`)).toBe(ITEM.id);
    expect(itemIdOfFile(`${ITEM.id}.md.4242.tmp`)).toBeUndefined();
    expect(itemIdOfFile("README.md")).toBeUndefined();
  });
});
