import { expect, test } from "bun:test";
import type { TrackwallLinkTarget } from "@trackwall/protocol";
import { openTrackwallLink } from "../src/lib/trackwall-link.ts";

const SESSION = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";

function openers(inShell: boolean) {
  const shell: string[] = [];
  const page: TrackwallLinkTarget[] = [];
  return {
    shell,
    page,
    openers: { inShell, viaShell: async (url: string) => void shell.push(url), inPage: (t: TrackwallLinkTarget) => void page.push(t) },
  };
}

test("in a browser tab the page itself shows what a link points at", () => {
  const { shell, page, openers: o } = openers(false);
  expect(openTrackwallLink(`trackwall://session/${SESSION}`, o)).toBe(true);
  expect(openTrackwallLink("trackwall://repo/orders-api", o)).toBe(true);
  expect(page).toEqual([
    { kind: "session", id: SESSION },
    { kind: "repo", id: "orders-api" },
  ]);
  expect(shell).toEqual([]);
});

test("in the desktop app the shell opens the link, so it reaches the window that shows sessions", () => {
  const { shell, page, openers: o } = openers(true);
  expect(openTrackwallLink("trackwall://repo/orders-api", o)).toBe(true);
  expect(shell).toEqual(["trackwall://repo/orders-api"]);
  expect(page).toEqual([]);
});

test("something that is not a valid trackwall link opens nothing anywhere", () => {
  for (const inShell of [true, false]) {
    const { shell, page, openers: o } = openers(inShell);
    expect(openTrackwallLink("trackwall://repo/orders-api?run=1", o)).toBe(false);
    expect(openTrackwallLink("https://example.com", o)).toBe(false);
    expect(shell).toEqual([]);
    expect(page).toEqual([]);
  }
});
