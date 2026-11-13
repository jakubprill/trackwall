import { sessionTitle } from "@trackwall/protocol";
import { entryId, entrySelection, proposalsName, type SessionEntry, type SessionSelection, taskName } from "./session-entries.ts";
import { SUPERVISOR_SHORTCUT, sessionShortcutLabel } from "./session-shortcut.ts";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./settings-categories.ts";
import { THEME_CHOICE_LABELS, THEME_CHOICES, type ThemeChoice } from "./theme.ts";
import { newWindowShortcutLabel, shortcutLabel, type ViewShortcut } from "./view-shortcut.ts";

/**
 * The command palette (ADR-246): one key opens a field over any view, a few letters find a session, a task, a repo, a
 * view or a Settings category, or an action, and Enter goes there. The view bar and the Alt shortcuts need you to know
 * where a thing is; the palette needs only its name. This file holds what the palette lists and how it matches; the
 * window (`components/CommandPalette.tsx`) only shows it.
 */

type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/**
 * Ctrl+K opens the palette, ⌘K on macOS, as in Slack and GitHub. The letter by character, like the menus of every
 * layout. In a terminal (a session's or a folder's) Ctrl+K is the shell's and Copilot CLI's "delete to the end of the
 * line", so there it stays the terminal's and Ctrl+Shift+K opens the palette instead; Ctrl+Shift+K works everywhere, so
 * one habit is enough. ⌘K never reaches a terminal: xterm.js sends nothing for ⌘.
 */
export function isPaletteShortcut(press: KeyPress, { isMac, inTerminal }: { isMac: boolean; inTerminal: boolean }): boolean {
  if (press.key.toLowerCase() !== "k" || press.altKey) return false;
  if (isMac) return press.metaKey && !press.ctrlKey && !press.shiftKey;
  if (!press.ctrlKey || press.metaKey) return false;
  return press.shiftKey || !inTerminal;
}

/** The key the palette shows for itself, in the system's convention. */
export function paletteShortcutLabel(isMac: boolean): string {
  return isMac ? "⌘K" : "Ctrl+K";
}

/** The groups, listed in this order: what you work on first, then where to go, then what to change. */
type PaletteGroup = "Sessions" | "Actions" | "Views" | "Repos" | "Settings";

/** What a command does; the window that owns the views carries it out. */
export type PaletteAction<ViewId extends string> =
  | { kind: "view"; view: ViewId }
  | { kind: "settings"; category: SettingsCategory }
  | { kind: "entry"; selection: SessionSelection }
  | { kind: "repo"; repo: string }
  | { kind: "new-session" }
  | { kind: "supervisor" }
  | { kind: "next-waiting" }
  | { kind: "new-window" }
  | { kind: "theme"; choice: ThemeChoice };

export interface PaletteCommand<ViewId extends string> {
  /** Unique among the commands: the option's id in the list. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** What tells two commands with the same label apart, such as a task's repo; it is matched too. */
  detail?: string;
  shortcut?: string;
  action: PaletteAction<ViewId>;
}

export interface PaletteSources<ViewId extends string> {
  views: readonly { id: ViewId; label: string; shortcut: ViewShortcut }[];
  /** The Sessions list's entries in its order, newest first. */
  entries: readonly SessionEntry[];
  /** Repo ids, as the Repos view names them. */
  repos: readonly string[];
  theme: ThemeChoice;
  /** Whether views open in new windows (the desktop app). */
  newWindow: boolean;
  isMac: boolean;
}

export function paletteCommands<ViewId extends string>(sources: PaletteSources<ViewId>): PaletteCommand<ViewId>[] {
  const { isMac } = sources;
  return [
    ...sources.entries.map((entry) => entryCommand<ViewId>(entry)),
    ...actionCommands<ViewId>(sources),
    ...sources.views.map(
      (view): PaletteCommand<ViewId> => ({
        id: `view:${view.id}`,
        group: "Views",
        label: view.label,
        shortcut: shortcutLabel(view.shortcut, isMac),
        action: { kind: "view", view: view.id },
      }),
    ),
    ...sources.repos.map(
      (repo): PaletteCommand<ViewId> => ({ id: `repo:${repo}`, group: "Repos", label: repo, action: { kind: "repo", repo } }),
    ),
    ...SETTINGS_CATEGORIES.map(
      (category): PaletteCommand<ViewId> => ({
        id: `settings:${category.id}`,
        group: "Settings",
        label: category.label,
        detail: category.description,
        action: { kind: "settings", category: category.id },
      }),
    ),
  ];
}

