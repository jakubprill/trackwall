import type { IncomingHttpHeaders } from "node:http";
import { CALL_RESPONSE_MAX_CHARS, type CallEndpointRequest, type CallResponse } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { loopbackRequest } from "../../infra/loopback.ts";
import type { ServiceAddress } from "./service-watch.ts";

/**
 * One HTTP request to a running service (ADR-45): to the loopback address and port that answered its probe, with the
 * method, path, headers and body from the caller. The URL is built here, so the request cannot leave the machine or
 * reach a port Trackwall does not run a service on. The body is read up to a limit, so a stream without an end does
 * not hold the call.
 */

/** Bytes of the response read; four bytes per character is the most UTF-8 needs for `CALL_RESPONSE_MAX_CHARS`. */
const READ_MAX_BYTES = CALL_RESPONSE_MAX_CHARS * 4;

export type EndpointOutcome = { kind: "response"; response: CallResponse } | { kind: "failure"; message: string };

export async function callEndpoint(
  address: ServiceAddress,
  request: Omit<CallEndpointRequest, "repo">,
  mask: (text: string) => string,
): Promise<EndpointOutcome> {
  try {
    const res = await loopbackRequest(address.port, request.path, {
      host: address.host,
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      timeoutMs: request.timeoutMs,
      maxBodyBytes: READ_MAX_BYTES,
    });
    const body = mask(res.body);
    return {
      kind: "response",
      response: {
        status: res.status,
        headers: flatHeaders(res.headers, mask),
        body: body.slice(0, CALL_RESPONSE_MAX_CHARS),
        truncated: res.truncated || body.length > CALL_RESPONSE_MAX_CHARS,
      },
    };
  } catch (err) {
    return { kind: "failure", message: messageOf(err) };
  }
}

/** Address for the result, in URL form (`[::1]` for IPv6). */
export function addressUrl(address: ServiceAddress, path: string): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `http://${host}:${address.port}${path}`;
}

function flatHeaders(headers: IncomingHttpHeaders, mask: (text: string) => string): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) flat[name] = mask(Array.isArray(value) ? value.join(", ") : value);
  }
  return flat;
}
