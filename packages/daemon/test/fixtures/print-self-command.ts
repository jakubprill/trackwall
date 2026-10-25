// Prints the command `selfCommand` hands out, for a test that runs it under Bun and under Node from a script that is
// not `src/main.ts`.
import { selfCommand } from "../../src/infra/self-command.ts";

process.stdout.write(JSON.stringify(selfCommand(["mcp-stdio"])));
