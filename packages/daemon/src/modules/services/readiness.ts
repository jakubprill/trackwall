/**
 * What a service log says about readiness (§4.3, ADR-45): the port its web server opened and whether a Spring Boot
 * app reported it has started. The port from the log wins over `server.port` on the card, because a profile, an
 * environment variable or `--server.port` in the mise task can change it and the card reads only the default profile.
 */

/**
 * Lines that name the port a server listens on, the port in the first group: Spring Boot (`Tomcat started on port
 * 8081 (http)`, older `port(s): 8081`, Netty, Jetty, Undertow), dev servers (`Local:   http://localhost:5173/`)
 * and the usual `listening on port 3000` / `Server listening on http://localhost:3000`.
 */
const PORT_LINES = [
  /\b(?:Tomcat|Netty|Jetty|Undertow)\b.*?\bstarted on port(?:s|\(s\))?:?\s*(\d{1,5})\b/i,
  /\bLocal:\s+https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\b/i,
  /\blistening on (?:port\s+)?(\d{1,5})\b/i,
  /\b(?:listening|running|available)\b.{0,40}?\b(?:on|at)\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*):(\d{1,5})\b/i,
];

/** Spring Boot's `Started OrdersApplication in 4.2 seconds (process running for 4.9)`: the context is up. */
const STARTED_LINE = /\bStarted \S+ in \d+(?:\.\d+)? seconds\b/;

/** The port a log line announces, or `null`. */
export function portFromLine(line: string): number | null {
  for (const pattern of PORT_LINES) {
    const port = Number(pattern.exec(line)?.[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

/** Whether a log line is Spring Boot's report that the application context has started. */
export function isStartedLine(line: string): boolean {
  return STARTED_LINE.test(line);
}
