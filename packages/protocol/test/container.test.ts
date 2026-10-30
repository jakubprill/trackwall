import { describe, expect, test } from "bun:test";
import { containerEditorUrl, DevContainerFolder, devContainerEditorUrl } from "../src/index.ts";

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

describe("a VS Code link through the dev container's configuration", () => {
  test("names the dev container by its folder on a Windows computer in hex, backslashes and spaces included", () => {
    const folder = String.raw`C:\Users\me\Dev\work space`;
    const hex = Buffer.from(folder, "utf8").toString("hex");
    expect(devContainerEditorUrl(folder, "/workspaces/shop")).toBe(`vscode://vscode-remote/dev-container+${hex}/workspaces/shop`);
  });

  test("takes the UTF-8 bytes of a folder name with non-ASCII characters", () => {
    expect(devContainerEditorUrl("/Users/zoë/Dev", "/workspaces/shop")).toBe(
      "vscode://vscode-remote/dev-container+2f55736572732f7a6fc3ab2f446576/workspaces/shop",
    );
  });

  test("encodes the path inside the container like the attached link", () => {
    expect(devContainerEditorUrl("/home/me/dev", "/workspaces/a b#1/notes?.md")).toEndWith("/workspaces/a%20b%231/notes%3F.md");
  });
});

describe("the dev container's folder", () => {
  test("is any path of the user's computer without control characters", () => {
    expect(DevContainerFolder.safeParse(String.raw`C:\Users\me\Dev\work space`).success).toBe(true);
    expect(DevContainerFolder.safeParse("/Users/zoë/Dev").success).toBe(true);
    expect(DevContainerFolder.safeParse("").success).toBe(false);
    expect(DevContainerFolder.safeParse("C:\\Dev\nX").success).toBe(false);
  });
});
