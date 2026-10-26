// Fake service for the `services` tests (ADR-45), run by `fake-mise.ts` as the mise task `dev` from `servers` in
// `fake-mise.json`: { port?: number (none: `SERVER_PORT` as Spring Boot reads it, else a free one), delayMs?: number,
// crash?: boolean, quiet?: boolean, buildDaemon?: number }.
// It listens on 127.0.0.1 after `delayMs` and logs the port as Spring Boot does (`quiet` leaves the line out). GET and
// POST answer JSON with the method, path, body, the working directory, `PORT` and `FAKE_API_TOKEN` from the environment
// (a secret to be masked);
// `/boom` logs an exception with a stack trace and answers 500; `/forward/<port><path>` passes the request to another
// fake service on 127.0.0.1 and answers 502 when that one fails. `crash` logs a startup failure and exits with code 1.
// `buildDaemon` is the port of a build daemon the test runs, as Gradle's daemon runs `bootRun`: this process only asks it
// for the app over a connection it keeps open, logs the port the daemon answers with, and the app lives in the daemon,
// outside the process group, until the daemon sees the connection close.
import { createServer, request } from "node:http";
import { connect } from "node:net";

const config = JSON.parse(process.argv[2] ?? "{}") as {
  port?: number;
  delayMs?: number;
  crash?: boolean;
  quiet?: boolean;
  buildDaemon?: number;
};

const logStarted = (port: number) =>
  console.log(`INFO o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port ${port} (http) with context path '/'`);

/** Asks the build daemon for the app and stays connected while it runs. */
function askBuildDaemon(port: number): void {
  const client = connect({ host: "127.0.0.1", port });
  client.setEncoding("utf8");
  client.once("data", (appPort: string) => logStarted(Number(appPort)));
  client.once("error", (err) => {
    console.error(`ERROR the build daemon did not answer: ${err.message}`);
    process.exit(1);
  });
}

if (config.crash) {
  console.error("ERROR o.s.boot.SpringApplication - Application run failed");
  console.error("java.lang.IllegalStateException: Failed to load the database driver");
  console.error("\tat com.example.orders.Db.connect(Db.java:12)");
  process.exit(1);
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const forward = /^\/forward\/(\d+)(\/.*)$/.exec(req.url ?? "");
    if (forward) {
      const upstream = request({ host: "127.0.0.1", port: Number(forward[1]), path: forward[2] }, (up) => {
        up.resume();
        res.writeHead((up.statusCode ?? 500) >= 500 ? 502 : 200);
        res.end();
      });
      upstream.end();
      return;
    }
    if (req.url === "/boom") {
      console.error("ERROR c.e.orders.OrderController - Request failed");
      console.error("java.lang.NullPointerException: order is null");
      console.error("\tat com.example.orders.OrderController.get(OrderController.java:42)");
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"Internal Server Error"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const body = Buffer.concat(chunks).toString("utf8");
    const env = { port: process.env.PORT ?? null, token: process.env.FAKE_API_TOKEN ?? null };
    const answer = { method: req.method, path: req.url, body, cwd: process.cwd(), ...env };
    res.end(JSON.stringify(answer));
  });
});

if (config.buildDaemon !== undefined) askBuildDaemon(config.buildDaemon);
else
  setTimeout(() => {
    server.listen(config.port ?? Number(process.env.SERVER_PORT ?? 0), "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (!config.quiet) logStarted(port);
    });
  }, config.delayMs ?? 0);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
