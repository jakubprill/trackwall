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
 * `bootstrap*`. Pod tą nazwą wołają ją klienci przez discovery (Feign `name`, `lb://nazwa`, nazwa w DNS
 * klastra Kubernetes).
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
   * zmiennymi jak w kodzie (`/api/orders/{id}`). Stała, której nie da się odczytać, zostaje jako `<Klasa.NAZWA>`.
   */
  path: z.string(),
  /** Nazwa aplikacji modułu, w którym leży kontroler; `null`, gdy moduł jej nie podaje. */
  app: z.string().nullable(),
  /** `Klasa.metoda` kontrolera. */
  handler: z.string(),
  /**
   * Typ ciała żądania (parametr z `@RequestBody`) w zapisie typu (`CreateOrder`, `List<Line>`); `null` bez ciała albo
   * gdy drzewo składni pliku nie powstało (ADR-38). Zapis typu to tekst z kodu bez adnotacji, ze spacją tylko przed
   * słowem po słowie albo po `?` (`List<? extends Line>`); dłuższy niż 256 znaków przycięty z „…”.
   */
  request: z.string().nullable(),
  /**
   * Typ odpowiedzi: typ zwracany bez opakowań, które nie zmieniają treści (`ResponseEntity<T>`, `Mono<T>`,
   * `Optional<T>`…), w zapisie typu jak `request`; `null` bez treści (`void`, `Unit`, `ResponseEntity<Void>`,
   * `ResponseEntity<*>`, samo `ResponseEntity`), bez jawnego typu (funkcja Kotlina z wyrażeniem) albo bez drzewa
   * składni (ADR-38).
   */
  response: z.string().nullable(),
  evidence: Evidence,
});
export type ProvidedEndpoint = z.infer<typeof ProvidedEndpoint>;

/** Pole DTO: nazwa i typ w zapisie typu jak `ProvidedEndpoint.request` (`List<Line>`, `String?`). */
export const DtoField = z.object({ name: z.string(), type: z.string() });
export type DtoField = z.infer<typeof DtoField>;

/**
 * DTO (ADR-38): typ z repo, który jest ciałem żądania albo odpowiedzią endpointu HTTP, wprost albo przez pole innego
 * DTO. Rekord ma pola z nagłówka, `data class` z konstruktora i z ciała, klasa pola instancji (bez `static`, także
 * te, do których Lombok dopisuje akcesory), enum stałe; najwyżej 200 pól albo stałych.
 * Typ bez pól albo stałych nie jest DTO.
 */
export const Dto = z.discriminatedUnion("kind", [
  z.object({
    /** Prosta nazwa typu; typ zagnieżdżony też tylko swoją nazwą (`Inner`, nie `Outer.Inner`). */
    name: z.string(),
    kind: z.enum(["record", "data-class", "class"]),
    fields: z.array(DtoField),
    evidence: Evidence,
  }),
  z.object({ name: z.string(), kind: z.literal("enum"), values: z.array(z.string()), evidence: Evidence }),
]);
export type Dto = z.infer<typeof Dto>;

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

/** Dłuższy tekst nie jest adresem z konfiguracji, a wyrażenia niżej i tak go nie dotkną. */
const MAX_URL_LENGTH = 2048;
const SCHEME = /^[a-z][a-z0-9+.-]{0,20}:\/\//i;
const HTTP_SCHEMES = new Set(["http", "https", "ws", "wss", "lb"]);
const HOST_PORT = /^(\[[^\]\s]{1,64}\]|[^:[\]\s]+)(?::(\d{1,5}))?$/;
/**
 * Człon ścieżki, który wygląda na token (klucz webhooka, identyfikator z hasłem): co najmniej 20 liter i cyfr bez
 * łączników, w tym co najmniej trzy cyfry. Nazwa w kebab-case (`customer-service-v2`) i metoda
 * (`getOrdersByCustomerId2`) nim nie są.
 */
const OPAQUE_SEGMENT = /^(?=(?:\D*\d){3})(?=[^A-Za-z]*[A-Za-z])\w{20,}$/;

/** Adres rozłożony raz, jedną regułą dla `parseHttpUrl` i `withoutCredentials`. */
interface UrlParts {
  /** Schemat z `://`, np. `http://`. */
  scheme: string;
  /** Czy adres ma użytkownika (i hasło) przed hostem. */
  userInfo: boolean;
  /** Host i port, bez użytkownika. */
  authority: string;
  /** Ścieżka bez zapytania i fragmentu, `""` bez ścieżki. */
  path: string;
}

/**
 * Użytkownik i hasło kończą się na ostatnim `@` przed ścieżką, bo hasło może mieć `@`, `?` i `#`; `@` w zapytaniu
 * bez `/` (`http://host?email=a@b`) nie jest użytkownikiem, bo przed `?` nie ma `:` hasła.
 */
