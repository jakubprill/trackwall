import type { ToolRequirement } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../error-message.ts";
import { baseName, inDir } from "./repo-path.ts";
import { type Extracted, emptyExtracted, escapeRegExp, evidenceAt, type RepoSnapshot } from "./snapshot.ts";

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

/** Nazwy plików z podpowiedziami, czytanych w korzeniu i w katalogach buildów. */
const HINT_FILE_NAMES = new Set([SDKMANRC, ...SINGLE_VERSION_FILES.map(([name]) => name), ...WRAPPERS.map(([path]) => baseName(path))]);

/** Pliki, które ten ekstraktor czyta, do wyboru plików z commita: konfiguracja mise tylko w korzeniu repo. */
export function readsToolFile(path: string): boolean {
  return MISE_CONFIG_FILES.includes(path) || path === TOOL_VERSIONS || HINT_FILE_NAMES.has(baseName(path));
}

/** Wersja narzędzia w `[tools]` mise: napis, lista albo tabela z `version` (i opcjami, których karta nie potrzebuje). */
const MiseVersion = z.union([z.string(), z.object({ version: z.string() })]);
/** `[tools]` z konfiguracji mise; wpis w nieznanej postaci jest pomijany bez utraty reszty. */
const MiseConfig = z.object({
  tools: z.record(z.string(), z.union([MiseVersion, z.array(MiseVersion)]).catch([])).catch({}),
});

/** Narzędzia z mise w korzeniu repo i podpowiedzi z korzenia oraz katalogów buildów (`buildDirs`). */
export function extractTools(snapshot: RepoSnapshot, buildDirs: readonly string[]): Extracted {
  const out = emptyExtracted();
  for (const path of MISE_CONFIG_FILES) {
    const text = snapshot.text(path);
    if (text === undefined) continue;
    try {
      out.tools.push(...miseTools(path, text));
    } catch (err) {
      out.problems.push({ path, message: messageOf(err) });
    }
  }
  const toolVersions = snapshot.text(TOOL_VERSIONS);
  if (toolVersions !== undefined) out.tools.push(...toolVersionsFile(TOOL_VERSIONS, toolVersions));
  for (const dir of new Set(["", ...buildDirs])) out.tools.push(...hints(snapshot, dir));
  return out;
}

/** `[tools]` z mise: wersja, lista wersji albo tabela z `version`. */
function miseTools(path: string, text: string): ToolRequirement[] {
  const parsed = MiseConfig.safeParse(parseToml(text));
  if (!parsed.success) return [];
  return Object.entries(parsed.data.tools).flatMap(([tool, value]) =>
    [value].flat().map((v) => ({
      tool,
      version: typeof v === "string" ? v : v.version,
      source: "mise" as const,
      evidence: evidenceAt(path, text, new RegExp(`^\\s*["']?${escapeRegExp(tool)}["']?\\s*=`)),
    })),
  );
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
