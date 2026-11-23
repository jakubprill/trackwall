import { createHash } from "node:crypto";
import type { RunSettingsChange, TaskRunSettings } from "@trackwall/protocol";

/**
 * A repo's run settings (`run-settings.ts`) as the user reads them (ADR-181, addendum of 2026-11-23): each place, such
 * as `.git/config core.fsmonitor` or `.git/hooks/pre-commit`, with a hash of what it holds, which a sandboxed task keeps
 * beside the digest, so a refusal names what changed; the text the user reviews before accepting a change, with
 * credentials hidden and characters that could disguise it made visible; and the changes no review can make safe, which
 * the user has to undo in the repo: almost every key of `.git/config` that counts (`ACCEPTABLE`), since a filter or a
 * credential helper can name a script the agent rewrites after the acceptance without changing the digest, an include
 * makes git read a file the guard does not read, a proxy or `url.*.insteadOf` sends the user's credentials or branches
 * elsewhere, and an alias runs in the user's own shell. Hooks and attributes can be accepted: the daemon runs no hook in
 * a guarded repo, and attributes do nothing without a filter or driver in the configuration.
 */

/** Each place of the run settings with the SHA-256 of what it holds. */
type RunSettingsSnapshot = Readonly<Record<string, string>>;

/** The digest and places a sandboxed task keeps of its repo's run settings; places are `null` in a task saved before them. */
export interface RunSettingsGuard {
  digest: string;
  snapshot: RunSettingsSnapshot | null;
}

/** What `readRunSettings` reads, before it is turned into places. */
export interface RunSettingsFiles {
  /** The counted entries of `.git/config`, in their order (`countedEntries`). */
  configEntries: readonly string[];
  attributes: string;
  /** Each file in `hooks/` with its bytes; `null` for a folder. */
  hooks: readonly (readonly [string, Buffer | null])[];
  /** Each `config.worktree` by its path from the common directory, with its text, every entry and the counted ones. */
  worktreeConfigs: readonly { file: string; content: string; entries: readonly string[]; counted: readonly string[] }[];
}

/** A repo's run settings now: the digest the baselines hold, every place's hash, and what the user reads of each. */
export interface RunSettings {
  digest: string;
  snapshot: RunSettingsSnapshot;
  shown: ReadonlyMap<string, string | null>;
  /** The places a review cannot make safe, which only undoing them in the repo clears. */
  undoOnly: ReadonlySet<string>;
  /** Every counted entry of `.git/config` in its order, for a change only their order shows. */
  configListing: string;
}

type PlaceChange = Omit<RunSettingsChange, "content" | "acceptable">;

/** The place a review shows when only the order of `.git/config`'s entries changed, which matters where a later value wins. */
const CONFIG_ORDER = ".git/config (the order of its settings)";
/** A place's text longer than this is not shown: the user reads it in the repo. */
const MAX_SHOWN_CHARS = 16_384;
/** A key longer than this is shortened in its place's name, which `tasks.json` keeps. */
const MAX_KEY_CHARS = 300;
/** Variable names whose value is a credential: the review names the key without it. */
const SECRET_NAMES = new Set(["extraheader", "password"]);
/**
 * The counted keys a user can accept after reading them: `extensions.worktreeConfig`, which only makes git read the
 * `config.worktree` files the guard reads too, and `core.bare`. Every other counted key runs a program, reads a file the
 * guard does not read, or sends git's requests (with the user's credentials) or the user's branches elsewhere.
 */
const ACCEPTABLE = /^(extensions\.worktreeconfig|core\.bare)$/;
/** Keys whose values are addresses, whose password the review hides. */
const ADDRESS_KEYS = /^(url|http|credential|remote)\./;
/** A hook sample `git init` writes: git runs no hook whose name ends in `.sample`. */
const SAMPLE_HOOK = /^\.git\/hooks\/[^/]+\.sample$/;
/**
 * Control (but tab and line ends), zero-width, direction and replacement characters, as code point ranges: they could
 * make a command look like another, so the review names them.
 */
const HIDING_CHARS: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
  [0xe0000, 0xe007f],
];
/** A URL's user part with a password (`https://user:pass@`), which place names and address values hide. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]*:[^/@\s]*@/i;
const WORD = { added: "added", modified: "changed", removed: "deleted" } as const;

/** The places of the files read, with the digest `readRunSettings` computed from them. */
export function placesOf(files: RunSettingsFiles, digest: string): RunSettings {
  const places = new Map<string, { raw: string | Buffer; shown: string | null; undoOnly: boolean }>();
  for (const [key, values] of keyValues(files.configEntries))
    places.set(`.git/config ${placeKey(key)}`, {
      raw: JSON.stringify(values),
      shown: values.some((value) => isHidden(key, value)) ? null : values.join("\n"),
      undoOnly: !ACCEPTABLE.test(key),
    });
  if (files.attributes !== "") places.set(".git/info/attributes", { raw: files.attributes, shown: files.attributes, undoOnly: false });
  for (const [name, content] of files.hooks)
    places.set(`.git/hooks/${name}`, {
      raw: content ?? "\0a folder",
      shown: content === null ? "(a folder)" : content.toString("utf8"),
      undoOnly: false,
    });
  for (const { file, content, entries, counted } of files.worktreeConfigs)
    places.set(`.git${file.replaceAll("\\", "/")}`, {
      raw: content,
      shown: listing(entries),
      undoOnly: counted.some((entry) => !ACCEPTABLE.test(keyOf(entry))),
    });
  return {
    digest,
    snapshot: Object.fromEntries([...places].map(([place, { raw }]) => [place, sha256(raw)])),
    shown: new Map([...places].map(([place, { shown }]) => [place, visible(shown)])),
    undoOnly: new Set([...places].flatMap(([place, { undoOnly }]) => (undoOnly ? [place] : []))),
    configListing: listing(files.configEntries) ?? "",
  };
}

