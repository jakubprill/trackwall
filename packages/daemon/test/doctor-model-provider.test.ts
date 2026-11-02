import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import {
  modelProviderOutcome,
  type ProfileEnvironment,
  profileEnvironment,
  providerTarget,
} from "../src/modules/doctor/model-provider-check.ts";
import { proxyFor, shownProxy } from "../src/modules/doctor/proxy-env.ts";
import { probeConnection, type TlsProbe, type TlsProbeResult } from "../src/modules/doctor/tls-probe.ts";

/** A TCP server that counts the bytes anyone sends it, and whether its connection was closed. */
async function startListener() {
  const seen = { connections: 0, bytes: 0, closed: 0 };
  const server = createNetServer((socket: Socket) => {
    seen.connections += 1;
    socket.on("data", (chunk: Buffer) => {
      seen.bytes += chunk.length;
    });
    socket.on("close", () => {
      seen.closed += 1;
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, seen, close: () => server.close() };
}

/** An HTTP proxy that answers `CONNECT` with `status` and, on 200, tunnels to the given port; it keeps every request head. */
async function startProxy(status: number, targetPort: number) {
  const heads: string[] = [];
  const proxy = createNetServer((client: Socket) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.off("data", onData);
      heads.push(head);
      if (status !== 200) return client.end(`HTTP/1.1 ${status} No\r\nContent-Length: 0\r\n\r\n`);
      const upstream = netConnect({ host: "127.0.0.1", port: targetPort }, () => {
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
  return { url: new URL(`http://127.0.0.1:${port}`), heads, close: () => proxy.close() };
}

async function closedPort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("the condition did not come true in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const OPTIONS = { proxy: null, ca: [], timeoutMs: 2_000 };

describe("connection probe", () => {
  test("a host that accepts connections is ok, gets not a single byte, and the connection is closed", async () => {
    const listener = await startListener();
    try {
      expect(await probeConnection({ host: "127.0.0.1", port: listener.port }, OPTIONS)).toEqual({ kind: "ok" });
      await until(() => listener.seen.closed === 1);
      expect(listener.seen).toEqual({ connections: 1, bytes: 0, closed: 1 });
    } finally {
      listener.close();
    }
  });

  test("a port nobody listens at is unreachable, not as a proxy", async () => {
    const result = await probeConnection({ host: "127.0.0.1", port: await closedPort() }, OPTIONS);
    expect(result).toMatchObject({ kind: "unreachable", proxy: false });
  });

  test("a host whose name cannot be found is a DNS failure", async () => {
    const result = await probeConnection({ host: "trackwall-no-such-host.invalid", port: 443 }, OPTIONS);
    expect(result.kind).toBe("dns");
  });

  test("through a proxy the probe sends only CONNECT for the host and port, and the host gets nothing", async () => {
    const listener = await startListener();
    const proxy = await startProxy(200, listener.port);
    try {
      const result = await probeConnection({ host: "provider.example.org", port: 4000 }, { ...OPTIONS, proxy: proxy.url });
      expect(result).toEqual({ kind: "ok" });
      expect(proxy.heads).toEqual(["CONNECT provider.example.org:4000 HTTP/1.1\r\nHost: provider.example.org:4000\r\n\r\n"]);
      await until(() => listener.seen.closed === 1);
      expect(listener.seen.bytes).toBe(0);
    } finally {
      proxy.close();
      listener.close();
    }
  });

  test("a proxy that refuses the tunnel is a refusal with its status", async () => {
    const proxy = await startProxy(403, await closedPort());
    try {
      const result = await probeConnection({ host: "provider.example.org", port: 4000 }, { ...OPTIONS, proxy: proxy.url });
      expect(result).toEqual({ kind: "proxy-refused", status: 403 });
    } finally {
      proxy.close();
    }
  });

  test("a proxy nobody listens at is unreachable as a proxy", async () => {
    const proxy = new URL(`http://127.0.0.1:${await closedPort()}`);
    const result = await probeConnection({ host: "provider.example.org", port: 4000 }, { ...OPTIONS, proxy });
    expect(result).toMatchObject({ kind: "unreachable", proxy: true });
  });
});

describe("model provider address", () => {
  test.each([
    ["http://127.0.0.1:4000/v1", { scheme: "http:", host: "127.0.0.1", port: 4000 }],
    ["https://models.example.org/openai/v1", { scheme: "https:", host: "models.example.org", port: 443 }],
    ["http://models.example.org", { scheme: "http:", host: "models.example.org", port: 80 }],
    ["https://key:sk-123@[::1]:8443/v1", { scheme: "https:", host: "::1", port: 8443 }],
    ["ftp://models.example.org", null],
    ["models.example.org:4000", null],
  ])("%s is %j", (address, target) => {
    expect(providerTarget(address)).toEqual(target as ReturnType<typeof providerTarget>);
  });

  test("an http address goes through HTTP_PROXY and not HTTPS_PROXY, as Node.js sends plain HTTP", () => {
    const env = { HTTPS_PROXY: "http://secure.example.org:3128", HTTP_PROXY: "http://plain.example.org:8080" };
    expect(shownProxy(proxyFor(env, "http:", "models.example.org", 80) ?? new URL("http://none"))).toBe("plain.example.org:8080");
    expect(proxyFor({ HTTPS_PROXY: "http://secure.example.org:3128" }, "http:", "models.example.org", 80)).toBeNull();
  });
});

describe("the environment of the model provider check", () => {
  const mise = {
    vars: {
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:4000/v1",
      COPILOT_PROVIDER_API_KEY: "sk-local",
      SHOP_SECRET: "from-age",
      SHOP_REGION: "byok",
    },
    secretNames: ["COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_API_KEY", "SHOP_SECRET", "SHOP_AGE_VALUE"],
    problem: null,
    profile: "byok",
  };

  test("holds the provider's address and the proxy settings, and no other secret: the API key never reaches the check", () => {
    const user = { HTTPS_PROXY: "http://proxy.example.org:3128", GH_TOKEN: "ghp-user", SHOP_AGE_VALUE: "x", PATH: "/usr/bin" };
    expect(profileEnvironment(user, mise)).toEqual({
      profile: "byok",
      env: {
        HTTPS_PROXY: "http://proxy.example.org:3128",
        PATH: "/usr/bin",
        COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:4000/v1",
        SHOP_REGION: "byok",
      },
      problem: null,
    });
  });

  test("keeps a proxy setting mise holds as a secret for the login in it, so the check takes the sessions' route", () => {
    const withProxySecret = {
      ...mise,
      vars: { ...mise.vars, https_proxy: "http://me:pass@proxy.example.org:3128" },
      secretNames: [...mise.secretNames, "https_proxy"],
    };
    expect(profileEnvironment({}, withProxySecret)?.env.https_proxy).toBe("http://me:pass@proxy.example.org:3128");
  });

  test("without a session profile there is nothing to check", () => {
    expect(profileEnvironment({}, { ...mise, profile: null })).toBeNull();
  });
});

/** A probe that answers `result` and records the targets and proxies it was given. */
function scriptedProbe(result: TlsProbeResult) {
  const calls: { host: string; port: number; proxy: string | null }[] = [];
  const probe: TlsProbe = async ({ host, port }, o) => {
    calls.push({ host, port, proxy: o.proxy?.href ?? null });
    return result;
  };
  return { probe, calls };
}

/** An address whose host and key no outcome may show: the address is a secret (it may carry a key). */
const HIDDEN = "https://sk-in-url@models.internal-host.example:8443/v1";

function byok(env: NodeJS.ProcessEnv, problem: string | null = null): ProfileEnvironment {
  return { profile: "byok", env, problem };
}

function expectNothingOfTheAddress(outcome: unknown): void {
  const text = JSON.stringify(outcome);
  expect(text).not.toContain("internal-host");
  expect(text).not.toContain("sk-in-url");
  expect(text).not.toContain("8443");
}

describe("model provider check", () => {
  test("a session profile that sets no provider gives no row", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    expect(await modelProviderOutcome(byok({ SHOP_REGION: "byok" }), { probe, ca: [] })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a provider that accepts connections is ok, and the row names the profile and not the address", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    const outcome = await modelProviderOutcome(byok({ COPILOT_PROVIDER_BASE_URL: HIDDEN }), { probe, ca: [] });
    expect(outcome).toEqual({ status: "ok", summary: "The model provider of the session profile byok accepts connections.", fix: null });
    expect(calls).toEqual([{ host: "models.internal-host.example", port: 8443, proxy: null }]);
  });

  test("through a proxy the row names the proxy's host and port, never its login", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    const env = { COPILOT_PROVIDER_BASE_URL: HIDDEN, HTTPS_PROXY: "http://me:proxy-pass@proxy.example.org:3128" };
    const outcome = await modelProviderOutcome(byok(env), { probe, ca: [] });
    expect(outcome?.summary).toBe(
      "The model provider of the session profile byok accepts connections through the proxy proxy.example.org:3128.",
    );
    expect(JSON.stringify(outcome)).not.toContain("proxy-pass");
    expect(calls[0]?.proxy).toBe("http://me:proxy-pass@proxy.example.org:3128/");
  });

  test.each<[TlsProbeResult, string, string]>([
    [
      { kind: "unreachable", message: "connect ECONNREFUSED models.internal-host.example:8443", proxy: false },
      "fail",
      "The model provider of the session profile byok does not accept connections.",
    ],
    [
      { kind: "dns", message: "getaddrinfo ENOTFOUND models.internal-host.example" },
      "fail",
      "The host of the model provider of the session profile byok cannot be found.",
    ],
    [
      { kind: "error", message: "models.internal-host.example did not answer" },
      "fail",
      "The model provider of the session profile byok could not be checked.",
    ],
  ])("a probe's %j is %s, and no socket message carries the host into the row", async (result, status, summary) => {
    const { probe } = scriptedProbe(result);
    const outcome = await modelProviderOutcome(byok({ COPILOT_PROVIDER_BASE_URL: HIDDEN }), { probe, ca: [] });
    expect(outcome).toMatchObject({ status, summary, fix: expect.stringContaining("mise.byok.toml") });
    expectNothingOfTheAddress(outcome);
  });

  test("a proxy that refuses the tunnel is only a warning: it may still forward the sessions' requests", async () => {
    const { probe } = scriptedProbe({ kind: "proxy-refused", status: 403 });
    const env = { COPILOT_PROVIDER_BASE_URL: HIDDEN, HTTPS_PROXY: "http://proxy.example.org:3128" };
    const outcome = await modelProviderOutcome(byok(env), { probe, ca: [] });
    expect(outcome).toMatchObject({
      status: "warn",
      summary: "The proxy did not open a connection to the model provider of the session profile byok (403), so it could not be checked.",
    });
    expectNothingOfTheAddress(outcome);
  });

  test("an HTTPS proxy whose own certificate is not trusted is named, with the certificate to add", async () => {
    const { probe } = scriptedProbe({ kind: "untrusted", code: "SELF_SIGNED_CERT_IN_CHAIN", issuer: null, proxy: true });
    const env = { COPILOT_PROVIDER_BASE_URL: HIDDEN, HTTPS_PROXY: "https://proxy.example.org:3129" };
    const outcome = await modelProviderOutcome(byok(env), { probe, ca: [] });
    expect(outcome).toMatchObject({
      status: "fail",
      summary: "The certificate of the proxy proxy.example.org:3129 is not trusted (SELF_SIGNED_CERT_IN_CHAIN).",
      fix: expect.stringContaining("NODE_EXTRA_CA_CERTS"),
    });
    expectNothingOfTheAddress(outcome);
  });

  test("a proxy that cannot be reached or found is named as the problem, with the proxy settings to correct", async () => {
    const env = { COPILOT_PROVIDER_BASE_URL: HIDDEN, HTTPS_PROXY: "http://proxy.example.org:3128" };
    const unreachable = await modelProviderOutcome(byok(env), {
      probe: scriptedProbe({ kind: "unreachable", message: "x", proxy: true }).probe,
      ca: [],
    });
    expect(unreachable).toEqual({
      status: "fail",
      summary: "The proxy proxy.example.org:3128 cannot be reached.",
      fix: "Correct HTTP_PROXY, HTTPS_PROXY or NO_PROXY.",
    });
    const unknown = await modelProviderOutcome(byok(env), { probe: scriptedProbe({ kind: "dns", message: "x" }).probe, ca: [] });
    expect(unknown?.summary).toBe("The proxy proxy.example.org:3128 cannot be found.");
  });

  test("an address that is not http or https fails without being probed or shown", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    const outcome = await modelProviderOutcome(byok({ COPILOT_PROVIDER_BASE_URL: "models.internal-host.example:8443" }), { probe, ca: [] });
    expect(outcome).toEqual({
      status: "fail",
      summary: "COPILOT_PROVIDER_BASE_URL of the session profile byok is not an http or https address.",
      fix: "Correct COPILOT_PROVIDER_BASE_URL in mise.byok.toml.",
    });
    expect(calls).toEqual([]);
  });

  test("a proxy that is not HTTP fails without its address or password", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    const env = { COPILOT_PROVIDER_BASE_URL: HIDDEN, HTTPS_PROXY: "socks5://me:proxy-pass@proxy.example.org:1080" };
    const outcome = await modelProviderOutcome(byok(env), { probe, ca: [] });
    expect(outcome?.status).toBe("fail");
    expect(JSON.stringify(outcome)).not.toContain("proxy-pass");
    expect(calls).toEqual([]);
  });

  test("when mise could not give the profile's environment the row says so instead of staying silent", async () => {
    const { probe, calls } = scriptedProbe({ kind: "ok" });
    const outcome = await modelProviderOutcome(byok({}, "mise.byok.toml: age key missing"), { probe, ca: [] });
    expect(outcome).toMatchObject({
      status: "warn",
      summary: "mise did not give the environment of the session profile byok, so the model provider could not be checked.",
    });
    expect(calls).toEqual([]);
  });
});
