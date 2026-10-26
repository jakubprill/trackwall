import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsumedHttp, ProvidedEndpoint } from "@trackwall/protocol";
import { type CallFile, readJavaCalls } from "../src/modules/cards/call-index-java.ts";
import { CallIndex, traceClosure, traceEndpoints } from "../src/modules/cards/endpoint-trace.ts";
import { extractSpring, isJvmSource } from "../src/modules/cards/spring.ts";
import { moduleOf, readsSpringConfigFile } from "../src/modules/cards/spring-config.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";

/**
 * SPIKE (issue #120): runs the endpoint trace on a cloned repo and prints accuracy inputs and timings.
 * `bun packages/daemon/scripts/spike-endpoint-trace.ts <repo dir> [<detail.json>]`
 */
const [dir, out] = process.argv.slice(2);
if (!dir) throw new Error("usage: spike-endpoint-trace.ts <repo dir> [<detail.json>]");

const t0 = performance.now();
const paths = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter(Boolean);
const texts = new Map<string, string>();
for (const p of paths) if (isJvmSource(p) || readsSpringConfigFile(p)) texts.set(p, readFileSync(join(dir, p), "utf8"));
const tRead = performance.now();

const facts = extractSpring({ commit: "spike", paths, text: (p) => texts.get(p), typeFiles: new Set(), problems: [] });
const endpoints = facts.provides.filter((p): p is ProvidedEndpoint => p.kind === "endpoint");
const clients = facts.consumes.filter((c): c is ConsumedHttp => c.kind === "http");
const tExtract = performance.now();

const parsers = await loadSyntaxParsers();
const files: CallFile[] = [];
let failed = 0;
let slowest = 0;
for (const [path, text] of texts) {
  if (!path.endsWith(".java") || !isJvmSource(path)) continue;
  const s = performance.now();
  const read = parsers.read("java", text, (root) => readJavaCalls(path, root));
  slowest = Math.max(slowest, performance.now() - s);
  if (read.kind === "parsed") files.push(read.value);
  else failed++;
}
const tParse = performance.now();
const index = new CallIndex(files);
const tIndex = performance.now();
const traces = traceEndpoints(endpoints, clients, index);
const tTrace = performance.now();
const maxDispatch = Number(process.env.MAX_DISPATCH ?? 8);
const closure = traceClosure(endpoints, clients, index, maxDispatch);
const tClosure = performance.now();
const closureWith = closure.traces.filter((t) => t.calls.length > 0);
// Where the bounded trace was not cut, the closure without a dispatch cap must agree with it.
const uncapped = process.env.COMPARE ? traceClosure(endpoints, clients, index, Number.POSITIVE_INFINITY).traces : [];
const disagree = uncapped.filter((c, i) => !traces[i]?.truncated && c.calls.length !== traces[i]?.calls.length).length;

const callsInModule = new Map<string, number>();
for (const c of clients)
  for (const call of c.calls) callsInModule.set(moduleOf(call.evidence.path), (callsInModule.get(moduleOf(call.evidence.path)) ?? 0) + 1);
const repoCalls = clients.reduce((n, c) => n + c.calls.length, 0);
const withCalls = traces.filter((t) => t.calls.length > 0);
const inCallingModules = traces.filter((t, i) => (callsInModule.get(moduleOf(endpoints[i]?.evidence.path ?? "")) ?? 0) > 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const invocations = sum(files.flatMap((f) => f.types.flatMap((t) => t.methods.map((m) => m.invocations.length))));
const summary = {
  repo: dir,
  javaFiles: files.length,
  parseFailed: failed,
  methods: sum(files.flatMap((f) => f.types.map((t) => t.methods.length))),
  invocations,
  endpoints: endpoints.length,
  handlersFound: traces.filter((t) => t.found).length,
  clients: clients.length,
  repoCalls,
  endpointsInModulesWithCalls: inCallingModules.length,
  endpointsReachingCalls: withCalls.length,
  avgReachedPerEndpointWithCalls: withCalls.length ? +(sum(withCalls.map((t) => t.calls.length)) / withCalls.length).toFixed(2) : 0,
  avgModuleCallsPerEndpoint: inCallingModules.length
    ? +(
        sum(
          inCallingModules.map(
            (_, i) => callsInModule.get(moduleOf(endpoints[traces.indexOf(inCallingModules[i] as never)]?.evidence.path ?? "")) ?? 0,
          ),
        ) / inCallingModules.length
      ).toFixed(2)
    : 0,
  truncated: traces.filter((t) => t.truncated).length,
  maxSteps: Math.max(0, ...traces.map((t) => t.steps)),
  maxDepth: Math.max(0, ...traces.map((t) => t.depth)),
  unresolvedShare: +(sum(traces.map((t) => t.unresolved)) / Math.max(1, sum(traces.map((t) => t.unresolved + t.external)))).toFixed(2),
  ms: {
    readFiles: Math.round(tRead - t0),
    extractCard: Math.round(tExtract - tRead),
    parseCalls: Math.round(tParse - tExtract),
    slowestFile: Math.round(slowest),
    index: Math.round(tIndex - tParse),
    trace: Math.round(tTrace - tIndex),
    total: Math.round(tTrace - t0),
  },
  closure: {
    maxDispatch,
    ...closure.stats,
    endpointsReachingCalls: closureWith.length,
    avgReached: closureWith.length ? +(sum(closureWith.map((t) => t.calls.length)) / closureWith.length).toFixed(2) : 0,
    maxReached: Math.max(0, ...closure.traces.map((t) => t.calls.length)),
    ms: Math.round(tClosure - tTrace),
    disagreeWithBoundedTrace: process.env.COMPARE ? disagree : "not compared",
  },
  rssMb: Math.round(process.memoryUsage().rss / 1e6),
};
console.log(JSON.stringify(summary, null, 2));
if (out) {
  const detail = traces.map((t) => ({
    endpoint: t.endpoint,
    handler: t.handler,
    found: t.found,
    steps: t.steps,
    truncated: t.truncated,
    calls: t.calls.map((c) => ({
      client: c.client,
      via: c.via,
      app: c.app,
      url: c.url,
      method: c.call.method,
      path: c.call.path,
      at: `${c.call.evidence.path}:${c.call.evidence.line}`,
      chain: c.chain.join(" > "),
    })),
  }));
  const closureDetail = closure.traces
    .filter((t) => t.calls.length > 0)
    .map((t) => ({
      endpoint: t.endpoint,
      handler: t.handler,
      calls: t.calls.map((c) => `${c.client} ${c.call.method} ${c.call.path} @${c.call.evidence.path}:${c.call.evidence.line}`),
    }));
  writeFileSync(
    out,
    JSON.stringify(
      {
        summary,
        closureDetail,
        clients: clients.map((c) => ({
          name: c.name,
          via: c.via,
          app: c.app,
          url: c.url,
          calls: c.calls.map((x) => `${x.method} ${x.path} @${x.evidence.path}:${x.evidence.line}`),
        })),
        detail,
      },
      null,
      2,
    ),
  );
}
