// Fake service for the `services` tests (ADR-45), run by `fake-mise.ts` as the mise task `dev` from `servers` in
// `fake-mise.json`: { port?: number (none: `SERVER_PORT` as Spring Boot reads it, else a free one), delayMs?: number,
// crash?: boolean, quiet?: boolean }.
// It listens on 127.0.0.1 after `delayMs` and logs the port as Spring Boot does (`quiet` leaves the line out). GET and
// POST answer JSON with the method, path, body, the working directory, `PORT` and `FAKE_API_TOKEN` from the environment
// (a secret to be masked);
// `/boom` logs an exception with a stack trace and answers 500; `/forward/<port><path>` passes the request to another
// fake service on 127.0.0.1 and answers 502 when that one fails. `crash` logs a startup failure and exits with code 1.
import { createServer, request } from "node:http";

const config = JSON.parse(process.argv[2] ?? "{}") as { port?: number; delayMs?: number; crash?: boolean; quiet?: boolean };

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

setTimeout(() => {
  server.listen(config.port ?? Number(process.env.SERVER_PORT ?? 0), "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!config.quiet)
      console.log(`INFO o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port ${port} (http) with context path '/'`);
  });
}, config.delayMs ?? 0);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