/**
 * The run settings `now` against the guards of a repo's sandboxed tasks, with what each changed place holds for the user
 * to read: no change while `now` matches one of them; else the changes against the closest guard that names its places,
 * every place when none does (`baselineKnown`), or the order of `.git/config` when no place differs.
 */
export function reviewRunSettings(now: RunSettings, guards: readonly RunSettingsGuard[]): TaskRunSettings {
  const review = { guarded: guards.length > 0, matches: true, baselineKnown: true, changes: [], digest: now.digest };
  if (guards.length === 0 || guards.some((g) => g.digest === now.digest)) return review;
  const closest = closestChanges(now, guards);
  const changes = (closest ?? everyPlace(now)).map(
    (c): RunSettingsChange => ({
      ...c,
      content: c.change === "removed" ? null : (now.shown.get(c.place) ?? null),
      acceptable: !now.undoOnly.has(c.place),
    }),
  );
  if (changes.length === 0)
    changes.push({
      place: CONFIG_ORDER,
      change: "modified",
      content: visible(now.configListing),
      acceptable: ![...now.undoOnly].some((place) => place.startsWith(".git/config ")),
    });
  return { ...review, matches: false, baselineKnown: closest !== null, changes };
}

/** What a refusal names in parentheses: the places changed against the closest guard, or the kinds of files to look at. */
export function changedPlacesText(now: RunSettings | null, guards: readonly RunSettingsGuard[], max: number): string {
  const changes = (now === null ? null : closestChanges(now, guards)) ?? [];
  const named = changes.slice(0, max).map((c) => `${WORD[c.change]} ${c.place}`);
  if (changes.length > max) named.push(`and ${changes.length - max} more`);
  return named.length > 0 ? named.join(", ") : ".git/config, .git/info/attributes or .git/hooks";
}

/** The changes against the guard with places that differ least from `now`; `null` when no guard has places. */
function closestChanges(now: RunSettings, guards: readonly RunSettingsGuard[]): PlaceChange[] | null {
  const diffs = guards.flatMap((g) => (g.snapshot === null ? [] : [changesBetween(g.snapshot, now.snapshot)]));
  return diffs.sort((a, b) => a.length - b.length)[0] ?? null;
}

/** Without a guard that names its places, every place, except the samples `git init` writes, which git never runs. */
function everyPlace(now: RunSettings): PlaceChange[] {
  const places = Object.keys(now.snapshot).filter((place) => !SAMPLE_HOOK.test(place));
  return places.sort().map((place) => ({ place, change: "added" }));
}

function changesBetween(before: RunSettingsSnapshot, now: RunSettingsSnapshot): PlaceChange[] {
  const places = [...new Set([...Object.keys(before), ...Object.keys(now)])].sort();
  return places.flatMap((place): PlaceChange[] => {
    const was = before[place];
    const is = now[place];
    if (was === is) return [];
    if (was === undefined) return [{ place, change: "added" }];
    if (is === undefined) return [{ place, change: "removed" }];
    return [{ place, change: "modified" }];
  });
}

/** Each key's values in their order (a key can repeat). */
function keyValues(entries: readonly string[]): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    keys.set(key, [...(keys.get(key) ?? []), entry.slice(key.length + 1)]);
  }
  return keys;
}

/** Entries as `key = value` lines, a credential hidden and a line break in a value written `\\n`; `null` for none. */
function listing(entries: readonly string[]): string | null {
  if (entries.length === 0) return null;
  return entries
    .map((entry) => {
      const key = keyOf(entry);
      const value = entry.slice(key.length + 1);
      return `${placeKey(key)} = ${isHidden(key, value) ? "(hidden)" : value.replaceAll("\n", "\\n")}`;
    })
    .join("\n");
}

function keyOf(entry: string): string {
  const newline = entry.indexOf("\n");
  return newline < 0 ? entry : entry.slice(0, newline);
}

/** A credential: a value under a credential's name (an alias is never one), or an address with a password in it. */
function isHidden(key: string, value: string): boolean {
  if (!key.startsWith("alias.") && SECRET_NAMES.has(key.slice(key.lastIndexOf(".") + 1))) return true;
  return ADDRESS_KEYS.test(key) && USERINFO.test(value);
}

/** A key as its place names it: a password in a URL subsection hidden, a very long subsection shortened with its hash. */
function placeKey(key: string): string {
  const shown = key.replace(new RegExp(USERINFO, "gi"), "$1***@");
  return shown.length <= MAX_KEY_CHARS ? shown : `${shown.slice(0, MAX_KEY_CHARS)}…${sha256(key).slice(0, 12)}`;
}

/** Text for the review, with characters that could disguise a command named; `null` when too long. Nothing is removed. */
function visible(text: string | null): string | null {
  if (text === null || text.length > MAX_SHOWN_CHARS) return null;
  return Array.from(text, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return HIDING_CHARS.some(([from, to]) => code >= from && code <= to) ? `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>` : c;
  }).join("");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
