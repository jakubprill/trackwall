import type { DoctorCheck } from "@trackwall/protocol";
import { isSecretName } from "../../infra/secret-name.ts";
import { proxyFor, shownProxy } from "./proxy-env.ts";
import type { ConnectionProbe, ConnectionProbeResult } from "./tls-probe.ts";

/**
 * The doctor's model provider check (§4.15, ADR-179): whether anything accepts connections at the model provider the
 * session profile points Copilot CLI at (`COPILOT_PROVIDER_BASE_URL`, ADR-136), e.g. a local proxy that stopped. It only
 * opens a connection and closes it: no request, no API key (it never reads one), nothing but `CONNECT host:port` to a
 * proxy. The address is a secret (it may carry a key), so no outcome names it, its host or a socket's message, which
 * would; only the profile and a proxy's host and port are shown, as the network check shows them.
 */

/** The variable Copilot CLI takes its model provider's address from (ADR-136). */
const PROVIDER_ADDRESS = "COPILOT_PROVIDER_BASE_URL";
const PROBE_TIMEOUT_MS = 5_000;

type Outcome = Omit<DoctorCheck, "id">;

/** What a session in the projects folder would start with under the session profile. */
export interface ProfileEnvironment {
  profile: string;
  /**
   * The session's environment as far as the check needs it: the provider's address and the proxy settings, from the
   * user's environment with mise's `[env]` on top. The caller leaves out mise's other secrets, the API key among them.
   */
  env: NodeJS.ProcessEnv;
  /** Why mise gave less than the place has (ADR-93), from `Mise.sessionEnv`; `null` when nothing is missing. */
  problem: string | null;
}

/** What mise gives a session in the projects folder (`Mise.sessionEnv`), as far as the check takes it. */
export interface ProfileMiseEnv {
  vars: Record<string, string>;
  secretNames: readonly string[];
  problem: string | null;
  profile: string | null;
}

/**
 * The environment the check works with: the user's with mise's on top, as a session gets it, without any secret but the
 * provider's address, so that the API key never reaches the check; `null` without a session profile.
 */
export function profileEnvironment(userEnv: NodeJS.ProcessEnv, mise: ProfileMiseEnv): ProfileEnvironment | null {
  if (mise.profile === null) return null;
  const secret = (name: string) => name !== PROVIDER_ADDRESS && (isSecretName(name) || mise.secretNames.includes(name));
  const env = Object.fromEntries(Object.entries({ ...userEnv, ...mise.vars }).filter(([name]) => !secret(name)));
  return { profile: mise.profile, env, problem: mise.problem };
}

export interface ModelProviderDeps {
  probe: ConnectionProbe;
  /** The certificates a session trusts, for an HTTPS proxy's own certificate. */
  ca: readonly string[];
}

/** The check's outcome; `null` without a session profile or when the profile sets no provider (sessions use GitHub then). */
export async function modelProviderOutcome(read: ProfileEnvironment | null, deps: ModelProviderDeps): Promise<Outcome | null> {
  if (read === null) return null;
  const address = read.env[PROVIDER_ADDRESS]?.trim();
  if (!address) return read.problem === null ? null : profileUnreadable(read.profile);
  const target = providerTarget(address);
  if (target === null)
    return {
      status: "fail",
      summary: `${PROVIDER_ADDRESS} of the session profile ${read.profile} is not an http or https address.`,
      fix: `Correct ${PROVIDER_ADDRESS} in mise.${read.profile}.toml.`,
    };
  let proxy: URL | null;
  try {
    proxy = proxyFor(read.env, target.scheme, target.host, target.port);
  } catch {
    return { status: "fail", summary: "The proxy for the model provider is not an HTTP proxy.", fix: "Correct HTTP_PROXY or HTTPS_PROXY." };
  }
  const result = await deps.probe({ host: target.host, port: target.port }, { proxy, ca: deps.ca, timeoutMs: PROBE_TIMEOUT_MS });
  return probeOutcome(read.profile, proxy, result);
}

/** The scheme, host and port of an `http` or `https` address; `null` for anything else. */
export function providerTarget(address: string): { scheme: "http:" | "https:"; host: string; port: number } | null {
  if (!URL.canParse(address)) return null;
  const url = new URL(address);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { scheme: url.protocol, host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

function profileUnreadable(profile: string): Outcome {
  return {
    status: "warn",
    summary: `mise did not give the environment of the session profile ${profile}, so the model provider could not be checked.`,
    fix: "Open a session: the line under its header says what is missing.",
  };
}

function probeOutcome(profile: string, proxy: URL | null, result: ConnectionProbeResult): Outcome {
  const provider = `the model provider of the session profile ${profile}`;
  const via = proxy === null ? "" : ` through the proxy ${shownProxy(proxy)}`;
  const check = `Check that the provider in ${PROVIDER_ADDRESS} of mise.${profile}.toml runs, for example a local proxy in front of it, and that the address is right.`;
  const proxyFix = "Correct HTTP_PROXY, HTTPS_PROXY or NO_PROXY.";
  switch (result.kind) {
    case "ok":
      return { status: "ok", summary: `${capitalized(provider)} accepts connections${via}.`, fix: null };
    case "dns":
      if (proxy !== null) return { status: "fail", summary: `The proxy ${shownProxy(proxy)} cannot be found.`, fix: proxyFix };
      return { status: "fail", summary: `The host of ${provider} cannot be found.`, fix: check };
    case "unreachable":
      if (result.proxy && proxy !== null)
        return { status: "fail", summary: `The proxy ${shownProxy(proxy)} cannot be reached.`, fix: proxyFix };
      return { status: "fail", summary: `${capitalized(provider)} does not accept connections${via}.`, fix: check };
    case "proxy-refused":
      // A proxy may refuse a tunnel to a port it would still forward a request to, so this is not the sessions' answer.
      return {
        status: "warn",
        summary: `The proxy did not open a connection to ${provider} (${result.status}), so it could not be checked.`,
        fix: `If sessions cannot reach the provider, add its host to NO_PROXY or ask whoever runs the proxy to allow it. ${proxyFix}`,
      };
    case "error":
      return { status: "fail", summary: `${capitalized(provider)} could not be checked${via}.`, fix: check };
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
