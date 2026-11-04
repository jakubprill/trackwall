import { type ProviderModel, providerModelsApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "./api.ts";
import type { Connection } from "./connection.ts";
import { useRemote } from "./use-remote.ts";

const NONE: readonly ProviderModel[] = [];

/** The models the Model fields suggest (ADR-194): none while they load, without a provider, or when it could not be asked. */
export function useProviderModels(conn: Connection): readonly ProviderModel[] {
  const load = useCallback(() => post(conn, providerModelsApi.list, {}), [conn]);
  return useRemote(load).data?.models ?? NONE;
}
