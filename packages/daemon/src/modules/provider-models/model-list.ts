import { type ProviderModel, TaskModel } from "@trackwall/protocol";
import { z } from "zod";

/**
 * The provider's answer to `GET /models` (ADR-194), an OpenAI-style list (`data[]` with `id`, and from some gateways
 * `context_window`), turned into the models a session can run on: an id Copilot CLI takes as `--model` (`TaskModel`),
 * no embedding model, each once, sorted by id. The list is outside data, so it is parsed, and an entry that does not
 * fit is left out rather than failing the list.
 */

const Entry = z.object({ id: z.string(), context_window: z.number().int().positive().optional() });
const ModelsAnswer = z.object({ data: z.array(z.unknown()) });

/** A list larger than this is not one a person picks from. */
const MAX_MODELS = 500;
/** Models that turn text into vectors and cannot hold a conversation. */
const EMBEDDING = /embed/i;

/** The chat models of the answer; `null` when it is not a list of models. */
export function chatModels(body: string): ProviderModel[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const answer = ModelsAnswer.safeParse(json);
  if (!answer.success) return null;
  const models = new Map<string, ProviderModel>();
  for (const item of answer.data.data) {
    const entry = Entry.safeParse(item);
    if (!entry.success || EMBEDDING.test(entry.data.id)) continue;
    const id = TaskModel.safeParse(entry.data.id);
    if (!id.success || models.has(id.data)) continue;
    models.set(id.data, { id: id.data, contextWindow: entry.data.context_window ?? null });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_MODELS);
}
