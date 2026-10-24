import { type ConsumedHttp, type EdgeEvidence, type HttpClientVia, pluralNoun } from "@trackwall/protocol";
import type { Join } from "./graph-join.ts";
import type { HttpIndex, HttpTarget, MatchedCall } from "./http-index.ts";

/**
 * Krawędzie `http` (§4.6, ADR-30): klient HTTP repo i repo, które woła (`HttpIndex.targets`), z dowodami: klient
 * (plik i linia adnotacji albo wywołania), wpis konfiguracji z adresem, aplikacja celu i pary wywołanie–endpoint.
 */

/** Ile par wywołanie–endpoint trafia do dowodów jednej krawędzi: kilka wystarcza, resztę pokaże `find_endpoint`. */
const MAX_CALL_EVIDENCE = 5;

/** Rodzaj klienta dla człowieka w dowodzie krawędzi; `Record` wymusza wpis dla każdego z kontraktu. */
const VIA_LABELS: Record<HttpClientVia, string> = {
  feign: "Feign client",
  "http-interface": "@HttpExchange interface",
  webclient: "WebClient",
  "rest-client": "RestClient",
  "rest-template": "RestTemplate",
  config: "address in config",
  env: ".env variable",
  proxy: "dev server proxy",
};

export function addHttpEdges(join: Join, index: HttpIndex): void {
  for (const { repo, client } of index.clients)
    for (const target of index.targets(repo, client))
      join.edges.add({
        from: repo,
        to: target.repo,
        kind: "http",
        key: target.key,
        confidence: target.confidence,
        evidence: [...clientEvidence(repo, client), ...target.evidence, ...callEvidence(repo, target)],
      });
}

function clientEvidence(repo: string, client: ConsumedHttp): EdgeEvidence[] {
  const target = [client.app, client.url].filter((t) => t !== null).join(", ");
  const profileNoun = pluralNoun(client.profiles.length, { one: "profile", other: "profiles" });
  const profiles = client.profiles.length > 0 ? ` (${profileNoun}: ${client.profiles.join(", ")})` : "";
  const evidence: EdgeEvidence[] = [
    { repo, ...client.evidence, detail: `${VIA_LABELS[client.via]} ${client.name}: ${target || "no address"}${profiles}` },
  ];
  const source = client.urlSource;
  if (source && (source.path !== client.evidence.path || source.line !== client.evidence.line))
    evidence.push({ repo, ...source, detail: `address ${client.url}${profiles}` });
  return evidence;
}

function callEvidence(from: string, target: HttpTarget): EdgeEvidence[] {
  return target.calls.slice(0, MAX_CALL_EVIDENCE).flatMap((m: MatchedCall) => [
    { repo: from, ...m.call.evidence, detail: `calls ${methodLabel(m.call.method)} ${m.path}` },
    {
      repo: target.repo,
      ...m.endpoint.evidence,
      detail: `handles ${methodLabel(m.endpoint.method)} ${m.endpoint.path} (${m.endpoint.handler})`,
    },
  ]);
}

function methodLabel(method: string | null): string {
  return method ?? "*";
}
