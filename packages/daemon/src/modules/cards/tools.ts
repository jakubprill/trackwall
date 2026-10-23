import type { CardProblem, ToolRequirement } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { messageOf } from "../../error-message.ts";
import type { RepoSnapshot } from "./snapshot.ts";
import { escapeRegExp, evidenceAt, inDir } from "./snapshot.ts";

/**
 * Wymagane narzędzia z drzewa commita (§4.6, ADR-25): `[tools]` z konfiguracji mise w korzeniu repo i `.tool-versions`
 * (źródło `mise`), a do tego wersje z plików, które podają je po swojemu (źródło `hint`): `.nvmrc`, `.node-version`,
 * `.java-version`, `.sdkmanrc` oraz wrappery Maven i Gradle. Nie pyta `mise ls`: to czytałoby katalog roboczy
 * i konfigurację globalną zamiast commita, wymagało zaufania i zainstalowanego mise.
 */

/** Pliki konfiguracji mise w korzeniu repo, w kolejności, w której mise je czyta (ostatni wygrywa, więc odwrotnie). */
const MISE_CONFIG_FILES = [
  "mise.toml",
  ".mise.toml",
  "mise/config.toml",
  ".mise/config.toml",
  ".config/mise.toml",
  ".config/mise/config.toml",
];
const TOOL_VERSIONS = ".tool-versions";
/** Plik z jedną wersją narzędzia w katalogu buildu. */
const SINGLE_VERSION_FILES: [string, string][] = [
  [".nvmrc", "node"],
  [".node-version", "node"],
  [".java-version", "java"],
];
const SDKMANRC = ".sdkmanrc";
/** Wrapper i narzędzie, którego wersję podaje w adresie dystrybucji (`apache-maven-3.9.6-bin.zip`, `gradle-8.7-bin.zip`). */
const WRAPPERS: [string, string, RegExp][] = [
  [".mvn/wrapper/maven-wrapper.properties", "maven", /apache-maven-([\w.-]+?)-bin\.zip/],
  ["gradle/wrapper/gradle-wrapper.properties", "gradle", /gradle-([\w.-]+?)-(?:bin|all)\.zip/],
];

/** Wszystkie nazwy plików, które ten ekstraktor czyta, do wyboru plików z commita. */
export const TOOL_FILE_NAMES = new Set([
  ...MISE_CONFIG_FILES.map((p) => p.slice(p.lastIndexOf("/") + 1)),
  TOOL_VERSIONS,
  SDKMANRC,
  ...SINGLE_VERSION_FILES.map(([name]) => name),
  ...WRAPPERS.map(([path]) => path.slice(path.lastIndexOf("/") + 1)),
]);

/** Narzędzia z mise w korzeniu repo i podpowiedzi z korzenia oraz katalogów buildów (`buildDirs`). */
export function extractTools(snapshot: RepoSnapshot, buildDirs: readonly string[]): { tools: ToolRequirement[]; problems: CardProblem[] } {
  const tools: ToolRequirement[] = [];
  const problems: CardProblem[] = [];
  for (const path of MISE_CONFIG_FILES) {
    const text = snapshot.text(path);
    if (text === undefined) continue;
    try {
      tools.push(...miseTools(path, text));
    } catch (err) {
      problems.push({ path, message: messageOf(err) });
    }
  }
  const toolVersions = snapshot.text(TOOL_VERSIONS);
  if (toolVersions !== undefined) tools.push(...toolVersionsFile(TOOL_VERSIONS, toolVersions));
  for (const dir of new Set(["", ...buildDirs])) tools.push(...hints(snapshot, dir));
  return { tools, problems };
}

/** `[tools]` z mise: wersja, lista wersji albo tabela z `version`. */
function miseTools(path: string, text: string): ToolRequirement[] {
  const section = parseToml(text).tools;
  if (typeof section !== "object" || section === null || Array.isArray(section)) return [];
  return Object.entries(section).flatMap(([tool, value]) =>
    versionsOf(value).map((version) => ({
      tool,
      version,
      source: "mise" as const,
      evidence: evidenceAt(path, text, new RegExp(`^\\s*["']?${escapeRegExp(tool)}["']?\\s*=`)),
    })),
  );
}

function versionsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(versionsOf);
  if (typeof value === "object" && value !== null && "version" in value && typeof value.version === "string") return [value.version];
  return [];
}

/** `.tool-versions`: `narzędzie wersja [wersja…]`, `#` zaczyna komentarz. */
function toolVersionsFile(path: string, text: string): ToolRequirement[] {
  return text.split("\n").flatMap((raw, i) => {
    const [tool, ...versions] = (raw.split("#")[0] ?? "").trim().split(/\s+/);
    if (!tool) return [];
    return versions.map((version) => ({ tool, version, source: "mise" as const, evidence: { path, line: i + 1 } }));
  });
}

function hints(snapshot: RepoSnapshot, dir: string): ToolRequirement[] {
  const found: ToolRequirement[] = [];
  for (const [name, tool] of SINGLE_VERSION_FILES) {
    const path = inDir(dir, name);
    const version = snapshot.text(path)?.trim().split(/\s+/)[0];
    if (version) found.push({ tool, version: version.replace(/^v(?=\d)/, ""), source: "hint", evidence: { path, line: 1 } });
  }
  const sdkman = snapshot.text(inDir(dir, SDKMANRC));
  if (sdkman !== undefined)
    sdkman.split("\n").forEach((raw, i) => {
      const m = /^\s*(java|maven|gradle)\s*=\s*([^\s#]+)/.exec(raw);
      if (m?.[1] && m[2]) found.push({ tool: m[1], version: m[2], source: "hint", evidence: { path: inDir(dir, SDKMANRC), line: i + 1 } });
    });
  for (const [file, tool, pattern] of WRAPPERS) {
    const path = inDir(dir, file);
    const text = snapshot.text(path);
    const version = text === undefined ? undefined : pattern.exec(text)?.[1];
    if (text !== undefined && version) found.push({ tool, version, source: "hint", evidence: evidenceAt(path, text, pattern) });
  }
  return found;
}
