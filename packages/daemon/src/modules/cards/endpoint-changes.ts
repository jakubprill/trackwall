import type { ChangedEndpoint, Dto, EndpointContract, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { typeNames } from "./endpoint-contracts.ts";

/**
 * The endpoints that differ between two cards of one repo (§4.6, ADR-145): the card of a task's base commit and the one
 * of its HEAD. An endpoint is known by its app, method and path; it changed when its request or response type did, or a
 * DTO reachable from them (ADR-38) did. Callers come from the graph, so they are left empty here.
 */

export type EndpointChange = Omit<ChangedEndpoint, "callers">;

export function endpointChanges(before: RepoCard | null, after: RepoCard | null): EndpointChange[] {
  const old = endpointsByKey(before);
  const now = endpointsByKey(after);
  const changes: EndpointChange[] = [];
  for (const [key, was] of old) {
    const is = now.get(key);
    if (is === undefined) {
      changes.push(change("removed", was, null, []));
      continue;
    }
    const dtos = changedDtos(was, before, is, after);
    if (was.request !== is.request || was.response !== is.response || dtos.length > 0) changes.push(change("changed", was, is, dtos));
  }
  for (const [key, is] of now) if (!old.has(key)) changes.push(change("added", null, is, []));
  return changes;
}

function change(kind: EndpointChange["change"], was: ProvidedEndpoint | null, is: ProvidedEndpoint | null, dtos: string[]): EndpointChange {
  const known = is ?? was;
  if (known === null) throw new Error("an endpoint change needs the endpoint on one side");
  return { change: kind, app: known.app, method: known.method, path: known.path, before: contractOf(was), after: contractOf(is), dtos };
}

function contractOf(endpoint: ProvidedEndpoint | null): EndpointContract | null {
  return endpoint === null ? null : { handler: endpoint.handler, request: endpoint.request, response: endpoint.response };
}

function endpointsByKey(card: RepoCard | null): Map<string, ProvidedEndpoint> {
  const endpoints = new Map<string, ProvidedEndpoint>();
  for (const p of card?.provides ?? []) if (p.kind === "endpoint") endpoints.set(JSON.stringify([p.app, p.method, p.path]), p);
  return endpoints;
}

/** The names of the DTOs reachable from either side's request and response whose members differ between the cards, in order. */
function changedDtos(was: ProvidedEndpoint, before: RepoCard | null, is: ProvidedEndpoint, after: RepoCard | null): string[] {
  const old = dtosByName(before);
  const now = dtosByName(after);
  const names = new Set([...reachable(was, old), ...reachable(is, now)]);
  return [...names].filter((name) => membersOf(old.get(name)) !== membersOf(now.get(name)));
}

function dtosByName(card: RepoCard | null): Map<string, Dto> {
  return new Map((card?.dtos ?? []).map((d) => [d.name, d]));
}

/** The DTO names reachable from the endpoint's request and response through field types. */
function reachable(endpoint: ProvidedEndpoint, dtos: ReadonlyMap<string, Dto>): string[] {
  const queue = [endpoint.request, endpoint.response].flatMap((t) => (t === null ? [] : typeNames(t)));
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i] ?? "";
    const dto = dtos.get(name);
    if (seen.has(name) || dto === undefined) continue;
    seen.add(name);
    if (dto.kind !== "enum") for (const f of dto.fields) for (const t of typeNames(f.type)) queue.push(t);
  }
  return [...seen];
}

/** What a consumer sees of a DTO: its kind and members, without where it is declared. */
function membersOf(dto: Dto | undefined): string {
  if (dto === undefined) return "";
  return JSON.stringify(dto.kind === "enum" ? [dto.kind, dto.values] : [dto.kind, dto.fields]);
}
