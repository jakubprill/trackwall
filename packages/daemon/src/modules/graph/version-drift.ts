import type {
  ConsumedPackage,
  DriftedRepo,
  DriftKind,
  MechanismEvidence,
  RepoCard,
  ToolRequirement,
  VersionDrift,
} from "@trackwall/protocol";
import type { GraphCardInput } from "./graph-input.ts";

/**
 * Version drift (§4.6, ADR-196): the tools, Spring Boot, parent poms, BOMs and build plugins that the repos of the
 * projects folder use in different versions. A pure function on the cards, like the graph: a version comes from a fact
 * on a card (`tools`, `consumes`) with its file and line, nothing is run. A repo's mise config wins over its hints for
 * a tool, because mise installs what it says; Java is compared by its major version, which is what `release`,
 * toolchains and `.java-version` give; everything else by the version as written. A version Maven or Gradle would
 * substitute (`${…}`, `$version`) is unknown, so it is left out.
 */

interface Sighting {
  kind: DriftKind;
  name: string;
  version: string;
  evidence: MechanismEvidence;
}

/** The order of drift kinds in the result: what a person aligns first. */
const KIND_ORDER: readonly DriftKind[] = ["tool", "spring-boot", "parent", "plugin"];

/** The packages that carry the Spring Boot version: its parent, its BOM and its Maven and Gradle plugins. */
const SPRING_BOOT_PACKAGES = new Set([
  "maven org.springframework.boot:spring-boot-starter-parent",
  "maven org.springframework.boot:spring-boot-dependencies",
  "maven org.springframework.boot:spring-boot-maven-plugin",
  "gradle-plugin org.springframework.boot",
]);

/** Maven scopes of a parent pom and an imported BOM (`ConsumedPackage.scope`). */
const PARENT_SCOPES = new Set(["parent", "import"]);

