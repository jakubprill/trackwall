// The `procs` module in a separate process, so that the test checks it under Node the same as under Bun: starts a process tree
// (PIDs in `<dir>`), waits until it is all up, stops it, writes the log (`<dir>/logs`) and prints the run state as JSON.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Logs } from "../../src/modules/logs/logs.ts";
import { ProcessGroups } from "../../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../../src/platform/group-platform.ts";
import { waitUntil } from "../../src/platform/process-group.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("missing directory");
const tree = fileURLToPath(new URL("./process-tree.ts", import.meta.url));
const logs = new Logs({ dir: join(dir, "logs"), maxFileBytes: 1024 * 1024, log: () => {} });
const groups = new ProcessGroups({
  logs,
  runtime: new RuntimeFile(join(dir, "runtime.json")),
  platform: groupPlatform(),
  log: () => {},
});
await groups.start({
  owner: "o",
  command: [process.execPath, ...process.execArgv, tree, dir, "0", "3"],
  cwd: dir,
  env: process.env,
  logSource: { kind: "mise-task", repo: "web", miseTask: "dev" },
});
if (!(await waitUntil(() => existsSync(join(dir, "2.pid")), 15_000))) throw new Error("the tree did not come up");
const stopped = await groups.stop("o");
logs.flush();
process.stdout.write(`${JSON.stringify(stopped)}\n`);
