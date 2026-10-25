import {
  type ConsumedHttp,
  type ConsumedPackage,
  cardsApi,
  type Dto,
  evidenceLabel,
  type Mechanism,
  type ProvidedApp,
  type ProvidedEndpoint,
  type ProvidedPackage,
  pluralNoun,
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
 * The "Card" tab (§4.6, ADR-25, ADR-30): facts from the build, configuration and code files in the last commit, each
 * with evidence (file and line), and the repo's tags with reasons. A new HEAD in the list fetches the card anew.
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
      <Surface label="Tags" meta={tags.length}>
        {tags.length === 0 ? (
          <Empty>No tags. Add your own tags with the repoTags key in workspace.yaml.</Empty>
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
      {card === null ? <Empty>This repo has no commits yet, so the card is empty.</Empty> : <CardFacts card={card} />}
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
        <Surface label="Could not read" meta={card.problems.length}>
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
      {card.dtos.length > 0 && <Dtos dtos={card.dtos} />}
      {clients.length > 0 && <HttpClients clients={clients} />}
      <Packages label="Provides" packages={provided} empty="The repo does not build a package that another repo could use." />
      <Packages label="Uses" packages={consumed} empty="No dependencies in the build files." />
      <Surface label="Build files" meta={card.buildFiles.length}>
        {card.buildFiles.length === 0 ? (
          <Empty>No pom.xml, build.gradle or package.json found.</Empty>
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
    <Surface label="Mechanisms" meta={mechanisms.length}>
      {mechanisms.length === 0 ? (
        <Empty>No framework, messaging or deployment recognized.</Empty>
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
    <Surface label="Required tools" meta={tools.length}>
      {tools.length === 0 ? (
        <Empty>The repo does not pin tool versions (mise, .tool-versions, .nvmrc, Maven or Gradle wrapper).</Empty>
      ) : (
        <ul className="divide-y">
          {tools.map((t) => (
            <Row key={`${t.tool}@${t.version}@${evidenceLabel(t.evidence)}`}>
              <span className="w-32 shrink-0 truncate font-mono text-sm">{t.tool}</span>
              <span className="w-28 shrink-0 truncate font-mono text-sm">{t.version}</span>
              <Badge
                variant={t.source === "mise" ? "default" : "secondary"}
                title={t.source === "mise" ? "mise reads this version" : "hint from another file"}
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
    <Surface label="Apps" meta={apps.length}>
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
    <Surface label="HTTP endpoints" meta={endpoints.length}>
      {endpoints.length === 0 ? (
        <Empty>No @RestController or @Controller controllers found.</Empty>
      ) : (
        <ul className="divide-y">
          {endpoints.map((e) => (
            <Row key={`${e.method} ${e.path} ${evidenceLabel(e.evidence)}`}>
              <Badge variant="secondary">{e.method ?? "any"}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.path}>
                {e.path}
              </span>
              {(e.request !== null || e.response !== null) && <Contract endpoint={e} />}
              <span className="text-muted-foreground max-w-48 truncate font-mono text-xs">{e.handler}</span>
              <Evidence label={evidenceLabel(e.evidence)} />
            </Row>
          ))}
        </ul>
      )}
    </Surface>
  );
}

/** The request and response body types of an endpoint (ADR-38): `CreateOrder → OrderDto`, a missing side is `–`. */
function Contract({ endpoint }: { endpoint: ProvidedEndpoint }) {
  const label = `${endpoint.request ?? "–"} → ${endpoint.response ?? "–"}`;
  return (
    <span className="text-muted-foreground max-w-64 truncate font-mono text-xs" title={label}>
      {label}
    </span>
  );
}

/** DTOs from the endpoint contracts (ADR-38): kind, name, fields with types, or enum constants. */
function Dtos({ dtos }: { dtos: Dto[] }) {
  return (
    <Surface label="DTOs" meta={dtos.length}>
      <ul className="divide-y">
        {dtos.map((d) => (
          <li key={`${d.name} ${evidenceLabel(d.evidence)}`} className="flex min-w-0 flex-col gap-1 px-3 py-2">
            <span className="flex min-w-0 items-center gap-3">
              <Badge variant="secondary">{d.kind}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.name}</span>
              <Evidence label={evidenceLabel(d.evidence)} />
            </span>
            <span className="text-muted-foreground min-w-0 font-mono text-xs break-words">
              {d.kind === "enum" ? d.values.join(", ") : d.fields.map((f) => `${f.name}: ${f.type}`).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

/** An HTTP client: where it calls (an application or address, in which profiles) and which paths. */
function HttpClients({ clients }: { clients: ConsumedHttp[] }) {
  return (
    <Surface label="HTTP clients" meta={clients.length}>
      <ul className="divide-y">
        {clients.map((c, i) => (
          // Two proxy entries to the same address have the same fields: the position in the list tells them apart without changing the order.
          <li key={`${i}:${c.via}:${c.name}:${c.url}`} className="flex min-w-0 flex-col gap-1 px-3 py-2">
            <span className="flex min-w-0 items-center gap-3">
              <Badge variant="secondary">{HTTP_CLIENT_LABELS[c.via]}</Badge>
              <span className="min-w-0 truncate font-mono text-xs" title={c.name}>
                {c.name}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs" title={c.url ?? undefined}>
                {[c.app, c.url].filter((v) => v !== null).join(" · ") || "address unknown"}
              </span>
              {c.profiles.length > 0 && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {pluralNoun(c.profiles.length, { one: "profile", other: "profiles" })} {c.profiles.join(", ")}
                </span>
              )}
              <Evidence label={evidenceLabel(c.evidence)} />
            </span>
            {c.calls.map((call) => (
              <span
                key={`${call.method} ${call.path} ${call.evidence.line}`}
                className="text-muted-foreground truncate pl-2 font-mono text-2xs"
              >
                {call.method ?? "any"} {call.path} <span className="opacity-70">{evidenceLabel(call.evidence)}</span>
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
