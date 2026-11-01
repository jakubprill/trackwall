import { probeTls } from "../../src/modules/doctor/tls-probe.ts";

/**
 * Runs one TLS probe in a process of its own and prints its result as JSON, so a test can run the probe under Bun and
 * under Node (ADR-1), whose TLS sockets differ. Arguments: one JSON object with `host`, `port`, `proxy` and `ca`.
 */
const arg = process.argv[2];
if (arg === undefined) throw new Error("tls-probe-runner needs its probe as a JSON argument");
const { host, port, proxy, ca } = JSON.parse(arg) as { host: string; port: number; proxy: string | null; ca: string[] };
const result = await probeTls({ host, port }, { proxy: proxy === null ? null : new URL(proxy), ca, timeoutMs: 5_000 });
process.stdout.write(JSON.stringify(result));
