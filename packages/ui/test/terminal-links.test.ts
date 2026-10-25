import { expect, test } from "bun:test";
import { findTrackwallLinks, opensLink, type TerminalRow } from "../src/lib/terminal-links.ts";

const TASK = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";
const row = (text: string, wrapped = false): TerminalRow => ({ text, wrapped });
const texts = (rows: TerminalRow[]) => findTrackwallLinks(rows).map((l) => l.text);

test("a trackwall link in an agent's answer is found with its first and last character", () => {
  expect(findTrackwallLinks([row("Open trackwall://repo/orders-api to see it.")])).toEqual([
    { text: "trackwall://repo/orders-api", start: { row: 0, index: 5 }, end: { row: 0, index: 31 } },
  ]);
  expect(texts([row(`(trackwall://task/${TASK}), done`)])).toEqual([`trackwall://task/${TASK}`]);
});

test("a full stop, comma or bracket after a link is not part of its id", () => {
  for (const end of [".", ",", ")"]) {
    expect(texts([row(`See trackwall://repo/orders-api${end}`)])).toEqual(["trackwall://repo/orders-api"]);
  }
});

test("a repo id that ends on an underscore or a hyphen is kept whole", () => {
  expect(texts([row("See trackwall://repo/build_.")])).toEqual(["trackwall://repo/build_"]);
  expect(texts([row("See trackwall://repo/build-")])).toEqual(["trackwall://repo/build-"]);
});

test("a task link that Copilot CLI broke into two indented rows is joined into one", () => {
  const rows = [row("  ● Task started: trackwall://task/0b7e3a52-5c1f-4c55"), row("    -9a4e-2f1d7c3b9e10. Waiting for it.")];
  expect(findTrackwallLinks(rows)).toEqual([
    { text: `trackwall://task/${TASK}`, start: { row: 0, index: 18 }, end: { row: 1, index: 21 } },
  ]);
});

test("a link that xterm wrapped onto the next row is joined, also across three rows", () => {
  expect(texts([row("Open trackwall://repo/orders-a"), row("pi now", true)])).toEqual(["trackwall://repo/orders-api"]);
  expect(texts([row("x trackwall://task/0b7e3a52-"), row("5c1f-4c55-9a4e-", true), row("2f1d7c3b9e10 ok", true)])).toEqual([
    `trackwall://task/${TASK}`,
  ]);
});

test("a task link whose UUID stays cut is left out, so a click never opens a shorter id", () => {
  expect(texts([row("trackwall://task/0b7e3a52-5c1f")])).toEqual([]);
  expect(texts([row("trackwall://task/0b7e3a52-5c1f"), row("  and then more text")])).toEqual([]);
});

test("a repo link at the end of a row is not joined with the next, unwrapped row", () => {
  expect(texts([row("Open trackwall://repo/orders"), row("api is the next word")])).toEqual(["trackwall://repo/orders"]);
});

test("a link at the end of a row inside a box border is still complete", () => {
  expect(texts([row(`│ trackwall://task/${TASK} │`)])).toEqual([`trackwall://task/${TASK}`]);
});

test("several links on one line are all found, and other links are not", () => {
  expect(texts([row("trackwall://repo/a and trackwall://repo/b")])).toEqual(["trackwall://repo/a", "trackwall://repo/b"]);
  expect(texts([row("https://example.com/repo/a trackwall:repo/a")])).toEqual([]);
});

test("a link opens on Ctrl+click on Windows and Cmd+click on macOS, not on a plain click", () => {
  expect(opensLink({ ctrlKey: true, metaKey: false }, false)).toBe(true);
  expect(opensLink({ ctrlKey: false, metaKey: true }, true)).toBe(true);
  expect(opensLink({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  expect(opensLink({ ctrlKey: false, metaKey: false }, false)).toBe(false);
});
