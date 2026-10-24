import { isMap, isNode, isScalar, isSeq, LineCounter, type Node, type Pair, parseAllDocuments } from "yaml";
import { messageOf } from "../../errors.ts";
import { type PlaceholderSource, type Resolved, resolvePlaceholders } from "./placeholders.ts";
import { baseName } from "./repo-path.ts";
import type { ProblemSink, RepoSnapshot } from "./snapshot.ts";

/**
 * Konfiguracja Spring modułu (§4.6, ADR-30): `application*` i `bootstrap*` (`.yml`, `.yaml`, `.properties`)
 * z `src/main/resources`, z profilami z nazwy pliku (`application-prod.yml`) i z dokumentów aktywowanych
 * `spring.config.activate.on-profile` (dawniej `spring.profiles`). Widok profilu to konfiguracja bez profilu
 * nadpisana dokumentami profilu, a klucze porównuje się jak w Spring Boot (bez wielkości liter, `-` i `_`).
 */

/** Profil Spring konfiguracji bez profilu; tak nazywa go sam Spring. */
export const DEFAULT_PROFILE = "default";
/** Plik konfiguracji Spring w zasobach modułu: rodzaj, profil z nazwy i rozszerzenie. */
const CONFIG_FILE = /(?:^|\/)src\/main\/resources\/(application|bootstrap)(?:-([^/]+?))?\.(ya?ml|properties)$/;
/** Ile wpisów czytać z jednego pliku i jak głęboko w YAML: więcej to nie konfiguracja aplikacji (§8). */
const MAX_ENTRIES = 20_000;
const MAX_YAML_DEPTH = 64;

/** Pliki, które ten odczyt czyta, do wyboru plików z commita. */
export function readsSpringConfigFile(path: string): boolean {
  return path.length <= 1024 && CONFIG_FILE.test(path);
}

export interface ConfigEntry extends PlaceholderSource {
  /** Klucz tak, jak stoi w pliku (`orders.base-url`). */
  key: string;
}

interface ConfigDoc {
  /** Profile, w których dokument działa; `null`: konfiguracja bez profilu. */
  profiles: string[] | null;
  entries: Map<string, ConfigEntry>;
}

/** Konfiguracja jednego modułu: widok każdego profilu i rozwijanie `${…}` w nim. */
export class ModuleConfig {
  readonly module: string;
  /** Profile wymienione w plikach, bez `default`, po nazwie. */
  readonly profiles: string[];
  private readonly views = new Map<string, Map<string, ConfigEntry>>();

  constructor(module: string, docs: readonly ConfigDoc[]) {
    this.module = module;
    const base = docs.filter((d) => d.profiles === null);
    this.profiles = [...new Set(docs.flatMap((d) => d.profiles ?? []))].sort();
    this.views.set(DEFAULT_PROFILE, merge(base));
    for (const p of this.profiles) this.views.set(p, merge([...base, ...docs.filter((d) => d.profiles?.includes(p))]));
  }

  /** Wpis klucza w widoku profilu (bez rozwijania). */
  entry(key: string, profile: string = DEFAULT_PROFILE): ConfigEntry | undefined {
    return this.views.get(profile)?.get(normalizeKey(key));
  }

  /** Klucze (znormalizowane) wszystkich widoków. */
  keys(): Set<string> {
    return new Set([...this.views.values()].flatMap((v) => [...v.keys()]));
  }

  /** Tekst z rozwiniętymi `${…}` w widoku profilu. */
  resolve(text: string, profile: string = DEFAULT_PROFILE): Resolved {
    return resolvePlaceholders(text, (key) => this.entry(key, profile));
  }

  /** Rozwinięta wartość klucza w profilu domyślnym; `undefined` bez wpisu. */
  value(key: string): string | undefined {
    const entry = this.entry(key);
    return entry && this.resolve(entry.value).value;
  }

  /** Profile w kolejności: `default`, potem pozostałe. */
  allProfiles(): string[] {
    return [DEFAULT_PROFILE, ...this.profiles];
  }
}

function merge(docs: readonly ConfigDoc[]): Map<string, ConfigEntry> {
  const view = new Map<string, ConfigEntry>();
  for (const doc of docs) for (const [key, entry] of doc.entries) view.set(key, entry);
  return view;
}

/** Klucz w postaci, w której Spring Boot go porównuje: `orders.baseUrl`, `orders.base-url` i `ORDERS.BASE_URL` to jedno. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** Konfiguracja każdego modułu z plikami Spring; moduł to katalog nad `src/main/resources`. */
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
  return new Map([...byModule].map(([module, docs]) => [module, new ModuleConfig(module, docs)]));
}

