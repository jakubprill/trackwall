import type { ConsumedPackage, Evidence } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { child, children, childText, parseXml, type XmlElement } from "../../infra/xml.ts";
import { baseName, dirOf, inDir, joinPath, rootFiles } from "./repo-path.ts";
import { type Extracted, emptyExtracted, type RepoSnapshot } from "./snapshot.ts";

/**
 * The Maven extractor (§4.6): the `pom.xml` of the roots and of the modules the roots list (also in profiles). Gives
 * the coordinates of every module (provided), a parent from outside the repo, dependencies, imported BOMs and plugins
 * (used) and the Java version from the properties. It substitutes versions with `${…}` from the properties of the pom
 * and its parents in the repo.
 */

const POM = "pom.xml";
/** Properties projects use to give the Java version, most reliable first. */
const JAVA_VERSION_PROPERTIES = ["maven.compiler.release", "java.version", "maven.compiler.source"];
const DEFAULT_PLUGIN_GROUP = "org.apache.maven.plugins";
/** How many times to substitute properties in one value: a property can refer to another, but not in a loop. */
const MAX_SUBSTITUTIONS = 10;
/**
 * The longest value after substitution. A property with a hundred references to the next one, which has a hundred of its
 * own, grows exponentially; without a limit a few KB of pom would take all of the daemon's memory (§8). A longer version
 * is not a version anyway.
 */
const MAX_SUBSTITUTED_LENGTH = 4096;

/** The files this extractor reads, for choosing files from the commit. */
export function readsMavenFile(path: string): boolean {
  return baseName(path) === POM;
}

interface Pom {
  path: string;
  xml: XmlElement;
  memberOf: string | null;
}

interface Coordinates {
  groupId: string | undefined;
  artifactId: string | undefined;
  version: string | undefined;
}

export function extractMaven(snapshot: RepoSnapshot): Extracted {
  const out = emptyExtracted();
  const poms = new Map<string, Pom>();
  const visit = (path: string, memberOf: string | null) => {
    if (poms.has(path)) return;
    const text = snapshot.text(path);
    if (text === undefined) return;
    let xml: XmlElement;
    try {
      xml = parseXml(text);
    } catch (err) {
      out.problems.push({ code: "file-invalid", path, message: messageOf(err) });
      return;
    }
    poms.set(path, { path, xml, memberOf });
    for (const module of moduleNames(xml)) {
      const target = pomAt(dirOf(path), module);
      if (target !== undefined) visit(target, path);
    }
  };
  for (const root of rootFiles(snapshot.paths.filter(readsMavenFile))) visit(root, null);

  const coordinates = (pom: Pom) => resolveCoordinates(pom, poms);
  const internal = new Set([...poms.values()].map((pom) => key(coordinates(pom))));
  for (const pom of poms.values()) {
    const own = coordinates(pom);
    const props = properties(pom, poms);
    const resolve = (value: string | undefined) => (value === undefined ? null : substitute(value, props));
    out.buildFiles.push({ path: pom.path, tool: "maven", name: own.artifactId ?? null, memberOf: pom.memberOf });
    if (own.groupId && own.artifactId)
      out.provides.push({
        kind: "package",
        ecosystem: "maven",
        name: `${own.groupId}:${own.artifactId}`,
        version: resolve(own.version),
        evidence: at(pom, child(pom.xml, "artifactId")),
      });
    out.consumes.push(...consumed(pom, resolve).filter((c) => !internal.has(c.name)));
    const java = JAVA_VERSION_PROPERTIES.map((name) => child(child(pom.xml, "properties"), name)).find((el) => el?.text);
    if (java) out.tools.push({ tool: "java", version: resolve(java.text) ?? java.text, source: "hint", evidence: at(pom, java) });
  }
  return out;
}

/** Modules from `<modules>` and from `<modules>` in profiles: a profile is sometimes the only place a module is listed. */
function moduleNames(pom: XmlElement): string[] {
  const profiles = children(pom, "profiles", "profile");
  return [pom, ...profiles].flatMap((el) => children(el, "modules", "module").map((m) => m.text)).filter((m) => m !== "");
}

