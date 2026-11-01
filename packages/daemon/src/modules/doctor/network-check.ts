import { readFile, stat } from "node:fs/promises";
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

/** Where sessions go: GitHub for signing in, the Copilot service for the model. Only a TLS handshake: nothing is sent but a proxy's login. */
export const SESSION_HOSTS = ["github.com", "api.githubcopilot.com"] as const;
const HTTPS_PORT = 443;
const PROBE_TIMEOUT_MS = 8_000;

/**
 * The files Linux distributions keep the system's certificates in (Debian, Ubuntu and Alpine; Fedora and RHEL; openSUSE;
 * the last one also on Alpine and macOS, where it lacks the certificates added to the Keychain). Windows has none.
 */
export const SYSTEM_CA_FILES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
] as const;

/** A system bundle is about 200 KB; a file far larger is not one. */
const MAX_PEM_BYTES = 5 * 1024 * 1024;
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
  const system = usesSystemCertificates(env) ? await firstSystemBundle(deps.systemCaFiles) : null;
  const ca = [...rootCertificates, ...(extra?.certs ?? []), ...(system?.certs ?? [])];
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
  if (result.kind !== "untrusted") return unreachableOutcome(host, proxy, result);
  if (usesSystemCertificates(env) && system === null) return systemStoreUnknown(host, result);
  const bundle = await workingSystemBundle(env, host, ca, deps, extra?.file ?? null);
  return untrustedOutcome(host, result, bundle, extraNote);
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

/** The certificates in a PEM file, or why there are none: a path from the environment may be a folder, a pipe or huge. */
async function pemCertificates(file: string): Promise<{ certs: string[] } | { problem: string }> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile()) return { problem: `${file} is not a file that can be read` };
  if (info.size > MAX_PEM_BYTES) return { problem: `${file} is larger than a certificate bundle` };
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { problem: `${file} cannot be read` };
  const certs = text.match(PEM_CERTIFICATE) ?? [];
  return certs.length === 0 ? { problem: `${file} holds no PEM certificate` } : { certs };
}

/** The certificates of `NODE_EXTRA_CA_CERTS`, or why Node.js would not use them; `null` when it is not set. */
async function extraCertificates(env: NodeJS.ProcessEnv): Promise<{ file: string; certs: string[]; problem: string | null } | null> {
  const file = env[envKey(env, "NODE_EXTRA_CA_CERTS")]?.trim();
  if (!file) return null;
  const read = await pemCertificates(file);
  return "certs" in read ? { file, certs: read.certs, problem: null } : { file, certs: [], problem: read.problem };
}

/**
 * Node.js 22.15 and newer trust the system's certificates with `NODE_USE_SYSTEM_CA=1` or `--use-system-ca`; the check
 * then adds the system's bundle where it is a file (Linux), and elsewhere cannot tell.
 */
function usesSystemCertificates(env: NodeJS.ProcessEnv): boolean {
  return (
    env[envKey(env, "NODE_USE_SYSTEM_CA")]?.trim() === "1" || /(^|\s)--use-system-ca(\s|$)/.test(env[envKey(env, "NODE_OPTIONS")] ?? "")
  );
}

async function firstSystemBundle(files: readonly string[]): Promise<{ file: string; certs: string[] } | null> {
  for (const file of files) {
    const read = await pemCertificates(file);
    if ("certs" in read) return { file, certs: read.certs };
  }
  return null;
}

/** The first system bundle, in list order, with which the host is trusted, so the fix names a file known to work. */
async function workingSystemBundle(
  env: NodeJS.ProcessEnv,
  host: string,
  ca: readonly string[],
  deps: NetworkCheckDeps,
  extraFile: string | null,
): Promise<string | null> {
  const tried = await Promise.all(
    deps.systemCaFiles
      .filter((file) => file !== extraFile)
      .map(async (file) => {
        const read = await pemCertificates(file);
        if (!("certs" in read)) return null;
        const retry = await probeHost(env, host, [...ca, ...read.certs], deps.probe);
        return retry.result.kind === "ok" ? file : null;
      }),
  );
  return tried.find((file) => file !== null) ?? null;
}

function systemStoreUnknown(host: string, result: Extract<TlsProbeResult, { kind: "untrusted" }>): Outcome {
  return {
    status: "warn",
    summary: `The connection to ${host} is ${signerOf(result)}, which Node.js trusts only from the system's certificates (NODE_USE_SYSTEM_CA), and the doctor cannot read them here (${result.code}).`,
    fix: `If sessions cannot connect, set NODE_EXTRA_CA_CERTS to the proxy's root certificate as a PEM file ${RESTART}.`,
  };
}

function signerOf(result: Extract<TlsProbeResult, { kind: "untrusted" }>): string {
  return result.issuer ? `signed by "${result.issuer}"` : "signed by an authority";
}

function untrustedOutcome(
  host: string,
  result: Extract<TlsProbeResult, { kind: "untrusted" }>,
  bundle: string | null,
  extraNote: string,
): Outcome {
  const summary = `The connection to ${host} is ${signerOf(result)}, which Copilot CLI does not trust (${result.code}).${extraNote}`;
  if (bundle !== null)
    return {
      status: "fail",
      summary,
      fix: `This computer trusts it, but Node.js, which runs Copilot CLI, reads only its own certificates: set NODE_EXTRA_CA_CERTS=${bundle} ${RESTART}.`,
    };
  return {
    status: "fail",
    summary,
    fix: `Ask whoever runs your network for the root certificate of its proxy as a PEM file, then set NODE_EXTRA_CA_CERTS to that file ${RESTART}. Where the system already trusts it, NODE_USE_SYSTEM_CA=1 does the same for Node.js 22.15 or newer.`,
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
