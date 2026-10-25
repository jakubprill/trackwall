import { isMap, isNode, isScalar, isSeq, LineCounter, type Node, type Pair, parseAllDocuments } from "yaml";
import { messageOf } from "../../infra/errors.ts";
import { type PlaceholderSource, type Resolved, resolvePlaceholders } from "./placeholders.ts";
import { baseName } from "./repo-path.ts";
import type { ProblemSink, RepoSnapshot } from "./snapshot.ts";

/**
 * A module's Spring configuration (§4.6, ADR-30): `application*` and `bootstrap*` (`.yml`, `.yaml`, `.properties`)
 * from `src/main/resources`, with profiles from the file name (`application-prod.yml`) and from documents activated by
 * `spring.config.activate.on-profile` (formerly `spring.profiles`). A profile's view is the configuration without a
 * profile overridden by the profile's documents, and keys are compared as in Spring Boot (ignoring case, `-` and `_`).
 */

/** The Spring profile of configuration without a profile; that is what Spring itself calls it. */
export const DEFAULT_PROFILE = "default";
/** A Spring configuration file in a module's resources: kind, profile from the name and extension. */
const CONFIG_FILE = /(?:^|\/)src\/main\/resources\/(application|bootstrap)(?:-([^/]+?))?\.(ya?ml|properties)$/;
/** How many entries to read from one file and how deep in YAML: more is not app configuration (§8). */
const MAX_ENTRIES = 20_000;
const MAX_YAML_DEPTH = 64;
/** How many profiles of a module to consider: each is a separate configuration view, and an app has a few. */
const MAX_PROFILES = 32;

/** The files this read reads, for choosing files from the commit. */
export function readsSpringConfigFile(path: string): boolean {
  return path.length <= 1024 && CONFIG_FILE.test(path) && !isTestPath(path);
}

/** A path under `src/test`, also a sample project in test resources (`src/test/resources/demo/src/main/…`). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((s, i) => s === "src" && segments[i + 1] === "test");
}

export interface ConfigEntry extends PlaceholderSource {
  /** The key as it stands in the file (`orders.base-url`). */
  key: string;
}

interface ConfigDoc {
  /** The profiles the document applies to; `null`: configuration without a profile. */
  profiles: string[] | null;
  entries: Map<string, ConfigEntry>;
}

/** The configuration of one module: the view of every profile and expanding `${…}` in it. */
export class ModuleConfig {
  readonly module: string;
  /** The profiles named in the files, without `default`, by name. */
  readonly profiles: string[];
  /** How many profiles beyond `MAX_PROFILES` were skipped. */
  readonly skippedProfiles: number;
  private readonly views = new Map<string, Map<string, ConfigEntry>>();

  constructor(module: string, docs: readonly ConfigDoc[]) {
    this.module = module;
    const base = docs.filter((d) => d.profiles === null);
    const all = [...new Set(docs.flatMap((d) => d.profiles ?? []))].sort();
    this.profiles = all.slice(0, MAX_PROFILES);
    this.skippedProfiles = all.length - this.profiles.length;
    this.views.set(DEFAULT_PROFILE, merge(base));
    for (const p of this.profiles) this.views.set(p, merge([...base, ...docs.filter((d) => d.profiles?.includes(p))]));
  }

  /** The key's entry in the profile's view (without expanding). */
  entry(key: string, profile: string = DEFAULT_PROFILE): ConfigEntry | undefined {
    return this.views.get(profile)?.get(normalizeKey(key));
  }

  /** The (normalised) keys of all views. */
  keys(): Set<string> {
    return new Set([...this.views.values()].flatMap((v) => [...v.keys()]));
  }

  /** The key's values without expanding in all views. */
  rawValues(key: string): string[] {
    const normalized = normalizeKey(key);
    return [...this.views.values()].flatMap((v) => {
      const entry = v.get(normalized);
      return entry ? [entry.value] : [];
    });
  }

  /** The text with `${…}` expanded in the profile's view. */
  resolve(text: string, profile: string = DEFAULT_PROFILE): Resolved {
    return resolvePlaceholders(text, (key) => this.entry(key, profile));
  }

