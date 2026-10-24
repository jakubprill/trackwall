import { z } from "zod";
import { Evidence } from "./evidence.ts";

/**
 * Fakty HTTP na karcie repo (§4.6, ADR-30): aplikacje Spring Boot, endpointy, które udostępniają, i klienci HTTP,
 * którymi repo woła inne aplikacje, wyczytane z kodu Javy i Kotlina, `application*.yml` / `.properties` z profilami
 * oraz plików `.env` i proxy frontendów. Graf łączy klientów z aplikacjami i endpointami innych repo.
 */

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/**
 * Aplikacja Spring Boot w repo: moduł z `spring.application.name` w `src/main/resources/application*` albo
 * `bootstrap*`. Pod tą nazwą wołają ją klienci przez discovery (Feign `name`, `lb://nazwa`, nazwa serwisu
 * Kubernetes).
 */
export const ProvidedApp = z.object({
  kind: z.literal("app"),
  name: z.string(),
  /** `server.port` z profilu domyślnego; `null` bez wpisu (karta nie zgaduje domyślnego 8080). */
  port: z.number().int().min(0).max(65535).nullable(),
  /** Katalog modułu w repo (`""` dla korzenia), w którym leżą `src/main/resources` i kod tej aplikacji. */
  module: z.string(),
  evidence: Evidence,
});
export type ProvidedApp = z.infer<typeof ProvidedApp>;

/** Endpoint HTTP z kontrolera Spring (`@RestController`, `@Controller` z `@*Mapping`). */
export const ProvidedEndpoint = z.object({
  kind: z.literal("endpoint"),
  /** `null`: `@RequestMapping` bez `method`, czyli każda metoda. */
  method: HttpMethod.nullable(),
  /**
   * Pełna ścieżka: ścieżka kontekstu aplikacji (`server.servlet.context-path`), prefiks klasy i ścieżka metody, ze
   * zmiennymi jak w kodzie (`/api/orders/{id}`). Stała, której nie da się odczytać, zostaje jako `<NAZWA>`.
   */
  path: z.string(),
  /** Nazwa aplikacji modułu, w którym leży kontroler; `null`, gdy moduł jej nie podaje. */
  app: z.string().nullable(),
  /** `Klasa.metoda` kontrolera. */
  handler: z.string(),
  evidence: Evidence,
});
export type ProvidedEndpoint = z.infer<typeof ProvidedEndpoint>;

/**
 * Skąd jest klient HTTP: interfejs `@FeignClient`, interfejs `@HttpExchange` (Spring 6), wywołania `WebClient`,
 * `RestClient` albo `RestTemplate` w klasie, adres w konfiguracji Spring (`config`), zmienna w `.env` frontendu
 * (`env`) albo cel proxy serwera deweloperskiego frontendu (`proxy`).
 */
export const HttpClientVia = z.enum(["feign", "http-interface", "webclient", "rest-client", "rest-template", "config", "env", "proxy"]);
export type HttpClientVia = z.infer<typeof HttpClientVia>;

/** Jedno wywołanie klienta: metoda i ścieżka bez adresu bazowego (`/orders/{id}`). */
export const HttpCall = z.object({
  /** `null`, gdy kod nie mówi, jaką metodą woła. */
  method: HttpMethod.nullable(),
  /** Ścieżka względem adresu klienta, ze zmiennymi `{…}`; część złożona w kodzie zmienną to `{}`. */
  path: z.string(),
  evidence: Evidence,
});
export type HttpCall = z.infer<typeof HttpCall>;

/** Klient HTTP: do kogo repo woła (nazwa aplikacji albo adres) i, gdy kod to mówi, jakie wywołania. */
export const ConsumedHttp = z.object({
  kind: z.literal("http"),
  via: HttpClientVia,
  /** Nazwa klienta dla człowieka: interfejs Feign, klasa z wywołaniami, klucz konfiguracji albo zmienna `.env`. */
  name: z.string(),
  /** Nazwa aplikacji w discovery: Feign `name`/`value`, host z `lb://`; `null`, gdy klient woła adres. */
  app: z.string().nullable(),
  /** Adres bazowy po rozwinięciu `${…}` z konfiguracji (`http://orders:8080/api`); nierozwinięty zostaje jak w pliku. */
  url: z.string().nullable(),
  /**
   * Profile Spring, w których klient ma ten adres: `default` to konfiguracja bez profilu, inny profil jest tu tylko,
   * gdy zmienia adres. Pusty dla klienta bez konfiguracji (frontend, adres wpisany w kod).
   */
  profiles: z.array(z.string()),
  /** Wpis konfiguracji, z którego jest adres (`application-prod.yml:12`); `null`, gdy adres jest w kodzie albo go nie ma. */
  urlSource: Evidence.nullable(),
  calls: z.array(HttpCall),
  evidence: Evidence,
});
export type ConsumedHttp = z.infer<typeof ConsumedHttp>;

