/**
 * Copilot CLI's `--model` for a session's start (ADR-98): a task's, a repo or free session's (ADR-175) and the
 * supervisor's (ADR-193), on every start and resume, since Copilot CLI otherwise resumes on its default model. None for
 * `null`, Copilot CLI's own default.
 */
const MODEL_FLAG = "--model";
const MODEL_ARG = `${MODEL_FLAG}=`;

export function modelArgs(model: string | null): string[] {
  return model === null ? [] : [`${MODEL_ARG}${model}`];
}

/** The model a start's arguments name, as `--model=x` or `--model x`, the last one when several do; `null` without one. */
export function modelOfArgs(args: readonly string[]): string | null {
  let found: string | null = null;
  args.forEach((arg, i) => {
    if (arg.startsWith(MODEL_ARG)) found = arg.slice(MODEL_ARG.length);
    else if (arg === MODEL_FLAG) found = args[i + 1] ?? null;
  });
  return found;
}
