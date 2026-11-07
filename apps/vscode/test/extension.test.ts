import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ViewerSessionList } from "@trackwall/protocol";

/**
 * The extension as VS Code loads it: the bundle `scripts/build.ts` makes, required as CommonJS, against a fake of the
 * few `vscode` APIs it uses and a daemon on 127.0.0.1 that answers the viewer. It shows that the bundle loads with
 * `@trackwall/protocol` inside it, fills the status bar and the side bar, and opens a session by its `trackwall://` link.
 */

const TOKEN = "q".repeat(43);
const SESSION = "11111111-1111-4111-8111-111111111111";
const LIST: ViewerSessionList = {
  sessions: [
    {
      id: SESSION,
      place: "shop",
      supervisor: false,
      windowTitle: "Editing Cart.java",
      task: null,
      taskName: null,
      status: { tone: "warning", label: "asking for approval" },
      needsAttention: true,
      live: true,
      since: "2026-11-07T10:00:00Z",
    },
  ],
  proposals: 0,
};

let server: Server;
let folder: string;

const statusItem = {
  text: "",
  tooltip: "",
  visible: false,
  command: "",
  backgroundColor: undefined as unknown,
  show() {
    this.visible = true;
  },
  hide() {
    this.visible = false;
  },
  dispose() {},
};
const commands = new Map<string, (...args: unknown[]) => unknown>();
const opened: string[] = [];
let tree: { getChildren: (node?: unknown) => unknown[]; getTreeItem: (node: unknown) => Record<string, unknown> } | undefined;

class TreeItem {
  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}

mock.module("vscode", () => ({
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(
      readonly id: string,
      readonly color?: unknown,
    ) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  window: {
    state: { focused: true },
    createStatusBarItem: () => statusItem,
    registerTreeDataProvider: (_id: string, provider: typeof tree) => {
      tree = provider;
      return { dispose() {} };
    },
    onDidChangeWindowState: () => ({ dispose() {} }),
    showWarningMessage: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: () => folder }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id: string, run: (...args: unknown[]) => unknown) => {
      commands.set(id, run);
      return { dispose() {} };
    },
    executeCommand: () => undefined,
  },
  env: {
    openExternal: async (uri: { toString: () => string }) => {
      opened.push(uri.toString());
      return true;
    },
  },
}));

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health")
        return void res.end(JSON.stringify({ ok: true, data: { status: "ok", version: "1", instance: "start-1" } }));
      res.end(
        JSON.stringify(
          req.headers.authorization === `Bearer ${TOKEN}`
            ? { ok: true, data: LIST }
            : { ok: false, error: { code: "unauthorized", message: "no" } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  folder = mkdtempSync(join(tmpdir(), "trackwall-vscode-"));
  writeFileSync(
    join(folder, "viewer.json"),
    JSON.stringify({ port: (server.address() as AddressInfo).port, token: TOKEN, instance: "start-1" }),
  );
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("gave up waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the built extension in VS Code", () => {
  test("loads as CommonJS, shows what waits in the status bar and side bar, and opens a session in Trackwall", async () => {
    const out = mkdtempSync(join(tmpdir(), "trackwall-vscode-dist-"));
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "src", "extension.ts")],
      outdir: out,
      target: "node",
      format: "cjs",
      external: ["vscode"],
    });
    expect(built.success).toBe(true);
    const extension = require(join(out, "extension.js")) as { activate: (context: { subscriptions: { dispose: () => void }[] }) => void };
    const context = { subscriptions: [] as { dispose: () => void }[] };
    extension.activate(context);

    await until(() => statusItem.visible);
    expect(statusItem.text).toBe("$(bell) 1 waiting");
    expect(statusItem.tooltip).toBe("Trackwall: 1 session waiting for you");

    if (!tree) throw new Error("no side bar registered");
    const [group] = tree.getChildren();
    expect(tree.getTreeItem(group)).toMatchObject({ label: "Waiting for you", description: "1" });
    const [row] = tree.getChildren(group);
    const item = tree.getTreeItem(row);
    expect(item).toMatchObject({ label: "Editing Cart.java", description: "shop · asking for approval" });
    expect(item.command).toEqual({ command: "trackwall.openSession", title: "Open in Trackwall", arguments: [SESSION] });

    await commands.get("trackwall.openSession")?.(SESSION);
    await commands.get("trackwall.openSession")?.("../../not-a-session");
    expect(opened).toEqual([`trackwall://session/${SESSION}`]);
    for (const d of context.subscriptions) d.dispose();
  });
});