/** Adres HTTP rozłożony na części: tyle, ile graf potrzebuje, żeby dopasować go do aplikacji z innego repo. */
export interface HttpUrl {
  /** `http`, `https`, `ws`, `wss` albo `lb` (load balancer Spring Cloud: host to nazwa aplikacji w discovery). */
  scheme: string;
  /** Host małymi literami. */
  host: string;
  port: number | null;
  /** Ścieżka bez zapytania, `""` bez ścieżki. */
  path: string;
}

/** Dłuższy tekst nie jest adresem z konfiguracji, a wyrażenie niżej i tak go nie dotknie. */
const MAX_URL_LENGTH = 2048;
const HTTP_URL = /^(https?|wss?|lb):\/\/([^/:?#\s]+)(?::(\d{1,5}))?([^?#\s]*)/i;

/** Adres HTTP z tekstu; `undefined` dla innego tekstu i dla hosta z nierozwiniętym `${…}`. */
export function parseHttpUrl(text: string): HttpUrl | undefined {
  if (text.length > MAX_URL_LENGTH) return undefined;
  const m = HTTP_URL.exec(text.trim());
  const [, scheme, host, port, path] = m ?? [];
  if (!scheme || !host || /[${}]/.test(host)) return undefined;
  return { scheme: scheme.toLowerCase(), host: host.toLowerCase(), port: port ? Number(port) : null, path: path ?? "" };
}

/** Ścieżki sklejone w jedną, z jednym `/` między częściami i bez zapytania: `/api` + `orders/` + `/{id}` → `/api/orders/{id}`. */
export function joinHttpPath(...parts: readonly string[]): string {
  const segments = parts.flatMap((p) => (p.split("?")[0] ?? "").split("/")).filter((s) => s !== "");
  return `/${segments.join("/")}`;
}

/** Człony ścieżki po złożeniu (`/api//orders/` → `["api", "orders"]`), do porównań `httpSegmentsMatch`. */
export function httpPathSegments(path: string): string[] {
  return joinHttpPath(path).split("/").slice(1).filter((s) => s !== "");
}

/**
 * Czy ścieżka wywołania pasuje do ścieżki endpointu: człon po członie, zmienna (`{id}`, `{}`, `*`) z każdej strony
 * pasuje do dowolnego członu, `**` w endpoincie do reszty ścieżki, a nieodczytana stała (`<NAZWA>`) tylko do tej samej.
 */
export function httpPathMatches(call: string, endpoint: string): boolean {
  return httpSegmentsMatch(httpPathSegments(call), httpPathSegments(endpoint));
}

/** `httpPathMatches` na członach policzonych raz (`httpPathSegments`), gdy jedną ścieżkę porównuje się z wieloma. */
export function httpSegmentsMatch(call: readonly string[], endpoint: readonly string[]): boolean {
  for (let i = 0; i < endpoint.length; i++) {
    const segment = endpoint[i] ?? "";
    if (segment === "**") return true;
    const other = call[i];
    if (other === undefined || !segmentMatches(other, segment)) return false;
  }
  return call.length === endpoint.length;
}

function segmentMatches(a: string, b: string): boolean {
  return a === b || isVariable(a) || isVariable(b);
}

function isVariable(segment: string): boolean {
  return segment === "*" || (segment.startsWith("{") && segment.endsWith("}"));
}

/** Czy metody wywołania i endpointu się zgadzają; `null` z którejś strony to każda metoda. */
export function httpMethodMatches(call: HttpMethod | null, endpoint: HttpMethod | null): boolean {
  return call === null || endpoint === null || call === endpoint;
}
