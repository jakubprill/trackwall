import { TaskModel } from "@trackwall/protocol";

/**
 * The model typed for a task (ADR-98), on the New session form or a proposal: an empty field is Copilot CLI's default
 * (`null`), an id the daemon would refuse is `undefined`, so the start waits until the user fixes it.
 */
export function typedModel(text: string): string | null | undefined {
  if (text.trim() === "") return null;
  const model = TaskModel.safeParse(text);
  return model.success ? model.data : undefined;
}
