/**
 * The hooks of the session plugin, read and fired the way Copilot CLI does it: `--plugin-dir` names the directory of
 * `hooks.json` (written by `writeCopilotPlugin`), and every hook is a program (`exec` + `args`) that gets a JSON
 * payload on stdin or a POST of that payload to a URL, which goes to `127.0.0.1` only with
 * `COPILOT_HOOK_ALLOW_LOCALHOST=1` (ADR-88). Copilot CLI waits for each hook, so the POST is made by a child process
 * the fake waits for; the answers' bodies are the hooks' outputs (ADR-85). Shared by the fake Copilot CLI of the tests
 * and the stand-in of the demo daemon.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jsonOf } from "../../src/modules/agents/json.ts";

const PluginHook = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), exec: z.string(), args: z.array(z.string()), cwd: z.string() }),
  z.object({ type: z.literal("http"), url: z.url(), headers: z.record(z.string(), z.string()) }),
]);
const HooksFile = z.object({ hooks: z.record(z.string(), z.array(PluginHook)) });

const POST_HOOK = join(import.meta.dir, "..", "fixtures", "post-hook.ts");

/** The output of an HTTP hook: a JSON object, or nothing for an empty or unreadable answer. */
const HookOutput = jsonOf(z.record(z.string(), z.unknown()));

/**
 * A function that fires every hook of an event, for the plugin named in `argv`, and returns the outputs of its HTTP
 * hooks; no `--plugin-dir` is an error.
 */
export function pluginHooks(
  argv: readonly string[],
  sessionId: string,
): (event: string, payload: Record<string, unknown>) => Record<string, unknown>[] {
  const dirIndex = argv.indexOf("--plugin-dir");
  const pluginDir = dirIndex < 0 ? undefined : argv[dirIndex + 1];
  if (pluginDir === undefined) throw new Error("no --plugin-dir");
  const { hooks } = HooksFile.parse(JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8")));
  const loopbackAllowed = process.env.COPILOT_HOOK_ALLOW_LOCALHOST === "1";
  return (event, payload) => {
    const input = JSON.stringify({ sessionId, timestamp: Date.now(), ...payload });
    const outputs: Record<string, unknown>[] = [];
    for (const hook of hooks[event] ?? []) {
      if (hook.type === "command") spawnSync(hook.exec, hook.args, { cwd: hook.cwd, input });
      else if (loopbackAllowed || new URL(hook.url).hostname !== "127.0.0.1") {
        const post = spawnSync(process.execPath, ["--no-env-file", POST_HOOK, hook.url, JSON.stringify(hook.headers)], { input });
        const output = HookOutput.safeParse(post.stdout.toString("utf8"));
        if (output.success) outputs.push(output.data);
      }
    }
    return outputs;
  };
}
