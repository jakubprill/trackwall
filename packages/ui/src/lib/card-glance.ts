import { countLabel, type RepoCard } from "@trackwall/protocol";
import { MECHANISM_LABELS } from "./card.ts";

/**
 * The top of the "Card" tab (ADR-103): the card in four short lines, so the repo is told at a glance before its facts
 * with evidence. Only counts and names from the card; the sections below it have the rest.
 */
export interface CardGlance {
  /** Mechanisms and pinned tools, as "Spring Boot", "java 21". */
  stack: string[];
  /** Spring Boot apps with their port, as "orders-api :8081". */
  apps: string[];
  /** "14 endpoints · 9 DTOs". */
  api: string;
  /** "2 HTTP clients · provides 1 package · uses 31 packages". */
  dependencies: string;
}

export function cardGlance(card: RepoCard): CardGlance {
  let endpoints = 0;
  let packagesProvided = 0;
  const apps: string[] = [];
  for (const p of card.provides) {
    if (p.kind === "endpoint") endpoints++;
    else if (p.kind === "package") packagesProvided++;
    else apps.push(p.port === null ? p.name : `${p.name} :${p.port}`);
  }
  const clients = card.consumes.filter((c) => c.kind === "http").length;
  const packagesUsed = card.consumes.length - clients;
  return {
    stack: [...card.mechanisms.map((m) => MECHANISM_LABELS[m.id]), ...toolVersions(card)],
    apps,
    api: `${countLabel(endpoints, { one: "endpoint", other: "endpoints" })} · ${countLabel(card.dtos.length, { one: "DTO", other: "DTOs" })}`,
    dependencies: [
      countLabel(clients, { one: "HTTP client", other: "HTTP clients" }),
      `provides ${countLabel(packagesProvided, PACKAGE)}`,
      `uses ${countLabel(packagesUsed, PACKAGE)}`,
    ].join(" · "),
  };
}

/** One version per tool: several files may pin the same tool, and the one mise reads wins over a hint. */
function toolVersions(card: RepoCard): string[] {
  const versions = new Map<string, string>();
  for (const t of [...card.tools].sort((a, b) => Number(b.source === "mise") - Number(a.source === "mise"))) {
    if (!versions.has(t.tool)) versions.set(t.tool, `${t.tool} ${t.version}`);
  }
  return [...versions.values()];
}

const PACKAGE = { one: "package", other: "packages" };
