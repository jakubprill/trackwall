import { child, childText, parseXml, type XmlElement } from "../../infra/xml.ts";
import { baseName, dirOf, joinPath } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";

/**
 * Which specs in the repo the build generates code from, and what code (§4.6, ADR-87): the executions of
 * `openapi-generator-maven-plugin` (and `swagger-codegen-maven-plugin`) in every `pom.xml`, and the `openApiGenerate` or
 * `GenerateTask` blocks of `build.gradle(.kts)`. A spec the build generates a client from describes another app's API,
 * so its operations are not this repo's endpoints; a spec the build generates a server from describes the module that
 * runs the generator.
 */

/** A spec the build generates code from: where, with which generator, and in which module (the build file's directory). */
export interface SpecGeneration {
  /** The spec path in the repo, when the build gives it relative to the module or the root; else the end of the path (`orders.yaml`). */
  spec: string;
  /** Whether `spec` is a full path in the repo, or only its end (the build gave the path through a property the card does not know). */
  exact: boolean;
  server: boolean;
  /**
   * A server generator with `interfaceOnly`: it writes only the interface with the operation mappings, without the
   * controller that puts the server's base path in front (`@RequestMapping("${openapi.<title>.base-path:/api}")`), so the
   * app serves the paths from `paths` under its own controller's mapping.
   */
  interfaceOnly: boolean;
  module: string;
}

const MAVEN_PLUGINS = new Set(["openapi-generator-maven-plugin", "swagger-codegen-maven-plugin"]);
/** Libraries of the `spring` generator that generate a client: a Feign interface, an `@HttpExchange` interface. */
const SPRING_CLIENT_LIBRARIES = new Set(["spring-cloud", "spring-http-interface"]);
/** A Gradle block configuring generation: the plugin's extension or a task of its type. */
const GRADLE_BLOCK = /\b(?:openApiGenerate|GenerateTask\b[^{}\n]{0,200})\s*\{/g;
/**
 * A setting with a quoted value, also through `file("…")`, `project.file("…")` or `layout.projectDirectory.file("…")`,
 * all relative to the module (`rootProject.file("…")`, relative to the root, is not read).
 */
const GRADLE_SETTING = (name: string) =>
  new RegExp(
    `\\b${name}\\b\\s*(?:\\.set\\s*\\(|=|\\()\\s*(?:(?:project\\.|layout\\.projectDirectory\\.)?file\\(\\s*)?["']([^"'\\n]{1,500})["']`,
  );
/** `interfaceOnly` set to true in `configOptions`: `"interfaceOnly" to "true"` (Kotlin), `interfaceOnly: "true"` (Groovy). */
const GRADLE_INTERFACE_ONLY = /\binterfaceOnly["']?\s*(?:to|:|=)\s*["']?true\b/;

/**
 * A server generator: `spring` without a client library, `jaxrs-*` and the `*-server` ones (`java-undertow-server`). Every
 * other generator (`java`, `typescript-axios`, `kotlin`…) generates a client.
 */
function isServerGenerator(generator: string, library: string | undefined): boolean {
  if (generator === "spring") return library === undefined || !SPRING_CLIENT_LIBRARIES.has(library);
  return generator.startsWith("jaxrs") || generator.endsWith("-server");
}

/** The generations of every Maven and Gradle build file in the commit. */
export function specGenerations(snapshot: RepoSnapshot): SpecGeneration[] {
  return snapshot.paths.flatMap((path) => {
    const name = baseName(path);
    const text = name === "pom.xml" || name.startsWith("build.gradle") ? snapshot.text(path) : undefined;
    if (text === undefined) return [];
    return name === "pom.xml" ? mavenGenerations(path, text) : gradleGenerations(path, text);
  });
}

/** Whether a generation is about the spec at `path`. */
export function generates(generation: SpecGeneration, path: string): boolean {
  return generation.exact ? generation.spec === path : path === generation.spec || path.endsWith(`/${generation.spec}`);
}

function mavenGenerations(path: string, text: string): SpecGeneration[] {
  let pom: XmlElement;
  try {
    pom = parseXml(text);
  } catch {
    // The Maven extractor reports an invalid pom; here it only gives no generations.
    return [];
  }
  const module = dirOf(path);
  return pluginsIn(pom).flatMap((plugin) => {
    const base = child(plugin, "configuration");
    const executions = child(plugin, "executions")?.children.filter((e) => e.name === "execution") ?? [];
    const configurations = executions.length > 0 ? executions.map((e) => child(e, "configuration")) : [undefined];
    return configurations.flatMap((own) => {
      const setting = (name: string) => childText(own, name) ?? childText(base, name);
      const option = (name: string) => childText(child(own, "configOptions"), name) ?? childText(child(base, "configOptions"), name);
      const input = setting("inputSpec");
      const generator = setting("generatorName") ?? setting("language");
      if (input === undefined || generator === undefined) return [];
      const server = isServerGenerator(generator, setting("library"));
      return [{ ...specPath(module, input), server, interfaceOnly: server && option("interfaceOnly") === "true", module }];
    });
  });
}

/** Generator plugins in `<build>`, `<pluginManagement>` and the same in profiles. */
function pluginsIn(pom: XmlElement): XmlElement[] {
  const builds = [child(pom, "build"), ...(child(pom, "profiles")?.children ?? []).map((p) => child(p, "build"))];
  return builds.flatMap((build) =>
    [child(build, "plugins"), child(child(build, "pluginManagement"), "plugins")].flatMap(
      (plugins) => plugins?.children.filter((p) => p.name === "plugin" && MAVEN_PLUGINS.has(childText(p, "artifactId") ?? "")) ?? [],
    ),
  );
}

function gradleGenerations(path: string, text: string): SpecGeneration[] {
  const module = dirOf(path);
  return [...text.matchAll(GRADLE_BLOCK)].flatMap((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    const block = text.slice(open, closingBrace(text, open));
    const input = GRADLE_SETTING("inputSpec").exec(block)?.[1];
    const generator = GRADLE_SETTING("generatorName").exec(block)?.[1];
    if (input === undefined || generator === undefined) return [];
    const server = isServerGenerator(generator, GRADLE_SETTING("library").exec(block)?.[1]);
    return [{ ...specPath(module, input), server, interfaceOnly: server && GRADLE_INTERFACE_ONLY.test(block), module }];
  });
}

/** The index after the `}` closing the block opened at `open`, or the end of the text. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * The spec path from the build: relative to the module (`src/main/resources/api.yaml`, `${project.basedir}/…`,
 * `$projectDir/…`) or to the repo root (`$rootDir/…`, `${maven.multiModuleProjectDirectory}/…`); with another property
 * in front only the part after it.
 */
function specPath(module: string, input: string): Pick<SpecGeneration, "spec" | "exact"> {
  const normalized = input.replaceAll("\\", "/");
  const prefix = /^\$\{?([\w.]+)\}?\/?/.exec(normalized);
  const rest = prefix ? normalized.slice(prefix[0].length) : normalized;
  const root = prefix?.[1] === "rootDir" || prefix?.[1] === "maven.multiModuleProjectDirectory";
  const own = prefix === null || ["project.basedir", "basedir", "projectDir"].includes(prefix[1] ?? "");
  const exact = root ? joinPath("", rest) : own ? joinPath(module, rest) : undefined;
  return exact === undefined ? { spec: rest.replace(/^(\.\.?\/)+/, ""), exact: false } : { spec: exact, exact: true };
}
