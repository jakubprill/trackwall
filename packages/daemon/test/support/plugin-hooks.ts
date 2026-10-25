/**
 * The hooks of the session plugin, read and fired the way Copilot CLI does it: `--plugin-dir` names the directory of
 * `hooks.json` (written by `writeCopilotPlugin`), and every hook is a program (`exec` + `args`) that gets a JSON
 * payload on stdin. Shared by the fake Copilot CLI of the tests and the stand-in of the demo daemon.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const HooksFile = z.object({
  hooks: z.record(z.string(), z.array(z.object({ exec: z.string(), args: z.array(z.string()), cwd: z.string() }))),
});

/** A function that fires every hook of an event, for the plugin named in `argv`; no `--plugin-dir` is an error. */
export function pluginHooks(argv: readonly string[], sessionId: string): (event: string, payload: Record<string, unknown>) => void {
  const dirIndex = argv.indexOf("--plugin-dir");
  const pluginDir = dirIndex < 0 ? undefined : argv[dirIndex + 1];
  if (pluginDir === undefined) throw new Error("no --plugin-dir");
  const { hooks } = HooksFile.parse(JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8")));
  return (event, payload) => {
    for (const hook of hooks[event] ?? []) {
      spawnSync(hook.exec, hook.args, { cwd: hook.cwd, input: JSON.stringify({ sessionId, timestamp: Date.now(), ...payload }) });
    }
  };
}
