// A fake `mise` for installing one tool outside a repo (ADR-123): `install <tool>@<version>` makes
// `<FAKE_MISE_INSTALLS>/<tool>@<version>/bin/java` (`java.exe` on Windows) and appends `MISE_CEILING_PATHS` and the working
// directory to `<FAKE_MISE_INSTALLS>/calls.log`; `where <tool>@<version>` prints that folder once it is installed and fails
// like mise otherwise. With `FAKE_MISE_INSTALL_ERROR` set, `install` prints it as mise's error and ends with code 1.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const installs = process.env.FAKE_MISE_INSTALLS;
if (installs === undefined) throw new Error("FAKE_MISE_INSTALLS is not set");
const [command, spec] = process.argv.slice(2);
if (spec === undefined) throw new Error(`fake mise: no tool after ${command}`);
const dir = join(installs, spec);

if (command === "install") {
  appendFileSync(join(installs, "calls.log"), `${JSON.stringify({ ceiling: process.env.MISE_CEILING_PATHS, cwd: process.cwd() })}\n`);
  const error = process.env.FAKE_MISE_INSTALL_ERROR;
  if (error !== undefined) {
    console.error(`mise ERROR ${error}`);
    console.error("mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information");
    process.exit(1);
  }
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", process.platform === "win32" ? "java.exe" : "java"), "");
} else if (command === "where") {
  if (!existsSync(dir)) {
    console.error(`mise ERROR ${spec} is not installed`);
    process.exit(1);
  }
  console.log(dir);
} else {
  throw new Error(`fake mise: unknown command ${command}`);
}
