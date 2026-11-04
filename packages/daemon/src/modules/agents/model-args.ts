/**
 * Copilot CLI's `--model` for a session's start (ADR-98): a task's, a repo or free session's (ADR-175) and the
 * supervisor's (ADR-193), on every start and resume, since Copilot CLI otherwise resumes on its default model. None for
 * `null`, Copilot CLI's own default.
 */
export function modelArgs(model: string | null): string[] {
  return model === null ? [] : [`--model=${model}`];
}
