import type { Dto, EndpointChange, EndpointChanges, EndpointContract, ProvidedEndpoint, RepoCard } from "@trackwall/protocol";
import { contractTypeNames, dtoFieldTypeNames, leavesContractsIncomplete, reachableTypes } from "./endpoint-contracts.ts";

/**
 * The endpoints that differ between two cards of one repo (§4.6, ADR-145): the card of a task's base commit and the one
 * of its HEAD. An endpoint is known by its app, method and path, and by its handler too when several endpoints share
 * them (mappings that differ only by `params` or `headers`). It changed when its request or response type did, or a DTO
 * reachable from them (ADR-38) did; that is compared only when neither card lacks types or DTOs
 * (`leavesContractsIncomplete`), since a card without syntax trees has no types to compare. Callers come from the graph.
 */

export function endpointChanges(before: RepoCard, after: RepoCard): Omit<EndpointChanges, "head" | "problems"> {
  const contractsCompared = [before, after].every((card) => !card.problems.some(leavesContractsIncomplete));
  const shared = sharedPlaces([before, after]);
  const old = endpointsByKey(before, shared);
  const now = endpointsByKey(after, shared);
  const oldDtos = dtosByName(before);
  const nowDtos = dtosByName(after);
  const changes: EndpointChange[] = [];
  for (const [key, was] of old) {
    const is = now.get(key);
    if (is === undefined) {
      changes.push(removed(was));
      continue;
    }
    if (!contractsCompared) continue;
    const dtos = changedDtos(reachable(was, oldDtos), oldDtos, reachable(is, nowDtos), nowDtos);
    if (was.request !== is.request || was.response !== is.response || dtos.length > 0) changes.push(changed(was, is, dtos));
  }
  for (const [key, is] of now) if (!old.has(key)) changes.push(added(is));
  return { changes, contractsCompared };
}

function removed(was: ProvidedEndpoint): EndpointChange {
  return { change: "removed", ...where(was), before: contractOf(was), after: null, dtos: [] };
}

function added(is: ProvidedEndpoint): EndpointChange {
  return { change: "added", ...where(is), before: null, after: contractOf(is), dtos: [] };
}

function changed(was: ProvidedEndpoint, is: ProvidedEndpoint, dtos: string[]): EndpointChange {
  return { change: "changed", ...where(is), before: contractOf(was), after: contractOf(is), dtos };
}

function where({ app, method, path }: ProvidedEndpoint): Pick<EndpointChange, "app" | "method" | "path"> {
  return { app, method, path };
}

function contractOf({ handler, request, response }: ProvidedEndpoint): EndpointContract {
  return { handler, request, response };
}

/** The app, method and path that several endpoints share in either card (mappings that differ by `params` or `headers`). */
function sharedPlaces(cards: readonly RepoCard[]): Set<string> {
  const shared = new Set<string>();
  for (const card of cards) {
    const seen = new Set<string>();
    for (const e of endpointsOf(card)) {
      const place = placeKey(e);
      if (seen.has(place)) shared.add(place);
      seen.add(place);
    }
  }
  return shared;
}

/** A card's endpoints by app, method and path, and also by handler where `shared` has those, so the two sides pair there by handler. */
function endpointsByKey(card: RepoCard, shared: ReadonlySet<string>): Map<string, ProvidedEndpoint> {
  return new Map(endpointsOf(card).map((e) => [shared.has(placeKey(e)) ? JSON.stringify([placeKey(e), e.handler]) : placeKey(e), e]));
}

function endpointsOf(card: RepoCard): ProvidedEndpoint[] {
  return card.provides.filter((p) => p.kind === "endpoint");
}

function placeKey({ app, method, path }: ProvidedEndpoint): string {
  return JSON.stringify([app, method, path]);
}

function dtosByName(card: RepoCard): Map<string, Dto> {
  return new Map(card.dtos.map((d) => [d.name, d]));
}

/** The DTO names reachable from the endpoint's request and response through field types. */
function reachable(endpoint: ProvidedEndpoint, dtos: ReadonlyMap<string, Dto>): string[] {
  return reachableTypes(contractTypeNames(endpoint), (name) => {
    const dto = dtos.get(name);
    return dto === undefined ? undefined : dtoFieldTypeNames(dto);
  });
}

/** The DTOs either side reaches whose members differ between the cards, in the order found. */
function changedDtos(
  reachedBefore: readonly string[],
  before: ReadonlyMap<string, Dto>,
  reachedAfter: readonly string[],
  after: ReadonlyMap<string, Dto>,
): string[] {
  return [...new Set([...reachedBefore, ...reachedAfter])].filter((name) => membersOf(before.get(name)) !== membersOf(after.get(name)));
}

/** What a consumer sees of a DTO: its kind and members, without where it is declared. */
function membersOf(dto: Dto | undefined): string {
  if (dto === undefined) return "";
  return JSON.stringify(dto.kind === "enum" ? [dto.kind, dto.values] : [dto.kind, dto.fields]);
}
