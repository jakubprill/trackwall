import { type DocsPage, VERIFY_MISE_TASK } from "@trackwall/protocol";
import { z } from "zod";
import { knownValue } from "./known-value.ts";
import { sessionShortcutLabel } from "./session-shortcut.ts";

/**
 * Tips (ADR-296): a few sentences on a feature, in the view right where it shows, the first time it shows. One tip at a
 * time, each once on this computer: "Got it" puts it among the seen ones, and Settings › App › Tips and What's new turns
 * them all off or shows the seen ones again. A tip that "Show" of What's new asks for shows even when seen, since the
 * user asked.
 *
 * Which tips are seen and whether tips are on are a convenience of this computer, like the theme, so they live in
 * `localStorage`, which every window of the desktop shell shares. Storage can be missing, refuse access or hold a value
 * from a newer version, so what cannot be read counts as nothing seen and tips on, and a write that fails is forgotten.
 */

/** What a tip says: the control's name as the app shows it, one sentence, the explanation, and the page that tells more. */
export interface TipText {
  label: string;
  title: string;
  /** The keys a tip names differ on macOS. */
  text: (isMac: boolean) => string;
  docs: { page: DocsPage; title: string };
}

/** Every tip, in the order they take turns when several are on screen: the ones a new user meets first come first. */
export const TIPS = {
  "own-worktree": {
    label: "Own worktree",
    title: "On, the prompt becomes a task on a branch of its own",
    text: () =>
      "Trackwall makes the branch from the repo's default branch in a worktree of its own, with a port of its own and the local config " +
      "files .worktreeinclude lists, and starts the agent there, so your working copy stays as it is. Changes, Verify and a merge " +
      "request are there only for a task. Off, the agent works in the repo's own folder.",
    docs: { page: "tasks", title: "Agent tasks" },
  },
  "plan-first": {
    label: "Plan first",
    title: "Read the agent's plan before it changes a file",
    text: () =>
      "The task starts in Copilot CLI's Plan mode: the agent reads the code and answers with a plan, Copilot CLI refuses its file " +
      "changes, and it asks before every command. Reply in the chat to change the plan; Approve plan lets the agent carry it out. " +
      "It needs Chat (preview), since Trackwall switches the mode in the conversation.",
    docs: { page: "tasks", title: "Agent tasks" },
  },
  "next-waiting": {
    label: "Next waiting",
    title: "One click to whatever waits for you",
    text: (isMac) =>
      `It opens the next session or task proposal waiting for you. ${sessionShortcutLabel({ kind: "next-waiting" }, isMac)} does it ` +
      `from any view, also from a terminal, and ${isMac ? "⌃⌥J" : "Win+Alt+J"} from any other app in the desktop app.`,
    docs: { page: "sessions", title: "Copilot CLI sessions" },
  },
  "always-allow": {
    label: "Always allow",
    title: "Every task of this repo runs it without asking",
    text: () =>
      "It answers Yes, and from then on the repo's tasks, also the running ones, run exactly the command or MCP tool Copilot CLI " +
      "names, so git status is not git push. It is never offered for a command that writes files by path, runs code you give it, " +
      "reaches the network or pushes. Settings › Agents › Always allowed in tasks lists what you allowed and takes it back.",
    docs: { page: "approvals", title: "Approvals outside the terminal" },
  },
  verify: {
    label: "Verify",
    title: "Run the task's tests where its agent works",
    text: () =>
      `Verify runs the repo's mise task ${VERIFY_MISE_TASK} in the task's worktree and shows the verdict in its details: passed or ` +
      "failed, the test counts and the first failed tests. The agent gets the same verdict before it reports, and the task's row " +
      "says Verify again once the files change after a run.",
    docs: { page: "tasks", title: "Agent tasks" },
  },
  evidence: {
    label: "Evidence",
    title: "Read what backs the change before the diff",
    text: () =>
      "Each line is one fact with whose word it is. Green: Trackwall checked it on the files as they are. Yellow: still open, or checked on an " +
      "earlier version of the changes. Red: a check speaks against the change. Grey: nobody checked it yet. The merge request's description " +
      "gets the same facts.",
    docs: { page: "tasks", title: "Agent tasks" },
  },
  "ready-to-close": {
    label: "Ready to close",
    title: "The agent says nothing is left to do",
    text: () =>
      "Close task stops its session, removes its worktree and keeps the branch; Keep open leaves the task in review. Anything you send the " +
      "agent takes the mark back, and Close all at the top of the Sessions list closes every task that is ready.",
    docs: { page: "tasks", title: "Agent tasks" },
  },
} as const satisfies Record<string, TipText>;

export type TipId = keyof typeof TIPS;

/** Every tip's id, in the order of `TIPS`. */
export const TIP_IDS = Object.keys(TIPS).filter((id): id is TipId => id in TIPS);

/**
 * The tip to show now, while tips are on: the one "Show" asked for once its place is on screen, else the first tip in
 * `TIPS` whose place is on screen and that the user has not seen.
 */
export function tipToShow({
  present,
  seen,
  on,
  asked,
}: {
  present: ReadonlySet<TipId>;
  seen: ReadonlySet<TipId>;
  on: boolean;
  asked: TipId | null;
}): TipId | null {
  if (!on) return null;
  if (asked !== null && present.has(asked)) return asked;
  return TIP_IDS.find((id) => present.has(id) && !seen.has(id)) ?? null;
}

const TIPS_ON = ["on", "off"] as const;

/** The `localStorage` keys; the `storage` event carries them to the other windows. */
export const TIPS_ON_KEY = "trackwall.tips";
export const TIPS_SEEN_KEY = "trackwall.tips.seen";

export function readTipsOn(storage: () => Pick<Storage, "getItem">): boolean {
  try {
    return knownValue(TIPS_ON, storage().getItem(TIPS_ON_KEY)) !== "off";
  } catch {
    return true;
  }
}

export function saveTipsOn(storage: () => Pick<Storage, "setItem">, on: boolean): void {
  try {
    storage().setItem(TIPS_ON_KEY, on ? "on" : "off");
  } catch {
    // The choice holds until the window closes; only the next start does not remember it.
  }
}

const SeenTips = z.array(z.string());

/** The tips seen on this computer; an id this version does not know, such as a tip a newer version added, is left out. */
export function readSeenTips(storage: () => Pick<Storage, "getItem">): ReadonlySet<TipId> {
  try {
    const stored = storage().getItem(TIPS_SEEN_KEY);
    const parsed = SeenTips.safeParse(stored === null ? [] : JSON.parse(stored));
    return new Set(parsed.success ? TIP_IDS.filter((id) => parsed.data.includes(id)) : []);
  } catch {
    return new Set();
  }
}

export function saveSeenTips(storage: () => Pick<Storage, "setItem">, seen: ReadonlySet<TipId>): void {
  try {
    storage().setItem(TIPS_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // The tip stays away in this window; only the next start shows it again.
  }
}
