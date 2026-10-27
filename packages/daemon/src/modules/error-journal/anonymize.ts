import { MAX_ERROR_MESSAGE_CHARS } from "@trackwall/protocol";

/**
 * Anonymization of an error's text (ADR-94): the journal keeps what went wrong in Trackwall, never what the computer, its
 * user or their repos are called. Two layers. The values the daemon knows (the home directory, the user and computer
 * names, the projects folder, repo names, repo hosts, environment variable values) are replaced first, in one pass over the
 * text with the longest value winning at each place, so a path with a space in it goes whole and a label already written
 * is never matched again. Then patterns catch what nobody named: paths (with spaces when a separator follows, or whole
 * between quotes), addresses, e-mail, IP addresses, host names (by a list of top-level domains that are not common words in
 * code) and things that look like tokens. A known folder takes the rest of its path with it (`<projects>/…`), because the
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
/** The patterns' work grows with the text, so a long message (git's stderr, a JSON body) is cut before them too. */
const MAX_INPUT_CHARS = 4 * MAX_ERROR_MESSAGE_CHARS;

/** The rest of a path: its characters, and a space only when another separator comes before the next space (`Acme Client\x`). */
const PATH_REST = String.raw`(?:[^\s'"\x60<>|*?]|\s(?=[^\s'"\x60<>|*?\\/]*[\\/]))*`;
/** Where a path starts: a drive (also URL-encoded), a UNC share, `~`, or a POSIX folder that holds users' files. */
const PATH_START = String.raw`(?:\b[A-Za-z](?::|%3A)(?:[\\/]|%5C|%2F)|\\\\[^\s'"\x60<>|*?\\]+\\|(?<![\w.<>-])~[\\/]|(?<![\w.<>-])\/(?:Users|home|root|tmp|private|var|Volumes|mnt|opt|media|srv|etc|workspace|workspaces|data)\/)`;

