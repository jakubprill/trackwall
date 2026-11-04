import { z } from "zod";

/**
 * The Copilot CLI model a task's session runs on (ADR-98), and the supervisor's (`supervisorModel`, ADR-193), passed as
 * `--model=<id>` whenever the session starts or resumes; `null` for Copilot CLI's own default. The catalog of models
 * depends on the Copilot CLI version and the user's account, so Trackwall checks only the shape of an id
 * (`claude-opus-5.5`, `gpt-5.5`, `auto`) and Copilot CLI the rest.
 */
export const TASK_MODEL_MAX = 64;
export const TaskModel = z
  .string()
  .trim()
  .min(1)
  .max(TASK_MODEL_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: "a model id is letters, digits, dots, dashes and underscores, such as claude-opus-5.5",
  });
