import { z } from "zod";
import { jsonOf } from "./json.ts";

/**
 * The event Copilot CLI appends to a conversation's event log when the conversation's model is set (ADR-225),
 * `session.model_change`: at every start and resume (`source: "startup"`), and on `/model`. Like the usage receipt, the
 * format is Copilot CLI's own and undocumented; a contract test pins the field read here.
 */

/** The event's type; a line without this text is not parsed at all, since tool results can make lines long. */
const MODEL_CHANGE = "session.model_change";

const ModelChangeLine = jsonOf(
  z.object({
    type: z.literal(MODEL_CHANGE),
    data: z.object({ newModel: z.string().min(1) }),
  }),
);

/** The model a model change sets, from an event log's line; `undefined` for any other line. */
export function modelChangeOf(line: string): string | undefined {
  if (!line.includes(MODEL_CHANGE)) return undefined;
  const parsed = ModelChangeLine.safeParse(line);
  return parsed.success ? parsed.data.data.newModel : undefined;
}
