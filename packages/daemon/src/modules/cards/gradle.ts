import type { ConsumedPackage, ToolRequirement } from "@trackwall/protocol";
import { alias, type Catalog, readCatalog } from "./gradle-catalog.ts";
import { codeLines } from "./gradle-code-lines.ts";
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
const JAVA_TOOLCHAIN =
  /JavaLanguageVersion\.of\(\s*["']?(\d+)["']?\s*\)|(?:source|target)Compatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/;

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
    const code = text.replace(/"[^"]*"|'[^']*'/g, "");
    depth += (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
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