/** Katalog modułu dla pliku pod `src/main/…`; `""`, gdy plik leży w `src/main` korzenia albo poza nim. */
export function moduleOf(path: string): string {
  const at = path.startsWith("src/main/") ? 0 : path.indexOf("/src/main/");
  return at <= 0 ? "" : path.slice(0, at);
}

/** Kolejność, w której Spring czyta pliki: `bootstrap` przed `application`, YAML przed `.properties`, które go nadpisuje. */
function byLoadOrder(a: string, b: string): number {
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function rank(path: string): number {
  const name = baseName(path);
  return (name.startsWith("bootstrap") ? 0 : 2) + (name.endsWith(".properties") ? 1 : 0);
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
 * Profile dokumentu z `spring.config.activate.on-profile` albo `spring.profiles`: `null` bez wpisu, nazwy z listy
 * (`prod, staging`, `prod | staging`), a `undefined` dla wyrażenia z samym zaprzeczeniem (`!dev`), którego karta
 * nie przypisze do nazwanego profilu.
 */
function activationProfiles(entries: Map<string, ConfigEntry>): string[] | null | undefined {
  const entry = entries.get(normalizeKey("spring.config.activate.on-profile")) ?? entries.get(normalizeKey("spring.profiles"));
  if (!entry) return null;
  const names = entry.value.split(/[\s,|&()]+/).filter((n) => n !== "" && !n.startsWith("!"));
  return names.length > 0 ? names : undefined;
}

/** Dokumenty YAML (`---`) jako płaskie wpisy `a.b[0].c` z linią klucza. Aliasy (`*kotwica`) są pomijane (§8). */
function readYaml(path: string, text: string): Map<string, ConfigEntry>[] {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter });
  if (!Array.isArray(docs)) return [];
  return docs.map((doc) => {
    const [error] = doc.errors;
    if (error) throw new Error(error.message);
    const entries = new Map<string, ConfigEntry>();
    if (doc.contents) flatten(doc.contents, "", { path, lineCounter, entries }, 0);
    return entries;
  });
}

interface FlattenContext {
  path: string;
  lineCounter: LineCounter;
  entries: Map<string, ConfigEntry>;
}

function flatten(node: Node, prefix: string, ctx: FlattenContext, depth: number): void {
  if (depth > MAX_YAML_DEPTH || ctx.entries.size >= MAX_ENTRIES) return;
  if (isMap(node)) flattenMap(node.items, prefix, ctx, depth);
  else if (isSeq(node)) flattenSeq(node.items, prefix, ctx, depth);
}

function flattenMap(items: readonly Pair[], prefix: string, ctx: FlattenContext, depth: number): void {
  for (const pair of items) {
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

/** Wartość pod kluczem: skalar to wpis, mapa i lista idą głębiej. */
function addValue(node: Node, key: string, line: number, ctx: FlattenContext, depth: number): void {
  if (isScalar(node)) add(ctx, key, node.value, line);
  else if (isMap(node) || isSeq(node)) flatten(node, key, ctx, depth + 1);
}

function add(ctx: FlattenContext, key: string, value: unknown, line: number): void {
  const text = value === null || value === undefined ? "" : String(value);
  ctx.entries.set(normalizeKey(key), { key, value: text, path: ctx.path, line });
}

/**
 * Plik `.properties`: `klucz=wartość`, `klucz: wartość` albo `klucz wartość`, `#` i `!` zaczynają komentarz, `\` na
 * końcu linii ją kontynuuje, a `#---` (albo `!---`) oddziela dokumenty jak `---` w YAML.
 */
function readProperties(path: string, text: string): Map<string, ConfigEntry>[] {
  const docs = [new Map<string, ConfigEntry>()];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    // Części linii z kontynuacją składane tablicą: sklejanie napisu w pętli byłoby kwadratowe na złośliwym pliku.
    const parts = [(lines[i] ?? "").trimStart()];
    while ((parts.at(-1) ?? "").endsWith("\\") && i + 1 < lines.length) {
      parts[parts.length - 1] = (parts.at(-1) ?? "").slice(0, -1);
      parts.push((lines[++i] ?? "").trimStart());
    }
    const line = parts.join("");
    const current = docs.at(-1);
    if (line === "#---" || line === "!---") docs.push(new Map());
    else if (current && line !== "" && !line.startsWith("#") && !line.startsWith("!") && current.size < MAX_ENTRIES)
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
