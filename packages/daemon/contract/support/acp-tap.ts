/**
 * Copilot CLI with its ACP output copied to a file, for a contract test that needs an update the daemon drops (ADR-107):
 * `acp-tap.ts <file> <copilot> <arguments…>` runs Copilot CLI with the arguments, passes the daemon's input and Copilot
 * CLI's output through unchanged, and appends each output line to the file.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [file, copilot, ...args] = process.argv.slice(2);
if (file === undefined || copilot === undefined) throw new Error("usage: acp-tap.ts <file> <copilot> <arguments…>");

const child = spawn(copilot, args, { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
child.stdout.on("data", (chunk: Buffer) => {
  appendFileSync(file, chunk);
  process.stdout.write(chunk);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
