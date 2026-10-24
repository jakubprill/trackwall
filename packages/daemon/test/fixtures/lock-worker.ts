// Proces testowy: wchodzi do sekcji krytycznej i zapisuje znaczniki wejścia i wyjścia do wspólnego pliku.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { withStartLock } from "../../src/infra/discovery.ts";

const home = process.argv[2] as string;
await withStartLock(home, async () => {
  appendFileSync(join(home, "trace"), `+${process.pid}\n`);
  await Bun.sleep(50);
  appendFileSync(join(home, "trace"), `-${process.pid}\n`);
});
