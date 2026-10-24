import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogStream } from "@trackwall/protocol";
import { Logs } from "../src/modules/logs/logs.ts";
import type { RunOutput } from "../src/modules/logs/run-output.ts";

const DEV = { kind: "mise-task", repo: "orders", miseTask: "dev" } as const;
const BUILD = { kind: "mise-task", repo: "orders", miseTask: "build" } as const;
const WEB = { kind: "mise-task", repo: "web", miseTask: "dev" } as const;
const ALL = { minLevel: "error", limit: 20 } as const;

function newLogs(): Logs {
  return new Logs({ dir: mkdtempSync(join(tmpdir(), "trackwall-errors-")), maxFileBytes: 1024 * 1024, log: () => {} });
}

/** Lines on one stream, each as a separate chunk, as from a process. */
function write(stream: LogStream, output: RunOutput, text: string): void {
  for (const line of text.split("\n")) output.push(stream, Buffer.from(`${line}\n`));
}

describe("errors from the log", () => {
  test("a Spring ERROR line with an exception and stack trace is one error whose cause is the last Caused by", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        "2026-10-24T10:00:00.100+02:00  INFO 4242 --- [main] o.s.b.w.e.tomcat.TomcatWebServer : Tomcat initialized with port 8080",
        "2026-10-24T10:00:01.200+02:00 ERROR 4242 --- [main] o.s.boot.SpringApplication : Application run failed",
        "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'dataSource'",
        "\tat org.springframework.beans.factory.support.AbstractBeanFactory.getBean(AbstractBeanFactory.java:205)",
        "\tat com.example.orders.OrdersApplication.main(OrdersApplication.java:10)",
        "Caused by: org.postgresql.util.PSQLException: Connection to localhost:5432 refused.",
        "\tat org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:342)",
        "\t... 25 more",
        "2026-10-24T10:00:01.300+02:00  INFO 4242 --- [main] o.s.b.a.l.ConditionEvaluationReportLogger : done",
      ].join("\n"),
    );

    const { errors } = logs.errors(ALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      source: DEV,
      runId: "r1",
      stream: "stdout",
      level: "error",
      exception: "org.postgresql.util.PSQLException: Connection to localhost:5432 refused.",
      count: 1,
      omittedLines: 0,
    });
    expect(errors[0]?.lines).toEqual([
      "2026-10-24T10:00:01.200+02:00 ERROR 4242 --- [main] o.s.boot.SpringApplication : Application run failed",
      "org.springframework.beans.factory.BeanCreationException: Error creating bean with name 'dataSource'",
      "\tat org.springframework.beans.factory.support.AbstractBeanFactory.getBean(AbstractBeanFactory.java:205)",
      "\tat com.example.orders.OrdersApplication.main(OrdersApplication.java:10)",
      "Caused by: org.postgresql.util.PSQLException: Connection to localhost:5432 refused.",
      "\tat org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:342)",
      "\t... 25 more",
    ]);
  });

  test("the Spring APPLICATION FAILED TO START report belongs to the error with its description and action", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        "2026-10-24T10:00:01.200+02:00 ERROR 4242 --- [main] o.s.b.d.LoggingFailureAnalysisReporter :",
        "",
        "***************************",
        "APPLICATION FAILED TO START",
        "***************************",
        "",
        "Description:",
        "",
        "Web server failed to start. Port 8080 was already in use.",
        "",
        "Action:",
        "",
        "Identify and stop the process that's listening on port 8080 or configure this application to listen on another port.",
        "",
        "Process finished",
      ].join("\n"),
    );

    const { errors } = logs.errors(ALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.exception).toBeNull();
    expect(errors[0]?.lines.slice(2)).toEqual([
      "***************************",
      "APPLICATION FAILED TO START",
      "***************************",
      "",
      "Description:",
      "",
      "Web server failed to start. Port 8080 was already in use.",
      "",
      "Action:",
      "",
      "Identify and stop the process that's listening on port 8080 or configure this application to listen on another port.",
    ]);
  });

  test("an uncaught Node exception on stderr starts the error at its header, and stdout between its lines does not break it", () => {
    const logs = newLogs();
    const output = logs.open(WEB, "r1", {});
    write(
      "stderr",
      output,
      ["/repo/server.js:5", '  throw new TypeError("port is not a number");', "  ^", "", "TypeError: port is not a number"].join("\n"),
    );
    write("stdout", output, "listening soon");
    write(
      "stderr",
      output,
      [
        "    at Object.<anonymous> (/repo/server.js:5:9)",
        "    at Module._compile (node:internal/modules/cjs/loader:1554:14)",
        "",
        "Node.js v22.22.0",
      ].join("\n"),
    );

    expect(logs.errors(ALL).errors).toMatchObject([
      {
        source: WEB,
        stream: "stderr",
        exception: "TypeError: port is not a number",
        lines: [
          "TypeError: port is not a number",
          "    at Object.<anonymous> (/repo/server.js:5:9)",
          "    at Module._compile (node:internal/modules/cjs/loader:1554:14)",
        ],
      },
    ]);
  });

  test("the same error repeated with another time and thread is one entry with a count and the lines of the latest occurrence", () => {
    const logs = newLogs();
    const output = logs.open(DEV, "r1", {});
    for (const [time, thread, id] of [
      ["10:00:01", "exec-1", 41],
      ["10:00:05", "exec-7", 42],
      ["10:00:09", "exec-3", 43],
    ] as const) {
      write(
        "stdout",
        output,
        [
          `2026-10-24T${time}.000+02:00 ERROR 4242 --- [nio-8080-${thread}] o.a.c.c.C.[.[.[/].[dispatcherServlet] : Servlet.service() threw exception`,
          `java.lang.IllegalStateException: order ${id} not found`,
          "\tat com.example.orders.OrdersController.get(OrdersController.java:31)",
        ].join("\n"),
      );
    }

    const { errors } = logs.errors(ALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      count: 3,
      exception: "java.lang.IllegalStateException: order 43 not found",
      ts: expect.any(String),
      firstTs: expect.any(String),
    });
    expect(errors[0]?.lines[0]).toContain("10:00:09");
    expect(errors[0]?.seq).toBe(
      Math.max(
        ...logs
          .tail({ source: DEV, limit: 100 })
          .records.filter((r) => r.level === "error")
          .map((r) => r.seq),
      ),
    );
  });

  test("a long stack trace keeps the first 10 frames of each exception and the rest becomes one line with the count", () => {
    const logs = newLogs();
    const frames = (cls: string) => Array.from({ length: 30 }, (_, i) => `\tat com.example.${cls}.m${i}(${cls}.java:${i + 1})`);
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      ["java.lang.RuntimeException: outer", ...frames("A"), "Caused by: java.io.IOException: inner", ...frames("B"), "\t... 25 more"].join(
        "\n",
      ),
    );

    const [error] = logs.errors(ALL).errors;
    expect(error?.lines).toEqual([
      "java.lang.RuntimeException: outer",
      ...frames("A").slice(0, 10),
      "\t… 20 frames omitted",
      "Caused by: java.io.IOException: inner",
      ...frames("B").slice(0, 10),
      "\t… 20 frames omitted",
      "\t... 25 more",
    ]);
    expect(error?.omittedLines).toBe(40);
    expect(error?.exception).toBe("java.io.IOException: inner");
  });

  test("build errors: javac with its context, consecutive Maven [ERROR] lines and the Gradle FAILURE report up to BUILD FAILED", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(BUILD, "r1", {}),
      [
        "> Task :compileJava",
        "/repo/src/main/java/com/example/Orders.java:12: error: cannot find symbol",
        "        repo.findAll();",
        "            ^",
        "  symbol:   method findAll()",
        "1 error",
        "",
        "FAILURE: Build failed with an exception.",
        "",
        "* What went wrong:",
        "Execution failed for task ':compileJava'.",
        "> Compilation failed; see the compiler error output for details.",
        "",
        "BUILD FAILED in 2s",
        "[INFO] BUILD FAILURE",
        "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile (default-compile) on project orders",
        "[ERROR] -> [Help 1]",
        "[INFO] Total time: 2 s",
      ].join("\n"),
    );

    expect(
      logs
        .errors(ALL)
        .errors.map((e) => e.lines)
        .reverse(),
    ).toEqual([
      [
        "/repo/src/main/java/com/example/Orders.java:12: error: cannot find symbol",
        "        repo.findAll();",
        "            ^",
        "  symbol:   method findAll()",
      ],
      [
        "FAILURE: Build failed with an exception.",
        "",
        "* What went wrong:",
        "Execution failed for task ':compileJava'.",
        "> Compilation failed; see the compiler error output for details.",
        "",
        "BUILD FAILED in 2s",
      ],
      [
        "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile (default-compile) on project orders",
        "[ERROR] -> [Help 1]",
      ],
    ]);
  });

  test("warnings come only with minLevel warn, and the mise task prefix does not get in the way", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(BUILD, "r1", {}),
      [
        "[build] WARN deprecated option --legacy",
        "[build] Error: Cannot find module 'left-pad'",
        "[build]     at require (node:internal:1:1)",
      ].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.level, e.exception, e.lines.length])).toEqual([
      ["error", "Error: Cannot find module 'left-pad'", 2],
    ]);
    expect(logs.errors({ ...ALL, minLevel: "warn" }).errors.map((e) => e.level)).toEqual(["error", "warn"]);
  });

  test("repo and task filters, a cursor across all sources and a limit keeping the most recent", () => {
    const logs = newLogs();
    write("stdout", logs.open(DEV, "r1", {}), "ERROR orders dev 1");
    write("stdout", logs.open({ kind: "mise-install", repo: "orders" }, "r2", {}), "mise ERROR failed to install java@21");
    write("stdout", logs.open(WEB, "r3", {}), "ERROR web dev");
    const cursor = logs.errors(ALL).nextSeq;
    write("stdout", logs.open(BUILD, "r4", {}), "ERROR orders build");

    expect(logs.errors(ALL).errors.map((e) => e.lines[0])).toEqual([
      "ERROR orders build",
      "ERROR web dev",
      "mise ERROR failed to install java@21",
      "ERROR orders dev 1",
    ]);
    expect(logs.errors({ ...ALL, limit: 2 })).toMatchObject({ truncated: true, errors: [{ source: BUILD }, { source: WEB }] });
    expect(logs.errors({ ...ALL, repo: "orders" }).errors.map((e) => e.source.kind)).toEqual(["mise-task", "mise-install", "mise-task"]);
    expect(logs.errors({ ...ALL, miseTask: "dev" }).errors.map((e) => e.source)).toEqual([WEB, DEV]);
    expect(logs.errors({ ...ALL, sinceSeq: cursor })).toMatchObject({ errors: [{ source: BUILD }], dropped: false });
    // A cursor from another daemon run: all errors, as without a cursor.
    expect(logs.errors({ ...ALL, sinceSeq: 5 })).toMatchObject({ dropped: true, errors: { length: 4 } });
  });

  test("a stack trace with the mise task prefix is trimmed like one without it", () => {
    const logs = newLogs();
    const frames = Array.from({ length: 15 }, (_, i) => `[build]     at f${i} (/repo/a.js:${i + 1}:1)`);
    write("stdout", logs.open(BUILD, "r1", {}), ["[build] TypeError: boom", ...frames].join("\n"));

    const [error] = logs.errors(ALL).errors;
    expect(error?.lines).toEqual(["[build] TypeError: boom", ...frames.slice(0, 10), "\t… 5 frames omitted"]);
    expect(error?.omittedLines).toBe(5);
  });

  test("two compiler errors in one file at different lines are two entries", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(BUILD, "r1", {}),
      ["/repo/src/Orders.java:12: error: cannot find symbol", "/repo/src/Orders.java:40: error: cannot find symbol"].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.lines[0], e.count])).toEqual([
      ["/repo/src/Orders.java:40: error: cannot find symbol", 1],
      ["/repo/src/Orders.java:12: error: cannot find symbol", 1],
    ]);
  });

  test("the same request error with a thread name cut differently and other trace ids is one entry", () => {
    const logs = newLogs();
    const output = logs.open(DEV, "r1", {});
    for (const [thread, trace] of [
      ["nio-8080-exec-9", "6f1e2d3c4b5a69788796a5b4c3d2e1f0-a1b2c3d4e5f60718"],
      ["io-8080-exec-10", "0a1b2c3d4e5f60718293a4b5c6d7e8f9-1029384756abcdef"],
    ]) {
      write(
        "stdout",
        output,
        [
          `2026-10-24T10:00:01.000+02:00 ERROR [orders,${trace}] 4242 --- [${thread}] c.e.o.OrdersController : lookup failed`,
          "java.lang.IllegalStateException: order 7 not found",
          "\tat com.example.orders.OrdersController.get(OrdersController.java:31)",
        ].join("\n"),
      );
    }

    expect(logs.errors(ALL).errors.map((e) => e.count)).toEqual([2]);
  });

  test("a line of asterisks alone is not an error, and a Spring report without Action ends at the next logger line", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        "**********************************",
        "2026-10-24T10:00:00.000+02:00  INFO 1 --- [main] c.e.App : starting",
        "2026-10-24T10:00:01.000+02:00 ERROR 1 --- [main] o.s.b.d.LoggingFailureAnalysisReporter :",
        "",
        "***************************",
        "APPLICATION FAILED TO START",
        "***************************",
        "",
        "Description:",
        "",
        "Failed to bind properties under 'server.port' to java.lang.Integer.",
        "",
        "2026-10-24T10:00:02.000+02:00  INFO 1 --- [main] c.e.App : retrying",
        "2026-10-24T10:00:03.000+02:00 ERROR 1 --- [main] c.e.App : second failure",
      ].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.lines.length, e.lines.at(-1)])).toEqual([
      [1, "2026-10-24T10:00:03.000+02:00 ERROR 1 --- [main] c.e.App : second failure"],
      [9, "Failed to bind properties under 'server.port' to java.lang.Integer."],
    ]);
  });

  test("Suppressed is part of the error but not its cause, and Require stack belongs to the Node error", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        "java.lang.RuntimeException: request failed",
        "\tat com.example.A.run(A.java:1)",
        "Caused by: java.sql.SQLException: connection reset",
        "\tat com.example.Db.query(Db.java:9)",
        "\tSuppressed: java.io.IOException: Broken pipe",
        "\t\tat com.example.Db.close(Db.java:12)",
      ].join("\n"),
    );
    write(
      "stderr",
      logs.open(WEB, "r2", {}),
      [
        "Error: Cannot find module 'left-pad'",
        "Require stack:",
        "- /repo/index.js",
        "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      ].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.exception, e.lines.length])).toEqual([
      ["Error: Cannot find module 'left-pad'", 4],
      ["java.sql.SQLException: connection reset", 6],
    ]);
  });

  test("an exception under a warning is an error of its own with either level threshold", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(WEB, "r1", {}),
      ["WARN deprecated option", "TypeError: x is not a function", "    at f (/repo/a.js:1:1)"].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.level, e.lines.length])).toEqual([["error", 2]]);
    expect(logs.errors({ ...ALL, minLevel: "warn" }).errors.map((e) => [e.level, e.lines.length])).toEqual([
      ["error", 2],
      ["warn", 1],
    ]);
  });

  test("a Caused by under a Suppressed exception is not the cause of the error", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        "java.lang.IllegalStateException: write failed",
        "\tat com.example.A.run(A.java:5)",
        "\tSuppressed: java.io.IOException: close failed",
        "\t\tat com.example.A.close(A.java:9)",
        "\tCaused by: java.net.SocketException: Broken pipe",
        "\t\t... 2 more",
      ].join("\n"),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.exception, e.lines.length])).toEqual([
      ["java.lang.IllegalStateException: write failed", 6],
    ]);
  });

  test("the prefix of a task whose name starts with a level word is still removed", () => {
    const logs = newLogs();
    write("stdout", logs.open(DEV, "r1", {}), ["[debug-server] Error: boom", "[debug-server]     at main (/repo/index.js:1:1)"].join("\n"));

    expect(logs.errors(ALL).errors.map((e) => [e.exception, e.lines.length])).toEqual([["Error: boom", 2]]);
  });

  test("a Spring report without Action ends at the build tool's output, and a Gradle report after it is its own error", () => {
    const logs = newLogs();
    const report = [
      "2026-10-24T10:00:01.000+02:00 ERROR 1 --- [main] o.s.b.d.LoggingFailureAnalysisReporter :",
      "***************************",
      "APPLICATION FAILED TO START",
      "***************************",
      "Description:",
      "The dependencies of some of the beans form a cycle:",
      "   a -> b",
    ];
    write(
      "stdout",
      logs.open(DEV, "r1", {}),
      [
        ...report,
        "[INFO] BUILD FAILURE",
        "[ERROR] Failed to execute goal spring-boot-maven-plugin: Process terminated with exit code: 1",
      ].join("\n"),
    );
    write("stdout", logs.open(BUILD, "r2", {}), [...report, "FAILURE: Build failed with an exception.", "BUILD FAILED in 2s"].join("\n"));

    expect(logs.errors({ ...ALL, repo: "orders", miseTask: "dev" }).errors.map((e) => e.lines.length)).toEqual([1, 7]);
    expect(logs.errors({ ...ALL, miseTask: "build" }).errors.map((e) => e.lines)).toEqual([
      ["FAILURE: Build failed with an exception.", "BUILD FAILED in 2s"],
      report,
    ]);
  });

  test("a Gradle report under a compiler warning is an error of its own with either level threshold", () => {
    const logs = newLogs();
    write(
      "stdout",
      logs.open(BUILD, "r1", {}),
      ["w: file:///repo/App.kt:3:5 Parameter 'x' is never used", "", "FAILURE: Build failed with an exception.", "BUILD FAILED in 2s"].join(
        "\n",
      ),
    );

    expect(logs.errors(ALL).errors.map((e) => [e.level, e.lines[0]])).toEqual([["error", "FAILURE: Build failed with an exception."]]);
    expect(logs.errors({ ...ALL, minLevel: "warn" }).errors.map((e) => [e.level, e.lines.length])).toEqual([
      ["error", 2],
      ["warn", 1],
    ]);
  });
});
