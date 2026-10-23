import type { ConsumedPackage, ToolRequirement } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../error-message.ts";
import { baseName, dirOf, inDir, rootFiles } from "./repo-path.ts";
import { type Extracted, emptyExtracted, evidenceAt, type RepoSnapshot } from "./snapshot.ts";

/**
 * Ekstraktor Gradle (§4.6). Skrypty Gradle to kod (Groovy albo Kotlin), więc ekstraktor nie wykonuje ich, tylko
 * czyta linie w typowej postaci: `include(...)` w `settings.gradle(.kts)`, `group` i `version`, zależności
 * `implementation("grupa:artefakt:wersja")` albo z katalogu wersji (`libs.…` z `gradle/libs.versions.toml`), wtyczki
 * `id("…")` i wersję Javy z toolchaina. Zależność złożona w kodzie (zmienne, pętle) nie trafi na kartę.
 */

const SETTINGS = ["settings.gradle.kts", "settings.gradle"];
const BUILD = ["build.gradle.kts", "build.gradle"];
const SCRIPTS = [...SETTINGS, ...BUILD];
const CATALOG = "gradle/libs.versions.toml";

/** Pliki, które ten ekstraktor czyta, do wyboru plików z commita. */
export function readsGradleFile(path: string): boolean {
  return SCRIPTS.includes(baseName(path)) || path === CATALOG || path.endsWith(`/${CATALOG}`);
}

/** Konfiguracja zależności: wbudowane Gradle i wtyczek Java/Kotlin oraz każda kończąca się tak jak one. */
const CONFIGURATION =
  /^(api|implementation|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|developmentOnly|compile|runtime|classpath|\w+(Implementation|Api|CompileOnly|RuntimeOnly|AnnotationProcessor))$/;
/*
 * Wyrażenia niżej nie mają dwóch `\s*` obok siebie (`\s*\(?\s*`): linia z tysiącami spacji dawałaby kwadratowe
 * dopasowanie, a plik buildu jest niezaufany (§8). Opcjonalny nawias to `(?:\(\s*)?`.
 */