  /** The key's expanded value in the default profile; `undefined` without an entry. */
  value(key: string): string | undefined {
    const entry = this.entry(key);
    return entry && this.resolve(entry.value).value;
  }
}

function merge(docs: readonly ConfigDoc[]): Map<string, ConfigEntry> {
  const view = new Map<string, ConfigEntry>();
  for (const doc of docs) for (const [key, entry] of doc.entries) view.set(key, entry);
  return view;
}

/** A key in the form Spring Boot compares it in: `orders.baseUrl`, `orders.base-url` and `ORDERS.BASE_URL` are one. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** The configuration of every module with Spring files; a module is the directory above `src/main/resources`. */
export function readSpringConfigs(snapshot: RepoSnapshot, out: ProblemSink): Map<string, ModuleConfig> {
  const byModule = new Map<string, ConfigDoc[]>();
  for (const path of [...snapshot.paths.filter(readsSpringConfigFile)].sort(byLoadOrder)) {
    const text = snapshot.text(path);
    if (text === undefined) continue;
    const module = moduleOf(path);
    const docs = byModule.get(module) ?? [];
    docs.push(...readConfigFile(path, text, out));
    byModule.set(module, docs);
  }
  return new Map(
    [...byModule].map(([module, docs]) => {
      const config = new ModuleConfig(module, docs);
      if (config.skippedProfiles > 0)
        out.problems.push({
          path: module,
          message: `profiles skipped over the limit of ${MAX_PROFILES} in this module: ${config.skippedProfiles} (the last ones by name)`,
        });
      return [module, config];
    }),
  );
}

/** The module directory for a file under `src/main/…`; `""` when the file lies in the root's `src/main` or outside it. */
export function moduleOf(path: string): string {
  const at = path.startsWith("src/main/") ? 0 : path.indexOf("/src/main/");
  return at <= 0 ? "" : path.slice(0, at);
}

/**
 * The order in which Spring reads files: every `bootstrap*` before every `application*`, within them a profile file
 * (`application-prod.yml`) after the file without a profile, also after its `on-profile` documents, and YAML before `.properties`.
 */
function byLoadOrder(a: string, b: string): number {
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function rank(path: string): number {
  const name = baseName(path);
  const profileFile = CONFIG_FILE.exec(path)?.[2] !== undefined;
  return (name.startsWith("bootstrap") ? 0 : 4) + (profileFile ? 2 : 0) + (name.endsWith(".properties") ? 1 : 0);
}

function readConfigFile(path: string, text: string, out: ProblemSink): ConfigDoc[] {
  const fileProfile = CONFIG_FILE.exec(path)?.[2];
  try {
    const raw = path.endsWith(".properties") ? readProperties(path, text) : readYaml(path, text);
    return raw.flatMap((entries) => {
      const profiles = fileProfile ? [fileProfile] : activationProfiles(entries);
      return profiles === undefined ? [] : [{ profiles, entries }];
    });
  } catch (err) {
    out.problems.push({ path, message: messageOf(err) });
    return [];
  }
}

/**
 * A document's profiles from `spring.config.activate.on-profile` or `spring.profiles`: `null` without an entry, names
 * from a list (`prod, staging`, `prod | staging`), and `undefined` for an expression with only a negation (`!dev`), which
 * the card does not assign to a named profile.
 */
function activationProfiles(entries: Map<string, ConfigEntry>): string[] | null | undefined {
  const entry = entries.get(normalizeKey("spring.config.activate.on-profile")) ?? entries.get(normalizeKey("spring.profiles"));
  if (!entry) return null;
  const names = entry.value.split(/[\s,|&()]+/).filter((n) => n !== "" && !n.startsWith("!"));
  return names.length > 0 ? names : undefined;
}

/** YAML documents (`---`) as flat `a.b[0].c` entries with the key's line. Aliases (`*anchor`) are skipped (§8). */
function readYaml(path: string, text: string): Map<string, ConfigEntry>[] {
  const lineCounter = new LineCounter();
  // No check for repeated keys: the library compares every map key with every other, and the file comes from the repo (§8).
  const docs = parseAllDocuments(text, { lineCounter, uniqueKeys: false });
  const budget = { left: MAX_ENTRIES };
  if (!Array.isArray(docs)) return [];
  return docs.map((doc) => {
    const [error] = doc.errors;
    if (error) throw new Error(error.message);
    const entries = new Map<string, ConfigEntry>();
    if (doc.contents) flatten(doc.contents, "", { path, lineCounter, entries, budget }, 0);
    return entries;
  });
}

interface FlattenContext {
  path: string;
  lineCounter: LineCounter;
  entries: Map<string, ConfigEntry>;
  /** How many entries are left until the file's limit (all documents together). */
  budget: { left: number };
}

function flatten(node: Node, prefix: string, ctx: FlattenContext, depth: number): void {
  if (depth > MAX_YAML_DEPTH || ctx.budget.left <= 0) return;
  if (isMap(node)) flattenMap(node.items, prefix, ctx, depth);
  else if (isSeq(node)) flattenSeq(node.items, prefix, ctx, depth);
}

function flattenMap(items: readonly Pair[], prefix: string, ctx: FlattenContext, depth: number): void {
  for (const pair of items) {
    if (ctx.budget.left <= 0) return;
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key === undefined || !isNode(pair.value)) continue;
    const child = key.startsWith("[") || prefix === "" ? `${prefix}${key}` : `${prefix}.${key}`;
    const line = ctx.lineCounter.linePos(isScalar(pair.key) ? (pair.key.range?.[0] ?? 0) : 0).line;
    addValue(pair.value, child, line, ctx, depth);
  }
}

