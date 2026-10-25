import { expect, test } from "bun:test";
import { findTrackwallLinks, opensLink } from "../src/lib/terminal-links.ts";

test("a trackwall link in an agent's answer is found with the index of its first character", () => {
  expect(findTrackwallLinks("Open trackwall://repo/orders-api to see it.", false)).toEqual([
    { index: 5, text: "trackwall://repo/orders-api" },
  ]);
  expect(findTrackwallLinks("(trackwall://task/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10), done", false)).toEqual([
    { index: 1, text: "trackwall://task/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10" },
  ]);
});

test("a full stop, comma or bracket after a link is not part of its id", () => {
  for (const end of [".", ",", ")"]) {
    expect(findTrackwallLinks(`See trackwall://repo/orders-api${end}`, false).map((l) => l.text)).toEqual(["trackwall://repo/orders-api"]);
  }
});

test("a repo id that ends on an underscore or a hyphen is kept whole", () => {
  expect(findTrackwallLinks("See trackwall://repo/build_.", false).map((l) => l.text)).toEqual(["trackwall://repo/build_"]);
  expect(findTrackwallLinks("See trackwall://repo/build-", false).map((l) => l.text)).toEqual(["trackwall://repo/build-"]);
});

test("a link cut off at the end of a wrapped row is left out, a link that ends the last row is kept", () => {
  expect(findTrackwallLinks("Open trackwall://repo/orders-a", true)).toEqual([]);
  expect(findTrackwallLinks("Open trackwall://repo/orders-a", false).map((l) => l.text)).toEqual(["trackwall://repo/orders-a"]);
  expect(findTrackwallLinks("trackwall://repo/a then trackwall://repo/b", true).map((l) => l.text)).toEqual(["trackwall://repo/a"]);
});

test("several links on one line are all found, and other links are not", () => {
  expect(findTrackwallLinks("trackwall://repo/a and trackwall://repo/b", false).map((l) => l.text)).toEqual([
    "trackwall://repo/a",
    "trackwall://repo/b",
  ]);
  expect(findTrackwallLinks("https://example.com/repo/a trackwall:repo/a", false)).toEqual([]);
});

test("a link opens on Ctrl+click on Windows and Cmd+click on macOS, not on a plain click", () => {
  expect(opensLink({ ctrlKey: true, metaKey: false }, false)).toBe(true);
  expect(opensLink({ ctrlKey: false, metaKey: true }, true)).toBe(true);
  expect(opensLink({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  expect(opensLink({ ctrlKey: false, metaKey: false }, false)).toBe(false);
});
