import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import type { DoctorCheck } from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";
import { proxyFor, shownProxy } from "./proxy-env.ts";
import type { TlsProbe, TlsProbeResult } from "./tls-probe.ts";

/**
 * The doctor's network check (§4.15, ADR-166): whether a session's Copilot CLI can reach GitHub and the Copilot service
 * from this computer, through the proxy and with the certificates its environment gives Node.js (`HTTPS_PROXY`,
 * `NO_PROXY`, `NODE_EXTRA_CA_CERTS`). Behind a company proxy that inspects TLS, the usual gap is a root certificate the
 * system trusts and Node.js does not; the check then tries the system's bundle and, when that works, names it.
 */

/** Where sessions go: GitHub for signing in, the Copilot service for the model. Only a TLS handshake, nothing is sent. */
export const SESSION_HOSTS = ["github.com", "api.githubcopilot.com"] as const;
const HTTPS_PORT = 443;
const PROBE_TIMEOUT_MS = 8_000;

/** The bundles Linux distributions keep the system's certificates in (Debian and Alpine, Fedora, openSUSE, Alpine and macOS). */
export const SYSTEM_CA_FILES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
] as const;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const RESTART =
  "in the environment Trackwall starts with (a user variable on Windows, the container's environment in a dev container), then restart Trackwall";

type Outcome = Omit<DoctorCheck, "id">;

export interface NetworkCheckDeps {
  probe: TlsProbe;
  systemCaFiles: readonly string[];
}

export async function networkOutcome(env: NodeJS.ProcessEnv, deps: NetworkCheckDeps): Promise<Outcome> {
  const extra = await extraCertificates(env);
  const ca = [...rootCertificates, ...(extra?.certs ?? [])];
  const probes = await Promise.all(SESSION_HOSTS.map((host) => probeHost(env, host, ca, deps.probe)));
  const failed = probes.find((p): p is FailedProbe => p.result.kind !== "ok");
  const extraNote = extra?.problem ? ` NODE_EXTRA_CA_CERTS: ${extra.problem}.` : "";
  if (failed === undefined) {
    const route = probes.find((p) => p.proxy !== null)?.proxy;
    const summary = `${SESSION_HOSTS.join(" and ")} answer ${route ? `through the proxy ${shownProxy(route)}` : "directly"}.`;
    if (extra?.problem) return { status: "warn", summary: summary + extraNote, fix: `Correct NODE_EXTRA_CA_CERTS ${RESTART}.` };
    return { status: "ok", summary, fix: null };
  }
  const { host, proxy, result } = failed;
  if (result.kind === "untrusted") {
    const bundle = await workingSystemBundle(env, failed.host, ca, deps);
    return untrustedOutcome(host, result, bundle, extraNote);
  }
  return unreachableOutcome(host, proxy, result);
}

interface HostProbe {
  host: string;
  proxy: URL | null;
  result: TlsProbeResult;
}

type FailedProbe = HostProbe & { result: Exclude<TlsProbeResult, { kind: "ok" }> };

async function probeHost(env: NodeJS.ProcessEnv, host: string, ca: readonly string[], probe: TlsProbe): Promise<HostProbe> {
  let proxy: URL | null;
  try {
    proxy = proxyFor(env, host, HTTPS_PORT);
  } catch (err) {
    return { host, proxy: null, result: { kind: "error", message: err instanceof Error ? err.message : String(err) } };
  }
  return { host, proxy, result: await probe({ host, port: HTTPS_PORT }, { proxy, ca, timeoutMs: PROBE_TIMEOUT_MS }) };
}

/** The certificates of `NODE_EXTRA_CA_CERTS`, or why Node.js would not use them; `null` when it is not set. */
async function extraCertificates(env: NodeJS.ProcessEnv): Promise<{ certs: string[]; problem: string | null } | null> {
  const file = env[envKey(env, "NODE_EXTRA_CA_CERTS")]?.trim();
  if (!file) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { certs: [], problem: `${file} cannot be read` };
  const certs = text.match(PEM_CERTIFICATE) ?? [];
  return { certs, problem: certs.length === 0 ? `${file} holds no PEM certificate` : null };
}

/** The first system bundle with which the host is trusted, so the fix can name a file that is known to work. */
async function workingSystemBundle(
  env: NodeJS.ProcessEnv,
  host: string,
  ca: readonly string[],
  deps: NetworkCheckDeps,
): Promise<string | null> {
  const current = env[envKey(env, "NODE_EXTRA_CA_CERTS")]?.trim();
  for (const file of deps.systemCaFiles) {
    if (file === current) continue;
    const certs = (await readFile(file, "utf8").catch(() => ""))?.match(PEM_CERTIFICATE) ?? [];
    if (certs.length === 0) continue;
    const retry = await probeHost(env, host, [...ca, ...certs], deps.probe);
    if (retry.result.kind === "ok") return file;
  }
  return null;
}

function untrustedOutcome(
  host: string,
  result: Extract<TlsProbeResult, { kind: "untrusted" }>,
  bundle: string | null,
  extraNote: string,
): Outcome {
  const signer = result.issuer ? `signed by "${result.issuer}"` : "signed by an authority";
  const summary = `The connection to ${host} is ${signer}, which Copilot CLI does not trust (${result.code}).${extraNote}`;
  if (bundle !== null)
    return {
      status: "fail",
      summary,
      fix: `This computer trusts it, but Node.js, which runs Copilot CLI, reads only its own certificates: set NODE_EXTRA_CA_CERTS=${bundle} ${RESTART}.`,
    };
  return {
    status: "fail",
    summary,
    fix: `Ask whoever runs your network for the root certificate of its proxy as a PEM file, then set NODE_EXTRA_CA_CERTS to that file ${RESTART}.`,
  };
}

function unreachableOutcome(host: string, proxy: URL | null, result: Exclude<TlsProbeResult, { kind: "ok" | "untrusted" }>): Outcome {
  const via = proxy === null ? "" : ` through the proxy ${shownProxy(proxy)}`;
  const fix = proxy
    ? `Correct HTTPS_PROXY (and NO_PROXY) ${RESTART}.`
    : `Check the network or VPN; behind a company proxy, set HTTPS_PROXY ${RESTART}.`;
  switch (result.kind) {
    case "proxy-refused":
      return proxyRefusedOutcome(host, proxy, result.status);
    case "dns":
      return { status: "fail", summary: `${proxy ? `The proxy ${shownProxy(proxy)}` : host} cannot be found: ${result.message}.`, fix };
    case "unreachable":
      if (result.proxy && proxy !== null)
        return { status: "fail", summary: `The proxy ${shownProxy(proxy)} cannot be reached: ${result.message}.`, fix };
      return { status: "fail", summary: `${host} cannot be reached${via}: ${result.message}.`, fix };
    case "error":
      return { status: "fail", summary: `${host}${via}: ${result.message}.`, fix };
  }
}

/** Only a proxy answers `CONNECT`; 407 is the one answer the user can fix alone. */
function proxyRefusedOutcome(host: string, proxy: URL | null, status: number): Outcome {
  const shown = proxy === null ? "" : ` ${shownProxy(proxy)}`;
  if (status === 407)
    return {
      status: "fail",
      summary: `The proxy${shown} asks for a login (407).`,
      fix: `Put the login into the proxy address (http://user:password@host:port) in HTTPS_PROXY ${RESTART}.`,
    };
  return {
    status: "fail",
    summary: `The proxy${shown} refused the connection to ${host} (${status}).`,
    fix: `Ask whoever runs the proxy to allow ${host}, or correct HTTPS_PROXY and NO_PROXY ${RESTART}.`,
  };
}
