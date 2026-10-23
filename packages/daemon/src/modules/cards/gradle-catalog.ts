import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { messageOf } from "../../error-message.ts";
import type { Extracted, RepoSnapshot } from "./snapshot.ts";

/**
 * Katalog wersji Gradle (`gradle/libs.versions.toml`, §4.6): aliasy bibliotek i wtyczek, do których skrypty odwołują
 * się przez `libs.…`. Plik jest z repo, więc wchodzi przez schemat zod.
 */

interface CatalogEntry {
  name: string;
  version: string | null;
}

export interface Catalog {
  libraries: Map<string, CatalogEntry>;
  plugins: Map<string, CatalogEntry>;
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
export function readCatalog(snapshot: RepoSnapshot, path: string, out: Extracted): Catalog {
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
  // `Object.hasOwn`: `ref = "constructor"` z repo nie może sięgnąć do prototypu obiektu.
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

/** Klucz aliasu katalogu tak, jak Gradle tworzy akcesor: `spring-boot-web`, `spring_boot.web` i `spring.boot.web` to to samo. */
export function alias(name: string): string {
  return name.replace(/[-_]/g, ".").toLowerCase();
}