function entryCommand<ViewId extends string>(entry: SessionEntry): PaletteCommand<ViewId> {
  const base = { id: `entry:${entryId(entry)}`, group: "Sessions", action: { kind: "entry", selection: entrySelection(entry) } } as const;
  if (entry.kind === "proposals") return { ...base, label: proposalsName(entry.proposals), detail: "Waiting for your decision" };
  if (entry.kind === "task") return { ...base, label: taskName(entry.task), detail: `Task in ${entry.task.repo}` };
  return { ...base, label: sessionTitle(entry.session), detail: "Session" };
}

/** The actions; the session ones carry the shortcuts they also have, so the palette teaches them. */
function actionCommands<ViewId extends string>({ theme, newWindow, isMac }: PaletteSources<ViewId>): PaletteCommand<ViewId>[] {
  const actions: PaletteCommand<ViewId>[] = [
    { id: "action:new-session", group: "Actions", label: "New session", action: { kind: "new-session" } },
    {
      id: "action:next-waiting",
      group: "Actions",
      label: "Next waiting",
      shortcut: sessionShortcutLabel({ kind: "next-waiting" }, isMac),
      action: { kind: "next-waiting" },
    },
    {
      id: "action:supervisor",
      group: "Actions",
      label: "Show the supervisor",
      shortcut: sessionShortcutLabel(SUPERVISOR_SHORTCUT, isMac),
      action: { kind: "supervisor" },
    },
  ];
  if (newWindow) {
    actions.push({
      id: "action:new-window",
      group: "Actions",
      label: "Open this view in a new window",
      shortcut: newWindowShortcutLabel(isMac),
      action: { kind: "new-window" },
    });
  }
  for (const choice of THEME_CHOICES) {
    if (choice === theme) continue;
    actions.push({
      id: `action:theme:${choice}`,
      group: "Actions",
      label: `Theme: ${THEME_CHOICE_LABELS[choice]}`,
      action: { kind: "theme", choice },
    });
  }
  return actions;
}

/**
 * The commands that match what was typed, best first. Every word must appear in the label, the detail or the group, in
 * any case, so "orders task" finds a task in `orders-api`. A word at the start of the label ranks above one at the start
 * of a word in it, which ranks above one anywhere else; equal ranks keep the palette's order. No fuzzy matching of
 * scattered letters: with sessions named after repos, "oa" would find half the list.
 */
export function matchCommands<ViewId extends string>(commands: readonly PaletteCommand<ViewId>[], query: string): PaletteCommand<ViewId>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands
    .map((command, order) => ({ command, order, rank: rankOf(command, words) }))
    .filter((match): match is { command: PaletteCommand<ViewId>; order: number; rank: number } => match.rank !== undefined)
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .map((match) => match.command);
}

function rankOf(command: PaletteCommand<string>, words: readonly string[]): number | undefined {
  const label = command.label.toLowerCase();
  const text = `${label} ${command.detail ?? ""} ${command.group}`.toLowerCase();
  let rank = 0;
  for (const word of words) {
    if (!text.includes(word)) return undefined;
    rank += wordRank(label, word);
  }
  return rank;
}

const WORD_START = /[\s\-_/.·:(]/;

function wordRank(label: string, word: string): number {
  if (label.startsWith(word)) return 3;
  let at = label.indexOf(word);
  while (at > 0) {
    if (WORD_START.test(label.charAt(at - 1))) return 2;
    at = label.indexOf(word, at + 1);
  }
  return label.includes(word) ? 1 : 0;
}
