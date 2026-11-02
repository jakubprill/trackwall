import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { networkOutcome, SESSION_HOSTS } from "../src/modules/doctor/network-check.ts";
import { proxyFor, shownProxy } from "../src/modules/doctor/proxy-env.ts";
import { probeTls, type TlsProbe, type TlsProbeResult } from "../src/modules/doctor/tls-probe.ts";
import { INSPECTION_CA, LOCALHOST_CERT, LOCALHOST_KEY } from "./fixtures/tls-certificates.ts";
import { RUNTIMES } from "./support/runtimes.ts";

const probeRunner = join(import.meta.dir, "fixtures", "tls-probe-runner.ts");

/** A TLS server for `localhost` whose certificate the test inspection authority signed, like a company proxy's would be. */
let server: Server;
let serverPort: number;

/** What a test proxy saw: the `CONNECT` request lines. */
interface ProxySeen {
  requests: string[];
}

/**
 * An HTTP proxy that tunnels `CONNECT` to the test server whatever host it names, or answers every request with `status`,
 * with text that is not HTTP (`"garbage"`), or by closing the connection (`"close"`).
 */
async function startProxy(answer: number | "garbage" | "close" = 200): Promise<{ url: string; seen: ProxySeen; close: () => void }> {
  const seen: ProxySeen = { requests: [] };
  const proxy = createNetServer((client: Socket) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.off("data", onData);
      seen.requests.push(head);
      if (answer === "close") return client.destroy();
      if (answer === "garbage") return client.end("SSH-2.0-OpenSSH_9.6\r\n\r\n");
      if (answer !== 200) return client.end(`HTTP/1.1 ${answer} No\r\nContent-Length: 0\r\n\r\n`);
      const upstream = netConnect({ host: "127.0.0.1", port: serverPort }, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => proxy.close() };
}

/** A port nothing listens on: one a server had a moment ago. */
async function closedPort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  server = createTlsServer({ key: LOCALHOST_KEY, cert: `${LOCALHOST_CERT}\n${INSPECTION_CA}` }, (s) => s.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

describe("TLS probe", () => {
  test("a certificate signed by an authority the probe is not given is untrusted, with the authority's name", async () => {
    const result = await probeTls({ host: "localhost", port: serverPort }, { proxy: null, ca: [], timeoutMs: 5_000 });
    expect(result).toEqual({ kind: "untrusted", code: "SELF_SIGNED_CERT_IN_CHAIN", issuer: "Trackwall Test Inspection CA", proxy: false });
  });

  test("with that authority among the given certificates the connection is ok", async () => {
    const result = await probeTls({ host: "localhost", port: serverPort }, { proxy: null, ca: [INSPECTION_CA], timeoutMs: 5_000 });
    expect(result).toEqual({ kind: "ok" });
  });

  test("through an HTTP proxy the probe asks it to CONNECT to the host and checks the certificate at the other end", async () => {
    const proxy = await startProxy();
    try {
      const result = await probeTls(
        { host: "localhost", port: serverPort },
        { proxy: new URL(proxy.url.replace("//", "//jo%40work:p%3Ass@")), ca: [INSPECTION_CA], timeoutMs: 5_000 },
      );
      expect(result).toEqual({ kind: "ok" });
      expect(proxy.seen.requests[0]).toStartWith(`CONNECT localhost:${serverPort} HTTP/1.1\r\n`);
      expect(proxy.seen.requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("jo@work:p:ss").toString("base64")}\r\n`);
    } finally {
      proxy.close();
    }
  });

  test("a proxy that wants a login answers 407, and the probe says so", async () => {
    const proxy = await startProxy(407);
    try {
      const result = await probeTls({ host: "localhost", port: serverPort }, { proxy: new URL(proxy.url), ca: [], timeoutMs: 5_000 });
      expect(result).toEqual({ kind: "proxy-refused", status: 407 });
      expect(proxy.seen.requests[0]).not.toContain("Proxy-Authorization");
    } finally {
      proxy.close();
    }
  });

  test("a proxy nobody listens at is unreachable, and the result says it was the proxy", async () => {
    const port = await closedPort();
    const result = await probeTls(
      { host: "localhost", port: serverPort },
      { proxy: new URL(`http://127.0.0.1:${port}`), ca: [], timeoutMs: 5_000 },
    );
    expect(result).toMatchObject({ kind: "unreachable", proxy: true });
  });

  test("a malformed escape in the proxy's user name is sent as written instead of failing the daemon", async () => {
    const proxy = await startProxy();
    try {
      const result = await probeTls(
        { host: "localhost", port: serverPort },
        { proxy: new URL(proxy.url.replace("//", "//us%zz:pw@")), ca: [INSPECTION_CA], timeoutMs: 5_000 },
      );
      expect(result).toEqual({ kind: "ok" });
      expect(proxy.seen.requests[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("us%zz:pw").toString("base64")}\r\n`);
    } finally {
      proxy.close();
    }
  });

  test.each(["close", "garbage"] as const)("a proxy that answers CONNECT with %s is unreachable as a proxy", async (answer) => {
    const proxy = await startProxy(answer);
    try {
      const result = await probeTls({ host: "localhost", port: serverPort }, { proxy: new URL(proxy.url), ca: [], timeoutMs: 5_000 });
      expect(result).toMatchObject({ kind: "unreachable", proxy: true });
    } finally {
      proxy.close();
    }
  });

  test("a certificate issued to another host is untrusted, even from a trusted authority", async () => {
    const proxy = await startProxy();
    try {
      const result = await probeTls(
        { host: "trackwall-test.example.org", port: 443 },
        { proxy: new URL(proxy.url), ca: [INSPECTION_CA], timeoutMs: 5_000 },
      );
      expect(result).toMatchObject({ kind: "untrusted", code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    } finally {
      proxy.close();
    }
  });

  test("a host whose name cannot be found is a DNS failure", async () => {
    const result = await probeTls({ host: "trackwall-test.invalid", port: 443 }, { proxy: null, ca: [], timeoutMs: 5_000 });
    expect(result.kind).toBe("dns");
  });
});

/** The probe's result from a process of `runtime`, which is where Bun's and Node's TLS sockets differ. */
function probeIn(runtime: string[], probe: { host: string; port: number; proxy: string | null; ca: string[] }): Promise<unknown> {
  const [command = "", ...args] = runtime;
  return new Promise((resolve, reject) => {
    execFile(command, [...args, probeRunner, JSON.stringify(probe)], { timeout: 20_000 }, (err, stdout) =>
      err ? reject(err) : resolve(JSON.parse(stdout)),
    );
  });
}

describe.each(RUNTIMES)("TLS probe under %s", (_name, runtime) => {
  test("an authority it is not given is untrusted and named, and through a proxy with that authority it is ok", async () => {
    const proxy = await startProxy();
    try {
      expect(await probeIn(runtime, { host: "localhost", port: serverPort, proxy: null, ca: [] })).toEqual({
        kind: "untrusted",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
        issuer: "Trackwall Test Inspection CA",
        proxy: false,
      });
      expect(await probeIn(runtime, { host: "localhost", port: serverPort, proxy: proxy.url, ca: [INSPECTION_CA] })).toEqual({
        kind: "ok",
      });
      expect(
        await probeIn(runtime, { host: "trackwall-test.example.org", port: 443, proxy: proxy.url, ca: [INSPECTION_CA] }),
      ).toMatchObject({
        kind: "untrusted",
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    } finally {
      proxy.close();
    }
  });
});

describe("proxy from the environment", () => {
  test.each([
    [{ HTTPS_PROXY: "http://proxy.example.org:3128" }, "github.com", "proxy.example.org:3128"],
    [{ https_proxy: "http://a.example.org:1", HTTPS_PROXY: "http://b.example.org:2" }, "github.com", "a.example.org:1"],
    [{ HTTP_PROXY: "proxy.example.org:8080" }, "github.com", "proxy.example.org:8080"],
    [{ HTTPS_PROXY: "http://user:secret@proxy.example.org" }, "github.com", "proxy.example.org:80"],
    [{ HTTPS_PROXY: "http://proxy.example.org:3128", NO_PROXY: "localhost,.github.com" }, "api.github.com", null],
    [{ HTTPS_PROXY: "http://proxy.example.org:3128", NO_PROXY: "github.com" }, "github.com", null],
    [{ HTTPS_PROXY: "http://proxy.example.org:3128", no_proxy: "*" }, "github.com", null],
    [{ HTTPS_PROXY: "http://proxy.example.org:3128", NO_PROXY: "github.com:22" }, "github.com", "proxy.example.org:3128"],
    [{ HTTPS_PROXY: "http://proxy.example.org:3128", NO_PROXY: "hub.com" }, "github.com", "proxy.example.org:3128"],
    [{}, "github.com", null],
  ])("%j for %s goes through %s", (env, host, shown) => {
    const proxy = proxyFor(env, "https:", host, 443);
    expect(proxy === null ? null : shownProxy(proxy)).toBe(shown);
  });

  test("a proxy that is not HTTP is refused, without its password", () => {
    expect(() => proxyFor({ HTTPS_PROXY: "socks5://user:secret@proxy.example.org:1080" }, "https:", "github.com", 443)).toThrow(
      "the proxy proxy.example.org:1080 is not an HTTP proxy",
    );
  });
});

/** A probe that answers each host from `results` and records what it was given. */
function scriptedProbe(results: (host: string, ca: readonly string[]) => TlsProbeResult) {
  const calls: { host: string; proxy: string | null; caCount: number }[] = [];
  const probe: TlsProbe = async ({ host }, o) => {
    calls.push({ host, proxy: o.proxy?.href ?? null, caCount: o.ca.length });
    return results(host, o.ca);
  };
  return { probe, calls };
}

describe("network check", () => {
  test("both hosts answering directly is ok, and the summary says there is no proxy", async () => {
    const { probe, calls } = scriptedProbe(() => ({ kind: "ok" }));
    expect(await networkOutcome({}, { probe, systemCaFiles: [] })).toEqual({
      status: "ok",
      summary: "github.com and api.githubcopilot.com answer directly.",
      fix: null,
    });
    expect(calls.map((c) => c.host)).toEqual([...SESSION_HOSTS]);
  });

  test("through a proxy the summary names its host and port, never the login in its address", async () => {
    const { probe } = scriptedProbe(() => ({ kind: "ok" }));
    const outcome = await networkOutcome({ HTTPS_PROXY: "http://jo:secret@proxy.example.org:3128" }, { probe, systemCaFiles: [] });
    expect(outcome.summary).toBe("github.com and api.githubcopilot.com answer through the proxy proxy.example.org:3128.");
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });

  test("an inspecting proxy the system trusts and Node.js does not names the system bundle for NODE_EXTRA_CA_CERTS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-doctor-ca-"));
    const empty = join(dir, "empty.pem");
    const bundle = join(dir, "ca-certificates.crt");
    writeFileSync(empty, "nothing here\n");
    writeFileSync(bundle, `${INSPECTION_CA}\n`);
    const { probe } = scriptedProbe((_host, ca) =>
      ca.includes(INSPECTION_CA)
        ? { kind: "ok" }
        : { kind: "untrusted", code: "SELF_SIGNED_CERT_IN_CHAIN", issuer: "Example Inspection CA", proxy: false },
    );
    expect(await networkOutcome({}, { probe, systemCaFiles: [join(dir, "missing.pem"), empty, bundle] })).toEqual({
      status: "fail",
      summary:
        'The connection to github.com is signed by "Example Inspection CA", which Copilot CLI does not trust (SELF_SIGNED_CERT_IN_CHAIN).',
      fix: `This computer trusts it, but Node.js, which runs Copilot CLI, reads only its own certificates: set NODE_EXTRA_CA_CERTS=${bundle} in the environment Trackwall starts with (a user variable on Windows, the container's environment in a dev container), then restart Trackwall.`,
    });
  });

  test("an HTTPS proxy whose own certificate is not trusted is named instead of the host", async () => {
    const { probe } = scriptedProbe(() => ({ kind: "untrusted", code: "SELF_SIGNED_CERT_IN_CHAIN", issuer: null, proxy: true }));
    const outcome = await networkOutcome({ HTTPS_PROXY: "https://proxy.example.org:8443" }, { probe, systemCaFiles: [] });
    expect(outcome.summary).toBe(
      "The connection to the proxy proxy.example.org:8443 is signed by an authority, which Copilot CLI does not trust (SELF_SIGNED_CERT_IN_CHAIN).",
    );
  });

  test("an inspecting proxy nobody here trusts asks for its root certificate", async () => {
    const { probe } = scriptedProbe(() => ({ kind: "untrusted", code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", issuer: null, proxy: false }));
    const outcome = await networkOutcome({}, { probe, systemCaFiles: [] });
    expect(outcome.status).toBe("fail");
    expect(outcome.summary).toBe(
      "The connection to github.com is signed by an authority, which Copilot CLI does not trust (UNABLE_TO_GET_ISSUER_CERT_LOCALLY).",
    );
    expect(outcome.fix).toStartWith("Ask whoever runs your network for the root certificate of its proxy as a PEM file");
  });

  test("certificates in NODE_EXTRA_CA_CERTS are given to the probe, and a file without any is a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-doctor-extra-"));
    const extra = join(dir, "company.pem");
    writeFileSync(extra, `subject=Example\n${INSPECTION_CA}\n`);
    const { probe } = scriptedProbe((_host, ca) =>
      ca.includes(INSPECTION_CA) ? { kind: "ok" } : { kind: "untrusted", code: "X", issuer: null, proxy: false },
    );
    expect((await networkOutcome({ NODE_EXTRA_CA_CERTS: extra }, { probe, systemCaFiles: [] })).status).toBe("ok");

    const notPem = join(dir, "company.der");
    writeFileSync(notPem, "binary");
    const outcome = await networkOutcome({ NODE_EXTRA_CA_CERTS: notPem }, { probe: async () => ({ kind: "ok" }), systemCaFiles: [] });
    expect(outcome).toEqual({
      status: "warn",
      summary: `github.com and api.githubcopilot.com answer directly. NODE_EXTRA_CA_CERTS: ${notPem} holds no PEM certificate.`,
      fix: "Correct NODE_EXTRA_CA_CERTS in the environment Trackwall starts with (a user variable on Windows, the container's environment in a dev container), then restart Trackwall.",
    });
  });

  test("with NODE_USE_SYSTEM_CA the system bundle is trusted from the start, as Node.js 22.15 and newer do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-doctor-system-ca-"));
    const bundle = join(dir, "ca-certificates.crt");
    writeFileSync(bundle, `${INSPECTION_CA}\n`);
    const { probe } = scriptedProbe((_host, ca) =>
      ca.includes(INSPECTION_CA) ? { kind: "ok" } : { kind: "untrusted", code: "X", issuer: null, proxy: false },
    );
    expect((await networkOutcome({ NODE_USE_SYSTEM_CA: "1" }, { probe, systemCaFiles: [bundle] })).status).toBe("ok");
    expect(
      (await networkOutcome({ NODE_OPTIONS: "--max-old-space-size=4096 --use-system-ca" }, { probe, systemCaFiles: [bundle] })).status,
    ).toBe("ok");
  });

  test("with NODE_USE_SYSTEM_CA and no system bundle to read, as on Windows, an untrusted certificate is only a warning", async () => {
    const outcome = await networkOutcome(
      { NODE_USE_SYSTEM_CA: "1" },
      {
        probe: async () => ({ kind: "untrusted", code: "SELF_SIGNED_CERT_IN_CHAIN", issuer: "Example Inspection CA", proxy: false }),
        systemCaFiles: [],
      },
    );
    expect(outcome.status).toBe("warn");
    expect(outcome.summary).toContain("the doctor cannot read them here");
  });

  test.each([
    [
      { kind: "proxy-refused", status: 407 } as const,
      "The proxy proxy.example.org:3128 asks for a login (407).",
      "Put the login into the proxy address",
    ],
    [
      { kind: "proxy-refused", status: 403 } as const,
      "The proxy proxy.example.org:3128 refused the connection to github.com (403).",
      "Ask whoever runs the proxy to allow github.com",
    ],
    [
      { kind: "unreachable", message: "connect ECONNREFUSED 10.0.0.1:3128", proxy: true } as const,
      "The proxy proxy.example.org:3128 cannot be reached: connect ECONNREFUSED 10.0.0.1:3128.",
      "Correct HTTPS_PROXY (and NO_PROXY)",
    ],
    [
      { kind: "dns", message: "getaddrinfo ENOTFOUND proxy.example.org" } as const,
      "The proxy proxy.example.org:3128 cannot be found: getaddrinfo ENOTFOUND proxy.example.org.",
      "Correct HTTPS_PROXY (and NO_PROXY)",
    ],
  ])("behind a proxy, %j fails with what to change", async (result, summary, fix) => {
    const outcome = await networkOutcome(
      { HTTPS_PROXY: "http://proxy.example.org:3128" },
      { probe: async () => result, systemCaFiles: [] },
    );
    expect(outcome.status).toBe("fail");
    expect(outcome.summary).toBe(summary);
    expect(outcome.fix).toStartWith(fix);
  });

  test("without a proxy, a host that cannot be found points at the network, VPN or HTTPS_PROXY", async () => {
    const outcome = await networkOutcome(
      {},
      { probe: async () => ({ kind: "dns", message: "getaddrinfo ENOTFOUND github.com" }), systemCaFiles: [] },
    );
    expect(outcome).toMatchObject({ status: "fail", summary: "github.com cannot be found: getaddrinfo ENOTFOUND github.com." });
    expect(outcome.fix).toStartWith("Check the network or VPN; behind a company proxy, set HTTPS_PROXY");
  });
});
