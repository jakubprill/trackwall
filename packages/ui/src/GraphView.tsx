import { graphApi } from "@trackwall/protocol";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { twoDigits } from "@/lib/format";
import { layoutGraph } from "@/lib/graph-layout";
import { useRemote } from "@/lib/use-remote";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { GraphNodePanel, GraphSummaryPanel } from "./GraphNodePanel.tsx";

/**
 * Widok „Przegląd” (§4.6, ADR-29): graf połączeń między repo na całą szerokość i panel szczegółów wybranego repo po
 * prawej. Graf liczy daemon z kart repo, więc nowy commit w repo zmienia go przy następnym odpytaniu.
 */
const POLL_MS = 30_000;

export function GraphView({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, graphApi.graph, {}), [conn]);
  const graph = useRemote(load, { pollMs: POLL_MS });
  const [selected, setSelected] = useState<string>();
  const data = graph.data;
  const layout = useMemo(
    () =>
      data &&
      layoutGraph(
        data.nodes.map((n) => n.repo),
        data.edges,
      ),
    [data],
  );
  // Repo, którego nie ma w odświeżonym grafie (np. usunięty katalog), nie ma panelu; wybór wraca, gdy repo wróci.
  const node = data?.nodes.find((n) => n.repo === selected);
  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_24rem]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="hud-label">Przegląd {data && <span className="text-primary">{`// ${twoDigits(data.nodes.length)}`}</span>}</h2>
          <Button variant="ghost" size="icon" onClick={graph.reload} aria-label="Odśwież graf">
            <RefreshCw />
          </Button>
        </header>
        {graph.error && (
          <div className="px-4 pb-3">
            <ErrorWithRetry message={graph.error} onRetry={graph.reload} />
          </div>
        )}
        {!data && !graph.error && (
          <div className="px-4">
            <Loading text="Liczenie grafu z kart repo…" />
          </div>
        )}
        {data && layout && <GraphCanvas graph={data} layout={layout} selected={node?.repo} onSelect={setSelected} />}
      </section>
      <aside className="bg-card min-h-0 overflow-y-auto border-l">
        {data && node && <GraphNodePanel node={node} graph={data} onSelect={setSelected} onClose={() => setSelected(undefined)} />}
        {data && !node && <GraphSummaryPanel graph={data} />}
      </aside>
    </div>
  );
}