function urlParts(text: string): UrlParts | undefined {
  const scheme = SCHEME.exec(text)?.[0];
  if (scheme === undefined) return undefined;
  const rest = text.slice(scheme.length);
  const end = authorityEnd(rest);
  const raw = end < 0 ? rest : rest.slice(0, end);
  const at = raw.lastIndexOf("@");
  const before = at < 0 ? "" : raw.slice(0, at);
  const query = before.search(/[?#]/);
  const userInfo = at >= 0 && (query < 0 || before.slice(0, query).includes(":"));
  const hostPart = userInfo ? raw.slice(at + 1) : raw;
  const hostEnd = hostPart.search(/[?#]/);
  const authority = hostEnd < 0 ? hostPart : hostPart.slice(0, hostEnd);
  const path = hostEnd >= 0 || end < 0 ? "" : (rest.slice(end).split(/[?#\s]/)[0] ?? "");
  return { scheme, userInfo, authority, path };
}

/**
 * Koniec części `user:hasło@host:port` w `rest` (adres bez schematu). Zwykle to pierwszy `/`, ale hasło może mieć `/`
 * (`u:p/ss@host`): gdy przed pierwszym `/` nie ma hosta z portem, a dalej (przed zapytaniem) jest `@`, to `@` kończy
 * hasło, inaczej reszta hasła trafiłaby do ścieżki na karcie.
 */
function authorityEnd(rest: string): number {
  const end = rest.search(/[/\s]/);
  const raw = end < 0 ? rest : rest.slice(0, end);
  if (end < 0 || raw.includes("@") || HOST_PORT.test(withoutPlaceholders(raw))) return end;
  const beforeQuery = rest.slice(0, rest.search(/[?#\s]|$/));
  const at = beforeQuery.lastIndexOf("@");
  if (at < 0) return end;
  const after = rest.slice(at).search(/[/\s]/);
  return after < 0 ? -1 : at + after;
}

/**
 * Adres bez użytkownika, hasła, zapytania i członów ścieżki wyglądających na token (`http://ja:tajne@host/api?key=x`
 * → `http://***@host/api`, `/services/T00/B00/XXXXSECRET1234567890` → `/services/T00/B00/***`): adres z `.env` albo
 * `application.yml` trafia na kartę, do UI i do agenta, a sekret nie może (§8).
 */
export function withoutCredentials(url: string): string {
  const parts = url.length > MAX_URL_LENGTH ? undefined : urlParts(url);
  if (parts === undefined) return maskPath(url.split(/[?#]/)[0] ?? "");
  // Część przed ścieżką, która nie jest hostem z portem, to resztka hasła (z `?`, `#` albo spacją), więc nie trafia na kartę.
  if (!HOST_PORT.test(withoutPlaceholders(parts.authority))) return `${parts.scheme}***`;
  return `${parts.scheme}${parts.userInfo ? "***@" : ""}${parts.authority}${maskPath(parts.path)}`;
}

/** Tekst z `${…}` zastąpionym jednym znakiem: nierozwinięty klucz (`localhost:${PORT}`) może stać w miejscu hosta i portu. */
function withoutPlaceholders(text: string): string {
  return text.replace(/\$\{[^}]{0,256}\}/g, "0");
}

function maskPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? "***" : segment))
    .join("/");
}

/** Adres HTTP z tekstu; `undefined` dla innego tekstu i dla hosta z nierozwiniętym `${…}`. */
export function parseHttpUrl(text: string): HttpUrl | undefined {
  if (text.length > MAX_URL_LENGTH) return undefined;
  const parts = urlParts(text.trim());
  const scheme = parts?.scheme.slice(0, -3).toLowerCase();
  if (!parts || !scheme || !HTTP_SCHEMES.has(scheme)) return undefined;
  const [, host, port] = HOST_PORT.exec(parts.authority) ?? [];
  if (!host || /[${}]/.test(host)) return undefined;
  return { scheme, host: host.toLowerCase(), port: port ? Number(port) : null, path: parts.path };
}

/** Nazwa aplikacji z adresu `lb://nazwa` (load balancer Spring Cloud); `null` dla innego adresu. */
export function lbAppName(url: string): string | null {
  const parsed = parseHttpUrl(url);
  return parsed?.scheme === "lb" ? parsed.host : null;
}

/** Ścieżki sklejone w jedną, z jednym `/` między częściami i bez zapytania: `/api` + `orders/` + `/{id}` → `/api/orders/{id}`. */
export function joinHttpPath(...parts: readonly string[]): string {
  const segments = parts.flatMap((p) => (p.split("?")[0] ?? "").split("/")).filter((s) => s !== "");
  return `/${segments.join("/")}`;
}

/** Człony ścieżki po złożeniu (`/api//orders/` → `["api", "orders"]`), do porównań `httpSegmentsMatch`. */
export function httpPathSegments(path: string): string[] {
  return joinHttpPath(path)
    .split("/")
    .slice(1)
    .filter((s) => s !== "");
}

/**
 * Czy ścieżka wywołania pasuje do ścieżki endpointu: człon po członie, zmienna (`{id}`, `{}`, `*`) z każdej strony
 * pasuje do dowolnego członu, `**` w endpoincie do reszty ścieżki, a nieodczytana stała (`<Klasa.NAZWA>`) tylko do tej samej.
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
