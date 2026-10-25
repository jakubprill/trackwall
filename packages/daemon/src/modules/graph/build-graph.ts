import type { ConsumedPackage, EdgeConfidence, EdgeEvidence, GraphNode, ManualEdge, ProvidedPackage, RepoGraph } from "@trackwall/protocol";
import type { GraphCardInput, GraphConfigInput } from "./graph-input.ts";
import { EdgeSet, type Join, missingRepo, repoResolver } from "./graph-join.ts";
import { addHttpEdges } from "./http-edges.ts";
import { HttpIndex } from "./http-index.ts";

/**
 * Joining repo cards into the graph (§4.6, ADR-29, ADR-30): a package a repo uses and the repo that builds it, and an HTTP
 * client and the repo with the app or endpoints it calls, give an edge with evidence from both sides. On top of that, package
 * and app aliases and manual edges from `workspace.yaml`. A pure function: the same cards and the same configuration give the
 * same graph.
 */

interface Provider {
  repo: string;
  pkg: ProvidedPackage;
}

export function buildGraph(cards: readonly GraphCardInput[], input: GraphConfigInput): RepoGraph {
  return buildGraphWithIndex(cards, input).graph;
}

/** The graph and the HTTP index its `http` edges came from; `find_endpoint` asks the same index. */
export function buildGraphWithIndex(cards: readonly GraphCardInput[], input: GraphConfigInput): { graph: RepoGraph; http: HttpIndex } {
  const join = joinOf(cards, input);
  const http = new HttpIndex(cards, join);
  addPackageEdgesOf(join, cards);
  addHttpEdges(join, http);
  checkAliases(join);
  for (const [i, manual] of input.config.edges.entries()) addManualEdges(join, manual, i);
  const graph = { nodes: cards.map(graphNode), edges: join.edges.sorted(), configProblems: join.problems, configFile: input.file };
  return { graph, http };
}

/** The shared join steps from the `graph` entries; app aliases case-insensitive, like host names. */
function joinOf(cards: readonly GraphCardInput[], { config, file, problems }: GraphConfigInput): Join {
  const appAliases = new Map(Object.entries(config.apps).map(([name, ref]) => [name.toLowerCase(), ref]));
  const aliases = new Map(Object.entries(config.packages));
  return { edges: new EdgeSet(), resolve: repoResolver(cards), problems: [...problems], aliases, appAliases, file };
}

function addPackageEdgesOf(join: Join, cards: readonly GraphCardInput[]): void {
  const providers = providersByPackage(cards);
  for (const entry of cards) {
    if (entry.kind !== "ok" || entry.card === null) continue;
    for (const pkg of entry.card.consumes) if (pkg.kind === "package") addPackageUse(join, providers, entry.repo, pkg);
  }
}

function addPackageUse(join: Join, providers: Map<string, Provider[]>, from: string, pkg: ConsumedPackage): void {
  const all = providers.get(packageKey(pkg)) ?? [];
  // An alias only for a package that no repo on the list builds, including the one that uses it (modules of one build).
  if (all.length === 0) addAliasEdges(join, from, pkg);
  const found = all.filter((p) => p.repo !== from);
  if (found.length > 0) addPackageEdges(join, from, pkg, found);
}

function addPackageEdges(join: Join, from: string, pkg: ConsumedPackage, found: Provider[]): void {
  // Several repos with the same package are usually clones of one repo or a fork: an edge to each, but uncertain. A repo
  // is in `found` once (`providersByPackage`), even when it builds the package with two build files.
  const confidence: EdgeConfidence = found.length === 1 ? "exact" : "medium";
  for (const p of found) {
    join.edges.add({
      from,
      to: p.repo,
      kind: "package",
      key: pkg.name,
      confidence,
      evidence: [consumerEvidence(from, pkg), providerEvidence(p)],
    });
  }
}