export function versionDrift(cards: readonly GraphCardInput[]): VersionDrift[] {
  const subjects = new Map<string, { kind: DriftKind; name: string; repos: Map<string, DriftedRepo> }>();
  for (const entry of cards) {
    if (entry.kind !== "ok" || entry.card === null) continue;
    for (const s of sightings(entry.card)) {
      const key = `${s.kind} ${s.name}`;
      const subject = subjects.get(key) ?? { kind: s.kind, name: s.name, repos: new Map<string, DriftedRepo>() };
      subjects.set(key, subject);
      const repo = subject.repos.get(entry.repo) ?? { repo: entry.repo, versions: [], evidence: [] };
      subject.repos.set(entry.repo, repo);
      if (!repo.versions.includes(s.version)) repo.versions.push(s.version);
      repo.evidence.push(s.evidence);
    }
  }
  return [...subjects.values()]
    .map(({ kind, name, repos }) => ({ kind, name, repos: [...repos.values()] }))
    .filter(({ repos }) => repos.length >= 2 && new Set(repos.flatMap((r) => r.versions)).size >= 2)
    .map((d) => ({ ...d, target: newestVersion(d.repos.flatMap((r) => r.versions)) }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

function sightings(card: RepoCard): Sighting[] {
  const packages = card.consumes.flatMap((c) => (c.kind === "package" ? packageSighting(c) : []));
  return [...toolSightings(card.tools), ...packages];
}

/** Per tool, the mise entries when the repo has any, otherwise its hints. */
function toolSightings(tools: readonly ToolRequirement[]): Sighting[] {
  const byTool = new Map<string, ToolRequirement[]>();
  for (const t of tools) byTool.set(t.tool, [...(byTool.get(t.tool) ?? []), t]);
  return [...byTool].flatMap(([name, all]) => {
    const fromMise = all.filter((t) => t.source === "mise");
    return (fromMise.length > 0 ? fromMise : all).flatMap((t) => {
      const version = name === "java" ? javaMajor(t.version) : t.version.trim();
      if (!comparable(version)) return [];
      return [{ kind: "tool" as const, name, version, evidence: { ...t.evidence, detail: `${name} ${t.version} (${t.source})` } }];
    });
  });
}

function packageSighting(pkg: ConsumedPackage): Sighting[] {
  if (pkg.version === null || !comparable(pkg.version.trim())) return [];
  const kind = packageKind(pkg);
  if (kind === undefined) return [];
  const name = kind === "spring-boot" ? "spring-boot" : pkg.name;
  const evidence = { ...pkg.evidence, detail: `${pkg.name} ${pkg.version} (${pkg.scope})` };
  return [{ kind, name, version: pkg.version.trim(), evidence }];
}

/** Which drift a package's version belongs to; a plain dependency belongs to none, its version usually comes from a BOM. */
function packageKind(pkg: ConsumedPackage): DriftKind | undefined {
  if (SPRING_BOOT_PACKAGES.has(`${pkg.ecosystem} ${pkg.name}`)) return "spring-boot";
  if (pkg.ecosystem === "gradle-plugin" || (pkg.ecosystem === "maven" && pkg.scope === "plugin")) return "plugin";
  if (pkg.ecosystem === "maven" && PARENT_SCOPES.has(pkg.scope)) return "parent";
  return undefined;
}

/**
 * A version that names one release: it starts with a number and has nothing the build tool would substitute (`${…}`,
 * `$version`). A range (`>=18`, `^20.0.0`), an alias (`lts`, `lts/iron`, `latest`) or a property says no version to
 * compare or to move to.
 */
function comparable(version: string): boolean {
  return /^\d/.test(version) && !version.includes("$");
}

/**
 * The major Java version from the ways repos write it: `21`, `21.0.2`, `1.8` (Java 8), mise's `temurin-21.0.2+13` and
 * `corretto-17`, SDKMAN's `21.0.2-tem`. A version without a number (`lts`) stays as written, and is not comparable.
 */
function javaMajor(version: string): string {
  const bare = version
    .trim()
    .replace(/^[a-z][a-z-]*?-(?=\d)/i, "")
    .replace(/^1\.(?=\d(?:\D|$))/, "");
  return /^\d+/.exec(bare)?.[0] ?? version.trim();
}

/**
 * The newest of the versions, all starting with a number: their leading numbers compared one by one, and at the same
 * numbers a release before a pre-release (`3.3.0` over `3.3.0-RC1`), and pre-releases by their stage and number
 * (`-SNAPSHOT` before `-M2` before `-RC1` before `-RC2`).
 */
function newestVersion(versions: readonly string[]): string {
  const [first, ...rest] = versions;
  if (first === undefined) throw new Error("a version drift has at least two versions");
  return rest.reduce((newest, v) => (compareVersions(v, newest) > 0 ? v : newest), first);
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  const [p, q] = [preRelease(a), preRelease(b)];
  return p.stage - q.stage || p.number - q.number;
}

/** The numbers of the leading `1.2.3` part. */
function numbers(version: string): number[] {
  const core = /^\d+(?:\.\d+)*/.exec(version)?.[0];
  return core === undefined ? [] : core.split(".").map(Number);
}

/** Pre-release stages, earliest first, by the words versions use for them; a release is after all of them. */
const STAGES: Record<string, number> = { snapshot: 0, alpha: 1, m: 2, milestone: 2, beta: 3, rc: 4, cr: 4 };
const RELEASE_STAGE = 5;

/** A version's stage and the number after it (`RC2` is 2). */
function preRelease(version: string): { stage: number; number: number } {
  const m = /^\d+(?:\.\d+)*[-.]?(snapshot|alpha|beta|rc|milestone|m|cr)(\d*)/i.exec(version);
  const stage = m?.[1] === undefined ? undefined : STAGES[m[1].toLowerCase()];
  return stage === undefined ? { stage: RELEASE_STAGE, number: 0 } : { stage, number: Number(m?.[2] || 0) };
}
