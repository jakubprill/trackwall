import { z } from "zod";
import { Evidence } from "./evidence.ts";

/**
 * HTTP facts on the repo card (§4.6, ADR-30): Spring Boot applications, the endpoints they provide, and the HTTP clients
 * a repo calls other applications with, read from Java and Kotlin code, `application*.yml` / `.properties` with profiles,
 * and `.env` files and frontend proxies. The graph joins clients with applications and endpoints of other repos.
 */

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethod>;

/**
 * A Spring Boot application in the repo: a module with `spring.application.name` in `src/main/resources/application*` or
 * `bootstrap*`. Clients call it by this name through discovery (Feign `name`, `lb://name`, a name in the Kubernetes
 * cluster DNS).
 */
export const ProvidedApp = z.object({
  kind: z.literal("app"),
  name: z.string(),
  /** `server.port` from the default profile; `null` without an entry (the card does not guess the default 8080). */
  port: z.number().int().min(0).max(65535).nullable(),
  /** The module's directory in the repo (`""` for the root), holding `src/main/resources` and this application's code. */
  module: z.string(),
  evidence: Evidence,
});
export type ProvidedApp = z.infer<typeof ProvidedApp>;

/** A DTO field: name and type in type notation like `ProvidedEndpoint.request` (`List<Line>`, `String?`). */
export const DtoField = z.object({ name: z.string(), type: z.string() });
export type DtoField = z.infer<typeof DtoField>;

/**
 * A DTO (ADR-38): a type from the repo that is the request body or response of an HTTP endpoint, directly or through a
 * field of another DTO. A record has the fields from its header, a `data class` from its constructor and body, a class
 * its instance fields (without `static`, including those Lombok adds accessors to), an enum its constants; at most 200
 * fields or constants. A type without fields or constants is not a DTO.
 */
export const Dto = z.discriminatedUnion("kind", [
  z.object({
    /** The simple type name; a nested type also just by its own name (`Inner`, not `Outer.Inner`). */
    name: z.string(),
    kind: z.enum(["record", "data-class", "class"]),
    fields: z.array(DtoField),
    evidence: Evidence,
  }),
  z.object({ name: z.string(), kind: z.literal("enum"), values: z.array(z.string()), evidence: Evidence }),
]);
export type Dto = z.infer<typeof Dto>;

/**
 * Where an HTTP client comes from: an `@FeignClient` interface, an `@HttpExchange` interface (Spring 6), `WebClient`,
 * `RestClient` or `RestTemplate` calls in a class, an address in the Spring configuration (`config`), a variable in a
 * frontend's `.env` (`env`), the proxy target of a frontend dev server (`proxy`) or an OpenAPI spec of another app that
 * the repo keeps to generate its client from (`openapi`, ADR-129).
 */
export const HttpClientVia = z.enum([
  "feign",
  "http-interface",
  "webclient",
  "rest-client",
  "rest-template",
  "config",
  "env",
  "proxy",
  "openapi",
]);
export type HttpClientVia = z.infer<typeof HttpClientVia>;

/** One client call: the method and the path without the base address (`/orders/{id}`). */
export const HttpCall = z.object({
  /** `null` when the code does not say which method it calls with. */
  method: HttpMethod.nullable(),
  /** The path relative to the client address, with `{…}` variables; a part built from a variable in code is `{}`. */
  path: z.string(),
  /** The `operationId` of a call from an OpenAPI spec (ADR-129); `null` for a call read from code, or without one. */
  operationId: z.string().nullable(),
  evidence: Evidence,
});
export type HttpCall = z.infer<typeof HttpCall>;

/** A client call an endpoint's handler reaches (ADR-82): the client and the call as on the same card. */
export const EndpointReach = z.object({
  via: HttpClientVia,
  /** The client name from the card (a Feign interface, a class with calls). */
  client: z.string(),
  method: HttpMethod.nullable(),
  /** The call path relative to the client address, as in `HttpCall.path`. */
  path: z.string(),
  /** The call's file and line, the same as the `HttpCall.evidence` of the client on the card. */
  evidence: Evidence,
});
export type EndpointReach = z.infer<typeof EndpointReach>;

