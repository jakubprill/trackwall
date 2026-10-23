import type { ConsumedPackage, ToolRequirement } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { messageOf } from "../../error-message.ts";
import { baseName, dirOf, type Extracted, emptyExtracted, evidenceAt, inDir, type RepoSnapshot, rootFiles } from "./snapshot.ts";

/**
 * Ekstraktor Gradle (§4.6). Skrypty Gradle to kod (Groovy albo Kotlin), więc ekstraktor nie wykonuje ich, tylko
 * czyta linie w typowej postaci: `include(...)` w `settings.gradle(.kts)`, `group` i `version`, zależności
 * `implementation("grupa:artefakt:wersja")` albo z katalogu wersji (`libs.…` z `gradle/libs.versions.toml`), wtyczki
 * `id("…")` i wersję Javy z toolchaina. Zależność złożona w kodzie (zmienne, pętle) nie trafi na kartę.
 */

const SETTINGS = ["settings.gradle.kts", "settings.gradle"];
const BUILD = ["build.gradle.kts", "build.gradle"];
const CATALOG = "gradle/libs.versions.toml";

/** Konfiguracja zależności: wbudowane Gradle i wtyczek Java/Kotlin oraz każda kończąca się tak jak one. */
const CONFIGURATION =
  /^(api|implementation|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|developmentOnly|compile|runtime|classpath|\w+(Implementation|Api|CompileOnly|RuntimeOnly|AnnotationProcessor))$/;
/** `implementation("g:a:v")`, `implementation 'g:a'`, także w `platform(...)` i `enforcedPlatform(...)`. */
const LITERAL_DEPENDENCY = /^\s*(\w+)\s*\(?\s*(?:(?:enforced)?[pP]latform\s*\(\s*)?["']([^"'\s:]+):([^"'\s:]+)(?::([^"'\s]+))?["']/;
/** `implementation(libs.spring.boot.web)` albo `implementation libs.spring.boot.web`. */
const CATALOG_DEPENDENCY = /^\s*(\w+)\s*\(?\s*(?:(?:enforced)?[pP]latform\s*\(\s*)?libs\.([\w.]+)/;
/** `id("org.springframework.boot") version "3.3.0"`, `id 'x' version 'y'`, `apply plugin: 'x'`. */
const PLUGIN_ID =
  /(?:(?:^|[{;\s])id\s*\(?\s*|apply\s*\(?\s*plugin\s*[:=]\s*)["']([\w.-]+)["']\s*\)?(?:\s*version\s*\(?\s*["']([^"']+)["'])?/;
const CATALOG_PLUGIN = /alias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/;
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
  const gradleFiles = snapshot.paths.filter((p) => [...SETTINGS, ...BUILD].includes(baseName(p)));
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

/** Ścieżki projektów z `include` w settings, bez `:` na początku (`:api:core` → `api:core`). */
function includedProjects(settings: string): string[] {
  const paths: string[] = [];
  for (const line of codeLines(settings)) {
    if (!/^\s*include\b/.test(line.text)) continue;
    for (const m of line.text.matchAll(/["']([^"']+)["']/g)) paths.push((m[1] ?? "").replace(/^:/, ""));
  }
  return paths.filter((p) => p !== "");
}

function buildFileIn(snapshot: RepoSnapshot, dir: string): string | undefined {
  return BUILD.map((name) => inDir(dir, name)).find((p) => snapshot.text(p) !== undefined);
}

/** Wartość przypisania `name = "…"` (także `name "…"` w Groovy); pierwsze w pliku. */
function assignment(text: string, name: string): string | undefined {
  return new RegExp(`^\\s*${name}\\s*=?\\s*["']([^"']+)["']`, "m").exec(text)?.[1];
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
          version: version.replace(/^1\.(\d)$/, "$1").replaceAll("_", "."),
          source: "hint",
          evidence: { path, line: line.number },
        },
      ];
  }
  return [];
}

/**
 * Katalog wersji Gradle: biblioteki (`module = "g:a"`, `group` + `name` albo `"g:a:v"`) i wtyczki, z wersją wprost
 * albo z `version.ref` do `[versions]`.
 */
function readCatalog(snapshot: RepoSnapshot, path: string, out: Extracted): Catalog {
  const catalog: Catalog = { libraries: new Map(), plugins: new Map() };
  const text = snapshot.text(path);
  if (text === undefined) return catalog;
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(text);
  } catch (err) {
    out.problems.push({ path, message: messageOf(err) });
    return catalog;
  }
  const versions = table(toml.versions);
  const version = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    const t = table(v);
    if (typeof t.ref === "string") return stringOr(versions[t.ref]);
    return stringOr(t.strictly) ?? stringOr(t.require) ?? stringOr(t.prefer);
  };
  for (const [name, value] of Object.entries(table(toml.libraries))) {
    const entry = libraryEntry(value, version);
    if (entry) catalog.libraries.set(alias(name), entry);
  }
  for (const [name, value] of Object.entries(table(toml.plugins))) {
    const t = table(value);
    const [id, inline] = typeof value === "string" ? value.split(":") : [stringOr(t.id)];
    if (id) catalog.plugins.set(alias(name), { name: id, version: inline ?? version(t.version) });
  }
  return catalog;
}

function libraryEntry(value: unknown, version: (v: unknown) => string | null): CatalogEntry | undefined {
  if (typeof value === "string") {
    const [group, artifact, v] = value.split(":");
    return group && artifact ? { name: `${group}:${artifact}`, version: v ?? null } : undefined;
  }
  const t = table(value);
  const module = stringOr(t.module) ?? (typeof t.group === "string" && typeof t.name === "string" ? `${t.group}:${t.name}` : null);
  return module ? { name: module, version: version(t.version) } : undefined;
}

/** Klucz aliasu katalogu tak, jak Gradle tworzy akcesor: `spring-boot-web`, `spring_boot.web` i `spring.boot.web` to to samo. */
function alias(name: string): string {
  return name.replace(/[-_]/g, ".").toLowerCase();
}

function table(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Linie z numerami, bez komentarzy `//` i blokowych `/* … *\/`, które w skryptach Gradle często wyłączają zależność. */
function codeLines(text: string): { text: string; number: number }[] {
  const lines: { text: string; number: number }[] = [];
  let inBlock = false;
  text.split("\n").forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const start = line.indexOf("/*");
    if (start >= 0) {
      line = line.slice(0, start);
      inBlock = true;
    }
    line = line.replace(/(^|\s)\/\/.*$/, "");
    if (line.trim() !== "") lines.push({ text: line, number: i + 1 });
  });
  return lines;
}
