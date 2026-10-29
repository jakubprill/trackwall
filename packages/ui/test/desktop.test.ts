import { describe, expect, test } from "bun:test";
import { openWebLink } from "../src/lib/desktop.ts";

describe("opening a web link", () => {
  test("a daemon with a desktop opens it in the system browser, and the page opens no tab", async () => {
    const viaDaemon: string[] = [];
    const tabs: string[] = [];
    await openWebLink("https://example.com/docs", {
      desktop: true,
      viaDaemon: async (url) => viaDaemon.push(url),
      newTab: (url) => tabs.push(url) > 0,
    });
    expect(viaDaemon).toEqual(["https://example.com/docs"]);
    expect(tabs).toEqual([]);
  });

  test("a daemon without a desktop leaves it to a new tab of the page, opened before anything is awaited", () => {
    const viaDaemon: string[] = [];
    const tabs: string[] = [];
    // Not awaited on purpose: a browser lets a page open a tab only while it handles the click.
    void openWebLink("https://example.com/docs", {
      desktop: false,
      viaDaemon: async (url) => viaDaemon.push(url),
      newTab: (url) => tabs.push(url) > 0,
    });
    expect(tabs).toEqual(["https://example.com/docs"]);
    expect(viaDaemon).toEqual([]);
  });

  test("a tab the browser blocked is an error the page can show", async () => {
    await expect(
      openWebLink("https://example.com/docs", { desktop: false, viaDaemon: async () => {}, newTab: () => false }),
    ).rejects.toThrow("the browser blocked the new tab");
  });
});
