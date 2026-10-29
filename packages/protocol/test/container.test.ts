import { describe, expect, test } from "bun:test";
import { containerEditorUrl } from "../src/index.ts";

const ID = "de4cc610b398445a55cd4802f1b0dc38776d583533fd7283c9d76e5825fd5f81";

describe("a VS Code link into the container", () => {
  test("names the container by its id in hex and keeps the path inside it", () => {
    const hex = Buffer.from(ID).toString("hex");
    expect(containerEditorUrl(ID, "/workspaces/shop")).toBe(`vscode://vscode-remote/attached-container+${hex}/workspaces/shop`);
  });

  test("encodes a folder name with characters that would end the path", () => {
    expect(containerEditorUrl(ID, "/workspaces/a b#1/notes?.md")).toEndWith("/workspaces/a%20b%231/notes%3F.md");
  });
});
