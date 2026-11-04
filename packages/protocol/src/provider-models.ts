import { z } from "zod";
import { apiEndpoints } from "./api.ts";
import { TaskModel } from "./task-model.ts";

/**
 * Contract of the `provider-models` module (ADR-194): the models the model provider of the session profile (ADR-136)
 * offers, which the Model fields suggest, with the format each answers in once known (ADR-195). The daemon asks the provider with the profile's key, which never leaves it.
 * Every action is `POST /api/provider-models/<action>`.
 */

/** The two formats Copilot CLI speaks to a custom provider in (`COPILOT_PROVIDER_WIRE_API`). */
export const WireApi = z.enum(["completions", "responses"]);
export type WireApi = z.infer<typeof WireApi>;

/** One model the provider offers, under the id Copilot CLI takes as `--model`. */
export const ProviderModel = z.object({
  id: TaskModel,
  /** The context window in tokens, when the provider says it; `null` when it does not. */
  contextWindow: z.number().int().positive().nullable(),
  /**
   * The one format the model answered in when a session started on it (`COPILOT_PROVIDER_WIRE_API`, ADR-195), which
   * every session on it now gets; `null` before a session used it, or when it answers in both.
   */
  wireApi: WireApi.nullable(),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

export const ProviderModelList = z.object({
  /** The session profile asked about; `null` without one, when sessions use GitHub's models and nothing is listed. */
  profile: z.string().nullable(),
  /** The chat models, sorted by id; empty without a provider or when it could not be asked. */
  models: z.array(ProviderModel),
  /** Why nothing could be listed, in one sentence without the provider's address or key; `null` when nothing went wrong. */
  problem: z.string().nullable(),
});
export type ProviderModelList = z.infer<typeof ProviderModelList>;

const endpoint = apiEndpoints("provider-models");

export const providerModelsApi = {
  /** The provider's models, asked anew after a few minutes; a failure is never kept, so asking again tries again. */
  list: endpoint("list", z.object({}).strict(), ProviderModelList),
};
