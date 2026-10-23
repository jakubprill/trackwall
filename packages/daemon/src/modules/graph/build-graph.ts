import type {
  ConsumedPackage,
  EdgeConfidence,
  EdgeEvidence,
  GraphConfig,
  GraphEdge,
  GraphNode,
  ManualEdge,
  ProvidedPackage,
  RepoCard,
  RepoGraph,
  RepoTag,
} from "@trackwall/protocol";

/**
 * Złączenie kart repo w graf (§4.6, ADR-29): paczka, której repo używa, i repo, które ją buduje, dają krawędź z dowodami
 * z obu stron. Do tego aliasy paczek i ręczne krawędzie z `workspace.yaml`. Funkcja czysta: te same karty i ta sama
 * konfiguracja dają ten sam graf, więc daemon liczy go przy każdym pytaniu i nie trzyma.
 */

/** Karta repo z listy, tak jak podaje ją moduł `cards` (`Cards.all`). */
export type GraphCardInput =
  | { kind: "ok"; repo: string; remote: string | null; card: RepoCard | null; tags: RepoTag[] }
  | { kind: "unavailable"; repo: string; message: string };

export interface GraphConfigInput {
  config: GraphConfig;
  /** Pełna ścieżka `workspace.yaml`: dowód aliasu i ręcznej krawędzi. */
  file: string;
}

interface Provider {
  repo: string;
  pkg: ProvidedPackage;
}

/** Wspólne dla kroków złączenia: krawędzie, rozwiązywanie wskazań repo i błędy wpisów z `workspace.yaml`. */
interface Join {
  edges: EdgeSet;
  resolve: (ref: string) => string[];
  problems: string[];
  config: GraphConfig;
  file: string;
}

export function buildGraph(cards: readonly GraphCardInput[], { config, file }: GraphConfigInput, configProblems: string[] = []): RepoGraph {
  const join: Join = { edges: new EdgeSet(), resolve: repoResolver(cards), problems: [...configProblems], config, file };
  const providers = providersByPackage(cards);
  for (const entry of cards) {
    if (entry.kind !== "ok" || entry.card === null) continue;
    for (const pkg of entry.card.consumes) {
      const found = (providers.get(packageKey(pkg)) ?? []).filter((p) => p.repo !== entry.repo);
      if (found.length > 0) addPackageEdges(join, entry.repo, pkg, found);
      else addAliasEdges(join, entry.repo, pkg);
    }
  }
  checkAliases(join);
  for (const [i, manual] of config.edges.entries()) addManualEdges(join, manual, i);
  return { nodes: cards.map(graphNode), edges: join.edges.sorted(), configProblems: join.problems, configFile: file };
}

function addPackageEdges(join: Join, from: string, pkg: ConsumedPackage, found: Provider[]): void {
  // Kilka repo z tą samą paczką to zwykle klony jednego repo albo fork: krawędź do każdego, ale niepewna.
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

/** Alias działa tylko dla paczki, której żadna karta nie pokazuje: fakt z plików buildu wygrywa z wpisem. */
function addAliasEdges(join: Join, from: string, pkg: ConsumedPackage): void {
  const alias = join.config.packages[pkg.name];
  if (alias === undefined) return;
  const evidence: EdgeEvidence = { repo: null, path: join.file, line: null, detail: `graph.packages: ${pkg.name} → ${alias}` };
  for (const to of join.resolve(alias).filter((repo) => repo !== from)) {
    join.edges.add({ from, to, kind: "package", key: pkg.name, confidence: "high", evidence: [consumerEvidence(from, pkg), evidence] });
  }
}

function checkAliases(join: Join): void {
  for (const [name, ref] of Object.entries(join.config.packages)) {
    if (join.resolve(ref).length === 0) join.problems.push(`graph.packages „${name}”: ${missingRepo(ref)}`);
  }
}

function addManualEdges(join: Join, manual: ManualEdge, i: number): void {
  const froms = join.resolve(manual.from);
  const tos = join.resolve(manual.to);
  if (froms.length === 0) join.problems.push(`graph.edges[${i}].from: ${missingRepo(manual.from)}`);
  if (tos.length === 0) join.problems.push(`graph.edges[${i}].to: ${missingRepo(manual.to)}`);
  const evidence: EdgeEvidence = { repo: null, path: join.file, line: null, detail: `graph.edges[${i}]: ${manual.from} → ${manual.to}` };
  for (const from of froms) {
    for (const to of tos.filter((repo) => repo !== from)) {
      join.edges.add({ from, to, kind: "manual", key: manual.note, confidence: "exact", evidence: [evidence] });
    }
  }
}

function graphNode(entry: GraphCardInput): GraphNode {
  if (entry.kind === "unavailable") return { repo: entry.repo, remote: null, tags: [], provides: null, problem: entry.message };
  return {
    repo: entry.repo,
    remote: entry.remote,
    tags: entry.tags.map((t) => t.name),
    provides: entry.card?.provides.length ?? 0,
    problem: null,
  };
}

/** Paczki łączą się w obrębie jednej przestrzeni nazw (`PackageEcosystem`): Maven `a:b` i npm `a:b` to różne paczki. */
function packageKey(pkg: { ecosystem: string; name: string }): string {
  return `${pkg.ecosystem} ${pkg.name}`;
}

function providersByPackage(cards: readonly GraphCardInput[]): Map<string, Provider[]> {
  const providers = new Map<string, Provider[]>();
  for (const entry of cards) {
    if (entry.kind !== "ok" || entry.card === null) continue;
    for (const pkg of entry.card.provides) {
      const key = packageKey(pkg);
      providers.set(key, [...(providers.get(key) ?? []), { repo: entry.repo, pkg }]);
    }
  }
  return providers;
}

/**
 * Wskazanie repo z `workspace.yaml` (`RepoRef`): identyfikator, a gdy takiego nie ma, adres repo zdalnego bez
 * wielkości liter (hosting tak go porównuje). Jeden adres może mieć kilka repo z listy (klon i worktree).
 */
function repoResolver(cards: readonly GraphCardInput[]): (ref: string) => string[] {
  const ids = new Set(cards.map((c) => c.repo));
  return (ref) => {
    if (ids.has(ref)) return [ref];
    const wanted = ref.toLowerCase();
    return cards.filter((c) => c.kind === "ok" && c.remote?.toLowerCase() === wanted).map((c) => c.repo);
  };
}

function missingRepo(ref: string): string {
  return `nie ma repo „${ref}” na liście repo (podaj identyfikator albo adres host/ścieżka)`;
}

function consumerEvidence(repo: string, pkg: ConsumedPackage): EdgeEvidence {
  const version = pkg.version === null ? "" : ` ${pkg.version}`;
  return { repo, ...pkg.evidence, detail: `używa ${pkg.name}${version} (${pkg.scope})` };
}

function providerEvidence({ repo, pkg }: Provider): EdgeEvidence {
  return { repo, ...pkg.evidence, detail: `buduje ${pkg.name}` };
}

/** Krawędzie bez powtórzeń: ta sama para repo, rodzaj i klucz to jedna krawędź (pierwsza wygrywa). */
class EdgeSet {
  private readonly edges = new Map<string, GraphEdge>();

  add(edge: GraphEdge): void {
    const id = [edge.from, edge.to, edge.kind, edge.key].join("\u0000");
    if (!this.edges.has(id)) this.edges.set(id, edge);
  }

  sorted(): GraphEdge[] {
    return [...this.edges.values()].sort(
      (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind) || compare(a.key, b.key),
    );
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