/**
 * Where an endpoint on the card comes from: `code` is a mapping in a Spring controller, `openapi` an operation of an
 * OpenAPI (or Swagger 2) spec in the repo that no mapping in the code matches, e.g. because the interface with the
 * mappings is generated from the spec during the build and is not in the repo (ADR-87).
 */
export const EndpointSource = z.enum(["code", "openapi"]);
export type EndpointSource = z.infer<typeof EndpointSource>;

/** The operation of an OpenAPI spec in the repo that describes an endpoint (ADR-87). */
export const OpenApiOperation = z.object({
  /** `operationId`; `null` without one. */
  id: z.string().nullable(),
  /** `summary`, or without it the first line of `description`, cut to 200 characters; `null` without either. */
  summary: z.string().nullable(),
  /** The spec file and the line of the operation (its HTTP method key). */
  evidence: Evidence,
});
export type OpenApiOperation = z.infer<typeof OpenApiOperation>;

/**
 * An HTTP endpoint from a Spring controller (`@RestController`, `@Controller` with `@*Mapping`) or from an OpenAPI spec in
 * the repo (ADR-87).
 */
export const ProvidedEndpoint = z.object({
  kind: z.literal("endpoint"),
  source: EndpointSource,
  /** `null`: `@RequestMapping` without `method`, that is any method. */
  method: HttpMethod.nullable(),
  /**
   * The full path: the application's context path (`server.servlet.context-path`), the class prefix and the method path,
   * with variables as in the code (`/api/orders/{id}`). A constant that cannot be read stays as `<Class.NAME>`.
   */
  path: z.string(),
  /** The application name of the module the controller is in; `null` when the module does not give one. */
  app: z.string().nullable(),
  /**
   * The controller's `Class.method`. For an endpoint from a spec, the controller method named like the `operationId`
   * (as the OpenAPI generator names the interface method it implements); `null` when the repo has no such method, or several.
   */
  handler: z.string().nullable(),
  /**
   * The request body type (the parameter with `@RequestBody`) in type notation (`CreateOrder`, `List<Line>`); `null`
   * without a body or when the file's syntax tree could not be built (ADR-38). For an endpoint from a spec, the schema
   * name of the JSON body (`CreateOrder`, `List<Line>`, `string`). Type notation is the text from the code
   * without annotations, with a space only between words or after `?` (`List<? extends Line>`); longer than 256
   * characters it is cut with "…".
   */
  request: z.string().nullable(),
  /**
   * The response type: the return type without wrappers that do not change the content (`ResponseEntity<T>`, `Mono<T>`,
   * `Optional<T>`…), in type notation like `request`; `null` without content (`void`, `Unit`, `ResponseEntity<Void>`,
   * `ResponseEntity<*>`, a bare `ResponseEntity`), without an explicit type (a Kotlin expression function) or without a
   * syntax tree (ADR-38). For an endpoint from a spec, the schema of the first 2xx response, like `request`.
   */
  response: z.string().nullable(),
  /**
   * The HTTP calls of this card's clients that the handler reaches through the repo's Java code (ADR-82): every call
   * some path of method calls from the handler leads to, also through an interface to each of its implementations in the
   * repo. `null` when the card could not trace (`RepoCard.reachTraced`) or the call graph has no method for the handler.
   */
  reaches: z.array(EndpointReach).nullable(),
  /** The OpenAPI operation describing this endpoint (ADR-87); `null` when no spec in the repo does. */
  operation: OpenApiOperation.nullable(),
  /** The mapping in the code; for an endpoint from a spec, the operation in the spec. */
  evidence: Evidence,
});
export type ProvidedEndpoint = z.infer<typeof ProvidedEndpoint>;

