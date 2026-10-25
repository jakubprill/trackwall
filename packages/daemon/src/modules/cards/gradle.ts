import type { ConsumedPackage, ToolRequirement } from "@trackwall/protocol";
import { alias, type Catalog, readCatalog } from "./gradle-catalog.ts";
import { codeLines } from "./gradle-code-lines.ts";
import { baseName, dirOf, inDir, rootFiles } from "./repo-path.ts";
import { type Extracted, emptyExtracted, evidenceAt, type RepoSnapshot } from "./snapshot.ts";

/**
 * The Gradle extractor (§4.6). Gradle scripts are code (Groovy or Kotlin), so the extractor does not run them; it reads
 * lines in the usual form: `include(...)` in `settings.gradle(.kts)`, `group` and `version`, dependencies
 * `implementation("group:artifact:version")` or from the version catalog (`libs.…` from `gradle/libs.versions.toml`),
 * plugins `id("…")` and the Java version from the toolchain. A dependency put together in code (variables, loops) does
 * not reach the card.
 */

const SETTINGS = ["settings.gradle.kts", "settings.gradle"];
const BUILD = ["build.gradle.kts", "build.gradle"];
const SCRIPTS = [...SETTINGS, ...BUILD];
const CATALOG = "gradle/libs.versions.toml";

/** The files this extractor reads, for choosing files from the commit. */
export function readsGradleFile(path: string): boolean {
  return SCRIPTS.includes(baseName(path)) || path === CATALOG || path.endsWith(`/${CATALOG}`);
}

/** Dependency configurations: the built-in ones of Gradle and the Java/Kotlin plugins, and every one ending like them. */
const CONFIGURATION =
  /^(api|implementation|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|developmentOnly|compile|runtime|classpath|\w+(Implementation|Api|CompileOnly|RuntimeOnly|AnnotationProcessor))$/;
/*
 * The expressions below never have two `\s*` next to each other (`\s*\(?\s*`): a line with thousands of spaces would
 * give a quadratic match, and the build file is untrusted (§8). The optional bracket is `(?:\(\s*)?`.
 */
/** `implementation("g:a:v")`, `implementation 'g:a'`, also inside `platform(...)` and `enforcedPlatform(...)`. */
const LITERAL_DEPENDENCY = /^\s*(\w+)\s*(?:\(\s*)?(?:(?:enforced)?[pP]latform\s*\(\s*)?["']([^"'\s:]+):([^"'\s:]+)(?::([^"'\s]+))?["']/;
/** `implementation(libs.spring.boot.web)` or `implementation libs.spring.boot.web`. */
const CATALOG_DEPENDENCY = /^\s*(\w+)\s*(?:\(\s*)?(?:(?:enforced)?[pP]latform\s*\(\s*)?libs\.([\w.]+)/;
/** `id("org.springframework.boot") version "3.3.0"`, `id 'x' version 'y'`, `apply plugin: 'x'`. */
const PLUGIN_ID =
  /(?:(?:^|[{;\s])id\s*(?:\(\s*)?|apply\s*(?:\(\s*)?plugin\s*[:=]\s*)["']([\w.-]+)["']\s*(?:\)\s*)?(?:version\s*(?:\(\s*)?["']([^"']+)["'])?/;
const CATALOG_PLUGIN = /alias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/;
const JAVA_TOOLCHAIN =
  /JavaLanguageVersion\.of\(\s*["']?(\d+)["']?\s*\)|(?:source|target)Compatibility\s*=\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?/;

interface Project {
  /** The project's build file; a project from `include` without its own file does not reach the card. */
  buildPath: string;
  /** The project name: the last segment of the path from `include` or `rootProject.name`; `null` when unknown. */
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

/** One Gradle build rooted in `dir`: the root project and the projects from `include`. */
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

/** The root project (named by `rootProject.name`) and the projects from `include` that have a build file. */
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
 * Project paths from `include` in settings, without the leading `:` (`:api:core` → `api:core`). `include` can be spread
 * over several lines: in brackets (Kotlin) or with a comma at the end of the line (Groovy).
 */
function includedProjects(settings: string): string[] {
  const paths: string[] = [];
  let depth = 0;
  let continued = false;
  for (const { text } of codeLines(settings)) {
    if (!continued && !/^\s*include\b/.test(text)) continue;
    if (!continued) depth = 0;
    for (const m of text.matchAll(/["']([^"']+)["']/g)) paths.push((m[1] ?? "").replace(/^:/, ""));
    // Plain strings are enough on include lines: `codeLines` has already removed the comments.
    const code = text.replace(/"[^"]*"|'[^']*'/g, "");
    depth += (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
    continued = depth > 0 || text.trimEnd().endsWith(",");
  }
  return paths.filter((p) => p !== "");
}

function buildFileIn(snapshot: RepoSnapshot, dir: string): string | undefined {
  return BUILD.map((name) => inDir(dir, name)).find((p) => snapshot.text(p) !== undefined);
}

/** The value of the assignment `name = "…"` (also `name "…"` in Groovy); the first in the file outside a comment. */
function assignment(text: string, name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*(?:=\\s*)?["']([^"']+)["']`);
  for (const line of codeLines(text)) {
    const value = pattern.exec(line.text)?.[1];
    if (value) return value;
  }
  return undefined;
}

/** Dependencies and plugins from a script line; one line gives at most one package. */
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
  // Plugins without a dot (`java`, `application`) are built into Gradle, so they are not a dependency.
  if (plugin?.[1]?.includes(".")) return { ecosystem: "gradle-plugin", name: plugin[1], version: plugin[2] ?? null, scope: "plugin" };
  const fromCatalog = CATALOG_PLUGIN.exec(line);
  const entry = fromCatalog ? catalog.plugins.get(alias(fromCatalog[1] ?? "")) : undefined;
  return entry && { ecosystem: "gradle-plugin", ...entry, scope: "plugin" };
}

function javaVersion(path: string, text: string): ToolRequirement[] {
  for (const line of codeLines(text)) {
    const m = JAVA_TOOLCHAIN.exec(line.text);
    const version = m?.[1] ?? m?.[2];
    // `1.8` is Java 8 in the old notation; mise knows it as `8`.
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
