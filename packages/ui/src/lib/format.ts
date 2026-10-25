/** Formatting for the repo views; pure functions, tested in `test/format.test.ts`. */

import { countLabel } from "@trackwall/protocol";

/** A footnote under a cut file (README or preview); the daemon returns only the beginning of large files. */
export const TRUNCATED_NOTE = "The file is longer; showing the beginning.";

export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** The daemon's uptime: seconds, minutes, or hours with minutes. */
export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Breadcrumbs for a path in the repo: `a/b` gives the root, `a` and `a/b`. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: "/", path: "" }];
  if (path === "") return crumbs;
  const parts = path.split("/");
  return [...crumbs, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))];
}

/**
 * Working directory changes with the new ones separate, because "4 changes" does not say whether something was changed or
 * only added: "3 changed, 1 new". New ones are `git status` entries, so a new directory is one entry, not the number of
 * its files. `undefined` when the repo is clean.
 */
export function workingTreeLabel(changed: number, untracked: number): string | undefined {
  const parts = [changed > 0 ? `${changed} changed` : undefined, untracked > 0 ? `${untracked} new` : undefined].filter(
    (p) => p !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** The number of working directory changes as text; `undefined` when the repo is clean. */
export function changesLabel(changes: number): string | undefined {
  return changes === 0 ? undefined : countLabel(changes, { one: "change", other: "changes" });
}

/** A number with at least two digits, like the numbers in the repo list: 1 gives "01", 12 gives "12". */
export function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}
