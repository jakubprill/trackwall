import {
  type EdgeConfidence,
  type EdgeEvidence,
  type EdgeKind,
  evidenceLabel,
  type GraphEdge,
  type GraphNode,
  type RepoGraph,
} from "@trackwall/protocol";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pluralNoun } from "@/lib/format";
import type { EdgePair } from "@/lib/graph-layout";

/** Pewność krawędzi dla człowieka (ADR-29, ADR-30; reguły przy `EdgeConfidence`); `Record` wymusza wpis dla każdej. */
const CONFIDENCE_LABELS: Record<EdgeConfidence, string> = {
  exact: "certain",
  high: "almost certain",
  medium: "likely",
  low: "possible",
};

const EDGE_KIND_LABELS: Record<EdgeKind, string> = {
  package: "package",
  http: "HTTP",
  manual: "manual",
};

/**
 * Panel szczegółów wybranego repo w widoku „Przegląd”: kogo repo używa i kto używa jego, każda krawędź z kluczem
 * (paczka, aplikacja albo adres HTTP, opis ręcznej krawędzi) i dowodami. Repo po drugiej stronie krawędzi wybiera się kliknięciem.
 */
export function GraphNodePanel({
  node,
  pairs,
  onSelect,
  onClose,
}: {
  node: GraphNode;
  /** Krawędzie zgrupowane po parze repo, te same co na rysunku (`GraphLayout.pairs`). */
  pairs: readonly EdgePair[];
  onSelect: (repo: string) => void;
  onClose: () => void;
}) {
  const uses = pairs.filter((p) => p.from === node.repo);
  const usedBy = pairs.filter((p) => p.to === node.repo);
  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="hud-label">Repo</p>
          <h3 className="truncate font-mono text-lg">{node.repo}</h3>
          {node.remote && <p className="text-muted-foreground truncate font-mono text-xs">{node.remote}</p>}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close repo details">
          <X />
        </Button>
      </header>
      {node.problem !== null && <p className="text-warning text-sm break-words">Cannot build the card: {node.problem}</p>}
      {node.apps.length > 0 && (
        <p className="text-muted-foreground truncate font-mono text-xs">
          {pluralNoun(node.apps.length, { one: "app", other: "apps" })} {node.apps.join(", ")}
        </p>
      )}
      {node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.tags.map((t) => (
            <Badge key={t}>#{t}</Badge>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-2">
        <Stat label="Uses" value={uses.length} />
        <Stat label="Used by" value={usedBy.length} />
        <Stat label="Packages" value={node.provides ?? "–"} />
        <Stat label="Endpoints" value={node.endpoints ?? "–"} />
      </dl>
      <Section label="Uses" empty="The repo has no connections to other repos in the list.">
        {uses.map((pair) => (
          <PairItem key={pair.to} repo={pair.to} edges={pair.edges} onSelect={onSelect} />
        ))}
      </Section>
      <Section label="Used by" empty="No repo in the list connects to this repo.">
        {usedBy.map((pair) => (
          <PairItem key={pair.from} repo={pair.from} edges={pair.edges} onSelect={onSelect} />
        ))}
      </Section>
    </div>
  );
}

/** Panel bez wybranego repo: liczby, wpisy `graph` z błędami i gdzie dopisać ręczne połączenia. */
export function GraphSummaryPanel({ graph, pairs }: { graph: RepoGraph; pairs: readonly EdgePair[] }) {
  const withProblems = graph.nodes.filter((n) => n.problem !== null).length;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="hud-label">Connection graph</p>
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Repos" value={graph.nodes.length} />
        <Stat label="Connections" value={pairs.length} />
        <Stat label="No card" value={withProblems} />
      </dl>
      <p className="text-muted-foreground text-sm">
        A line goes from a repo to each repo whose package it depends on or whose app it calls over HTTP. Select a repo to see its
        connections, their confidence and the evidence (file and line).
      </p>
      {graph.configProblems.length > 0 && (
        <Section label="Errors in graph entries" empty="">
          {graph.configProblems.map((problem) => (
            <li key={problem} className="text-warning px-3 py-2 text-xs break-words">
              {problem}
            </li>
          ))}
        </Section>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          Add connections the cards cannot see, packages built outside build files and app addresses (graph.apps) under the graph key in
          this file:
        </p>
        <p className="font-mono text-xs break-all">{graph.configFile}</p>
      </div>
    </div>
  );
}

function PairItem({ repo, edges, onSelect }: { repo: string; edges: GraphEdge[]; onSelect: (repo: string) => void }) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <button type="button" onClick={() => onSelect(repo)} className="text-primary self-start font-mono text-sm hover:underline">
        {repo}
      </button>
      <ul className="flex flex-col gap-1.5">
        {edges.map((edge) => (
          <li key={`${edge.kind}:${edge.key}`} className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <Badge variant={edge.kind === "manual" ? "outline" : "secondary"}>{EDGE_KIND_LABELS[edge.kind]}</Badge>
              <span className="min-w-0 truncate font-mono text-xs" title={edge.key}>
                {edge.key}
              </span>
              <span className="text-muted-foreground ml-auto shrink-0 text-2xs">{CONFIDENCE_LABELS[edge.confidence]}</span>
            </span>
            {edge.evidence.map((e) => (
              <span
                key={`${e.repo}:${e.path}:${e.line}:${e.detail}`}
                className="text-muted-foreground truncate font-mono text-2xs"
                title={evidenceText(e)}
              >
                {evidenceText(e)}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Dowód jako `repo: ścieżka:linia szczegół`. Wpis z `workspace.yaml` ma pełną ścieżkę pliku, którą panel podsumowania
 * pokazuje w całości, więc tu wystarcza nazwa pliku.
 */
function evidenceText(e: EdgeEvidence): string {
  return e.repo === null ? `${fileName(e.path)} ${e.detail}` : `${e.repo}: ${evidenceLabel(e)} ${e.detail}`;
}

/** Ostatni człon pełnej ścieżki z Windowsa albo macOS (UI nie ma `node:path`). */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Lista w powierzchni z liczbą pozycji w nagłówku i zdaniem, gdy jest pusta. */
function Section({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return (
    <Surface label={label} meta={children.length}>
      {children.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-sm">{empty}</p>
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
    </Surface>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="surface flex flex-col px-3 py-2">
      <dt className="hud-label">{label}</dt>
      <dd className="font-mono text-xl">{value}</dd>
    </div>
  );
}
