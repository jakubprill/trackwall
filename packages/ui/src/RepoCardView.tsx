import {
  type ConsumedPackage,
  cardsApi,
  type Mechanism,
  type ProvidedPackage,
  type RepoCard,
  type RepoCardResult,
  type ToolRequirement,
} from "@trackwall/protocol";
import { type ReactNode, useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { post } from "@/lib/api";
import { evidenceLabel, MECHANISM_LABELS } from "@/lib/card";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * Zakładka „Karta” (§4.6, ADR-25): fakty z plików buildu i konfiguracji w ostatnim commicie, każdy z dowodem
 * (plik i linia), oraz tagi repo z powodami. Nowy HEAD w liście pobiera kartę od nowa.
 */
export function RepoCardView({ conn, repo, head }: { conn: Connection; repo: string; head: string }) {
  const load = useCallback(() => post(conn, cardsApi.card, { repo }), [conn, repo]);
  const remote = useRemote(load, { refreshKey: head });
  if (remote.error) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (!remote.data) return <Loading />;
  return <CardPanel result={remote.data} />;
}

function CardPanel({ result }: { result: RepoCardResult }) {
  const { card, tags } = result;
  return (
    <div className="flex flex-col gap-4">
      <Surface label="Tagi" meta={tags.length}>
        {tags.length === 0 ? (
          <Empty>Brak tagów. Tagi własne dodasz kluczem repoTags w workspace.yaml.</Empty>
        ) : (
          <ul className="divide-y">
            {tags.map((tag) => (
              <Row key={tag.name}>
                <Badge>#{tag.name}</Badge>
                <span className="text-muted-foreground min-w-0 text-xs break-words">{tag.reason}</span>
              </Row>
            ))}
          </ul>
        )}
      </Surface>
      {card === null ? <Empty>To repo nie ma jeszcze commitów, więc karta jest pusta.</Empty> : <CardFacts card={card} />}
    </div>
  );
}

function CardFacts({ card }: { card: RepoCard }) {
  return (
    <>
      {card.problems.length > 0 && (
        <Surface label="Nie udało się przeczytać" meta={card.problems.length}>
          <ul className="divide-y">
            {card.problems.map((p) => (
              <Row key={`${p.path}:${p.message}`}>
                <span className="text-warning font-mono text-xs">{p.path || "repo"}</span>
                <span className="text-muted-foreground min-w-0 text-xs break-words">{p.message}</span>
              </Row>
            ))}
          </ul>
        </Surface>
      )}
      <Mechanisms mechanisms={card.mechanisms} />
      <Tools tools={card.tools} />
      <Packages label="Udostępnia" packages={card.provides} empty="Repo nie buduje paczki, którą inne repo mogłoby wziąć." />
      <Packages label="Używa" packages={card.consumes} empty="Brak zależności w plikach buildu." />
      <Surface label="Pliki buildu" meta={card.buildFiles.length}>
        {card.buildFiles.length === 0 ? (
          <Empty>Nie znaleziono pom.xml, build.gradle ani package.json.</Empty>
        ) : (
          <ul className="divide-y">
            {card.buildFiles.map((f) => (
              <Row key={f.path}>
                <span className="min-w-0 truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <Badge variant="secondary">{f.tool}</Badge>
                {f.name && <span className="text-muted-foreground truncate text-xs">{f.name}</span>}
              </Row>
            ))}
          </ul>
        )}
      </Surface>
      <p className="text-muted-foreground font-mono text-xs">commit {card.commit.slice(0, 12)}</p>
    </>
  );
}

function Mechanisms({ mechanisms }: { mechanisms: Mechanism[] }) {
  return (
    <Surface label="Mechanizmy" meta={mechanisms.length}>
      {mechanisms.length === 0 ? (
        <Empty>Nie rozpoznano frameworka, komunikacji ani wdrożenia.</Empty>
      ) : (
        <ul className="divide-y">
          {mechanisms.map((m) => (
            <Row key={m.id}>
              <span className="w-48 shrink-0 text-sm">{MECHANISM_LABELS[m.id]}</span>
              <span className="text-muted-foreground flex min-w-0 flex-col font-mono text-xs">
                {m.evidence.map((e) => (
                  <span key={`${evidenceLabel(e)} ${e.detail}`} className="truncate" title={`${evidenceLabel(e)} ${e.detail}`}>
                    {evidenceLabel(e)} <span className="text-foreground">{e.detail}</span>
                  </span>
                ))}
              </span>
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

function Tools({ tools }: { tools: ToolRequirement[] }) {
  return (
    <Surface label="Narzędzia" meta={tools.length}>
      {tools.length === 0 ? (
        <Empty>Repo nie podaje wersji narzędzi (mise, .tool-versions, .nvmrc, wrapper Maven lub Gradle).</Empty>
      ) : (
        <ul className="divide-y">
          {tools.map((t) => (
            <Row key={`${t.tool}@${t.version}@${evidenceLabel(t.evidence)}`}>
              <span className="w-32 shrink-0 truncate font-mono text-sm">{t.tool}</span>
              <span className="w-28 shrink-0 truncate font-mono text-sm">{t.version}</span>
              <Badge
                variant={t.source === "mise" ? "default" : "secondary"}
                title={t.source === "mise" ? "mise czyta tę wersję" : "podpowiedź z innego pliku"}
              >
                {t.source}
              </Badge>
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{evidenceLabel(t.evidence)}</span>
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

function Packages({ label, packages, empty }: { label: string; packages: (ProvidedPackage | ConsumedPackage)[]; empty: string }) {
  return (
    <Surface label={label} meta={packages.length}>
      {packages.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y">
          {packages.map((p) => (
            <Row key={`${p.ecosystem}:${p.name}`}>
              <Badge variant="secondary">{p.ecosystem}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={p.name}>
                {p.name}
              </span>
              {p.version && <span className="text-muted-foreground max-w-40 truncate font-mono text-xs">{p.version}</span>}
              {"scope" in p && <span className="text-muted-foreground w-28 shrink-0 truncate text-xs">{p.scope}</span>}
              <span className="text-muted-foreground w-48 shrink-0 truncate text-right font-mono text-xs" title={evidenceLabel(p.evidence)}>
                {evidenceLabel(p.evidence)}
              </span>
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <li className="flex min-w-0 items-center gap-3 px-3 py-2">{children}</li>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-3 py-2 text-sm">{children}</p>;
}
