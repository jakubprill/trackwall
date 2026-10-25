import { expect, test } from "bun:test";
import { join } from "node:path";
import { selfCommand } from "../src/infra/self-command.ts";

test("from source the command runs src/main.ts with the subcommand, whatever script started the process", () => {
  const { exec, args } = selfCommand(["mcp-stdio", "--home", "state"]);

  expect(exec).toBe(process.execPath);
  expect(args.slice(-4)).toEqual([join(import.meta.dir, "..", "src", "main.ts"), "mcp-stdio", "--home", "state"]);
  expect(process.argv[1]).not.toBe(args.at(-4));
});
