import type { ConsumedPackage, Evidence } from "@trackwall/protocol";
import { messageOf } from "../../error-message.ts";
import { dirOf, type Extracted, emptyExtracted, inDir, joinPath, type RepoSnapshot, rootFiles } from "./snapshot.ts";
import { child, children, childText, parseXml, type XmlElement } from "./xml.ts";

/**
 * Ekstraktor Maven (§4.6): `pom.xml` korzeni i modułów, które korzenie wymieniają (także w profilach). Daje
 * współrzędne każdego modułu (udostępniane), rodzica spoza repo, zależności, importowane BOM-y i wtyczki (używane)
 * oraz wersję Javy z właściwości. Wersje z `${…}` podstawia z właściwości pom i jego rodziców z repo.
 */

const POM = "pom.xml";
/** Właściwości, którymi projekty podają wersję Javy, od najpewniejszej. */
const JAVA_VERSION_PROPERTIES = ["maven.compiler.release", "java.version", "maven.compiler.source"];
const DEFAULT_PLUGIN_GROUP = "org.apache.maven.plugins";
/** Ile razy podstawiać właściwości w jednej wartości: właściwość może odwoływać się do innej, ale nie w kółko. */
const MAX_SUBSTITUTIONS = 10;

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
      out.problems.push({ path, message: messageOf(err) });
      return;
    }
    poms.set(path, { path, xml, memberOf });
    for (const module of moduleNames(xml)) {
      const target = joinPath(dirOf(path), module);
      if (target !== undefined) visit(target.endsWith(".xml") ? target : inDir(target, POM), path);
    }
  };
  for (const root of rootFiles(snapshot.paths.filter((p) => p === POM || p.endsWith(`/${POM}`)))) visit(root, null);

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

/** Moduły z `<modules>` i z `<modules>` w profilach: profil bywa jedynym miejscem, gdzie moduł jest wymieniony. */
function moduleNames(pom: XmlElement): string[] {
  const profiles = children(pom, "profiles", "profile");
  return [pom, ...profiles].flatMap((el) => children(el, "modules", "module").map((m) => m.text)).filter((m) => m !== "");
}

/** Rodzic, zależności, importowane BOM-y i wtyczki buildu jednego pom. */
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
 * Współrzędne pom: `groupId` i `version` bez własnej wartości dziedziczą z `<parent>` (tak robi Maven), więc
 * moduł wielomodułowego projektu ma pełne współrzędne bez powtarzania grupy.
 */
function resolveCoordinates(pom: Pom, poms: ReadonlyMap<string, Pom>, seen = new Set<string>()): Coordinates {
  seen.add(pom.path);
  const parent = child(pom.xml, "parent");
  const inherited = repoParent(pom, poms);
  // Rodzice zapętleni przez `relativePath` to błąd w repo; Maven by go odrzucił, karta bierze to, co ma.
  const fromParent = inherited && !seen.has(inherited.path) ? resolveCoordinates(inherited, poms, seen) : undefined;
  return {
    groupId: childText(pom.xml, "groupId") ?? childText(parent, "groupId") ?? fromParent?.groupId,
    artifactId: childText(pom.xml, "artifactId"),
    version: childText(pom.xml, "version") ?? childText(parent, "version") ?? fromParent?.version,
  };
}

/** Rodzic z tego repo: pom pod `relativePath` (domyślnie `../pom.xml`) z tym samym `artifactId` co w `<parent>`. */
function repoParent(pom: Pom, poms: ReadonlyMap<string, Pom>): Pom | undefined {
  const parent = child(pom.xml, "parent");
  if (!parent) return undefined;
  const relative = childText(parent, "relativePath") ?? "../pom.xml";
  const target = joinPath(dirOf(pom.path), relative);
  if (target === undefined) return undefined;
  const candidate = poms.get(target.endsWith(".xml") ? target : inDir(target, POM));
  return candidate && candidate !== pom && childText(candidate.xml, "artifactId") === childText(parent, "artifactId")
    ? candidate
    : undefined;
}

/** Właściwości pom: rodzice z repo najpierw, więc własne je nadpisują; do tego `project.*` jak w Mavenie. */
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

/** Podstawia `${nazwa}` znanymi właściwościami; nieznana zostaje w tekście, żeby było widać, skąd wersja pochodzi. */
function substitute(value: string, props: ReadonlyMap<string, string>): string {
  let current = value;
  for (let i = 0; i < MAX_SUBSTITUTIONS && current.includes("${"); i++) {
    const next = current.replace(/\$\{([^}]+)\}/g, (whole, name: string) => props.get(name) ?? whole);
    if (next === current) break;
    current = next;
  }
  return current;
}

function key(c: Coordinates): string {
  return `${c.groupId}:${c.artifactId}`;
}

function at(pom: Pom, el: XmlElement | undefined): Evidence {
  return { path: pom.path, line: el?.line ?? null };
}
