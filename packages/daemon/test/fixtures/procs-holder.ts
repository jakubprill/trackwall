// „Daemon” na niby: uruchamia drzewo procesów przez moduł `procs`, zgłasza gotowość plikiem `ready` i czeka, aż
// test zabije go twardo. Argument: katalog stanu (tam `runtime.json`, `tree/` z PID-ami drzewa i `ready`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logs } from "../../src/modules/logs/logs.ts";
import { ProcessGroups } from "../../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../../src/platform/group-platform.ts";

const home = process.argv[2];
if (home === undefined) throw new Error("brak katalogu stanu");
const tree = join(home, "tree");
mkdirSync(tree, { recursive: true });
const groups = new ProcessGroups({
  logs: new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} }),
  runtime: new RuntimeFile(join(home, "runtime.json")),
  platform: groupPlatform(),
  log: () => {},
});
await groups.start({
  owner: "holder",
  command: [process.execPath, join(import.meta.dir, "process-tree.ts"), tree, "0", "3"],
  cwd: home,
  env: process.env,
  logSource: { kind: "mise-task", repo: "web", miseTask: "dev" },
});
writeFileSync(join(home, "ready"), "1");
setInterval(() => {}, 60_000);