/** The parent, dependencies, imported BOMs and build plugins of one pom. */
function consumed(pom: Pom, resolve: (value: string | undefined) => string | null): ConsumedPackage[] {
  const pkg = (el: XmlElement, scope: string, defaultGroup?: string): ConsumedPackage | undefined => {
    const groupId = resolve(childText(el, "groupId") ?? defaultGroup);
    const artifactId = resolve(childText(el, "artifactId"));
    if (!groupId || !artifactId) return undefined;
    const version = resolve(childText(el, "version"));
    return { kind: "package", ecosystem: "maven", name: `${groupId}:${artifactId}`, version, scope, evidence: at(pom, el) };
  };
  const parent = child(pom.xml, "parent");
  const dependencies = children(pom.xml, "dependencies", "dependency").map((d) => pkg(d, childText(d, "scope") ?? "compile"));
  const boms = children(child(pom.xml, "dependencyManagement"), "dependencies", "dependency")
    .filter((d) => childText(d, "scope") === "import")
    .map((d) => pkg(d, "import"));
  const plugins = children(child(pom.xml, "build"), "plugins", "plugin").map((p) => pkg(p, "plugin", DEFAULT_PLUGIN_GROUP));
  return [parent && pkg(parent, "parent"), ...dependencies, ...boms, ...plugins].filter((c) => c !== undefined);
}

/**
 * The pom's coordinates: `groupId` and `version` without their own value are inherited from `<parent>` (as Maven does),
 * so a module of a multi-module project has full coordinates without repeating the group.
 */
function resolveCoordinates(pom: Pom, poms: ReadonlyMap<string, Pom>, seen = new Set<string>()): Coordinates {
  seen.add(pom.path);
  const parent = child(pom.xml, "parent");
  const inherited = repoParent(pom, poms);
  // Parents looped through `relativePath` are an error in the repo; Maven would reject it, the card takes what it has.
  const fromParent = inherited && !seen.has(inherited.path) ? resolveCoordinates(inherited, poms, seen) : undefined;
  return {
    groupId: childText(pom.xml, "groupId") ?? childText(parent, "groupId") ?? fromParent?.groupId,
    artifactId: childText(pom.xml, "artifactId"),
    version: childText(pom.xml, "version") ?? childText(parent, "version") ?? fromParent?.version,
  };
}

/** A parent from this repo: the pom at `relativePath` (by default `../pom.xml`) with the same `artifactId` as in `<parent>`. */
function repoParent(pom: Pom, poms: ReadonlyMap<string, Pom>): Pom | undefined {
  const parent = child(pom.xml, "parent");
  if (!parent) return undefined;
  const target = pomAt(dirOf(pom.path), childText(parent, "relativePath") ?? "../pom.xml");
  const candidate = target === undefined ? undefined : poms.get(target);
  return candidate && candidate !== pom && childText(candidate.xml, "artifactId") === childText(parent, "artifactId")
    ? candidate
    : undefined;
}

/** The pom's properties: parents from the repo first, so its own override them; plus `project.*` as in Maven. */
function properties(pom: Pom, poms: ReadonlyMap<string, Pom>, seen = new Set<string>()): Map<string, string> {
  seen.add(pom.path);
  const parent = repoParent(pom, poms);
  const props = parent && !seen.has(parent.path) ? properties(parent, poms, seen) : new Map<string, string>();
  for (const el of child(pom.xml, "properties")?.children ?? []) props.set(el.name, el.text);
  const own = resolveCoordinates(pom, poms);
  const parentEl = child(pom.xml, "parent");
  const builtIn: [string, string | undefined][] = [
    ["project.groupId", own.groupId],
    ["project.artifactId", own.artifactId],
    ["project.version", own.version],
    ["project.parent.groupId", childText(parentEl, "groupId")],
    ["project.parent.version", childText(parentEl, "version")],
  ];
  for (const [name, value] of builtIn) if (value !== undefined) props.set(name, value);
  return props;
}

/**
 * Substitutes `${name}` with known properties; an unknown one (or one that would exceed `MAX_SUBSTITUTED_LENGTH`)
 * stays in the text, so that it is visible where the version comes from.
 */
function substitute(value: string, props: ReadonlyMap<string, string>): string {
  // A value longer than the result after substitution is not a version, and searching it is expensive.
  if (value.length > MAX_SUBSTITUTED_LENGTH) return value;
  let current = value;
  for (let i = 0; i < MAX_SUBSTITUTIONS && current.includes("${"); i++) {
    let length = current.length;
    const next = current.replace(/\$\{([^}$]+)\}/g, (whole, name: string) => {
      const value = props.get(name);
      if (value === undefined || length + value.length > MAX_SUBSTITUTED_LENGTH) return whole;
      length += value.length - whole.length;
      return value;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

/** The pom a relative path points to (a module, `relativePath`): a `.xml` file directly or `pom.xml` in a directory. */
function pomAt(dir: string, rel: string): string | undefined {
  const target = joinPath(dir, rel);
  if (target === undefined) return undefined;
  return target.endsWith(".xml") ? target : inDir(target, POM);
}

function key(c: Coordinates): string {
  return `${c.groupId}:${c.artifactId}`;
}

function at(pom: Pom, el: XmlElement | undefined): Evidence {
  return { path: pom.path, line: el?.line ?? null };
}
