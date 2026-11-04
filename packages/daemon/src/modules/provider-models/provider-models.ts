import { createHash } from "node:crypto";
import type { ProviderModelList, WireApi } from "@trackwall/protocol";
import { chatModels } from "./model-list.ts";
import { callProvider, type ProviderAnswer, type ProviderCall } from "./provider-call.ts";
import { providerRequest, providerUrl } from "./provider-request.ts";
import { probeWireApis } from "./wire-api-probe.ts";

/**
 * The models the model provider of the session profile offers (§4.24, ADR-194), for the Model fields to suggest, and
 * the format each answers in (ADR-195), for a session's start to set. The daemon asks the provider itself, as a
 * session's Copilot CLI would reach it, because the key must not leave the daemon and Copilot CLI with a custom
 * provider lists no models (neither in a session nor over ACP). A list is kept for a few minutes per profile, address
 * and credentials, so opening a form does not ask the provider each time; a failure is not kept, so asking again tries
 * again. What a probe learned about a model's format is kept while the daemon runs, per address, credentials and model.
 */

/** The session profile's environment as a session gets it in the projects folder, the provider's key included. */
interface ProfileSessionEnv {
  profile: string;
  env: NodeJS.ProcessEnv;
  /** Why mise gave less than the place has; `null` when nothing is missing. */
  problem: string | null;
}

export interface ProviderModelsDeps {
  /** `null` without a session profile. */
  profileEnv: () => Promise<ProfileSessionEnv | null>;
  /** The certificate authorities a session's Node.js trusts in that environment. */
  ca: (env: NodeJS.ProcessEnv) => Promise<readonly string[]>;
  log: (msg: string) => void;
}

const KEEP_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 10_000;
/** A probe holds up a session's start, so it gives up sooner than the list. */
const PROBE_TIMEOUT_MS = 5_000;
const MAX_BYTES = 4 * 1024 * 1024;

export class ProviderModels {
  private readonly deps: ProviderModelsDeps;
  private kept: { key: string; at: number; list: Promise<ProviderModelList> } | null = null;
  /** The formats a model answered in, by provider key and model; only models where at least one answered. */
  private readonly formats = new Map<string, readonly WireApi[]>();
  /** Probes under way, so sessions that start together on one model ask once. */
  private readonly probing = new Map<string, Promise<readonly WireApi[] | null>>();

  constructor(deps: ProviderModelsDeps) {
    this.deps = deps;
  }

  async list(): Promise<ProviderModelList> {
    const read = await this.deps.profileEnv();
    if (read === null) return { profile: null, models: [], problem: null };
    const { profile } = read;
    const request = providerRequest(read.env, profile);
    if (request.kind === "none") {
      const problem = read.problem === null ? null : `mise did not give the environment of the session profile ${profile}.`;
      return { profile, models: [], problem };
    }
    if (request.kind === "unsupported") return { profile, models: [], problem: request.problem };
    const provider = providerKey(request.base, request.headers);
    const now = Date.now();
    const key = `${profile}\n${provider}`;
    const list =
      this.kept?.key === key && now - this.kept.at < KEEP_MS ? this.kept.list : this.ask(profile, request.base, request.headers, read.env);
    if (this.kept?.list !== list) this.kept = { key, at: now, list };
    try {
      const result = await list;
      if (result.problem !== null && this.kept?.list === list) this.kept = null;
      return { ...result, models: result.models.map((m) => ({ ...m, wireApi: only(this.formats.get(`${provider}\n${m.id}`)) })) };
    } catch (err) {
      if (this.kept?.list === list) this.kept = null;
      throw err;
    }
  }

  /**
   * The format a session on `model` must use with the provider of its environment (ADR-195): the one format the model
   * answered in, probed on its first use and remembered; `null` to leave the session's environment as it is, when it
   * names no provider over HTTP, the model answered in both formats or in neither, or the provider could not be asked.
   */
  async wireApiFor(model: string, env: NodeJS.ProcessEnv): Promise<WireApi | null> {
    // Only the problems name the profile, and a problem only leaves the session's environment as it is.
    const request = providerRequest(env, "");
    if (request.kind !== "request" || !request.http) return null;
    const key = `${providerKey(request.base, request.headers)}\n${model}`;
    const known = this.formats.get(key);
    if (known !== undefined) return only(known);
    let probe = this.probing.get(key);
    if (probe === undefined) {
      probe = this.probe(request.base, request.headers, model, env).finally(() => this.probing.delete(key));
      this.probing.set(key, probe);
    }
    const works = await probe;
    if (works === null) return null;
    this.formats.set(key, works);
    return only(works);
  }

  private async probe(base: URL, headers: Record<string, string>, model: string, env: NodeJS.ProcessEnv) {
    const ca = await this.deps.ca(env);
    const call = (request: ProviderCall) => callProvider(request, { env, ca, timeoutMs: PROBE_TIMEOUT_MS, maxBytes: MAX_BYTES });
    const probe = await probeWireApis(base, headers, model, call);
    if (probe.kind === "unknown" || probe.works.length === 0) {
      this.deps.log(`the model provider did not tell which format model ${model} answers in; the session keeps its own`);
      return null;
    }
    return probe.works;
  }

  private async ask(profile: string, base: URL, headers: Record<string, string>, env: NodeJS.ProcessEnv): Promise<ProviderModelList> {
    const ca = await this.deps.ca(env);
    const answer = await callProvider(
      { url: providerUrl(base, "/models"), headers },
      { env, ca, timeoutMs: LIST_TIMEOUT_MS, maxBytes: MAX_BYTES },
    );
    return { profile, ...outcome(answer) };
  }
}

/** A provider told apart by its address and a hash of its credentials, so a changed key asks anew; never the key itself. */
function providerKey(base: URL, headers: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([base.href, headers]))
    .digest("hex");
}

/** The format to set: the only one that answered; `null` when both did, or nothing is known. */
function only(works: readonly WireApi[] | undefined): WireApi | null {
  return works?.length === 1 ? (works[0] ?? null) : null;
}

function outcome(answer: ProviderAnswer): Pick<ProviderModelList, "models" | "problem"> {
  const provider = "The model provider of the session profile";
  if (answer.kind === "failed") return { models: [], problem: `${provider} could not be asked for its models: ${answer.reason}.` };
  if (answer.status === 401 || answer.status === 403)
    return { models: [], problem: `${provider} did not accept its key when asked for its models (${answer.status}).` };
  if (answer.status !== 200) return { models: [], problem: `${provider} answered ${answer.status} when asked for its models.` };
  const models = chatModels(answer.body);
  if (models === null) return { models: [], problem: `${provider} did not answer with a list of models.` };
  return { models, problem: null };
}
