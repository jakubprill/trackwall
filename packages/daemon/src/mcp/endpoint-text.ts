import type { EndpointCallee, EndpointCaller, EndpointRef, FindEndpointResult, FoundEndpoint, HttpMethod } from "@trackwall/protocol";
import { evidenceLabel, MAX_FOUND_ENDPOINTS } from "@trackwall/protocol";

/**
 * The text of a `find_endpoint` result, which is all the model behind Copilot CLI reads of it (ADR-187). Each endpoint
 * is a block, best match first:
 *
 * ```
 * GET /owners/{ownerId} in customers-service (app customers), match path
 *   handler OwnerResource.findOwner at src/.../OwnerResource.java:67; response Owner
 *   caller api-gateway: CustomersServiceClient (webclient, exact) GET /owners/{ownerId} at src/.../CustomersServiceClient.java:37
 *     from GET /api/gateway/owners/{ownerId} ApiGatewayController.getOwnerDetails
 *   calls nothing in other repos
 * ```
 *
 * An endpoint without a method (any method) has `ANY`, a call whose method the code does not say `?`; `from` and `calls` that were not traced say so instead of listing nothing.
 */
export function findEndpointText(result: FindEndpointResult): string {
  if (result.endpoints.length === 0) return `No endpoints match ${result.query}.`;
  const lines = result.endpoints.flatMap(endpointLines);
  if (result.truncated) lines.push(`Truncated: more than ${MAX_FOUND_ENDPOINTS} endpoints match; narrow the query.`);
  return lines.join("\n");
}

function endpointLines(endpoint: FoundEndpoint): string[] {
  const app = endpoint.app === null ? "" : ` (app ${endpoint.app})`;
  return [
    `${methodLabel(endpoint.method)} ${endpoint.path} in ${endpoint.repo}${app}, match ${endpoint.match}`,
    `  ${contractLine(endpoint)}`,
    ...(endpoint.operation === null ? [] : [`  ${operationLine(endpoint.operation)}`]),
    ...(endpoint.callers.length === 0 ? ["  no callers found"] : endpoint.callers.flatMap(callerLines)),
    ...calleeLines(endpoint.calls),
  ];
}

function contractLine(endpoint: FoundEndpoint): string {
  const where = evidenceLabel(endpoint.evidence);
  const handler = endpoint.handler === null ? `no handler, at ${where}` : `handler ${endpoint.handler} at ${where}`;
  return [
    endpoint.source === "openapi" ? `only in an OpenAPI spec, ${handler}` : handler,
    endpoint.request === null ? undefined : `request ${endpoint.request}`,
    endpoint.response === null ? undefined : `response ${endpoint.response}`,
  ]
    .filter((part) => part !== undefined)
    .join("; ");
}

function operationLine(operation: NonNullable<FoundEndpoint["operation"]>): string {
  const summary = operation.summary === null ? "" : `: ${operation.summary}`;
  return `operation ${operation.id ?? "without operationId"} at ${evidenceLabel(operation.evidence)}${summary}`;
}

function callerLines(caller: EndpointCaller): string[] {
  const head = `  caller ${caller.repo}: ${caller.client} (${caller.via}, ${caller.confidence}) ${caller.method ?? "?"} ${caller.path} at ${evidenceLabel(caller.evidence)}`;
  if (caller.from === null) return [head, "    from: not traced, any endpoint of the repo may make the call"];
  if (caller.from.length === 0) return [head, "    from: no endpoint (a scheduled job, a listener or startup code)"];
  return [head, ...caller.from.map((from) => `    from ${refLabel(from)}`)];
}

function calleeLines(calls: readonly EndpointCallee[] | null): string[] {
  if (calls === null) return ["  calls: not traced"];
  if (calls.length === 0) return ["  calls nothing in other repos"];
  return calls.map(
    (callee) =>
      `  calls ${callee.repo} ${refLabel(callee)} through ${callee.client} (${callee.via}, ${callee.confidence}) at ${evidenceLabel(callee.evidence)}`,
  );
}

function refLabel(ref: EndpointRef): string {
  return `${methodLabel(ref.method)} ${ref.path}${ref.handler === null ? "" : ` ${ref.handler}`}`;
}

function methodLabel(method: HttpMethod | null): string {
  return method ?? "ANY";
}
