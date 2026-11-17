/**
 * Git without hooks (`core.hooksPath`): `--no-verify` skips only some hooks, while a push or a ref update also runs
 * `reference-transaction` and an index write `post-index-change`, and a repo's hooks may come from a directory an agent
 * writes (`.husky`, or any folder a relative `core.hooksPath` names). For the task branch push (ADR-77), the local
 * config store's commits and push (ADR-86), the round commits, and every daemon git call in a repo with a task in the
 * sandbox (`git.ts`, ADR-181 addendum).
 *
 * The hooks path is the daemon's own program file: git looks for `<path>/<hook>`, which cannot exist under a file, and
 * no agent can put one there. An empty folder in the temporary folder would do the same only until a task in the
 * sandbox, which may write the temporary folder, puts a hook into it.
 */
export const NO_HOOKS = `core.hooksPath=${process.execPath}`;
