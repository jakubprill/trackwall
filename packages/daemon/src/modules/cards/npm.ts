import { BuildTool, type ConsumedPackage, type Evidence, type ToolRequirement } from "@trackwall/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { messageOf } from "../../infra/errors.ts";
import { globMatcher } from "./glob.ts";
import { baseName, dirOf, inDir, isUnder, rootFiles } from "./repo-path.ts";
import { type Extracted, emptyExtracted, keyLines, type RepoSnapshot } from "./snapshot.ts";

/**
 * The npm extractor (§4.6): the `package.json` of the roots and of workspace packages (`workspaces` in `package.json` or
 * `pnpm-workspace.yaml`). Gives the package name and version (provided, unless `"private": true`), dependencies from the
 * `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` fields, the package manager and the
 * required Node and manager versions.
 */

const PACKAGE_JSON = "package.json";
const PNPM_WORKSPACE = "pnpm-workspace.yaml";
/** The files this extractor reads, for choosing files from the commit. */
export function readsNpmFile(path: string): boolean {
  const name = baseName(path);
  return name === PACKAGE_JSON || name === PNPM_WORKSPACE;
}
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
/** A lock file in the root directory says which manager installs the dependencies when `packageManager` is silent. */
const LOCKFILES: [string, BuildTool][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
const MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

const Dependencies = z.record(z.string(), z.string()).optional().catch(undefined);
/** The `package.json` fields we use; a wrong type of one field does not take away the rest. */
const PackageJson = z.object({
  name: z.string().optional().catch(undefined),
  version: z.string().optional().catch(undefined),
  private: z.boolean().optional().catch(undefined),
  packageManager: z.string().optional().catch(undefined),
  engines: z
    .object({ node: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  workspaces: z
    .union([z.array(z.string()), z.object({ packages: z.array(z.string()) }).transform((w) => w.packages)])
    .optional()
    .catch(undefined),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  peerDependencies: Dependencies,
  optionalDependencies: Dependencies,
});
type PackageJson = z.infer<typeof PackageJson>;
const PnpmWorkspace = z.object({ packages: z.array(z.string()).optional() });

interface Manifest {
  path: string;
  json: PackageJson;
  /** The line of the first occurrence of every JSON key, for evidence. */
  keys: Map<string, number>;
  memberOf: string | null;
  tool: BuildTool;
}

export function extractNpm(snapshot: RepoSnapshot): Extracted {
  const out = emptyExtracted();
  const manifests = readManifests(snapshot, out);
  const internal = new Set(manifests.map((m) => m.json.name).filter((n) => n !== undefined));
  for (const m of manifests) {
    out.buildFiles.push({ path: m.path, tool: m.tool, name: m.json.name ?? null, memberOf: m.memberOf });
    if (m.json.name && !m.json.private)
      out.provides.push({
        kind: "package",
        ecosystem: "npm",
        name: m.json.name,
        version: m.json.version ?? null,
        evidence: keyEvidence(m, "name"),
      });
    out.consumes.push(...dependencies(m).filter((d) => !internal.has(d.name)));
    out.tools.push(...tools(m));
  }
  return out;
}

/** The `package.json` of the roots and their workspace packages; a package inherits the manager from its root. */
function readManifests(snapshot: RepoSnapshot, out: Extracted): Manifest[] {
  const all = snapshot.paths.filter((p) => baseName(p) === PACKAGE_JSON);
  const manifests: Manifest[] = [];
  for (const root of rootFiles(all)) {
    const json = readManifest(snapshot, root, out);
    if (!json) continue;
    const tool = packageManager(snapshot, root, json);
    manifests.push({ path: root, json, keys: keyLines(snapshot.text(root) ?? "", JSON_KEY), memberOf: null, tool });
    for (const member of workspaceMembers(snapshot, root, json, all, out)) {
      const memberJson = readManifest(snapshot, member, out);
      if (memberJson)
        manifests.push({ path: member, json: memberJson, keys: keyLines(snapshot.text(member) ?? "", JSON_KEY), memberOf: root, tool });
    }
  }
  return manifests;
}

function readManifest(snapshot: RepoSnapshot, path: string, out: Extracted): PackageJson | undefined {
  const text = snapshot.text(path);
  if (text === undefined) return undefined;
  try {
    const parsed = PackageJson.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    out.problems.push({ path, message: "package.json is not a JSON object" });
  } catch (err) {
    out.problems.push({ path, message: messageOf(err) });
  }
  return undefined;
}

/** The `package.json` of a root's workspace packages: patterns from `workspaces` or `pnpm-workspace.yaml`, `!` excludes. */
function workspaceMembers(snapshot: RepoSnapshot, root: string, json: PackageJson, all: readonly string[], out: Extracted): string[] {
  const dir = dirOf(root);
  const patterns = json.workspaces ?? pnpmWorkspaces(snapshot, inDir(dir, PNPM_WORKSPACE), out);
  const include = patterns.filter((p) => !p.startsWith("!")).map((p) => globMatcher(clean(p)));
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => globMatcher(clean(p.slice(1))));
  return all.filter((path) => {
    if (path === root || !isUnder(path, dir)) return false;
    const rel = dirOf(dir === "" ? path : path.slice(dir.length + 1));
    return include.some((match) => match(rel)) && !exclude.some((match) => match(rel));
  });
}

/**
 * A workspace pattern without a leading `./` and a trailing `/`, the way people write it. A loop instead of `/\/+$/`: the
 * pattern comes from the repo, and that expression backtracks quadratically on a long run of slashes in the middle.
 */
function clean(pattern: string): string {
  let end = pattern.length;
  while (end > 0 && pattern[end - 1] === "/") end--;
  return pattern.slice(0, end).replace(/^\.\//, "");
}

/** A quoted JSON key followed by `:`; one line can hold many (a minified `package.json`). */
export const JSON_KEY = /"([^"\\]*)"\s*:/g;

function keyEvidence(m: Manifest, key: string): Evidence {
  return { path: m.path, line: m.keys.get(key) ?? null };
}

function pnpmWorkspaces(snapshot: RepoSnapshot, path: string, out: Extracted): string[] {
  const text = snapshot.text(path);
  if (text === undefined) return [];
  try {
    return PnpmWorkspace.safeParse(parseYaml(text)).data?.packages ?? [];
  } catch (err) {
    out.problems.push({ path, message: messageOf(err) });
    return [];
  }
}

function packageManager(snapshot: RepoSnapshot, root: string, json: PackageJson): BuildTool {
  const declared = BuildTool.safeParse(json.packageManager?.split("@")[0]);
  if (declared.success && MANAGERS.has(declared.data)) return declared.data;
  const dir = dirOf(root);
  return LOCKFILES.find(([file]) => snapshot.paths.includes(inDir(dir, file)))?.[1] ?? "npm";
}

function dependencies(m: Manifest): ConsumedPackage[] {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(m.json[field] ?? {}).map(([name, version]) => ({
      kind: "package" as const,
      ecosystem: "npm" as const,
      name,
      version,
      scope: field,
      evidence: keyEvidence(m, name),
    })),
  );
}

/** `engines.node` and the manager from `packageManager` (`pnpm@10.28.0`); mise does not read them itself, so they are hints. */
function tools(m: Manifest): ToolRequirement[] {
  const found: ToolRequirement[] = [];
  const node = m.json.engines?.node;
  if (node) found.push({ tool: "node", version: node, source: "hint", evidence: keyEvidence(m, "node") });
  const [manager, version] = m.json.packageManager?.split("@") ?? [];
  if (manager && version && MANAGERS.has(manager))
    found.push({
      tool: manager,
      // A version sometimes has a hash suffix (`pnpm@9.1.0+sha512.…`).
      version: version.split("+")[0] ?? version,
      source: "hint",
      evidence: keyEvidence(m, "packageManager"),
    });
  return found;
}
