import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorFingerprint } from "../src/modules/error-journal/error-journal.ts";
import { shellFrame } from "../src/modules/error-journal/shell-errors.ts";
import { parseStack, repoPath, trackwallFrames } from "../src/modules/error-journal/stack-frames.ts";
import { lookup, uiFramePlace } from "../src/modules/error-journal/ui-source-map.ts";

describe("stack frames", () => {
  test("V8 and WebKit frames are parsed, other lines skipped", () => {
    const stack = [
      "TypeError: boom",
      "    at list (/home/u/trackwall/packages/daemon/src/modules/workspace/workspace.ts:104:11)",
      "    at C:\\Users\\u\\trackwall\\packages\\daemon\\src\\api\\routes.ts:40:7",
      "render@http://127.0.0.1:5123/assets/index-abc.js:1:2345",
    ].join("\n");
    expect(parseStack(stack)).toEqual([
      { file: "/home/u/trackwall/packages/daemon/src/modules/workspace/workspace.ts", line: 104, column: 11 },
      { file: "C:\\Users\\u\\trackwall\\packages\\daemon\\src\\api\\routes.ts", line: 40, column: 7 },
      { file: "http://127.0.0.1:5123/assets/index-abc.js", line: 1, column: 2345 },
    ]);
  });

  test.each([
    ["/home/u/trackwall/packages/daemon/src/api/server.ts", "packages/daemon/src/api/server.ts"],
    ["C:\\Users\\u\\trackwall\\packages\\protocol\\src\\api.ts", "packages/protocol/src/api.ts"],
    ["file:///Users/u/trackwall/packages/daemon/src/main.ts", "packages/daemon/src/main.ts"],
    // The compiled daemon writes paths from its package root.
    ["src/api/server.ts", "packages/daemon/src/api/server.ts"],
    ["../protocol/src/api.ts", "packages/protocol/src/api.ts"],
  ])("a file of Trackwall is a path in its repo: %s", (file, expected) => {
    expect(repoPath(file, "daemon")).toBe(expected);
  });

  test.each([
    ["/home/u/trackwall/node_modules/zod/v4/core/errors.js"],
    ["node:internal/process/task_queues"],
    ["/home/u/other-project/src/index.ts"],
  ])("a file outside Trackwall's code is no frame: %s", (file) => {
    expect(repoPath(file, "daemon")).toBeNull();
  });

  test("frames keep Trackwall's places, without a place repeated right after itself, at most eight", () => {
    const raw = [
      { file: "src/a.ts", line: 1, column: 1 },
      { file: "src/a.ts", line: 1, column: 9 },
      { file: "/x/node_modules/lib/index.js", line: 5, column: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({ file: "src/b.ts", line: i + 2, column: 1 })),
    ];
    const frames = trackwallFrames(raw, (f) => {
      const path = repoPath(f.file, "daemon");
      return path ? { path, line: f.line } : null;
    });
    expect(frames).toEqual([
      "packages/daemon/src/a.ts:1",
      "packages/daemon/src/b.ts:2",
      "packages/daemon/src/b.ts:3",
      "packages/daemon/src/b.ts:4",
      "packages/daemon/src/b.ts:5",
      "packages/daemon/src/b.ts:6",
      "packages/daemon/src/b.ts:7",
      "packages/daemon/src/b.ts:8",
    ]);
  });
});

describe("UI frames", () => {
  // `AAyCA`: from column 0 of line 1, line 42 (41 counted from 0) of source 0; `UCAA`: from column 10, the same line of source 1.
  const map = { sources: ["../../src/views/repos/RepoView.tsx", "../../../protocol/src/api.ts"], mappings: "AAyCA,UCAA" };

  test("a position in a chunk is found in its source map", () => {
    expect(lookup(map, 1, 1)).toEqual({ source: "../../src/views/repos/RepoView.tsx", line: 42 });
    expect(lookup(map, 1, 30)).toEqual({ source: "../../../protocol/src/api.ts", line: 42 });
    expect(lookup(map, 2, 1)).toBeNull();
  });

  test("a frame of a built chunk becomes a place in the UI's sources through the map next to it", () => {
    const uiDir = mkdtempSync(join(tmpdir(), "trackwall-ui-"));
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(join(uiDir, "assets", "index-abc.js.map"), JSON.stringify({ version: 3, ...map }));
    const frame = { file: "tauri://localhost/assets/index-abc.js", line: 1, column: 1 };
    expect(uiFramePlace(frame, uiDir)).toEqual({ path: "packages/ui/src/views/repos/RepoView.tsx", line: 42 });
    expect(uiFramePlace({ ...frame, column: 30 }, uiDir)).toEqual({ path: "packages/protocol/src/api.ts", line: 42 });
  });

  test("a chunk without a map, a name that leaves the assets folder and a library chunk are no frames", () => {
    const uiDir = mkdtempSync(join(tmpdir(), "trackwall-ui-"));
    expect(uiFramePlace({ file: "http://127.0.0.1:1/assets/missing.js", line: 1, column: 1 }, uiDir)).toBeNull();
    expect(uiFramePlace({ file: "http://127.0.0.1:1/assets/../../secret.js", line: 1, column: 1 }, uiDir)).toBeNull();
    expect(uiFramePlace({ file: "http://127.0.0.1:5173/node_modules/.vite/deps/react.js", line: 1, column: 1 }, uiDir)).toBeNull();
  });

  test("under vite dev the frames are the sources already", () => {
    const frame = { file: "http://127.0.0.1:5173/src/views/repos/RepoView.tsx?t=1700000000", line: 12, column: 3 };
    expect(uiFramePlace(frame, undefined)).toEqual({ path: "packages/ui/src/views/repos/RepoView.tsx", line: 12 });
  });
});

describe("shell frames and fingerprints", () => {
  test("a shell location is a path in the repo; a library's is none", () => {
    expect(shellFrame("src/badge.rs:201:9")).toBe("apps/desktop/src-tauri/src/badge.rs:201");
    expect(shellFrame("src\\daemon.rs:116")).toBe("apps/desktop/src-tauri/src/daemon.rs:116");
    expect(shellFrame("/home/u/.cargo/registry/src/tauri-2/src/app.rs:10")).toBeNull();
    expect(shellFrame(null)).toBeNull();
  });

  test("the same error with other numbers in its message has one fingerprint; another top frame has another", () => {
    const a = errorFingerprint("daemon", "startup", "Error", null, "port 51234 is taken");
    expect(errorFingerprint("daemon", "startup", "Error", null, "port 51240 is taken")).toBe(a);
    expect(errorFingerprint("daemon", "startup", "Error", "packages/daemon/src/main.ts:10", "x")).not.toBe(
      errorFingerprint("daemon", "startup", "Error", "packages/daemon/src/main.ts:90", "x"),
    );
  });
});
