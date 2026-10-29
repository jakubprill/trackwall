import { type ConsumedHttp, type HttpCall, joinHttpPath, parseHttpUrl, withoutCredentials } from "@trackwall/protocol";
import type { OpenApiSpec } from "./openapi-spec.ts";
import { stemOf } from "./repo-path.ts";

/**
 * An OpenAPI spec of another app as an HTTP client of the repo (§4.6, ADR-129): a frontend, or a Java build that generates
 * a client from the spec, keeps the spec of the app it calls, and the generated client is not in the repo (it is built
 * from the spec), so the spec's operations are the calls the repo can make. The graph matches them with the endpoints of
 * other repos by `operationId` and by path with a different prefix, since a spec copied and normalised by a tool (a
 * bundler adding a prefix, a gateway in `servers`) keeps its operations but not their exact paths.
 */

/**
 * The client of spec `path`: named by the spec's title (else the file name), with the first server address when it is
 * absolute (the host can name the app), and every operation as a call. A relative server path (`/orders-bff/api`) has no
 * host, so it goes in front of each call's path instead.
 */
export function specClient(path: string, spec: OpenApiSpec): ConsumedHttp {
  const url = spec.serverUrl !== null && parseHttpUrl(spec.serverUrl) ? withoutCredentials(spec.serverUrl) : null;
  const prefix = url === null ? spec.basePath : "";
  const calls: HttpCall[] = spec.operations.map((op) => ({
    method: op.method,
    path: joinHttpPath(prefix, op.path),
    operationId: op.id,
    evidence: { path, line: op.line },
  }));
  const evidence = { path, line: null };
  return {
    kind: "http",
    via: "openapi",
    name: spec.title ?? stemOf(path),
    app: null,
    url,
    profiles: [],
    urlSource: url === null ? null : evidence,
    calls,
    evidence,
  };
}
