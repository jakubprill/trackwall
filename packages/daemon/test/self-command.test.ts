import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { RUNTIMES } from "./support/runtimes.ts";

const DAEMON = join(import.meta.dir, "..");
const Command = z.object({ exec: z.string(), args: z.array(z.string()) });

describe.each(RUNTIMES)("under %s", (_name, runtime) => {
  test("from source the command runs src/main.ts with the subcommand, whatever script started the process", () => {
    const [exec = "", ...flags] = runtime;
    const printed = spawnSync(exec, [...flags, join("test", "fixtures", "print-self-command.ts")], { cwd: DAEMON, encoding: "utf8" });

    const { args } = Command.parse(JSON.parse(printed.stdout));

    expect(args.slice(-2)).toEqual([join(DAEMON, "src", "main.ts"), "mcp-stdio"]);
  });
});
