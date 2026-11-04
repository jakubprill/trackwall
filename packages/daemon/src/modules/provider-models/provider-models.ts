import { createHash } from "node:crypto";
import type { ProviderModelList } from "@trackwall/protocol";
import { chatModels } from "./model-list.ts";
import { type ProviderAnswer, providerGet } from "./provider-get.ts";
import { providerRequest } from "./provider-request.ts";

/**
 * The models the model provider of the session profile offers (§4.24, ADR-194), for the Model fields to suggest. The
 * daemon asks the provider's `GET /models` itself, as a session's Copilot CLI would reach it, because the key must not
 * leave the daemon and Copilot CLI with a custom provider lists no models (neither in a session nor over ACP). A list is
 * kept for a few minutes per profile, address and credentials, so opening a form does not ask the provider each time;
 * a failure is not kept, so asking again tries again.
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
  /** The request to the provider; `providerGet` outside tests. */
  get?: typeof providerGet;
  now?: () => number;
}

const KEEP_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;

export class ProviderModels {
  private readonly deps: ProviderModelsDeps;
  private kept: { key: string; at: number; list: Promise<ProviderModelList> } | null = null;

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
    const now = (this.deps.now ?? Date.now)();
    // The key's hash, not the key, tells a changed profile apart; the list itself never holds a secret.
    const key = createHash("sha256")
      .update(JSON.stringify([profile, request.url.href, request.headers]))
      .digest("hex");
    if (this.kept?.key === key && now - this.kept.at < KEEP_MS) return this.kept.list;
    const list = this.ask(profile, request.url, request.headers, read.env);
    this.kept = { key, at: now, list };
    const result = await list;
    if (result.problem !== null && this.kept?.list === list) this.kept = null;
    return result;
  }

  private async ask(profile: string, url: URL, headers: Record<string, string>, env: NodeJS.ProcessEnv): Promise<ProviderModelList> {
    const get = this.deps.get ?? providerGet;
    const answer = await get(url, headers, { env, ca: await this.deps.ca(env), timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    return { profile, ...outcome(answer) };
  }
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
