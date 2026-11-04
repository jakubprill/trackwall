/**
 * Copilot CLI's `--model` for a session's start (ADR-98): a task's, a repo or free session's (ADR-175) and the
 * supervisor's (ADR-193), on every start and resume, since Copilot CLI otherwise resumes on its default model. None for
 * `null`, Copilot CLI's own default.
 */
const MODEL_ARG = "--model=";

export function modelArgs(model: string | null): string[] {
  return model === null ? [] : [`${MODEL_ARG}${model}`];
}

/** The model a start's arguments name with `modelArgs`, the last one when several do; `null` without one. */
export function modelOfArgs(args: readonly string[]): string | null {
  const arg = args.findLast((a) => a.startsWith(MODEL_ARG));
  return arg === undefined ? null : arg.slice(MODEL_ARG.length);
}
