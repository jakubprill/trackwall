import type { EdgeConfidence, EdgeEvidence, GraphEdge } from "@trackwall/protocol";
import type { GraphCardInput } from "./graph-input.ts";

/**
 * Wspólne dla kroków złączenia kart w graf (§4.6, ADR-29, ADR-30): zbiór krawędzi bez powtórzeń, rozwiązywanie
 * wskazań repo z `workspace.yaml` i błędy wpisów.
 */

/** Wspólne dla kroków złączenia: krawędzie, rozwiązywanie wskazań repo i błędy wpisów z `workspace.yaml`. */
export interface Join {
  edges: EdgeSet;
  resolve: (ref: string) => string[];
  problems: string[];
  /**
   * Aliasy paczek i aplikacji jako `Map`: nazwa pochodzi z repo, a obiekt z YAML-a dla nazwy `constructor` czy
   * `toString` oddałby funkcję z prototypu.
   */
  aliases: Map<string, string>;
  /** Aliasy aplikacji z kluczem małymi literami (nazwa aplikacji albo host). */
  appAliases: Map<string, string>;
  file: string;
}

/** Ile dowodów zostaje przy krawędzi złożonej z kilku faktów (klient w kilku profilach, wiele wywołań). */
const MAX_EVIDENCE = 20;
const CONFIDENCE_ORDER: EdgeConfidence[] = ["low", "medium", "high", "exact"];

/**
 * Krawędzie bez powtórzeń: ta sama para repo, rodzaj i klucz to jedna krawędź. Druga taka sama dokłada dowody, a
 * pewność zostaje wyższa z obu (klient Feign z adresem w dwóch profilach to jedno połączenie).
 */
export class EdgeSet {
  private readonly edges = new Map<string, GraphEdge>();

  add(edge: GraphEdge): void {
    const id = [edge.from, edge.to, edge.kind, edge.key].join("\u0000");
    const existing = this.edges.get(id);
    if (!existing) {
      this.edges.set(id, { ...edge, evidence: uniqueEvidence(edge.evidence) });
      return;
    }
    const confidence =
      CONFIDENCE_ORDER.indexOf(edge.confidence) > CONFIDENCE_ORDER.indexOf(existing.confidence) ? edge.confidence : existing.confidence;
    this.edges.set(id, { ...existing, confidence, evidence: uniqueEvidence([...existing.evidence, ...edge.evidence]) });
  }

  sorted(): GraphEdge[] {
    return [...this.edges.values()].sort(
      (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.kind, b.kind) || compare(a.key, b.key),
    );
  }
}

function uniqueEvidence(evidence: readonly EdgeEvidence[]): EdgeEvidence[] {
  const seen = new Set<string>();
  return evidence
    .filter((e) => {
      const id = [e.repo, e.path, e.line, e.detail].join("\u0000");
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_EVIDENCE);
}

/** Bez `localeCompare`: porządek nie może zależeć od danych ICU w Bun i Node (jak `byName` w `workspace`). */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wskazanie repo z `workspace.yaml` (`RepoRef`): identyfikator, a gdy takiego nie ma, adres repo zdalnego bez
 * wielkości liter (hosting tak go porównuje). Jeden adres może mieć kilka repo z listy (klon i worktree).
 */
export function repoResolver(cards: readonly GraphCardInput[]): (ref: string) => string[] {
  const ids = new Set(cards.map((c) => c.repo));
  return (ref) => {
    if (ids.has(ref)) return [ref];
    const wanted = ref.toLowerCase();
    return cards.filter((c) => c.kind === "ok" && c.remote?.toLowerCase() === wanted).map((c) => c.repo);
  };
}

export function missingRepo(ref: string): string {
  return `nie ma repo „${ref}” na liście repo (podaj identyfikator albo adres host/ścieżka)`;
}
