/**
 * Copilot CLI with its ACP output copied to a file, for a contract test that needs an update the daemon drops (ADR-107):
 * `acp-tap.ts <file> <copilot> <arguments…>` runs Copilot CLI with the arguments, passes the daemon's input and Copilot
 * CLI's output through unchanged, and appends each output chunk to the file. `startRealCopilotDaemon` puts it in front
 * of Copilot CLI when given `acpTap`.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [file, copilot, ...args] = process.argv.slice(2);
if (file === undefined || copilot === undefined) throw new Error("usage: acp-tap.ts <file> <copilot> <arguments…>");

const child = spawn(copilot, args, { stdio: ["pipe", "pipe", "inherit"] });
// The daemon may still write while Copilot CLI exits; the broken pipe is the end of the session, not an error to report.
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.on("data", (chunk: Buffer) => {
  appendFileSync(file, chunk);
  process.stdout.write(chunk);
});
// `close` comes after Copilot CLI's output has been read to its end; setting the exit code lets that output be written.
child.on("close", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 0 : 1);
});
