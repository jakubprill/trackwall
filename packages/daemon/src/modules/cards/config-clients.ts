import { type ConsumedHttp, parseHttpUrl } from "@trackwall/protocol";
import { appOf } from "./imperative-clients.ts";
import { type SpringModule, urlVariants } from "./spring-module.ts";

/**
 * Klienci HTTP z samej konfiguracji Spring (§4.6, ADR-30): klucz, którego wartość w którymś profilu jest adresem
 * HTTP albo `lb://nazwa` (`orders.url`, `spring.cloud.gateway.routes[0].uri`, `eureka.client.service-url.defaultZone`),
 * a którego kod nie użył już jako adresu klienta (`usedKeys`). Wywołań nie ma, bo konfiguracja ich nie zna.
 */
export function configClients(module: SpringModule): ConsumedHttp[] {
  const clients: ConsumedHttp[] = [];
  for (const key of module.config.keys()) {
    if (module.usedKeys.has(key)) continue;
    for (const variant of urlVariants(module, `\${${key}}`)) {
      const name = variant.source && module.config.entry(key, variant.profiles[0])?.key;
      if (!variant.source || !name || !parseHttpUrl(variant.value)) continue;
      clients.push({
        kind: "http",
        via: "config",
        name,
        app: appOf(variant.value),
        url: variant.value,
        profiles: variant.profiles,
        urlSource: variant.source,
        calls: [],
        evidence: variant.source,
      });
    }
  }
  return clients;
}