/** An alias works only for a package no card shows: a fact from the build files beats an entry. */
function addAliasEdges(join: Join, from: string, pkg: ConsumedPackage): void {
  const alias = join.aliases.get(pkg.name);
  if (alias === undefined) return;
  const evidence: EdgeEvidence = { repo: null, path: join.file, line: null, detail: `graph.packages: ${pkg.name} → ${alias}` };
  for (const to of join.resolve(alias).filter((repo) => repo !== from)) {
    join.edges.add({ from, to, kind: "package", key: pkg.name, confidence: "high", evidence: [consumerEvidence(from, pkg), evidence] });
  }
}

function checkAliases(join: Join): void {
  for (const [name, ref] of join.aliases) {
    if (join.resolve(ref).length === 0) join.problems.push(`graph.packages “${name}”: ${missingRepo(ref)}`);
  }
  for (const [name, ref] of join.appAliases) {
    if (join.resolve(ref).length === 0) join.problems.push(`graph.apps “${name}”: ${missingRepo(ref)}`);
  }
}

function addManualEdges(join: Join, manual: ManualEdge, i: number): void {
  const froms = join.resolve(manual.from);
  const tos = join.resolve(manual.to);
  if (froms.length === 0) join.problems.push(`graph.edges[${i}].from: ${missingRepo(manual.from)}`);
  if (tos.length === 0) join.problems.push(`graph.edges[${i}].to: ${missingRepo(manual.to)}`);
  const evidence: EdgeEvidence = { repo: null, path: join.file, line: null, detail: `graph.edges[${i}]: ${manual.from} → ${manual.to}` };
  const pairs = froms.flatMap((from) => tos.filter((to) => to !== from).map((to) => ({ from, to })));
  if (froms.length > 0 && tos.length > 0 && pairs.length === 0) {
    join.problems.push(`graph.edges[${i}]: from and to point to the same repo (${froms.join(", ")})`);
  }
  for (const { from, to } of pairs) {
    join.edges.add({ from, to, kind: "manual", key: manual.note, confidence: "exact", evidence: [evidence] });
  }
}

function graphNode(entry: GraphCardInput): GraphNode {
  if (entry.kind === "unavailable")
    return { repo: entry.repo, remote: null, tags: [], provides: null, apps: [], endpoints: null, problem: entry.message };
  const provides = entry.card?.provides ?? [];
  return {
    repo: entry.repo,
    remote: entry.remote,
    tags: entry.tags.map((t) => t.name),
    provides: new Set(provides.flatMap((p) => (p.kind === "package" ? [packageKey(p)] : []))).size,
    apps: [...new Set(provides.flatMap((p) => (p.kind === "app" ? [p.name] : [])))],
    endpoints: provides.filter((p) => p.kind === "endpoint").length,
    problem: null,
  };
}

/** Packages join within one namespace (`PackageEcosystem`): Maven `a:b` and npm `a:b` are different packages. */
function packageKey(pkg: { ecosystem: string; name: string }): string {
  return `${pkg.ecosystem} ${pkg.name}`;
}

function providersByPackage(cards: readonly GraphCardInput[]): Map<string, Provider[]> {
  const providers = new Map<string, Provider[]>();
  for (const entry of cards) {
    if (entry.kind !== "ok" || entry.card === null) continue;
    for (const pkg of entry.card.provides) {
      if (pkg.kind !== "package") continue;
      const key = packageKey(pkg);
      const list = providers.get(key) ?? [];
      // The same package from two build files of one repo (e.g. while moving from Maven to Gradle) is one repo.
      if (!list.some((p) => p.repo === entry.repo)) providers.set(key, [...list, { repo: entry.repo, pkg }]);
    }
  }
  return providers;
}

function consumerEvidence(repo: string, pkg: ConsumedPackage): EdgeEvidence {
  const version = pkg.version === null ? "" : ` ${pkg.version}`;
  return { repo, ...pkg.evidence, detail: `uses ${pkg.name}${version} (${pkg.scope})` };
}

function providerEvidence({ repo, pkg }: Provider): EdgeEvidence {
  return { repo, ...pkg.evidence, detail: `builds ${pkg.name}` };
}
