import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import {
  CallEndpointResult,
  FindEndpointResult,
  LogErrors,
  MiseTaskRunResult,
  RepoCardResult,
  type RunState,
  StartServiceResult,
  StopServiceResult,
  TestResults,
  VerifyTaskResult,
} from "@trackwall/protocol";
import { connectHttpClient } from "../test/support/mcp-client.ts";
import { startSessionApi } from "../test/support/session-api.ts";

// What Trackwall reads from Java builds, checked on real Spring Boot projects built by real Maven and Gradle through
// real mise (ADR-72, docs/development.md, "Tests with real Java builds"): the card, the graph, services, test reports,
// the verification of a task and log errors. The unit tests check the same features on handwritten files and logs; a
// failure here means a real build tool writes something those files no longer show. Run by `jvm.yml` every night and
// on PRs that touch the code it covers, not in `pnpm test`, since a run needs network and minutes the first time.

const PROJECTS = join(import.meta.dir, "projects");
const TOKEN = "j".repeat(43);
/** The ports in each project's `application.properties`. */
const ORDERS_PORT = 18081;
const CHECKOUT_PORT = 18082;
/** The first build downloads Spring Boot and the build plugins; a cold Windows runner takes minutes for that. */
const BUILD_MS = 10 * 60_000;
/** One waiting tool call: below the 30 s an HTTP request of the test's MCP client may take (`support/mcp-client.ts`). */
const WAIT_SECONDS = 25;
setDefaultTimeout(2 * BUILD_MS);

let daemon: Awaited<ReturnType<typeof startSessionApi>>;
let client: Client;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, {
    repos: { orders: trackedFiles("orders"), checkout: trackedFiles("checkout") },
    miseCommand: ["mise"],
  });
  client = await connectHttpClient(daemon.api.port, TOKEN);
  // What the user does once per repo in the UI: trust its mise config, then the Batch command's `tools` step installs
  // the JDK, Maven and Gradle its mise config names.
  for (const repo of ["orders", "checkout"]) {
    await daemon.facade.mise.trust(repo);
    const install = await daemon.facade.mise.installTools(repo, AbortSignal.timeout(BUILD_MS));
    expectExitCode(install, 0);
  }
}, 2 * BUILD_MS);

afterAll(async () => {
  await client?.close();
  await daemon?.stop();
  // Gradle keeps its daemon after a build, as on the user's machine; stopped here so it holds no files of the run.
  if (daemon)
    execFileSync("mise", ["exec", "--", "gradle", "--stop", "--quiet"], { cwd: join(daemon.projects, "checkout"), stdio: "inherit" });
}, 60_000);

/**
 * A project's files as git tracks them (path with `/` → contents), so build output left in `projects/` by a run in place
 * does not reach the test's repos.
 */
function trackedFiles(project: string): Record<string, string> {
  const dir = join(PROJECTS, project);
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
  if (paths.length === 0) throw new Error(`git tracks no files in ${dir}`);
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(dir, ...path.split("/")), "utf8")]));
}