/** An HTTP client: whom the repo calls (an application name or an address) and, when the code says, which calls. */
export const ConsumedHttp = z.object({
  kind: z.literal("http"),
  via: HttpClientVia,
  /** The client name for a person: a Feign interface, a class with calls, a configuration key or a `.env` variable. */
  name: z.string(),
  /** The application name in discovery: Feign `name`/`value`, the host from `lb://`; `null` when the client calls an address. */
  app: z.string().nullable(),
  /** The base address after expanding `${…}` from the configuration (`http://orders:8080/api`); unexpanded it stays as in the file. */
  url: z.string().nullable(),
  /**
   * The Spring profiles in which the client has this address: `default` is the configuration without a profile; another
   * profile is here only when it changes the address. Empty for a client without configuration (a frontend, an address
   * written in code).
   */
  profiles: z.array(z.string()),
  /** The configuration entry the address comes from (`application-prod.yml:12`); `null` when the address is in code or missing. */
  urlSource: Evidence.nullable(),
  calls: z.array(HttpCall),
  evidence: Evidence,
});
export type ConsumedHttp = z.infer<typeof ConsumedHttp>;

/** An HTTP address split into parts: as much as the graph needs to match it to an application of another repo. */
export interface HttpUrl {
  /** `http`, `https`, `ws`, `wss` or `lb` (Spring Cloud load balancer: the host is the application name in discovery). */
  scheme: string;
  /** The host in lowercase. */
  host: string;
  port: number | null;
  /** The path without the query, `""` without a path. */
  path: string;
}

/** Longer text is not an address from configuration, and the expressions below would not touch it anyway. */
const MAX_URL_LENGTH = 2048;
/** A scheme of up to four words, as JDBC writes it (`jdbc:postgresql://`). */
const SCHEME = /^[a-z][a-z0-9+.-]{0,20}(?::[a-z][a-z0-9+.-]{0,20}){0,3}:\/\//i;
const HTTP_SCHEMES = new Set(["http", "https", "ws", "wss", "lb"]);
const HOST_PORT = /^(\[[^\]\s]{1,64}\]|[^:[\]\s]+)(?::(\d{1,5}))?$/;
/**
 * A path segment that looks like a token (a webhook key, an id with a secret): at least 20 letters and digits without
 * hyphens, including at least three digits. A kebab-case name (`customer-service-v2`) and a method
 * (`getOrdersByCustomerId2`) are not.
 */
const OPAQUE_SEGMENT = /^(?=(?:\D*\d){3})(?=[^A-Za-z]*[A-Za-z])\w{20,}$/;

/** An address split once, by one rule for `parseHttpUrl` and `withoutCredentials`. */
interface UrlParts {
  /** The scheme with `://`, for example `http://`. */
  scheme: string;
  /** Whether the address has a user (and password) before the host. */
  userInfo: boolean;
  /** Host and port, without the user. */
  authority: string;
  /** The path without the query and fragment, `""` without a path. */
  path: string;
}

/**
 * The user and password end at the last `@` before the path, because a password can contain `@`, `?` and `#`; an `@` in
 * a query without `/` (`http://host?email=a@b`) is not a user, because there is no password `:` before the `?`.
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
 * The end of the `user:password@host:port` part in `rest` (an address without the scheme). Usually it is the first `/`,
 * but a password can contain `/` (`u:p/ss@host`): when there is no host with a port before the first `/`, and an `@`
 * follows (before the query), that `@` ends the password; otherwise the rest of the password would land in the path on the card.
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
 * The address without the user, password, query and path segments that look like tokens (`http://me:secret@host/api?key=x`
 * → `http://***@host/api`, `/services/T00/B00/XXXXSECRET1234567890` → `/services/T00/B00/***`): an address from `.env` or
 * `application.yml` reaches the card, the UI and the agent, and a secret must not (§8).
 */
