import type { ToolRequirement } from "@trackwall/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../infra/errors.ts";
import { baseName, inDir } from "./repo-path.ts";
import { type Extracted, emptyExtracted, keyLines, type RepoSnapshot } from "./snapshot.ts";

/**
 * Required tools from the commit tree (§4.6, ADR-25): `[tools]` from the mise configuration in the repo root and
 * `.tool-versions` (source `mise`), plus versions from files that give them their own way (source `hint`): `.nvmrc`,
 * `.node-version`, `.java-version`, `.sdkmanrc` and the Maven and Gradle wrappers. It does not ask `mise ls`: that would
 * read the working directory and the global configuration instead of the commit, and would need trust and an installed mise.
 */

/** mise config files in the repo root, in the order mise reads them (the last one wins, so reversed). */
export const MISE_CONFIG_FILES = [
  "mise.toml",
  ".mise.toml",
  "mise/config.toml",
  ".mise/config.toml",
  ".config/mise.toml",
  ".config/mise/config.toml",
];
const TOOL_VERSIONS = ".tool-versions";
/** A file with one tool version in a build directory. */
const SINGLE_VERSION_FILES: [string, string][] = [
  [".nvmrc", "node"],
  [".node-version", "node"],
  [".java-version", "java"],
];
const SDKMANRC = ".sdkmanrc";
/**
 * The wrapper, the tool and the distribution file name from the address in `distributionUrl` (`apache-maven-3.9.6-bin.zip`,
 * `gradle-8.7-bin.zip`). The expression gets only the file name and is anchored at both ends, because the file comes from the repo.
 */
const WRAPPERS: [string, string, RegExp][] = [
  [".mvn/wrapper/maven-wrapper.properties", "maven", /^apache-maven-(.+)-bin\.zip$/],
  ["gradle/wrapper/gradle-wrapper.properties", "gradle", /^gradle-(.+)-(?:bin|all)\.zip$/],
];
/** A TOML table key at the start of a line (`node =`, `"npm:prettier" =`, `"ubi:cli/cli[exe=gh]" =`). */
export const TOML_KEY = /^\s*(?:"([^"]*)"|'([^']*)'|([^"'\s=]+))\s*=/g;

/** Names of hint files, read in the root and in build directories. */
const HINT_FILE_NAMES = new Set([SDKMANRC, ...SINGLE_VERSION_FILES.map(([name]) => name), ...WRAPPERS.map(([path]) => baseName(path))]);

/** The files this extractor reads, for choosing files from the commit: mise configuration only in the repo root. */
export function readsToolFile(path: string): boolean {
  return MISE_CONFIG_FILES.includes(path) || path === TOOL_VERSIONS || HINT_FILE_NAMES.has(baseName(path));
}

/** A tool version in mise's `[tools]`: a string, a list or a table with `version` (and options the card does not need). */
const MiseVersion = z.union([z.string(), z.object({ version: z.string() })]);
/** `[tools]` from the mise configuration; an entry in an unknown form is skipped without losing the rest. */
const MiseConfig = z.object({
  tools: z.record(z.string(), z.union([MiseVersion, z.array(MiseVersion)]).catch([])).catch({}),
});

/** Tools from mise in the repo root and hints from the root and the build directories (`buildDirs`). */
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

/** `[tools]` from mise: a version, a list of versions or a table with `version`. */
function miseTools(path: string, text: string): ToolRequirement[] {
  const parsed = MiseConfig.safeParse(parseToml(text));
  if (!parsed.success) return [];
  const keys = keyLines(text, TOML_KEY);
  return Object.entries(parsed.data.tools).flatMap(([tool, value]) =>
    [value].flat().map((v) => ({
      tool,
      version: typeof v === "string" ? v : v.version,
      source: "mise" as const,
      evidence: { path, line: keys.get(tool) ?? null },
    })),
  );
}

/** `.tool-versions`: `tool version [version…]`, `#` starts a comment. */
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
    const hint = wrapperVersion(snapshot.text(path) ?? "", pattern);
    if (hint) found.push({ tool, version: hint.version, source: "hint", evidence: { path, line: hint.line } });
  }
  return found;
}

/** The version from the file name in the wrapper properties' `distributionUrl=…` and the line of that entry. */
function wrapperVersion(text: string, pattern: RegExp): { version: string; line: number } | undefined {
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    const url = /^\s*distributionUrl\s*=(.*)$/.exec(raw)?.[1]?.trim();
    const version = url === undefined ? undefined : pattern.exec(url.slice(url.lastIndexOf("/") + 1))?.[1];
    if (version) return { version, line: i + 1 };
  }
  return undefined;
}
