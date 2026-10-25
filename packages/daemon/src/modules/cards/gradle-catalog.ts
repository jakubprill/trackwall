import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../infra/errors.ts";
import type { ProblemSink, RepoSnapshot } from "./snapshot.ts";

/**
 * The Gradle version catalog (`gradle/libs.versions.toml`, §4.6): library and plugin aliases that scripts refer to
 * through `libs.…`. The file comes from the repo, so it goes through a zod schema.
 */

interface CatalogEntry {
  name: string;
  version: string | null;
}

export interface Catalog {
  libraries: Map<string, CatalogEntry>;
  plugins: Map<string, CatalogEntry>;
}

/** A version in the catalog: a string, a reference to `[versions]` or a rich version (`strictly`, `require`, `prefer`). */
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
/** `gradle/libs.versions.toml`; an entry in an unknown form is skipped without losing the rest. */
const VersionCatalog = z.object({
  versions: z.record(z.string(), z.string().catch("")).catch({}),
  libraries: z.record(z.string(), CatalogLibrary.nullable().catch(null)).catch({}),
  plugins: z.record(z.string(), CatalogPlugin.nullable().catch(null)).catch({}),
});
type VersionCatalog = z.infer<typeof VersionCatalog>;

/**
 * The Gradle version catalog: libraries (`module = "g:a"`, `group` + `name` or `"g:a:v"`) and plugins (`id` or
 * `"id:version"`), with the version given directly or with `version.ref` to `[versions]`.
 */
export function readCatalog(snapshot: RepoSnapshot, path: string, out: ProblemSink): Catalog {
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
  // `Object.hasOwn`: `ref = "constructor"` from the repo must not reach the object's prototype.
  if ("ref" in v) return Object.hasOwn(versions, v.ref) ? versions[v.ref] || null : null;
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

/** A catalog alias key the way Gradle builds the accessor: `spring-boot-web`, `spring_boot.web` and `spring.boot.web` are the same. */
export function alias(name: string): string {
  return name.replace(/[-_]/g, ".").toLowerCase();
}
