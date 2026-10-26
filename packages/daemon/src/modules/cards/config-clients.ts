import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import type { ProblemSink } from "./snapshot.ts";
import { clientAt, type SpringModule, urlVariants } from "./spring-module.ts";

/** At most this many clients from the configuration of one module: an app has a few dozen, and the file comes from the repo (§8). */
const MAX_CONFIG_CLIENTS = 500;

/**
 * HTTP clients from Spring configuration alone (§4.6, ADR-30): a key whose value in some profile is an HTTP address or
 * `lb://name` (`orders.url`, `spring.cloud.gateway.routes[0].uri`, `eureka.client.service-url.defaultZone`), and whose
 * entry is not already pointed to by the address of a client from code (`codeClients`, `usedBy`). There are no calls,
 * because the configuration does not know them.
 */
export function configClients(module: SpringModule, codeClients: readonly ConsumedHttp[], out: ProblemSink): ConsumedHttp[] {
  const used = codeUrlsByEntry(codeClients);
  const clients: ConsumedHttp[] = [];
  for (const key of module.config.keys()) {
    // Expanding in every profile only for a key whose value in one of them looks like an address or has `${…}`.
    if (!module.config.rawValues(key).some((v) => v.includes("${") || parseHttpUrl(v))) continue;
    for (const variant of urlVariants(module, `\${${key}}`)) {
      const name = variant.source && module.config.entry(key, variant.profiles[0])?.key;
      if (!variant.source || !name || usedBy(used, variant.source, variant.value) || !parseHttpUrl(variant.value)) continue;
      if (clients.length >= MAX_CONFIG_CLIENTS) {
        out.problems.push({
          code: "truncated",
          path: module.config.module,
          message: `the module has more than ${MAX_CONFIG_CLIENTS} addresses in its config; the card shows the first ones`,
        });
        return clients;
      }
      clients.push(clientAt({ via: "config", name, app: null, calls: [], evidence: variant.source }, variant));
    }
  }
  return clients;
}

/** Addresses of clients from code by the configuration entry (file and line) they were expanded from. */
function codeUrlsByEntry(codeClients: readonly ConsumedHttp[]): Map<string, string[]> {
  const byEntry = new Map<string, string[]>();
  for (const client of codeClients) {
    if (!client.urlSource || client.url === null) continue;
    const id = entryId(client.urlSource);
    byEntry.set(id, [...(byEntry.get(id) ?? []), client.url]);
  }
  return byEntry;
}

/**
 * An entry is already a code client's address when the client from that line has an address that starts with its value
 * (the code appends a path: `${orders.url}/v1`). The line alone is not enough, because a YAML map `{a: …, b: …}` has
 * several entries on one line.
 */
function usedBy(used: ReadonlyMap<string, readonly string[]>, source: { path: string; line: number }, value: string): boolean {
  return used.get(entryId(source))?.some((url) => url.startsWith(value)) ?? false;
}

function entryId(source: { path: string; line: number | null }): string {
  return `${source.path}:${source.line}`;
}