/** `implementation("g:a:v")`, `implementation 'g:a'`, także w `platform(...)` i `enforcedPlatform(...)`. */
const LITERAL_DEPENDENCY = /^\s*(\w+)\s*(?:\(\s*)?(?:(?:enforced)?[pP]latform\s*\(\s*)?["']([^"'\s:]+):([^"'\s:]+)(?::([^"'\s]+))?["']/;
/** `implementation(libs.spring.boot.web)` albo `implementation libs.spring.boot.web`. */
const CATALOG_DEPENDENCY = /^\s*(\w+)\s*(?:\(\s*)?(?:(?:enforced)?[pP]latform\s*\(\s*)?libs\.([\w.]+)/;
/** `id("org.springframework.boot") version "3.3.0"`, `id 'x' version 'y'`, `apply plugin: 'x'`. */
const PLUGIN_ID =
  /(?:(?:^|[{;\s])id\s*(?:\(\s*)?|apply\s*(?:\(\s*)?plugin\s*[:=]\s*)["']([\w.-]+)["']\s*(?:\)\s*)?(?:version\s*(?:\(\s*)?["']([^"']+)["'])?/;
const CATALOG_PLUGIN = /alias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/;
/** Dłuższa linia to dane (wygenerowany kod, osadzony plik), nie zapis zależności; wyrażenia jej nie widzą. */
const MAX_LINE_LENGTH = 2000;
const JAVA_TOOLCHAIN =
  /JavaLanguageVersion\.of\(\s*["']?(\d+)["']?\s*\)|(?:source|target)Compatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/;

interface CatalogEntry {
  name: string;
  version: string | null;
}

interface Catalog {
  libraries: Map<string, CatalogEntry>;
  plugins: Map<string, CatalogEntry>;
}

interface Project {
  /** Plik buildu projektu; projekt z `include` bez własnego pliku nie trafia na kartę. */
  buildPath: string;
  /** Nazwa projektu: ostatni segment ścieżki z `include` albo `rootProject.name`; `null`, gdy nieznana. */
  name: string | null;
  memberOf: string | null;
}

export function extractGradle(snapshot: RepoSnapshot): Extracted {
  const out = emptyExtracted();
  const gradleFiles = snapshot.paths.filter((p) => SCRIPTS.includes(baseName(p)));
  const rootDirs = [...new Set(rootFiles(gradleFiles).map(dirOf))];
  for (const dir of rootDirs) extractBuild(snapshot, dir, out);
  return out;
}

/** Jeden build Gradle z korzeniem w `dir`: projekt główny i projekty z `include`. */
function extractBuild(snapshot: RepoSnapshot, dir: string, out: Extracted): void {
  const catalog = readCatalog(snapshot, inDir(dir, CATALOG), out);
  const projects = buildProjects(snapshot, dir);
  const rootText = projects.find((p) => p.memberOf === null)?.text ?? "";
  const facts = projects.map((project) => ({
    ...project,
    group: assignment(project.text, "group") ?? assignment(rootText, "group"),
    version: assignment(project.text, "version") ?? assignment(rootText, "version"),
  }));
  const coordinates = (f: (typeof facts)[number]) => (f.group && f.name ? `${f.group}:${f.name}` : undefined);
  const internal = new Set(facts.map(coordinates));
  for (const f of facts) {
    out.buildFiles.push({ path: f.buildPath, tool: "gradle", name: f.name, memberOf: f.memberOf });
    const name = coordinates(f);
    if (name)
      out.provides.push({
        kind: "package",
        ecosystem: "maven",
        name,
        version: f.version ?? null,
        evidence: evidenceAt(f.buildPath, f.text, /^\s*group\s*=/),
      });
    out.consumes.push(...dependencies(f.buildPath, f.text, catalog).filter((c) => !internal.has(c.name)));
    out.tools.push(...javaVersion(f.buildPath, f.text));
  }
}

/** Projekt główny (z nazwą z `rootProject.name`) i projekty z `include`, które mają plik buildu. */
function buildProjects(snapshot: RepoSnapshot, dir: string): (Project & { text: string })[] {
  const settingsPath = SETTINGS.map((name) => inDir(dir, name)).find((p) => snapshot.text(p) !== undefined);
  const settings = settingsPath === undefined ? "" : (snapshot.text(settingsPath) ?? "");
  const rootBuild = buildFileIn(snapshot, dir);
  const projects: Project[] = [];
  if (rootBuild)
    projects.push({ buildPath: rootBuild, name: /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1] ?? null, memberOf: null });
  const parent = rootBuild ?? settingsPath ?? null;
  for (const path of includedProjects(settings)) {
    const buildPath = buildFileIn(snapshot, inDir(dir, path.replaceAll(":", "/")));
    if (buildPath) projects.push({ buildPath, name: path.split(":").at(-1) ?? null, memberOf: parent });
  }
  return projects.map((p) => ({ ...p, text: snapshot.text(p.buildPath) ?? "" }));
}

/**
 * Ścieżki projektów z `include` w settings, bez `:` na początku (`:api:core` → `api:core`). `include` bywa rozpisany
 * na wiele linii: w nawiasie (Kotlin) albo z przecinkiem na końcu linii (Groovy).
 */
function includedProjects(settings: string): string[] {
  const paths: string[] = [];
  let depth = 0;
  let continued = false;
  for (const { text } of codeLines(settings)) {
    if (!continued && !/^\s*include\b/.test(text)) continue;
    if (!continued) depth = 0;
    for (const m of text.matchAll(/["']([^"']+)["']/g)) paths.push((m[1] ?? "").replace(/^:/, ""));
    depth += (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0);
    continued = depth > 0 || text.trimEnd().endsWith(",");
  }
  return paths.filter((p) => p !== "");
}

function buildFileIn(snapshot: RepoSnapshot, dir: string): string | undefined {
  return BUILD.map((name) => inDir(dir, name)).find((p) => snapshot.text(p) !== undefined);
}

/** Wartość przypisania `name = "…"` (także `name "…"` w Groovy); pierwsze w pliku poza komentarzem. */
function assignment(text: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*(?:=\\s*)?["']([^"']+)["']`);
  for (const line of codeLines(text)) {
    const value = pattern.exec(line.text)?.[1];
    if (value) return value;
  }
  return undefined;
}

/** Zależności i wtyczki z linii skryptu; jedna linia daje najwyżej jedną paczkę. */
function dependencies(path: string, text: string, catalog: Catalog): ConsumedPackage[] {
  const found: ConsumedPackage[] = [];
  for (const line of codeLines(text)) {
    const pkg = literalDependency(line.text) ?? catalogDependency(line.text, catalog) ?? pluginDependency(line.text, catalog);
    if (pkg) found.push({ kind: "package", ...pkg, evidence: { path, line: line.number } });
  }
  return found;
}

type LinePackage = Pick<ConsumedPackage, "ecosystem" | "name" | "version" | "scope">;

function literalDependency(line: string): LinePackage | undefined {
  const m = LITERAL_DEPENDENCY.exec(line);
  if (!m?.[1] || !CONFIGURATION.test(m[1])) return undefined;
  return { ecosystem: "maven", name: `${m[2]}:${m[3]}`, version: m[4] ?? null, scope: m[1] };
}

function catalogDependency(line: string, catalog: Catalog): LinePackage | undefined {
  const m = CATALOG_DEPENDENCY.exec(line);
  if (!m?.[1] || !CONFIGURATION.test(m[1])) return undefined;
  const entry = catalog.libraries.get(alias(m[2] ?? ""));
  return entry && { ecosystem: "maven", ...entry, scope: m[1] };
}

function pluginDependency(line: string, catalog: Catalog): LinePackage | undefined {
  const plugin = PLUGIN_ID.exec(line);
  // Wtyczki bez kropki (`java`, `application`) są wbudowane w Gradle, więc nie są zależnością.
  if (plugin?.[1]?.includes(".")) return { ecosystem: "gradle-plugin", name: plugin[1], version: plugin[2] ?? null, scope: "plugin" };
  const fromCatalog = CATALOG_PLUGIN.exec(line);
  const entry = fromCatalog ? catalog.plugins.get(alias(fromCatalog[1] ?? "")) : undefined;
  return entry && { ecosystem: "gradle-plugin", ...entry, scope: "plugin" };
}

function javaVersion(path: string, text: string): ToolRequirement[] {
  for (const line of codeLines(text)) {
    const m = JAVA_TOOLCHAIN.exec(line.text);
    const version = m?.[1] ?? m?.[2];
    // `1.8` to Java 8 w starym zapisie; mise zna ją jako `8`.
    if (version)
      return [
        {
          tool: "java",
          version: version.replaceAll("_", ".").replace(/^1\.(\d)$/, "$1"),
          source: "hint",
          evidence: { path, line: line.number },
        },
      ];
  }
  return [];
}

/** Wersja w katalogu: napis, odwołanie do `[versions]` albo wersja bogata (`strictly`, `require`, `prefer`). */
const CatalogVersion = z.union([
  z.string(),
  z.object({ ref: z.string() }),
  z.object({ strictly: z.string().optional(), require: z.string().optional(), prefer: z.string().optional() }),
]);
type CatalogVersion = z.infer<typeof CatalogVersion>;
const CatalogLibrary = z.union([
  z.string(),
  z.object({ module: z.string(), version: CatalogVersion.optional() }),
  z.object({ group: z.string(), name: z.string(), version: CatalogVersion.optional() }),
]);
const CatalogPlugin = z.union([z.string(), z.object({ id: z.string(), version: CatalogVersion.optional() })]);
/** `gradle/libs.versions.toml`; wpis w nieznanej postaci jest pomijany bez utraty reszty. */
const VersionCatalog = z.object({
  versions: z.record(z.string(), z.string().catch("")).catch({}),
  libraries: z.record(z.string(), CatalogLibrary.nullable().catch(null)).catch({}),
  plugins: z.record(z.string(), CatalogPlugin.nullable().catch(null)).catch({}),
});
type VersionCatalog = z.infer<typeof VersionCatalog>;

/**
 * Katalog wersji Gradle: biblioteki (`module = "g:a"`, `group` + `name` albo `"g:a:v"`) i wtyczki (`id` albo
 * `"id:wersja"`), z wersją wprost albo z `version.ref` do `[versions]`.
 */
function readCatalog(snapshot: RepoSnapshot, path: string, out: Extracted): Catalog {
  const catalog: Catalog = { libraries: new Map(), plugins: new Map() };
  const text = snapshot.text(path);
  if (text === undefined) return catalog;
  let parsed: VersionCatalog;
  try {
    parsed = VersionCatalog.parse(parseToml(text));
  } catch (err) {
    out.problems.push({ path, message: messageOf(err) });
    return catalog;
  }
  const version = (v: CatalogVersion | undefined) => catalogVersion(v, parsed.versions);
  for (const [name, entry] of Object.entries(parsed.libraries)) {
    const library = entry === null ? undefined : libraryEntry(entry, version);
    if (library) catalog.libraries.set(alias(name), library);
  }
  for (const [name, entry] of Object.entries(parsed.plugins)) {
    const plugin = entry === null ? undefined : pluginEntry(entry, version);
    if (plugin) catalog.plugins.set(alias(name), plugin);
  }
  return catalog;
}

function catalogVersion(v: CatalogVersion | undefined, versions: Readonly<Record<string, string>>): string | null {
  if (v === undefined) return null;
  if (typeof v === "string") return v;
  if ("ref" in v) return versions[v.ref] || null;
  return v.strictly ?? v.require ?? v.prefer ?? null;
}

function pluginEntry(
  entry: z.infer<typeof CatalogPlugin>,
  version: (v: CatalogVersion | undefined) => string | null,
): CatalogEntry | undefined {
  if (typeof entry !== "string") return { name: entry.id, version: version(entry.version) };
  const [id, inline] = entry.split(":");
  return id ? { name: id, version: inline ?? null } : undefined;
}

function libraryEntry(
  entry: z.infer<typeof CatalogLibrary>,
  version: (v: CatalogVersion | undefined) => string | null,
): CatalogEntry | undefined {
  if (typeof entry === "string") {
    const [group, artifact, v] = entry.split(":");
    return group && artifact ? { name: `${group}:${artifact}`, version: v ?? null } : undefined;
  }
  const module = "module" in entry ? entry.module : `${entry.group}:${entry.name}`;
  return { name: module, version: version(entry.version) };
}

/** Klucz aliasu katalogu tak, jak Gradle tworzy akcesor: `spring-boot-web`, `spring_boot.web` i `spring.boot.web` to to samo. */
function alias(name: string): string {
  return name.replace(/[-_]/g, ".").toLowerCase();
}

/** Stan skanera między liniami: otwarty komentarz blokowy albo napis w potrójnym cudzysłowie. */
interface ScanState {
  inBlock: boolean;
  quote: string | null;
}

/** Początek komentarza albo napisu; potrójny cudzysłów przed pojedynczym. */
const SCAN_TOKEN = /\/\*|\/\/|"""|'''|["']/g;

/**
 * Linie z numerami, bez komentarzy `//` i blokowych `/* … *\/`, które w skryptach Gradle często wyłączają zależność.
 * Napisy są pomijane przy szukaniu komentarzy, bo `exclude("META-INF/*.SF")` nie zaczyna komentarza. Linie dłuższe niż
 * `MAX_LINE_LENGTH` nie trafiają do wyniku.
 */
function codeLines(text: string): { text: string; number: number }[] {
  const lines: { text: string; number: number }[] = [];
  const state: ScanState = { inBlock: false, quote: null };
  text.split("\n").forEach((raw, i) => {
    const line = stripComments(raw, state);
    // Zwykły napis kończy się z linią; tylko potrójny cudzysłów ją przekracza.
    if (state.quote?.length === 1) state.quote = null;
    if (line.trim() !== "" && raw.length <= MAX_LINE_LENGTH) lines.push({ text: line, number: i + 1 });
  });
  return lines;
}

/** Kawałek linii przeczytany w jednym stanie skanera i pozycja, od której czytać dalej (`-1`: koniec linii). */
interface ScanStep {
  text: string;
  next: number;
}

/** Linia bez komentarzy; `state` przenosi otwarty komentarz blokowy i napis do następnej linii. */
function stripComments(raw: string, state: ScanState): string {
  let out = "";
  for (let i = 0; i >= 0 && i < raw.length; ) {
    const step = state.inBlock ? skipBlock(raw, i, state) : state.quote !== null ? readString(raw, i, state) : readCode(raw, i, state);
    out += step.text;
    i = step.next;
  }
  return out;
}

function skipBlock(raw: string, from: number, state: ScanState): ScanStep {
  const end = raw.indexOf("*/", from);
  if (end < 0) return { text: "", next: -1 };
  state.inBlock = false;
  return { text: "", next: end + 2 };
}

function readString(raw: string, from: number, state: ScanState): ScanStep {
  const end = stringEnd(raw, from, state.quote ?? "");
  if (end < 0) return { text: raw.slice(from), next: -1 };
  state.quote = null;
  return { text: raw.slice(from, end), next: end };
}

/** Kod do początku komentarza (który zmienia stan) albo napisu (który zostaje w wyniku). */
function readCode(raw: string, from: number, state: ScanState): ScanStep {
  SCAN_TOKEN.lastIndex = from;
  const token = SCAN_TOKEN.exec(raw);
  if (!token) return { text: raw.slice(from), next: -1 };
  const code = raw.slice(from, token.index);
  if (token[0] === "//") return { text: code, next: -1 };
  const next = token.index + token[0].length;
  if (token[0] === "/*") {
    state.inBlock = true;
    return { text: code, next };
  }
  state.quote = token[0];
  return { text: code + token[0], next };
}

/** Indeks za cudzysłowem zamykającym napis od `from` (z pominięciem `\` i znaku po nim); `-1`, gdy go nie ma. */
function stringEnd(raw: string, from: number, quote: string): number {
  for (let j = from; j < raw.length; j++) {
    if (raw[j] === "\\") j++;
    else if (raw.startsWith(quote, j)) return j + quote.length;
  }
  return -1;
}