/** Replaces the one line `from` of a file in a task's worktree with `to`: the task's change, shown as the line it edits. */
function changeLine(file: string, from: string, to: string): void {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const at = lines.findIndex((line) => line.trim() === from);
  if (at < 0) throw new Error(`no line "${from}" in ${file}`);
  lines[at] = lines[at]?.replace(from, to) ?? to;
  writeFileSync(file, lines.join("\n"));
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

/** A waiting tool call (`wait_for_mise_task`, `verify_task`, `start_service`) made again until `done` or `BUILD_MS`. */
async function until<T>(next: () => Promise<T>, done: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + BUILD_MS;
  let result = await next();
  while (!done(result) && Date.now() < deadline) result = await next();
  return result;
}

/** The run ended with `code`; otherwise the failure shows the end of its output. */
function expectExitCode(run: RunState, code: number): void {
  expect({
    kind: run.kind,
    exitCode: run.kind === "exited" ? run.exitCode : null,
    lastLines: run.kind === "exited" && run.exitCode !== code ? run.lastLines : [],
  }).toEqual({
    kind: "exited",
    exitCode: code,
    lastLines: [],
  });
}

/** What a card says about a Spring app, without the evidence and the packages, which the unit tests check. */
function cardSummary({ repo, card, tags }: RepoCardResult) {
  if (card === null) throw new Error(`${repo} has no card`);
  return {
    buildFiles: card.buildFiles.map((f) => [f.path, f.tool]),
    apps: card.provides.flatMap((p) => (p.kind === "app" ? [[p.name, p.port]] : [])),
    endpoints: card.provides.flatMap((p) => (p.kind === "endpoint" ? [[p.method, p.path, p.response]] : [])),
    http: card.consumes.flatMap((c) =>
      c.kind === "http" ? [[c.name, c.via, c.url, c.calls.map((call) => [call.method, call.path])]] : [],
    ),
    tags: tags.map((t) => t.name),
  };
}

/** A mise task run with `run_mise_task` and awaited with `wait_for_mise_task`, as an agent does: the run once it ended. */
async function runToEnd(repo: string, miseTask: string): Promise<RunState> {
  await call("run_mise_task", { repo, miseTask });
  const wait = async () => MiseTaskRunResult.parse(await call("wait_for_mise_task", { repo, miseTask, timeoutSeconds: WAIT_SECONDS })).run;
  return until(wait, (run) => run.kind === "exited");
}

/** `verify_task` of a task, called again until the verification has ended. */
async function verify(repo: string, task: string) {
  const first = VerifyTaskResult.parse(await call("verify_task", { repo, task, timeoutSeconds: WAIT_SECONDS })).verification;
  const again = async () =>
    VerifyTaskResult.parse(await call("verify_task", { repo, task, runId: first.runId, timeoutSeconds: WAIT_SECONDS })).verification;
  return first.state === "running" ? until(again, (v) => v.state !== "running") : first;
}

/** `start_service` called again until every service of the slice has settled. */
async function startService(args: { repo: string; task?: string; dependencies?: boolean }) {
  const start = async () => StartServiceResult.parse(await call("start_service", { ...args, timeoutSeconds: WAIT_SECONDS })).slice;
  return until(start, (slice) => slice.settled);
}

/** A compiler line without the directory before the file name (`/tmp/…/Shipping.java:9: …`, `C:\\…\\Shipping.java:9: …`). */
function withoutDirectory(line: string): string {
  return line.replace(/^\S*[\\/](?=[^\\/\s]+\.java:\d+:)/, "");
}

describe("a Maven project and a Gradle project", () => {
  test("the cards name each Spring app with its port and endpoints, its build tool, and the call from checkout to orders", async () => {
    const orders = RepoCardResult.parse(await call("get_repo_card", { repo: "orders" }));
    const checkout = RepoCardResult.parse(await call("get_repo_card", { repo: "checkout" }));

    expect([orders, checkout].map(cardSummary)).toEqual([
      {
        buildFiles: [["pom.xml", "maven"]],
        apps: [["orders", ORDERS_PORT]],
        endpoints: [["GET", "/api/orders/{id}", "OrderDto"]],
        http: [],
        tags: ["backend", "java"],
      },
      {
        buildFiles: [["build.gradle.kts", "gradle"]],
        apps: [["checkout", CHECKOUT_PORT]],
        endpoints: [["GET", "/api/checkout/{orderId}", "CheckoutDto"]],
        http: [["OrdersClient", "rest-client", `http://localhost:${ORDERS_PORT}`, [["GET", "/api/orders/{id}"]]]],
        tags: ["backend", "java"],
      },
    ]);
  });

  test("find_endpoint finds the orders endpoint with checkout as its caller", async () => {
    const found = FindEndpointResult.parse(await call("find_endpoint", { query: "/api/orders/{id}", method: "GET" }));

    expect(found.endpoints.map((e) => [e.repo, e.method, e.path, e.response, e.callers.map((c) => [c.repo, c.via])])).toEqual([
      ["orders", "GET", "/api/orders/{id}", "OrderDto", [["checkout", "rest-client"]]],
    ]);
  });

  test("run_mise_task runs mvn test and gradle test, and get_test_results reads the reports each one wrote", async () => {
    const reports: Record<string, unknown> = {};
    for (const repo of ["orders", "checkout"]) {
      const run = await runToEnd(repo, "test");
      expectExitCode(run, 0);
      const results = TestResults.parse(await call("get_test_results", { repo, since: run.startedAt }));
      reports[repo] = { totals: results.totals, reports: results.reports.map((r) => [r.path, r.tests]), problems: results.problems };
    }

    expect(reports).toMatchObject({
      orders: {
        totals: { tests: 2, failures: 0, errors: 0, skipped: 0 },
        reports: [["target/surefire-reports/TEST-com.example.orders.PricingTest.xml", 2]],
        problems: [],
      },
      checkout: {
        totals: { tests: 1, failures: 0, errors: 0, skipped: 0 },
        reports: [["build/test-results/test/TEST-com.example.checkout.ShippingTest.xml", 1]],
        problems: [],
      },
    });
  });

  test("start_service starts orders before checkout from the graph, and call_endpoint reaches orders through checkout", async () => {
    const slice = await startService({ repo: "checkout" });
    expect(slice.members.map((m) => [m.repo, m.service?.state, m.service?.port])).toEqual([
      ["orders", "healthy", ORDERS_PORT],
      ["checkout", "healthy", CHECKOUT_PORT],
    ]);

    const answer = CallEndpointResult.parse(await call("call_endpoint", { repo: "checkout", path: "/api/checkout/42" }));
    expect({ status: answer.response?.status, body: answer.response?.body, errors: answer.errors }).toEqual({
      status: 200,
      body: JSON.stringify({ orderId: "42", toPay: 17 }),
      errors: [],
    });

    const { services } = StopServiceResult.parse(await call("stop_service", { repo: "checkout", dependencies: true }));
    expect(services.map((s) => [s.repo, s.state])).toEqual([
      ["checkout", "stopped"],
      ["orders", "stopped"],
    ]);
  });

  test("verify_task fails a Maven task whose change breaks a test, with the failed test from the report and the Maven errors", async () => {
    const task = await daemon.facade.agents.createTask("orders", "charge per item");
    changeLine(
      join(task.worktree, "src", "main", "java", "com", "example", "orders", "Pricing.java"),
      "return quantity * unitPrice;",
      "return quantity * (unitPrice + 1);",
    );

    const verification = await verify("orders", task.id);

    expect(verification).toMatchObject({ state: "failed", exitCode: 1 });
    expect(verification.failures.map((f) => [f.className, f.name, f.message])).toEqual([
      ["com.example.orders.PricingTest", "multipliesQuantityByUnitPrice", "expected: <12> but was: <15>"],
    ]);
    expect(verification.tests?.totals).toMatchObject({ tests: 2, failures: 1, errors: 0 });
    // The first error is the test's exception from Surefire's output, and Maven's summary names the test and its line.
    expect(verification.errors[0]?.exception).toBe("org.opentest4j.AssertionFailedError: expected: <12> but was: <15>");
    expect(verification.errors.flatMap((e) => e.lines)).toContain(
      "[ERROR]   PricingTest.multipliesQuantityByUnitPrice:11 expected: <12> but was: <15>",
    );
  });

  test("verify_task fails a Gradle task that does not compile, with the compiler error from the Gradle log", async () => {
    const task = await daemon.facade.agents.createTask("checkout", "rename the shipping rate");
    // The constant renamed where it is declared, not where `withShipping` uses it (line 9).
    changeLine(
      join(task.worktree, "src", "main", "java", "com", "example", "checkout", "Shipping.java"),
      "static final int FLAT_RATE = 5;",
      "static final int RATE = 5;",
    );

    const verification = await verify("checkout", task.id);

    expect(verification).toMatchObject({ state: "failed", exitCode: 1, failures: [] });
    // javac's error with the source line, then Gradle's FAILURE report with the task that failed. The path before the
    // file name is the task's worktree, spelled as the system gives it.
    const [compiler, gradle] = verification.errors;
    expect(compiler?.lines.map(withoutDirectory)).toEqual([
      "Shipping.java:9: error: cannot find symbol",
      "        return total + FLAT_RATE;",
      "                       ^",
      "  symbol:   variable FLAT_RATE",
      "  location: class Shipping",
    ]);
    expect(gradle?.lines.slice(0, 4)).toEqual([
      "FAILURE: Build failed with an exception.",
      "",
      "* What went wrong:",
      "Execution failed for task ':compileJava'.",
    ]);
    // get_errors reads the same errors from the run's log.
    const fromLog = LogErrors.parse(await call("get_errors", { repo: "checkout", task: task.id }));
    expect(fromLog.errors.map((e) => e.lines[0])).toEqual(verification.errors.map((e) => e.lines[0]).reverse());
  });

  test("start_service reports a task's service that fails to start as crashed, with the Spring Boot report from its log", async () => {
    const task = await daemon.facade.agents.createTask("orders", "add refunds");
    writeFileSync(
      join(task.worktree, "src", "main", "java", "com", "example", "orders", "Refunds.java"),
      "package com.example.orders;\n\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class Refunds {\n    public interface PaymentGateway {}\n\n    public Refunds(PaymentGateway gateway) {}\n}\n",
    );

    const slice = await startService({ repo: "orders", task: task.id, dependencies: false });

    expect(slice.members.map((m) => [m.repo, m.outcome, m.service?.state, m.service?.port])).toEqual([
      ["orders", "started", "crashed", task.port],
    ]);
    // Spring Boot's failure report, which Maven prints between its own lines, is one error of the service log.
    const report = slice.members[0]?.errors.find((e) => e.lines.includes("APPLICATION FAILED TO START"));
    expect(report?.lines).toContain(
      "Parameter 0 of constructor in com.example.orders.Refunds required a bean of type 'com.example.orders.Refunds$PaymentGateway' that could not be found.",
    );
  });
});
