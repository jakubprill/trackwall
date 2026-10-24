import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import { clientAt, type SpringModule, urlVariants } from "./spring-module.ts";

/**
 * Klienci HTTP z samej konfiguracji Spring (§4.6, ADR-30): klucz, którego wartość w którymś profilu jest adresem
 * HTTP albo `lb://nazwa` (`orders.url`, `spring.cloud.gateway.routes[0].uri`, `eureka.client.service-url.defaultZone`),
 * a którego wpisu nie wskazuje już adres klienta z kodu (`codeClients`: ten sam plik i linia w `urlSource`). Wywołań
 * nie ma, bo konfiguracja ich nie zna.
 */
export function configClients(module: SpringModule, codeClients: readonly ConsumedHttp[]): ConsumedHttp[] {
  const used = new Set(codeClients.flatMap((c) => (c.urlSource ? [sourceId(c.urlSource)] : [])));
  const clients: ConsumedHttp[] = [];
  for (const key of module.config.keys()) {
    // Rozwijanie w każdym profilu tylko dla klucza, którego wartość w którymś wygląda na adres albo ma `${…}`.
    if (!module.config.rawValues(key).some((v) => v.includes("${") || parseHttpUrl(v))) continue;
    for (const variant of urlVariants(module, `\${${key}}`)) {
      const name = variant.source && module.config.entry(key, variant.profiles[0])?.key;
      if (!variant.source || !name || used.has(sourceId(variant.source)) || !parseHttpUrl(variant.value)) continue;
      clients.push(clientAt({ via: "config", name, app: null, calls: [], evidence: variant.source }, variant));
    }
  }
  return clients;
}

function sourceId(source: { path: string; line: number | null }): string {
  return `${source.path}:${source.line}`;
}
