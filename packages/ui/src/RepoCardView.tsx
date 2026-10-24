import {
  type ConsumedHttp,
  type ConsumedPackage,
  cardsApi,
  evidenceLabel,
  type Mechanism,
  type ProvidedApp,
  type ProvidedEndpoint,
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
import { HTTP_CLIENT_LABELS, MECHANISM_LABELS } from "@/lib/card";
import type { Connection } from "@/lib/connection";
import { useRemote } from "@/lib/use-remote";

/**
 * Zakładka „Karta” (§4.6, ADR-25, ADR-30): fakty z plików buildu, konfiguracji i kodu w ostatnim commicie, każdy
 * z dowodem (plik i linia), oraz tagi repo z powodami. Nowy HEAD w liście pobiera kartę od nowa.
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
  const provided = card.provides.filter((p): p is ProvidedPackage => p.kind === "package");
  const consumed = card.consumes.filter((c): c is ConsumedPackage => c.kind === "package");
  const apps = card.provides.filter((p): p is ProvidedApp => p.kind === "app");
  const endpoints = card.provides.filter((p): p is ProvidedEndpoint => p.kind === "endpoint");
  const clients = card.consumes.filter((c): c is ConsumedHttp => c.kind === "http");
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
      {apps.length > 0 && <Apps apps={apps} />}
      {(apps.length > 0 || endpoints.length > 0) && <Endpoints endpoints={endpoints} />}
      {clients.length > 0 && <HttpClients clients={clients} />}
      <Packages label="Udostępnia" packages={provided} empty="Repo nie buduje paczki, którą inne repo mogłoby wziąć." />
      <Packages label="Używa" packages={consumed} empty="Brak zależności w plikach buildu." />
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
    <Surface label="Wymagane narzędzia" meta={tools.length}>
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
              <Evidence label={evidenceLabel(p.evidence)} />
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

function Apps({ apps }: { apps: ProvidedApp[] }) {
  return (
    <Surface label="Aplikacje" meta={apps.length}>
      <ul className="divide-y">
        {apps.map((a) => (
          <Row key={`${a.module}:${a.name}`}>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{a.name}</span>
            {a.port !== null && <span className="text-muted-foreground font-mono text-xs">port {a.port}</span>}
            {a.module && <span className="text-muted-foreground max-w-40 truncate font-mono text-xs">{a.module}</span>}
            <Evidence label={evidenceLabel(a.evidence)} />
          </Row>
        ))}
      </ul>
    </Surface>
  );
}

function Endpoints({ endpoints }: { endpoints: ProvidedEndpoint[] }) {
  return (
    <Surface label="Endpointy HTTP" meta={endpoints.length}>
      {endpoints.length === 0 ? (
        <Empty>Nie znaleziono kontrolerów z @RestController ani @Controller.</Empty>
      ) : (
        <ul className="divide-y">
          {endpoints.map((e) => (
            <Row key={`${e.method} ${e.path} ${e.handler}`}>
              <Badge variant="secondary">{e.method ?? "każda"}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.path}>
                {e.path}
              </span>
              <span className="text-muted-foreground max-w-48 truncate font-mono text-xs">{e.handler}</span>
              <Evidence label={evidenceLabel(e.evidence)} />
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

/** Klient HTTP: dokąd woła (aplikacja albo adres, w których profilach) i jakie ścieżki. */
function HttpClients({ clients }: { clients: ConsumedHttp[] }) {
  return (
    <Surface label="Klienci HTTP" meta={clients.length}>
      <ul className="divide-y">
        {clients.map((c) => (
          <li key={`${c.via}:${c.name}:${c.url}:${c.profiles.join(",")}`} className="flex min-w-0 flex-col gap-1 px-3 py-2">
            <span className="flex min-w-0 items-center gap-3">
              <Badge variant="secondary">{HTTP_CLIENT_LABELS[c.via]}</Badge>
              <span className="min-w-0 truncate font-mono text-xs" title={c.name}>
                {c.name}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs" title={c.url ?? undefined}>
                {[c.app, c.url].filter((v) => v !== null).join(" · ") || "adres nieznany"}
              </span>
              {c.profiles.length > 0 && <span className="text-muted-foreground shrink-0 text-xs">profil {c.profiles.join(", ")}</span>}
              <Evidence label={evidenceLabel(c.evidence)} />
            </span>
            {c.calls.map((call) => (
              <span
                key={`${call.method} ${call.path} ${call.evidence.line}`}
                className="text-muted-foreground truncate pl-2 font-mono text-2xs"
              >
                {call.method ?? "każda"} {call.path} <span className="opacity-70">{evidenceLabel(call.evidence)}</span>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function Evidence({ label }: { label: string }) {
  return (
    <span className="text-muted-foreground w-48 shrink-0 truncate text-right font-mono text-xs" title={label}>
      {label}
    </span>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <li className="flex min-w-0 items-center gap-3 px-3 py-2">{children}</li>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-3 py-2 text-sm">{children}</p>;
}
