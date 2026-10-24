import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import type { ProblemSink } from "./snapshot.ts";
import { clientAt, type SpringModule, urlVariants } from "./spring-module.ts";

/**
 * Klienci HTTP z samej konfiguracji Spring (§4.6, ADR-30): klucz, którego wartość w którymś profilu jest adresem
 * HTTP albo `lb://nazwa` (`orders.url`, `spring.cloud.gateway.routes[0].uri`, `eureka.client.service-url.defaultZone`),
 * a którego wpisu nie wskazuje już adres klienta z kodu (`codeClients`: ten sam plik i linia w `urlSource`). Wywołań
 * nie ma, bo konfiguracja ich nie zna.
 */

/** Najwięcej klientów z konfiguracji jednego modułu: aplikacja ma ich kilkadziesiąt, a plik jest z repo (§8). */
const MAX_CONFIG_CLIENTS = 500;
export function configClients(module: SpringModule, codeClients: readonly ConsumedHttp[], out: ProblemSink): ConsumedHttp[] {
  const used = new Set(codeClients.flatMap((c) => (c.urlSource ? [sourceId(c.urlSource, c.url)] : [])));
  const clients: ConsumedHttp[] = [];
  for (const key of module.config.keys()) {
    if (clients.length >= MAX_CONFIG_CLIENTS) {
      out.problems.push({
        path: module.config.module,
        message: `moduł ma ponad ${MAX_CONFIG_CLIENTS} adresów w konfiguracji; karta pokazuje pierwsze`,
      });
      break;
    }
    // Rozwijanie w każdym profilu tylko dla klucza, którego wartość w którymś wygląda na adres albo ma `${…}`.
    if (!module.config.rawValues(key).some((v) => v.includes("${") || parseHttpUrl(v))) continue;
    for (const variant of urlVariants(module, `\${${key}}`)) {
      const name = variant.source && module.config.entry(key, variant.profiles[0])?.key;
      if (!variant.source || !name || used.has(sourceId(variant.source, variant.value)) || !parseHttpUrl(variant.value)) continue;
      clients.push(clientAt({ via: "config", name, app: null, calls: [], evidence: variant.source }, variant));
    }
  }
  return clients;
}

/** Wpis po miejscu i wartości: kilka kluczy w jednej linii (mapa `{a: …, b: …}` w YAML) to różne wpisy. */
function sourceId(source: { path: string; line: number | null }, url: string | null): string {
  return `${source.path}:${source.line}:${url}`;
}
