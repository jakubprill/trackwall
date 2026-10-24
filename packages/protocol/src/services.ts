import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { HttpMethod } from "./http.ts";
import { LogError } from "./logs.ts";
import { RunState } from "./procs.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `services` module (§4.3, ADR-45): a service is a repo and its mise task `dev`, with a port and
 * a readiness that the daemon observes. Starting a service also starts the services it calls (HTTP and manual edges
 * of the graph), dependencies first, and an endpoint call goes only to the port of a service the daemon started.
 * Each action is `POST /api/services/<action>`.
 */

/** The mise task that runs a service; the same kind of convention as `setup` and `build` in the batch command (ADR-27). */
export const SERVICE_MISE_TASK = "dev";

/**
 * Observed state of a service: `starting` until its port answers (or a Spring Boot app without a web server reports
 * it has started), `healthy` while the port answers, `unhealthy` when it stops answering or never opened within the
 * startup limit, `crashed` when the process group ended by itself, `stopped` after a stop, `stopping` in between.
 */
export const ServiceState = z.enum(["starting", "healthy", "unhealthy", "stopping", "stopped", "crashed"]);
export type ServiceState = z.infer<typeof ServiceState>;

/** Where the port comes from: `server.port` on the repo card or a line of the service log (`Tomcat started on port 8081`). */
export const ServicePortSource = z.enum(["card", "log"]);
export type ServicePortSource = z.infer<typeof ServicePortSource>;

export const Service = z.object({
  repo: RepoId,
  state: ServiceState,
  /** The port that answered (or the one waited for); `null` until one is known. */
  port: z.number().int().min(1).max(65535).nullable(),
  portSource: ServicePortSource.nullable(),
  /** The run of the mise task `dev` (§4.1). */
  run: RunState,
  /** ISO 8601, the last change of `state`. */
  since: z.string(),
  /** Why the service is `unhealthy`, `crashed` or still `starting`, as a sentence; `null` otherwise. */
  reason: z.string().nullable(),
});
export type Service = z.infer<typeof Service>;

/**
 * One repo of a slice (the service asked for and everything it calls). `pending`: waiting for its dependencies to
 * settle; `started`: the daemon started it for this slice; `running`: it was already running; `skipped`: not started,
 * with the reason in `problem` (no mise task `dev`, mise unavailable, the config not trusted, its port already taken).
 */
export const SliceMember = z.object({
  repo: RepoId,
  /** The repos that call this one within the slice, with the edge key (app name, address, note); empty for the root. */
  calledBy: z.array(z.object({ repo: RepoId, key: z.string() })),
  outcome: z.enum(["pending", "started", "running", "skipped"]),
  service: Service.nullable(),
  problem: z.string().nullable(),
  /** Errors from the service log of its current run, the most recent first; only for `crashed` and `unhealthy`. */
  errors: z.array(LogError),
});
export type SliceMember = z.infer<typeof SliceMember>;

/** Whether a repo's mise tasks include the one that runs its service. */
export function hasService(tasks: readonly { name: string }[]): boolean {
  return tasks.some((t) => t.name === SERVICE_MISE_TASK);
}

/** At most this many repos in one slice; a larger one is a sign the graph pulls in half of the projects folder. */
export const MAX_SLICE_REPOS = 12;

export const ServiceSlice = z.object({
  repo: RepoId,
  /** Dependencies first (in the order they start), the repo asked for last. */
  members: z.array(SliceMember),
  /** Every member has settled (not `starting`); `false` when the wait ended first. */
  settled: z.boolean(),
});
export type ServiceSlice = z.infer<typeof ServiceSlice>;

export const StartServiceRequest = z
  .object({
    repo: RepoId,
    /** Also start the services it calls (graph edges `http` and `manual`, not `low` confidence), transitively. */
    dependencies: z.boolean(),
    /** How long to wait for the slice to settle before answering; the start goes on in the background. */
    waitMs: z.number().int().min(0).max(55_000),
  })
  .strict();
export type StartServiceRequest = z.infer<typeof StartServiceRequest>;

export const StopServiceRequest = z
  .object({
    repo: RepoId,
    /** Also stop the dependencies the latest start of this repo started (not the ones that were already running). */
    dependencies: z.boolean(),
  })
  .strict();
export type StopServiceRequest = z.infer<typeof StopServiceRequest>;

/** Request headers the daemon sets itself; the caller cannot override them. */
const RESERVED_HEADERS = ["host", "content-length", "transfer-encoding", "connection"];

/** An HTTP header name (RFC 9110 token) that is not one of `RESERVED_HEADERS`. */
const HeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/)
  .refine((name) => !RESERVED_HEADERS.includes(name.toLowerCase()), "set by the daemon");

/** Request body limit: enough for a JSON payload, far below the 256 KB limit of an MCP request. */
export const CALL_BODY_MAX_CHARS = 64 * 1024;
/** Response body returned to the caller; the rest is cut (`truncated`). */
export const CALL_RESPONSE_MAX_CHARS = 32 * 1024;

export const CallEndpointRequest = z
  .object({
    repo: RepoId,
    method: HttpMethod,
    /** Path with the query, e.g. `/api/orders/42?expand=lines`. */
    path: z
      .string()
      .max(2000)
      .regex(/^\/[^\s#]*$/, "a path starting with / without spaces or #"),
    headers: z
      .record(
        HeaderName,
        z
          .string()
          .max(4000)
          .regex(/^[^\r\n]*$/, "one line"),
      )
      .refine((h) => Object.keys(h).length <= 20, "at most 20 headers"),
    body: z.string().max(CALL_BODY_MAX_CHARS).nullable(),
    timeoutMs: z.number().int().min(100).max(55_000),
  })
  .strict();
export type CallEndpointRequest = z.infer<typeof CallEndpointRequest>;

export const CallResponse = z.object({
  status: z.number().int(),
  /** `content-type`, `location` and the other headers, one value per name (repeated ones joined with `, `). */
  headers: z.record(z.string(), z.string()),
  /** UTF-8 text with secrets from the service environment masked; at most `CALL_RESPONSE_MAX_CHARS`. */
  body: z.string(),
  truncated: z.boolean(),
});
export type CallResponse = z.infer<typeof CallResponse>;

export const CallEndpointResult = z.object({
  /** `http://127.0.0.1:<port><path>` (or `[::1]`, whichever answered). */
  url: z.string(),
  method: HttpMethod,
  /** `null` when there is no response: `failure` says why (connection refused, timeout). */
  response: CallResponse.nullable(),
  failure: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  /**
   * Errors that started in the logs of running services during the call and shortly after it, the most recent first
   * (`get_errors` of the mise task `dev`).
   */
  errors: z.array(LogError),
});
export type CallEndpointResult = z.infer<typeof CallEndpointResult>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/services/${action}`, request, data };
}

export const servicesApi = {
  /** Services the daemon started or watched since it started, in the order they were first started. */
  list: endpoint("list", z.object({}).strict(), z.array(Service)),
  start: endpoint("start", StartServiceRequest, ServiceSlice),
  stop: endpoint("stop", StopServiceRequest, z.array(Service)),
};