export function withoutCredentials(url: string): string {
  const parts = url.length > MAX_URL_LENGTH ? undefined : urlParts(url);
  if (parts === undefined) return maskPath(url.split(/[?#]/)[0] ?? "");
  // A part before the path that is not a host with a port is the rest of a password (with `?`, `#` or a space), so it does not reach the card.
  if (!HOST_PORT.test(withoutPlaceholders(parts.authority))) return `${parts.scheme}***`;
  return `${parts.scheme}${parts.userInfo ? "***@" : ""}${parts.authority}${maskPath(parts.path)}`;
}

/**
 * An address inside free text: a scheme in the form `SCHEME` reads (so `withoutCredentials` always splits it) and what
 * follows up to a space, comma, semicolon or quote.
 */
const ADDRESS_IN_TEXT = /[a-z][a-z0-9+.-]{0,20}(?::[a-z][a-z0-9+.-]{0,20}){0,3}:\/\/[^\s,;"']*/gi;
/** Oracle's `user/password@host` (`jdbc:oracle:thin:scott/tiger@//db:1521/orders`), which has no `://` to find it by. */
const SLASH_CREDENTIALS = /[^\s/@:=]+\/[^\s/@]+@/g;

/**
 * Every address in free text without its user, password and query, by `withoutCredentials`, and Oracle's
 * `user/password@` as `***@`: a Spring configuration value (ADR-153) may hold several addresses or an address inside
 * other words. A longer text than an address may be is hidden whole when it holds one.
 */
export function withoutCredentialsInText(text: string): string {
  if (text.length > MAX_URL_LENGTH && (text.includes("://") || text.includes("@"))) return "***";
  return text.replace(ADDRESS_IN_TEXT, (address) => withoutCredentials(address)).replace(SLASH_CREDENTIALS, "***@");
}

/** Text with `${…}` replaced by a single character: an unexpanded key (`localhost:${PORT}`) can stand in place of the host and port. */
function withoutPlaceholders(text: string): string {
  return text.replace(/\$\{[^}]{0,256}\}/g, "0");
}

function maskPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? "***" : segment))
    .join("/");
}

/** An HTTP address from text; `undefined` for other text and for a host with an unexpanded `${…}`. */
export function parseHttpUrl(text: string): HttpUrl | undefined {
  if (text.length > MAX_URL_LENGTH) return undefined;
  const parts = urlParts(text.trim());
  const scheme = parts?.scheme.slice(0, -3).toLowerCase();
  if (!parts || !scheme || !HTTP_SCHEMES.has(scheme)) return undefined;
  const [, host, port] = HOST_PORT.exec(parts.authority) ?? [];
  if (!host || /[${}]/.test(host)) return undefined;
  return { scheme, host: host.toLowerCase(), port: port ? Number(port) : null, path: parts.path };
}

/** The application name from an `lb://name` address (Spring Cloud load balancer); `null` for other addresses. */
export function lbAppName(url: string): string | null {
  const parsed = parseHttpUrl(url);
  return parsed?.scheme === "lb" ? parsed.host : null;
}

/**
 * The path of an address without the scheme, host, query and fragment (`https://host:8080/api/v1?x=1` → `/api/v1`); text
 * without a scheme and host is a path already and loses only its query (`/api?x` → `/api`).
 */
export function httpUrlPath(text: string): string {
  if (text.length > MAX_URL_LENGTH) return "";
  return urlParts(text)?.path ?? text.split(/[?#]/)[0] ?? "";
}

/** Paths joined into one, with one `/` between parts and without a query: `/api` + `orders/` + `/{id}` → `/api/orders/{id}`. */
export function joinHttpPath(...parts: readonly string[]): string {
  const segments = parts.flatMap((p) => (p.split("?")[0] ?? "").split("/")).filter((s) => s !== "");
  return `/${segments.join("/")}`;
}

/** Path segments after joining (`/api//orders/` → `["api", "orders"]`), for comparisons in `httpSegmentsMatch`. */
export function httpPathSegments(path: string): string[] {
  return joinHttpPath(path)
    .split("/")
    .slice(1)
    .filter((s) => s !== "");
}

/**
 * Whether a call path matches an endpoint path: segment by segment, a variable (`{id}`, `{}`, `*`) on either side matches
 * any segment, `**` in the endpoint matches the rest of the path, and an unread constant (`<Class.NAME>`) only the same one.
 */
export function httpPathMatches(call: string, endpoint: string): boolean {
  return httpSegmentsMatch(httpPathSegments(call), httpPathSegments(endpoint));
}

/** `httpPathMatches` on segments computed once (`httpPathSegments`), when one path is compared with many. */
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

/** Whether the methods of the call and the endpoint agree; `null` on either side means any method. */
export function httpMethodMatches(call: HttpMethod | null, endpoint: HttpMethod | null): boolean {
  return call === null || endpoint === null || call === endpoint;
}
