/**
 * The key under which `env` holds the variable `name` (upper case). On Windows variable names are case-insensitive
 * (`Path`), but a copy of `process.env` is a plain object, so a lookup or an override by the exact name would miss the
 * user's spelling and leave two variables that differ only in case.
 */
export function envKey(env: NodeJS.ProcessEnv, name: string): string {
  if (process.platform !== "win32") return name;
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
}
