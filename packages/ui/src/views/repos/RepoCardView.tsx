import {
  type BuildFile,
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
  type RepoReadiness,
  type RepoTag,
  readinessApi,
  type ToolRequirement,
} from "@trackwall/protocol";
import { type ReactNode, useCallback, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { FoldedSection } from "@/components/FoldedSection";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/badge";
import { post } from "@/lib/api";
import { CARD_PROBLEM_LABELS, HTTP_CLIENT_LABELS, MECHANISM_LABELS } from "@/lib/card";
import { CARD_SECTIONS, type CardFacts, type CardSectionId, cardFacts, cardSections } from "@/lib/card-sections";
import type { Connection } from "@/lib/connection";
import type { SessionSelection } from "@/lib/session-entries";
import { useRemote } from "@/lib/use-remote";
import { RepoCardGlance } from "./RepoCardGlance.tsx";
import { ReadinessFact, RepoReadinessSection } from "./RepoReadiness.tsx";

/**
 * The "Card" tab (§4.6, ADR-25, ADR-30), with "At a glance" on top (ADR-103): facts from the build, configuration and
 * code files in the last commit, each with evidence (file and line), and the repo's tags with reasons, and its agent readiness
 * (ADR-208). Under "At a glance" each kind of fact is a section folded until asked for, and the kinds the repo has none
 * of share one folded line (ADR-267). A new HEAD in the list fetches the card and the readiness anew.
 */
export function RepoCardView({
  conn,
  repo,
  head,
  onOpenMiseTasks,
  onOpenInSessions,
}: {
  conn: Connection;
  repo: string;
  head: string;
  onOpenMiseTasks: () => void;
  onOpenInSessions: (selection: SessionSelection) => void;
}) {
  const load = useCallback(() => post(conn, cardsApi.card, { repo }), [conn, repo]);
  const remote = useRemote(load, { refreshKey: head });
  const loadReadiness = useCallback(() => post(conn, readinessApi.repo, { repo }), [conn, repo]);
  const readiness = useRemote(loadReadiness, { refreshKey: head });
  if (remote.error) return <ErrorWithRetry message={remote.error} onRetry={remote.reload} />;
  if (!remote.data) return <Loading />;
  return (
    <CardPanel key={repo} result={remote.data} readiness={readiness.data}>
      {readiness.error && <ErrorWithRetry message={readiness.error} onRetry={readiness.reload} />}
      {readiness.data && (
        <RepoReadinessSection
          conn={conn}
          readiness={readiness.data}
          onOpenMiseTasks={onOpenMiseTasks}
          onOpenInSessions={onOpenInSessions}
          onFixed={readiness.reload}
        />
      )}
    </CardPanel>
  );
}

function CardPanel({ result, readiness, children }: { result: RepoCardResult; readiness: RepoReadiness | undefined; children: ReactNode }) {
  const { card, tags } = result;
  const facts = cardFacts(card, tags);
  const { found, missing } = cardSections(facts, card !== null);
  // Which sections the user opened; every one starts folded (ADR-267), also on the next repo (the panel is keyed by it).
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const fold = (id: string) => ({
    open: opened.has(id),
    onOpen: (open: boolean) => {
      const next = new Set(opened);
      if (open) next.add(id);
      else next.delete(id);
      setOpened(next);
    },
  });
  return (
    <div className="flex flex-col gap-4">
      {card && <RepoCardGlance card={card} tags={tags} readiness={<ReadinessFact readiness={readiness} />} />}
      {children}
      {card === null && <Empty>This repo has no commits yet, so the card is empty.</Empty>}
      {card !== null && card.problems.length > 0 && <Problems problems={card.problems} />}
      <div className="surface divide-y overflow-hidden">
        {found.map((id) => (
          <FoldedSection key={id} label={CARD_SECTIONS[id].label} meta={facts[id].length} {...fold(id)}>
            <SectionFacts id={id} facts={facts} />
          </FoldedSection>
        ))}
        {missing.length > 0 && (
          <FoldedSection
            label="Not found in this repo"
            meta={missing.map((id) => CARD_SECTIONS[id].label).join(" · ")}
            {...fold(NOT_FOUND)}
          >
            <ul className="divide-y">
              {missing.map((id) => (
                <Row key={id}>
                  <span className="w-32 shrink-0 text-sm">{CARD_SECTIONS[id].label}</span>
                  <span className="text-muted-foreground min-w-0 text-xs break-words">{CARD_SECTIONS[id].missing}</span>
                </Row>
              ))}
            </ul>
          </FoldedSection>
        )}
      </div>
      {card !== null && <p className="text-muted-foreground font-mono text-xs">commit {card.commit.slice(0, 12)}</p>}
    </div>
  );
}

/** The fold of the line that names the kinds of fact the repo has none of; no section has this id. */
const NOT_FOUND = "not-found";

/** What the card could not read in full (ADR-80): open, since it tells the user the facts below may be incomplete. */
function Problems({ problems }: { problems: RepoCard["problems"] }) {
  return (
    <Surface label="Incomplete" meta={problems.length}>
      <ul className="divide-y">
        {problems.map((p) => (
          <Row key={`${p.path}:${p.message}`}>
            <span className="text-warning shrink-0 text-xs">{CARD_PROBLEM_LABELS[p.code]}</span>
            <span className="min-w-0 font-mono text-xs break-all">{p.path || "repo"}</span>
            <span className="text-muted-foreground min-w-0 text-xs break-words">{p.message}</span>
          </Row>
        ))}
      </ul>
    </Surface>
  );
}

/** The facts of one section, each with its evidence. */
function SectionFacts({ id, facts }: { id: CardSectionId; facts: CardFacts }) {
  switch (id) {
    case "tags":
      return <Tags tags={facts.tags} />;
    case "mechanisms":
      return <Mechanisms mechanisms={facts.mechanisms} />;
    case "tools":
      return <Tools tools={facts.tools} />;
    case "apps":
      return <Apps apps={facts.apps} />;
    case "endpoints":
      return <Endpoints endpoints={facts.endpoints} />;
    case "dtos":
      return <Dtos dtos={facts.dtos} />;
    case "clients":
      return <HttpClients clients={facts.clients} />;
    case "provides":
      return <Packages packages={facts.provides} />;
    case "uses":
      return <Packages packages={facts.uses} />;
    case "build-files":
      return <BuildFiles files={facts["build-files"]} />;
  }
}

function Tags({ tags }: { tags: readonly RepoTag[] }) {
  return (
    <ul className="divide-y">
      {tags.map((tag) => (
        <Row key={tag.name}>
          <Badge>#{tag.name}</Badge>
          <span className="text-muted-foreground min-w-0 text-xs break-words">{tag.reason}</span>
        </Row>
      ))}
    </ul>
  );
}

function BuildFiles({ files }: { files: BuildFile[] }) {
  return (
    <ul className="divide-y">
      {files.map((f) => (
        <Row key={f.path}>
          <span className="min-w-0 truncate font-mono text-xs" title={f.path}>
            {f.path}
          </span>
          <Badge variant="secondary">{f.tool}</Badge>
          {f.name && <span className="text-muted-foreground truncate text-xs">{f.name}</span>}
        </Row>
      ))}
    </ul>
  );
}

function Mechanisms({ mechanisms }: { mechanisms: Mechanism[] }) {
  return (
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
  );
}

function Tools({ tools }: { tools: ToolRequirement[] }) {
  return (
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
  );
}

function Packages({ packages }: { packages: (ProvidedPackage | ConsumedPackage)[] }) {
  return (
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
  );
}

function Apps({ apps }: { apps: ProvidedApp[] }) {
  return (
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
  );
}

function Endpoints({ endpoints }: { endpoints: ProvidedEndpoint[] }) {
  return (
    <ul className="divide-y">
      {endpoints.map((e) => (
        <Row key={`${e.method} ${e.path} ${evidenceLabel(e.evidence)}`}>
          <Badge variant="secondary">{e.method ?? "any"}</Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.operation?.summary ?? e.path}>
            {e.path}
          </span>
          {e.source === "openapi" && (
            <Badge variant="outline" title="From an OpenAPI spec in the repo, without a mapping in the code">
              OpenAPI
            </Badge>
          )}
          {(e.request !== null || e.response !== null) && <Contract endpoint={e} />}
          {e.handler !== null && <span className="text-muted-foreground max-w-48 truncate font-mono text-xs">{e.handler}</span>}
          <Evidence label={evidenceLabel(e.evidence)} />
        </Row>
      ))}
    </ul>
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
  );
}

/** An HTTP client: where it calls (an app or address, in which profiles) and which paths. */
function HttpClients({ clients }: { clients: ConsumedHttp[] }) {
  return (
    <ul className="divide-y">
      {clients.map((c, i) => (
        // Two proxy entries to the same address have the same fields: the position in the list tells them apart without
        // changing the order.
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
