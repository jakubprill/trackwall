import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import type { ProblemSink } from "./snapshot.ts";
import { clientAt, type SpringModule, urlVariants } from "./spring-module.ts";

/** Najwięcej klientów z konfiguracji jednego modułu: aplikacja ma ich kilkadziesiąt, a plik jest z repo (§8). */
const MAX_CONFIG_CLIENTS = 500;

/**
 * Klienci HTTP z samej konfiguracji Spring (§4.6, ADR-30): klucz, którego wartość w którymś profilu jest adresem
 * HTTP albo `lb://nazwa` (`orders.url`, `spring.cloud.gateway.routes[0].uri`, `eureka.client.service-url.defaultZone`),
 * a którego wpisu nie wskazuje już adres klienta z kodu (`codeClients`, `usedBy`). Wywołań nie ma, bo konfiguracja
 * ich nie zna.
 */
export function configClients(module: SpringModule, codeClients: readonly ConsumedHttp[], out: ProblemSink): ConsumedHttp[] {
  const used = codeUrlsByEntry(codeClients);
  const clients: ConsumedHttp[] = [];
  for (const key of module.config.keys()) {
    // Rozwijanie w każdym profilu tylko dla klucza, którego wartość w którymś wygląda na adres albo ma `${…}`.
    if (!module.config.rawValues(key).some((v) => v.includes("${") || parseHttpUrl(v))) continue;
    for (const variant of urlVariants(module, `\${${key}}`)) {
      const name = variant.source && module.config.entry(key, variant.profiles[0])?.key;
      if (!variant.source || !name || usedBy(used, variant.source, variant.value) || !parseHttpUrl(variant.value)) continue;
      if (clients.length >= MAX_CONFIG_CLIENTS) {
        out.problems.push({
          path: module.config.module,
          message: `moduł ma ponad ${MAX_CONFIG_CLIENTS} adresów w konfiguracji; karta pokazuje pierwsze`,
        });
        return clients;
      }
      clients.push(clientAt({ via: "config", name, app: null, calls: [], evidence: variant.source }, variant));
    }
  }
  return clients;
}

/** Adresy klientów z kodu po wpisie konfiguracji (plik i linia), z którego je rozwinięto. */
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
 * Wpis jest już adresem klienta z kodu, gdy klient z tej linii ma adres zaczynający się od jego wartości (kod dokleja
 * ścieżkę: `${orders.url}/v1`). Sama linia nie wystarcza, bo mapa YAML `{a: …, b: …}` ma kilka wpisów w jednej linii.
 */
function usedBy(used: ReadonlyMap<string, readonly string[]>, source: { path: string; line: number }, value: string): boolean {
  return used.get(entryId(source))?.some((url) => url.startsWith(value)) ?? false;
}

function entryId(source: { path: string; line: number | null }): string {
  return `${source.path}:${source.line}`;
}
