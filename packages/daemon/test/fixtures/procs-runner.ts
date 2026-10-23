// Moduł `procs` w osobnym procesie, żeby test sprawdził go pod Node tak samo jak pod Bun: uruchamia drzewo procesów
// (PID-y w `<dir>`), czeka, aż całe stoi, zatrzymuje je i drukuje stan uruchomienia jako JSON.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessGroups } from "../../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../../src/platform/group-platform.ts";
import { waitUntil } from "../../src/platform/process-group.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("brak katalogu");
const tree = fileURLToPath(new URL("./process-tree.ts", import.meta.url));
const groups = new ProcessGroups({ runtime: new RuntimeFile(join(dir, "runtime.json")), platform: groupPlatform(), log: () => {} });
await groups.start({ owner: "o", command: [process.execPath, ...process.execArgv, tree, dir, "0", "3"], cwd: dir, env: process.env });
if (!(await waitUntil(() => existsSync(join(dir, "2.pid")), 15_000))) throw new Error("drzewo nie wstało");
process.stdout.write(`${JSON.stringify(await groups.stop("o"))}\n`);
