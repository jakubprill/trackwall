import { expect, test } from "bun:test";
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import {
  findTrackwallLinks,
  hyperlinkHandler,
  hyperlinkTarget,
  opensLink,
  type TerminalRow,
  trackwallLinkProvider,
} from "../src/lib/terminal-links.ts";

const TASK = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";
const row = (text: string, wrapped = false): TerminalRow => ({ text, wrapped });
const texts = (rows: TerminalRow[]) => findTrackwallLinks(rows).map((l) => l.text);

test("a trackwall link in an agent's answer is found with its first and last character", () => {
  expect(findTrackwallLinks([row("Open trackwall://repo/orders-api to see it.")])).toEqual([
    { text: "trackwall://repo/orders-api", parts: [{ row: 0, start: 5, end: 31 }] },
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
    {
      text: `trackwall://task/${TASK}`,
      parts: [
        { row: 0, start: 18, end: 52 },
        { row: 1, start: 4, end: 21 },
      ],
    },
  ]);
});

test("a link that Copilot CLI broke inside its scheme, kind or right after the kind is joined too", () => {
  expect(texts([row("  Open trackwall://ta  │"), row(`    sk/${TASK} now │`)])).toEqual([`trackwall://task/${TASK}`]);
  expect(texts([row("  x trackwall://task/"), row(`    ${TASK}`)])).toEqual([`trackwall://task/${TASK}`]);
  expect(texts([row("  see trackwall://repo/"), row("    orders-api")])).toEqual(["trackwall://repo/orders-api"]);
});

test("a link cut after a bracket stuck to it is joined, and an upper-case scheme is found", () => {
  expect(texts([row("  Started (trackwall://task/0b7e3a52-5c1f"), row("    -4c55-9a4e-2f1d7c3b9e10).")])).toEqual([
    `trackwall://task/${TASK}`,
  ]);
  expect(texts([row("  Started (trackw"), row(`    all://task/${TASK}).`)])).toEqual([`trackwall://task/${TASK}`]);
  expect(texts([row("Open TRACKWALL://repo/orders")])).toEqual(["TRACKWALL://repo/orders"]);
});

test("an empty row ends a cut link instead of joining it with what comes after", () => {
  expect(texts([row("  x trackwall://task/0b7e3a52-5c1f-4c55"), row("   "), row("    -9a4e-2f1d7c3b9e10")])).toEqual([]);
});

test("a link that xterm wrapped onto the next row is joined, also across three rows", () => {
  expect(texts([row("Open trackwall://repo/orders-a"), row("pi now", true)])).toEqual(["trackwall://repo/orders-api"]);
  expect(findTrackwallLinks([row("x trackwall://task/0b7e3a52-"), row("5c1f-4c55-9a4e-", true), row("2f1d7c3b9e10 ok", true)])).toEqual([
    {
      text: `trackwall://task/${TASK}`,
      parts: [
        { row: 0, start: 2, end: 27 },
        { row: 1, start: 0, end: 14 },
        { row: 2, start: 0, end: 11 },
      ],
    },
  ]);
});

test("a space or border that xterm wrapped after a link is not dropped, so the next word stays apart", () => {
  expect(texts([row("Open trackwall://repo/orders "), row("and more", true)])).toEqual(["trackwall://repo/orders"]);
  expect(texts([row("a trackwall://repo/x |"), row("yz", true)])).toEqual(["trackwall://repo/x"]);
});

test("a task link whose UUID stays cut is left out, so a click never opens a shorter id", () => {
  expect(texts([row("trackwall://task/0b7e3a52-5c1f")])).toEqual([]);
  expect(texts([row("trackwall://task/0b7e3a52-5c1f"), row("  and then more text")])).toEqual([]);
  expect(texts([row("x trackwall://task/0b7e3a52"), row("  deadbeefdeadbeefdeadbeefdeadbeef0 is")])).toEqual([]);
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

test("a hyperlink whose label is other text opens a Trackwall link in the window and a web address in the browser", () => {
  // Copilot CLI shows the Markdown link `[supervisor session](trackwall://session/…)` as this hyperlink.
  expect(hyperlinkTarget(`trackwall://session/${TASK}`)).toEqual({ kind: "trackwall", url: `trackwall://session/${TASK}` });
  expect(hyperlinkTarget("https://example.com/docs")).toEqual({ kind: "external", url: "https://example.com/docs" });
  expect(hyperlinkTarget("file:///etc/passwd")).toBeUndefined();
  expect(hyperlinkTarget("javascript:alert(1)")).toBeUndefined();
});

/** A terminal with these rows, numbered from 1 like the rows `provideLinks` asks for. */
function fakeTerminal(rows: TerminalRow[]): Terminal {
  const line = (r: TerminalRow) => ({ translateToString: () => r.text, isWrapped: r.wrapped }) as IBufferLine;
  return { buffer: { active: { getLine: (i: number) => (rows[i] ? line(rows[i]) : undefined) } } } as unknown as Terminal;
}

function linksOn(terminal: Terminal, y: number): Pick<ILink, "text" | "range">[] {
  let links: ILink[] | undefined;
  trackwallLinkProvider(terminal, false).provideLinks(y, (found) => {
    links = found;
  });
  return (links ?? []).map(({ text, range }) => ({ text, range }));
}

test("a link split over two rows is underlined on each row over its own characters only, once", () => {
  const terminal = fakeTerminal([
    row("Before"),
    row("  ● Task started: trackwall://task/0b7e3a52-5c1f-4c55 │"),
    row("    -9a4e-2f1d7c3b9e10. Waiting.                      │"),
  ]);
  const link = `trackwall://task/${TASK}`;
  expect(linksOn(terminal, 1)).toEqual([]);
  expect(linksOn(terminal, 2)).toEqual([{ text: link, range: { start: { x: 19, y: 2 }, end: { x: 53, y: 2 } } }]);
  expect(linksOn(terminal, 3)).toEqual([{ text: link, range: { start: { x: 5, y: 3 }, end: { x: 22, y: 3 } } }]);
});

test("a hyperlink to a web address opens in the browser on Ctrl+click only, and one to another scheme never", () => {
  const opened: string[] = [];
  const handler = hyperlinkHandler(false, (url) => opened.push(url));
  const click = (ctrlKey: boolean) => ({ ctrlKey, metaKey: false }) as MouseEvent;
  const range = { start: { x: 1, y: 1 }, end: { x: 24, y: 1 } };
  handler.activate(click(false), "https://example.com/docs", range);
  handler.activate(click(true), "file:///etc/passwd", range);
  handler.activate(click(true), "https://example.com/docs", range);
  expect(opened).toEqual(["https://example.com/docs"]);
});
