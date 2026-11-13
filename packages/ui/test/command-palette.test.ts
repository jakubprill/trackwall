import { describe, expect, test } from "bun:test";
import type { Session, Task } from "@trackwall/protocol";
import {
  isPaletteShortcut,
  matchCommands,
  type PaletteCommand,
  type PaletteSources,
  paletteCommands,
  paletteShortcutLabel,
} from "../src/lib/command-palette.ts";

const none = { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const outside = { isMac: false, inTerminal: false };
const inTerminal = { isMac: false, inTerminal: true };
const mac = { isMac: true, inTerminal: false };

describe("the command palette's shortcut (ADR-246)", () => {
  test("Ctrl+K opens it on Windows and Linux, ⌘K on macOS, also in a terminal there", () => {
    expect(isPaletteShortcut({ ...none, key: "k", ctrlKey: true }, outside)).toBe(true);
    expect(isPaletteShortcut({ ...none, key: "k", metaKey: true }, mac)).toBe(true);
    expect(isPaletteShortcut({ ...none, key: "k", metaKey: true }, { isMac: true, inTerminal: true })).toBe(true);
    expect(paletteShortcutLabel(false)).toBe("Ctrl+K");
    expect(paletteShortcutLabel(true)).toBe("⌘K");
  });

  test("in a terminal Ctrl+K stays the terminal's delete to the end of the line, and Ctrl+Shift+K opens the palette", () => {
    expect(isPaletteShortcut({ ...none, key: "k", ctrlKey: true }, inTerminal)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "K", ctrlKey: true, shiftKey: true }, inTerminal)).toBe(true);
    expect(isPaletteShortcut({ ...none, key: "K", ctrlKey: true, shiftKey: true }, outside)).toBe(true);
  });

  test("other modifiers and other keys stay ordinary key presses", () => {
    expect(isPaletteShortcut({ ...none, key: "k" }, outside)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "k", ctrlKey: true, altKey: true }, outside)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "k", metaKey: true }, outside)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "k", ctrlKey: true }, mac)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "K", metaKey: true, shiftKey: true }, mac)).toBe(false);
    expect(isPaletteShortcut({ ...none, key: "j", ctrlKey: true }, outside)).toBe(false);
  });
});

const ordersSession: Session = {
  id: "s-1",
  repo: "orders-api",
  supervisor: false,
  startedAt: "2026-11-13T10:00:00.000Z",
  run: { kind: "running", runId: "s-1", startedAt: "2026-11-13T10:00:00.000Z", pid: 1 },
  state: null,
  windowTitle: "Fix the rounding",
  needsAttention: false,
  waitingSince: null,
  stuck: null,
  task: null,
  dialog: null,
  environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
  view: "terminal",
  readRequest: null,
  copyRequest: null,
  usage: null,
  model: null,
  modelInUse: null,
  modelError: null,
  tokenBudget: null,
};

const billingTask: Task = {
  id: "t-1",
  repo: "billing",
  prompt: "Add invoice export to CSV",
  branch: "trackwall/add-invoice-export",
  baseBranch: "main",
  base: "a".repeat(40),
  worktree: "/home/me/.trackwall/worktrees/billing/add-invoice-export",
  createdAt: "2026-11-13T09:00:00.000Z",
  title: null,
  proposedBy: null,
  model: null,
  approvals: "ask",
  plan: null,
  javaNavigation: false,
  sandbox: false,
  item: null,
  view: "terminal",
  summary: null,
  inReview: false,
  port: 41000,
  included: { files: [], problems: [] },
  change: null,
  retryOf: null,
};

const sources: PaletteSources<"home" | "repos"> = {
  views: [
    { id: "home", label: "Home", shortcut: "1" },
    { id: "repos", label: "Repos", shortcut: "2" },
  ],
  entries: [
    { kind: "session", session: ordersSession },
    { kind: "task", task: billingTask, session: undefined },
  ],
  repos: ["billing", "orders-api"],
  theme: "dark",
  newWindow: false,
  isMac: false,
};

const labels = (commands: readonly PaletteCommand<string>[]) => commands.map((c) => `${c.group}: ${c.label}`);

describe("the command palette's commands (ADR-246)", () => {
  test("lists sessions and tasks first, then actions, views with their keys, repos and Settings categories", () => {
    const commands = paletteCommands(sources);
    expect(labels(commands)).toEqual([
      "Sessions: orders-api · Fix the rounding",
      "Sessions: Add invoice export to CSV",
      "Actions: New session",
      "Actions: Next waiting",
      "Actions: Show the supervisor",
      "Actions: Theme: Light",
      "Actions: Theme: Same as the system",
      "Views: Home",
      "Views: Repos",
      "Repos: billing",
      "Repos: orders-api",
      "Settings: Workspace",
      "Settings: Repo hosts",
      "Settings: Agents",
      "Settings: Usage",
      "Settings: App",
      "Settings: Files",
      "Settings: Diagnostics",
    ]);
    expect(commands[1]).toMatchObject({ detail: "Task in billing", action: { kind: "entry", selection: { kind: "task", id: "t-1" } } });
    expect(commands.find((c) => c.label === "Repos")).toMatchObject({ shortcut: "Ctrl+2", action: { kind: "view", view: "repos" } });
    expect(commands.find((c) => c.label === "Next waiting")?.shortcut).toBe("Alt+J");
  });

  test("offers a new window only where views open in one, and the theme choices other than the current one", () => {
    const commands = paletteCommands({ ...sources, newWindow: true, theme: "system", isMac: true });
    const actions = commands.filter((c) => c.group === "Actions").map((c) => `${c.label} ${c.shortcut ?? ""}`.trim());
    expect(actions).toEqual([
      "New session",
      "Next waiting ⌥J",
      "Show the supervisor ⌥0",
      "Open this view in a new window ⌘⇧N",
      "Theme: Dark",
      "Theme: Light",
    ]);
  });
});

describe("matching what was typed (ADR-246)", () => {
  const commands = paletteCommands(sources);

  test("an empty field lists every command in order", () => {
    expect(matchCommands(commands, "  ")).toEqual(commands);
  });

  test("every word must appear in the label, the detail or the group, in any case", () => {
    expect(labels(matchCommands(commands, "billing task"))).toEqual(["Sessions: Add invoice export to CSV"]);
    expect(labels(matchCommands(commands, "ORDERS"))).toEqual(["Sessions: orders-api · Fix the rounding", "Repos: orders-api"]);
    expect(matchCommands(commands, "nothing like this")).toEqual([]);
  });

  test("the start of the label ranks above the start of a word, which ranks above the middle of one; equal ranks keep the order", () => {
    const repo = (label: string): PaletteCommand<string> => ({ id: label, group: "Repos", label, action: { kind: "repo", repo: label } });
    const listed = [repo("shop-catalog"), repo("catalog-v1"), repo("old-catalog"), repo("product-catalog")];
    expect(matchCommands(listed, "cat").map((c) => c.label)).toEqual(["catalog-v1", "shop-catalog", "old-catalog", "product-catalog"]);
    expect(matchCommands(listed, "talo").map((c) => c.label)).toEqual(["shop-catalog", "catalog-v1", "old-catalog", "product-catalog"]);
  });
});
