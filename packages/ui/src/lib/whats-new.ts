import { z } from "zod";
import type { PaletteAction } from "./command-palette.ts";
import type { TipId } from "./tips.ts";

/**
 * What's new (ADR-296): after an update, a strip above the views lists the changes a user should look at, each with
 * "Show", which opens the place it lives in and, for a change with a tip, shows that tip. The strip shows the entries
 * this computer has not seen; "Dismiss" counts every entry as seen. A new computer sees none, as its user meets
 * everything for the first time anyway: Trackwall without a projects folder is a new install.
 *
 * The seen entries are a convenience of this computer in `localStorage`, like the seen tips. Storage can be missing,
 * refuse access or hold anything, so what cannot be read counts as never stored, and a write that fails is forgotten.
 */

/** Where "Show" takes the user: a command of the command palette, which `App` carries out as it does the palette's. */
export type WhatsNewPlace = Extract<PaletteAction<"sessions" | "repos">, { kind: "view" | "settings" | "new-session" }>;

/** What "Show" of an entry does: opens the place, and shows the tip there. */
export interface WhatsNewShow {
  place: WhatsNewPlace;
  tip?: TipId;
}

export interface WhatsNewEntry {
  /** Never reused: a computer that saw an entry with this id never shows another one with it. */
  id: string;
  title: string;
  text: string;
  /** None for a change with no place of its own. */
  show?: WhatsNewShow;
}

/**
 * The changes worth a look, newest first. A feature a user should notice after an update adds its entry at the top in
 * the same PR (AGENTS.md), and the oldest entries go when the list would hold more than `WHATS_NEW_MOST`: a computer
 * that skipped that many changes reads the release notes. "Tips" stays last: it is the entry whose Show brings back a
 * tip, which `tips.e2e.ts` checks, so the list always has one.
 */
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "tests-tab",
    title: "A Tests tab in every task",
    text: "The Tests tab of a task lists the tests that failed in its worktree's test reports, without pages and without the passed ones, each with its stack trace and Fix this; All shows the rest.",
    show: { place: { kind: "view", view: "sessions" } },
  },
  {
    id: "remove-a-repo",
    title: "Remove a repo",
    text: "Remove… in a repo's header takes the repo off the list once you type its name: its folder moves into .trackwall/removed, and nothing is deleted.",
    show: { place: { kind: "view", view: "repos" } },
  },
  {
    id: "failed-tests-open",
    title: "Failed tests open to their stack trace",
    text: "Click a failed test in a task's Verification to see what it expected, what it got and where in your code it failed, open that line in VS Code, and hand the test to the agent with Fix this.",
    show: { place: { kind: "view", view: "sessions" } },
  },
  {
    id: "settings-in-the-store",
    title: "Settings in the workspace store",
    text: "Turn on Keep Trackwall and Copilot CLI settings in the store, and workspace.yaml and your Copilot CLI settings get a history in git, with the tokens in mcp-config.json masked, and a new container gets them back with Restore settings from the store.",
    show: { place: { kind: "settings", category: "workspace" } },
  },
  {
    id: "accept-changed-git-hooks",
    title: "Accept changed git hooks",
    text: "When a package install in a sandboxed task changes the repo's git hooks, the error names them, and End task shows them with Accept these settings, so the task can end.",
    show: { place: { kind: "view", view: "sessions" } },
  },
  {
    id: "tips",
    title: "Tips",
    text: "A tip explains a feature where you meet it for the first time, such as Own worktree in the New session form.",
    show: { place: { kind: "new-session" }, tip: "own-worktree" },
  },
];

/** The most entries `WHATS_NEW` holds (a test keeps it so): more would push the views down too far. */
export const WHATS_NEW_MOST = 6;

/** Whether the computer is new, from the daemon's projects folder (`undefined` until the daemon says): none is set yet. */
export function isNewComputer(projectsDir: string | null | undefined): boolean | undefined {
  return projectsDir === undefined ? undefined : projectsDir === null;
}

/**
 * The entries the strip lists: the ones this computer has not seen, newest first; none on a new computer that never
 * stored any; `undefined` while it is not known yet whether the computer is new.
 */
export function whatsNewEntries(seen: ReadonlySet<string> | null, newComputer: boolean | undefined): readonly WhatsNewEntry[] | undefined {
  if (seen === null && newComputer === undefined) return undefined;
  if (seen === null && newComputer === true) return [];
  return WHATS_NEW.filter((entry) => !seen?.has(entry.id));
}

/** The `localStorage` key; the `storage` event carries it to the other windows. */
export const WHATS_NEW_SEEN_KEY = "trackwall.whats-new.seen";

const SeenEntries = z.array(z.string());

/** The entries seen on this computer, `null` when it never stored any. */
export function readSeenWhatsNew(storage: () => Pick<Storage, "getItem">): ReadonlySet<string> | null {
  try {
    const stored = storage().getItem(WHATS_NEW_SEEN_KEY);
    if (stored === null) return null;
    const parsed = SeenEntries.safeParse(JSON.parse(stored));
    return parsed.success ? new Set(parsed.data) : null;
  } catch {
    return null;
  }
}

/** Counts every entry of this version as seen; ids of entries gone from the list are not kept. */
export function saveAllWhatsNewSeen(storage: () => Pick<Storage, "setItem">): void {
  try {
    storage().setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(WHATS_NEW.map((entry) => entry.id)));
  } catch {
    // The strip goes away in this window; only the next start shows it again.
  }
}
