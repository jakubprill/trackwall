import type { SettingsRestoreItem } from "@trackwall/protocol";

/**
 * The logic of restoring the user's settings from the workspace store in Settings (ADR-299): which items start ticked
 * and what each changes, line by line. An agent can commit to the store, so an item that decides what agents may run
 * or read (`trust`) never starts ticked: the user ticks it after reading its lines.
 */

/** A line of what a restore changes: kept, gone from this computer's text or brought by the store's. */
export interface RestoreLine {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Past this many lines on a side the lines are not compared, and the whole text is shown as replaced. */
const MAX_COMPARED_LINES = 2000;

/** The ids ticked when the list opens: every item without `trust` and without a problem. */
export function initiallyTicked(items: readonly SettingsRestoreItem[]): Set<string> {
  return new Set(items.filter((item) => !item.trust && item.problem === null).map((item) => item.id));
}

/** The items in the order the list shows them: plain ones first, then the ones that need their own tick. */
export function restoreGroups(items: readonly SettingsRestoreItem[]): { plain: SettingsRestoreItem[]; trust: SettingsRestoreItem[] } {
  return { plain: items.filter((item) => !item.trust), trust: items.filter((item) => item.trust) };
}

/** The lines of `current` turned into `restored`, by their longest common run of lines; `null` current is all added. */
export function restoreLines(current: string | null, restored: string): RestoreLine[] {
  const before = current === null ? [] : linesOf(current);
  const after = linesOf(restored);
  if (before.length > MAX_COMPARED_LINES || after.length > MAX_COMPARED_LINES) {
    return [...before.map((text) => line("removed", text)), ...after.map((text) => line("added", text))];
  }
  return compared(before, after);
}

/** `common(i, j)`: the length of the longest common run of `before[i..]` and `after[j..]`. */
function commonRuns(before: string[], after: string[]): (i: number, j: number) => number {
  const width = after.length + 1;
  const table = new Array<number>((before.length + 1) * width).fill(0);
  const common = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? common(i + 1, j + 1) + 1 : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }
  return common;
}

function compared(before: string[], after: string[]): RestoreLine[] {
  const common = commonRuns(before, after);
  const lines: RestoreLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const old = before[i];
    const brought = after[j];
    if (old !== undefined && old === brought) {
      lines.push(line("same", old));
      i++;
      j++;
    } else if (old !== undefined && (brought === undefined || common(i + 1, j) >= common(i, j + 1))) {
      lines.push(line("removed", old));
      i++;
    } else if (brought !== undefined) {
      lines.push(line("added", brought));
      j++;
    }
  }
  return lines;
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function line(kind: RestoreLine["kind"], text: string): RestoreLine {
  return { kind, text };
}
