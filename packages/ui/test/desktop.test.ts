import { describe, expect, test } from "bun:test";
import { openInNewTabOnceKnown, openWebLink } from "../src/lib/desktop.ts";

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

  test("an address that is not http or https opens no tab, since it would run in this page's origin", async () => {
    const tabs: string[] = [];
    await expect(
      openWebLink("javascript:alert(document.cookie)", {
        desktop: false,
        viaDaemon: async () => {},
        newTab: (url) => tabs.push(url) > 0,
      }),
    ).rejects.toThrow("not a web address");
    expect(tabs).toEqual([]);
  });

  test("a tab the browser blocked is an error the page can show", async () => {
    await expect(
      openWebLink("https://example.com/docs", { desktop: false, viaDaemon: async () => {}, newTab: () => false }),
    ).rejects.toThrow("the browser blocked the new tab");
  });
});

describe("opening a tab for an address the daemon gives later", () => {
  test("the tab opens in the click, before the address is known, and then goes to it", async () => {
    const events: string[] = [];
    const opening = openInNewTabOnceKnown(
      async () => {
        events.push("address asked");
        return "https://git.example.com/shop/-/merge_requests/new";
      },
      () => {
        events.push("tab opened");
        return { go: (url) => events.push(`tab at ${url}`), close: () => events.push("tab closed") };
      },
    );
    expect(events).toEqual(["tab opened", "address asked"]);
    await opening;
    expect(events).toEqual(["tab opened", "address asked", "tab at https://git.example.com/shop/-/merge_requests/new"]);
  });

  test("a refusal from the daemon closes the empty tab and is the error the page shows", async () => {
    const events: string[] = [];
    await expect(
      openInNewTabOnceKnown(
        async () => {
          throw new Error("the branch has commits that are not pushed");
        },
        () => ({ go: () => events.push("tab moved"), close: () => events.push("tab closed") }),
      ),
    ).rejects.toThrow("the branch has commits that are not pushed");
    expect(events).toEqual(["tab closed"]);
  });

  test("an address from the daemon that is not http or https closes the tab instead of loading it", async () => {
    const events: string[] = [];
    await expect(
      openInNewTabOnceKnown(
        async () => "javascript:alert(1)",
        () => ({ go: (url) => events.push(`tab at ${url}`), close: () => events.push("tab closed") }),
      ),
    ).rejects.toThrow("not a web address");
    expect(events).toEqual(["tab closed"]);
  });

  test("a tab the browser blocked asks nothing of the daemon", async () => {
    let asked = false;
    await expect(
      openInNewTabOnceKnown(
        async () => {
          asked = true;
          return "https://example.com";
        },
        () => undefined,
      ),
    ).rejects.toThrow("the browser blocked the new tab");
    expect(asked).toBe(false);
  });
});
