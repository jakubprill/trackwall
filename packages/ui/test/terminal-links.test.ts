import { expect, test } from "bun:test";
import { findTrackwallLinks, opensLink } from "../src/lib/terminal-links.ts";

test("a trackwall link in an agent's answer is found with the index of its first character", () => {
  expect(findTrackwallLinks("Open trackwall://repo/orders-api to see it.")).toEqual([{ index: 5, text: "trackwall://repo/orders-api" }]);
  expect(findTrackwallLinks("(trackwall://task/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10), done")).toEqual([
    { index: 1, text: "trackwall://task/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10" },
  ]);
});

test("several links on one line are all found, and other links are not", () => {
  expect(findTrackwallLinks("trackwall://repo/a and trackwall://repo/b").map((l) => l.text)).toEqual([
    "trackwall://repo/a",
    "trackwall://repo/b",
  ]);
  expect(findTrackwallLinks("https://example.com/repo/a trackwall:repo/a")).toEqual([]);
});

test("a link opens on Ctrl+click on Windows and Cmd+click on macOS, not on a plain click", () => {
  expect(opensLink({ ctrlKey: true, metaKey: false }, false)).toBe(true);
  expect(opensLink({ ctrlKey: false, metaKey: true }, true)).toBe(true);
  expect(opensLink({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  expect(opensLink({ ctrlKey: false, metaKey: false }, false)).toBe(false);
});