const PATTERNS: readonly [RegExp, string | ((match: string) => string)][] = [
  // A path between quotes, whole, spaces included; a known folder's label counts as its start, except the state directory's.
  [new RegExp(String.raw`(['"\x60])(?:<(?!trackwall>)[a-z]+>[\\/]|${PATH_START})[^'"\x60\n]*\1`, "gi"), "$1<path>$1"],
  // A known folder takes the rest of its path with it, except Trackwall's own state directory.
  [new RegExp(String.raw`<(?!trackwall>)([a-z]+)>(?:(?:[\\/]|%2F|%5C)${PATH_REST})+`, "gi"), "<$1>/…"],
  // `Bearer …`, `Basic …`, `access_token=…`, `password: …`: the name stays, the value goes; "basic" is an ordinary word too,
  // so only a value that looks like base64 (a capital, a digit or `+/=` in it) goes after it.
  [/\b(bearer)\s+[^\s'"]+/gi, "$1 <secret>"],
  [/\b([Bb][Aa][Ss][Ii][Cc])\s+(?=[\w+/]*[A-Z0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g, "$1 <secret>"],
  [
    /\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|credentials?))(["']?\s*[=:]\s*["']?)(?!(?:bearer|basic)\b)[^\s'",;&]+/gi,
    "$1$2<secret>",
  ],
  // GitHub and GitLab tokens by their prefix.
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, "<secret>"],
  // Any address with a scheme, `file:` included, and a git remote in scp form (`git@host:group/repo.git`).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()[\]{}]+/gi, "<url>"],
  [/\b[\w.-]+@[\w.-]+:[^\s'"<>()]+/g, "<url>"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [new RegExp(`${PATH_START}${PATH_REST}`, "gi"), "<path>"],
  // Any other absolute POSIX path of three or more folders; `/api/…` routes stay.
  [/(?<![\w.<>-])\/(?!api\/)[^\s'"<>()/]+(?:\/[^\s'"<>()/]+){2,}/g, "<path>"],
  // IPv4 addresses other than loopback.
  [/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  // A host name: labels joined by dots that end in a top-level domain; file names (`server.ts`, `package.json`) do not.
  [
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|ai|dev|cloud|internal|local|lan|corp|intra|intranet|biz|eu|pl|de|uk|fr|nl|ch|se|dk|fi|cz|es|cn|jp|ru|ca|au|br|us|be|at|it|no|me)\b/gi,
    "<host>",
  ],
  // A long hexadecimal string or a long run of letters and digits: a hash or a key either way, and no help in reading the error.
  [/\b[0-9a-f]{32,}\b/gi, "<secret>"],
  [/\b[A-Za-z0-9_-]{40,}={0,2}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "<secret>" : run)],
];

/** The known values compiled once into one pass over a text; build it again when the values change. */
export interface KnownValues {
  pattern: RegExp | null;
  byText: Map<string, KnownValue>;
}

export function compileKnownValues(known: readonly KnownValue[]): KnownValues {
  const byText = new Map<string, KnownValue>();
  for (const entry of known) {
    const trimmed = entry.value.replace(/[\\/]+$/, "");
    if (trimmed.length < (entry.wholeWord ? MIN_WHOLE_WORD_CHARS : MIN_KNOWN_CHARS)) continue;
    for (const spelling of spellingsOf(trimmed)) {
      // The first value given for a spelling wins, so the caller puts the more specific label first.
      if (!byText.has(spelling.toLowerCase())) byText.set(spelling.toLowerCase(), { ...entry, value: spelling });
    }
  }
  const texts = [...byText.values()].map((v) => v.value).sort((a, b) => b.length - a.length);
  return { pattern: texts.length === 0 ? null : new RegExp(texts.map(escapeRegExp).join("|"), "gi"), byText };
}

/** A value in the spellings a message can carry it in: both slashes, JSON's doubled backslash, URL encoding. */
function spellingsOf(value: string): Set<string> {
  return new Set([value, value.replaceAll("\\", "/"), value.replaceAll("/", "\\"), value.replaceAll("\\", "\\\\"), ...uriEncoded(value)]);
}

/** `encodeURIComponent` throws on a lone surrogate, which a value from the environment can carry. */
function uriEncoded(value: string): string[] {
  try {
    return [encodeURIComponent(value)];
  } catch {
    return [];
  }
}

/** The anonymized text, cut to `MAX_ERROR_MESSAGE_CHARS`. */
export function anonymize(text: string, known: KnownValues): string {
  const replaced = applyPatterns(replaceKnown(text.slice(0, MAX_INPUT_CHARS), known));
  return replaced.length > MAX_ERROR_MESSAGE_CHARS ? `${replaced.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…` : replaced;
}

function replaceKnown(text: string, known: KnownValues): string {
  if (!known.pattern) return text;
  const pattern = known.pattern;
  pattern.lastIndex = 0;
  const labels = [...text.matchAll(LABEL)].map((m) => [m.index, m.index + m[0].length] as const);
  let out = "";
  let done = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const entry = known.byText.get(match[0].toLowerCase());
    const end = match.index + match[0].length;
    const inLabel = labels.some(([start, stop]) => match.index < stop && end > start);
    if (!entry || inLabel || (entry.wholeWord && !isWholeWord(text, match.index, match[0].length))) {
      // Not replaced, so a shorter value starting inside it gets its chance: look again from the next character.
      pattern.lastIndex = match.index + 1;
      continue;
    }
    out += text.slice(done, match.index) + entry.label;
    done = end;
  }
  return out + text.slice(done);
}

/** A label anonymization wrote; a known value is never matched inside one, so anonymizing twice changes nothing. */
const LABEL = /<[a-z]+>/g;

/** Not part of a longer word or of a path: a repo `api` in `/api/sync` or `api-gateway` stays. */
function isWholeWord(text: string, start: number, length: number): boolean {
  return !/[\w./\\-]/.test(text[start - 1] ?? "") && !/[\w/\\-]/.test(text[start + length] ?? "");
}

function applyPatterns(text: string): string {
  return PATTERNS.reduce(
    (out, [pattern, replacement]) =>
      typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement),
    text,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
