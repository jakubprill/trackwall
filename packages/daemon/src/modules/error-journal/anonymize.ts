import { MAX_ERROR_MESSAGE_CHARS } from "@trackwall/protocol";

/**
 * Anonymization of an error's text (ADR-94): the journal keeps what went wrong in Trackwall, never what the computer, its
 * user or their repos are called. Two layers. The values the daemon knows (the home directory, the user and computer
 * names, the projects folder, repo names, repo hosts, environment variable values) are replaced first, longest first, so a
 * path with a space in it goes whole. Then patterns catch what nobody named: paths, addresses, e-mail, IP addresses, host
 * names (by a list of top-level domains that are not also words in code, so `this.app` stays) and things that look like tokens. A known folder takes the rest of its path with it (`<projects>/…`), because the
 * folders under it are the user's repos; only Trackwall's own state directory keeps its path, which is Trackwall's.
 */

/** A value to replace and what replaces it, for example the projects folder and `<projects>`. */
export interface KnownValue {
  value: string;
  label: string;
  /** Only as a whole word outside a path: a repo called `api` must not take `api` out of `/api/workspace/sync`. */
  wholeWord?: boolean;
}

/** The label of the state directory, whose files are Trackwall's own, so the path under it stays. */
export const STATE_DIR_LABEL = "<trackwall>";

/** Shorter values (`1`, `on`) would cut ordinary words out of every message; a whole word may be shorter (a computer called `vm`). */
const MIN_KNOWN_CHARS = 3;
const MIN_WHOLE_WORD_CHARS = 2;

const PATTERNS: readonly [RegExp, string][] = [
  // `Bearer …`, `token=…`, `password: …`: the name stays, the value goes.
  [/\b(bearer)\s+[^\s'"]+/gi, "$1 <secret>"],
  [
    /\b(token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key)(["']?\s*[=:]\s*["']?)(?!bearer\b)[^\s'",;&]+/gi,
    "$1$2<secret>",
  ],
  // GitHub and GitLab tokens by their prefix.
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, "<secret>"],
  // Any address with a scheme, `file:` included; the daemon's own loopback address carries nothing of the user's.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()[\]{}]+/gi, "<url>"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  // A Windows path with a drive letter, and a UNC path (`\\server\share`).
  [/\b[A-Za-z]:[\\/][^\s'"<>|*?]*/g, "<path>"],
  [/\\\\[^\s'"<>|*?\\]+\\[^\s'"<>|*?]*/g, "<path>"],
  // A POSIX path under a folder that holds users' files; `/api/…` routes and the like stay.
  [/(?<![\w.<>-])\/(?:Users|home|root|tmp|private|var|Volumes|mnt|opt|media|srv|etc)\/[^\s'"<>()]*/g, "<path>"],
  // IPv4 addresses other than loopback.
  [/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  // A host name: labels joined by dots that end in a top-level domain; file names (`server.ts`, `package.json`) do not.
  [
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|cloud|internal|local|lan|corp|intra|intranet|biz|eu|pl|de|uk|fr|nl|ch|se|dk|fi|cz|es|cn|jp|ru|ca|au|br)\b/gi,
    "<host>",
  ],
  // A long hexadecimal string or a long run of letters and digits: a hash or a key either way, and no help in reading the error.
  [/\b[0-9a-f]{32,}\b/gi, "<secret>"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}={0,2}/g, "<secret>"],
];

/** The anonymized text, cut to `MAX_ERROR_MESSAGE_CHARS`. */
export function anonymize(text: string, known: readonly KnownValue[]): string {
  const replaced = applyPatterns(replaceKnown(text, known));
  return replaced.length > MAX_ERROR_MESSAGE_CHARS ? `${replaced.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` : replaced;
}

function replaceKnown(text: string, known: readonly KnownValue[]): string {
  let out = text;
  for (const { value, label, wholeWord } of spellings(known)) {
    const escaped = escapeRegExp(value);
    out = out.replace(new RegExp(wholeWord ? `(?<![\\w./\\\\-])${escaped}(?![\\w/\\\\-])` : escaped, "gi"), label);
  }
  // A known folder takes the rest of its path with it, except Trackwall's own state directory.
  return out.replace(/(<[a-z]+>)((?:[\\/][^\s'"<>|*?]*)+)/g, (all, label: string) => (label === STATE_DIR_LABEL ? all : `${label}/…`));
}

/** Every value in the spellings it can take in a message (both slashes, JSON's doubled backslash), longest first. */
function spellings(known: readonly KnownValue[]): KnownValue[] {
  const all: KnownValue[] = [];
  for (const entry of known) {
    const trimmed = entry.value.replace(/[\\/]+$/, "");
    if (trimmed.length < (entry.wholeWord ? MIN_WHOLE_WORD_CHARS : MIN_KNOWN_CHARS)) continue;
    for (const spelling of new Set([
      trimmed,
      trimmed.replaceAll("\\", "/"),
      trimmed.replaceAll("/", "\\"),
      trimmed.replaceAll("\\", "\\\\"),
    ])) {
      all.push({ ...entry, value: spelling });
    }
  }
  return all.sort((a, b) => b.value.length - a.value.length);
}

function applyPatterns(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
