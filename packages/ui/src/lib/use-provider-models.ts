import { type ProviderModel, type ProviderModelList, providerModelsApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

const NONE: readonly ProviderModel[] = [];

/**
 * The models of the session profile's provider (ADR-194): `models` is what the Model fields suggest, none while they
 * load, without a provider, or when it could not be asked; `list` is the whole answer with its problem.
 */
export function useProviderModels(conn: Connection): { models: readonly ProviderModel[]; list: RemoteHandle<ProviderModelList> } {
  const load = useCallback(() => post(conn, providerModelsApi.list, {}), [conn]);
  const list = useRemote(load);
  return { models: list.data?.models ?? NONE, list };
}
