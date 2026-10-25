import { describe, expect, test } from "bun:test";
import { browserCommand, folderCommand } from "../src/infra/system-open.ts";

describe("system open", () => {
  test("a folder opens in a visible Explorer with the path quoted verbatim, in Finder on macOS and with xdg-open on Linux", () => {
    expect(folderCommand("win32", "C:\\Work\\a,b c")).toEqual({
      program: "explorer.exe",
      args: ['"C:\\Work\\a,b c"'],
      verbatim: true,
      hidden: false,
    });
    expect(folderCommand("darwin", "/Users/me/shop")).toEqual({ program: "open", args: ["/Users/me/shop"], verbatim: false, hidden: true });
    expect(folderCommand("linux", "/home/me/shop")).toEqual({
      program: "xdg-open",
      args: ["/home/me/shop"],
      verbatim: false,
      hidden: true,
    });
  });

  test("a URL opens through the Windows URL handler, open on macOS and xdg-open on Linux", () => {
    const url = "https://example.com/a";
    expect(browserCommand("win32", url)).toEqual({
      program: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
      verbatim: false,
      hidden: true,
    });
    expect(browserCommand("darwin", url)).toEqual({ program: "open", args: [url], verbatim: false, hidden: true });
    expect(browserCommand("linux", url)).toEqual({ program: "xdg-open", args: [url], verbatim: false, hidden: true });
  });
});