function flattenSeq(items: readonly unknown[], prefix: string, ctx: FlattenContext, depth: number): void {
  items.forEach((item, i) => {
    if (isNode(item)) addValue(item, `${prefix}[${i}]`, ctx.lineCounter.linePos(item.range?.[0] ?? 0).line, ctx, depth);
  });
}

/** The value under a key: a scalar is an entry, a map and a list go deeper. */
function addValue(node: Node, key: string, line: number, ctx: FlattenContext, depth: number): void {
  if (isScalar(node)) add(ctx, key, node.value, line);
  else if (isMap(node) || isSeq(node)) flatten(node, key, ctx, depth + 1);
}

function add(ctx: FlattenContext, key: string, value: unknown, line: number): void {
  if (ctx.budget.left <= 0) return;
  ctx.budget.left--;
  const text = value === null || value === undefined ? "" : String(value);
  ctx.entries.set(normalizeKey(key), { key, value: text, path: ctx.path, line });
}

/**
 * A `.properties` file: `key=value`, `key: value` or `key value`, `#` and `!` start a comment, `\` at the end of a line
 * continues it, and `#---` (or `!---`) separates documents like `---` in YAML.
 */
function readProperties(path: string, text: string): Map<string, ConfigEntry>[] {
  const docs = [new Map<string, ConfigEntry>()];
  const lines = text.split("\n");
  let read = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    // The parts of a continued line are joined through an array: concatenating a string in a loop would be quadratic on a malicious file.
    const parts = [(lines[i] ?? "").trimStart()];
    while ((parts.at(-1) ?? "").endsWith("\\") && i + 1 < lines.length) {
      parts[parts.length - 1] = (parts.at(-1) ?? "").slice(0, -1);
      parts.push((lines[++i] ?? "").trimStart());
    }
    const line = parts.join("");
    const current = docs.at(-1);
    if (line === "#---" || line === "!---") docs.push(new Map());
    else if (current && line !== "" && !line.startsWith("#") && !line.startsWith("!") && read++ < MAX_ENTRIES)
      addProperty(current, path, line, start + 1);
  }
  return docs;
}

function addProperty(entries: Map<string, ConfigEntry>, path: string, line: string, number: number): void {
  const sep = line.search(/[=:\s]/);
  const key = sep < 0 ? line : line.slice(0, sep);
  const value = sep < 0 ? "" : line.slice(sep + 1).replace(/^\s*[=:]?\s*/, "");
  entries.set(normalizeKey(key), { key, value: value.trimEnd(), path, line: number });
}
