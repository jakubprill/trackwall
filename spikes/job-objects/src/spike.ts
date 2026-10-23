/**
 * Spike: grupa procesów, której nie da się zgubić.
 *
 *   spike.ts                 uruchamia wszystkie sprawdzenia i drukuje JSON z wynikami
 * Role procesów potomnych (w zmiennej TRACKWALL_SPIKE_ROLE jako tablica JSON):
 *   ["tree", n, dir]         węzeł drzewa testowego (ignoruje łagodne sygnały, odpala poziom n+1)
 *   ["holder", dir]          „daemon”, który trzyma job z drzewem i zostaje zabity
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, check, isAlive, isCompiled, ROLE_ENV, readTreePids, spawnSelf, TREE_DEPTH, waitUntil } from "./common.ts";

const [role, ...rest] = JSON.parse(process.env[ROLE_ENV] ?? "[]") as string[];

if (role === "tree") await treeNode(Number(rest[0]), rest[1] as string);
else if (role === "holder") await holder(rest[0] as string);
else await main();

/** Węzeł drzewa: zapisuje PID, ignoruje łagodne zatrzymanie i odpala następny poziom. */
async function treeNode(level: number, dir: string): Promise<void> {
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(s, () => {});
    } catch {
      // sygnał nieobsługiwany na tej platformie
    }
  }
  if (level + 1 < TREE_DEPTH) spawnSelf(["tree", String(level + 1), dir]);
  writeFileSync(join(dir, `${level}.pid`), String(process.pid));
  setInterval(() => {}, 60_000);
}

async function holder(dir: string): Promise<void> {
  const { Job } = await import("./win32.ts");
  const job = new Job(true);
  const root = spawnSelf(["tree", "0", dir]);
  job.assign(root.pid as number);
  await waitUntil(() => readTreePids(dir).length === TREE_DEPTH, 10_000);
  writeFileSync(join(dir, "ready"), "1");
  setInterval(() => {}, 60_000);
}

async function main(): Promise<void> {
  const checks: Check[] = process.platform === "win32" ? await windowsChecks() : await unixChecks();
  const runtime = (process.versions as Record<string, string>).bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
  process.stdout.write(`${JSON.stringify({ platform: `${process.platform}-${process.arch}`, runtime, compiled: isCompiled(), checks })}\n`);
  process.exit(checks.every((c) => c.ok || !c.required) ? 0 : 1);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "trackwall-job-"));
}

async function windowsChecks(): Promise<Check[]> {
  const out: Check[] = [];
  let win: typeof import("./win32.ts");
  try {
    win = await import("./win32.ts");
    out.push(check("ffi: kernel32 przez bun:ffi", true, "dlopen kernel32.dll"));
  } catch (err) {
    out.push(check("ffi: kernel32 przez bun:ffi", false, String(err)));
    return out;
  }

  try {
    out.push(
      check(
        "daemon już w jobie",
        true,
        `IsProcessInJob=${win.isInAnyJob(process.pid)} (informacyjnie: zagnieżdżone joby działają od Windows 8)`,
        false,
      ),
    );
  } catch (err) {
    out.push(check("daemon już w jobie", false, String(err), false));
  }

  // 1. Przypisanie zaraz po spawn, bez wstrzymanego startu: mierzy wyścig assign vs. pierwszy potomek.
  {
    const dir = tmp();
    const job = new win.Job(true);
    const t0 = performance.now();
    const root = spawnSelf(["tree", "0", dir]);
    try {
      job.assign(root.pid as number);
    } catch (err) {
      out.push(check("assign + drzewo w jobie", false, String(err)));
    }
    const ready = await waitUntil(() => readTreePids(dir).length === TREE_DEPTH, 10_000);
    const tree = readTreePids(dir);
    const inJob = job.pids();
    const assignMs = Math.round(performance.now() - t0);
    const all = ready && tree.every((p) => inJob.includes(p));
    out.push(
      check(
        "assign + drzewo w jobie",
        all,
        `drzewo ${tree.join(",")}; w jobie ${inJob.join(",")}; assign bez bramki, potomkowie startują po nim`,
        true,
        assignMs,
      ),
    );

    // 2. Zabicie całego drzewa jednym wywołaniem.
    const t1 = performance.now();
    job.terminate(1);
    const dead = await waitUntil(() => tree.every((p) => !isAlive(p)), 5000);
    out.push(
      check(
        "TerminateJobObject zabija całe drzewo",
        dead,
        `żywe po: ${tree.filter(isAlive).join(",") || "brak"}`,
        true,
        Math.round(performance.now() - t1),
      ),
    );
    job.close();
  }

  // 3. Śmierć „daemona” (zamknięcie ostatniego uchwytu joba) zabija drzewo dzięki KILL_ON_JOB_CLOSE.
  {
    const dir = tmp();
    const holder = spawnSelf(["holder", dir]);
    const ready = await waitUntil(() => existsSync(join(dir, "ready")), 15_000);
    const tree = readTreePids(dir);
    holder.kill("SIGKILL");
    const t = performance.now();
    const dead = ready && (await waitUntil(() => tree.every((p) => !isAlive(p)), 5000));
    out.push(
      check(
        "KILL_ON_JOB_CLOSE po twardym zabiciu daemona",
        dead,
        ready ? `drzewo ${tree.join(",")}; żywe po: ${tree.filter(isAlive).join(",") || "brak"}` : "holder nie zgłosił gotowości",
        true,
        Math.round(performance.now() - t),
      ),
    );
  }

  // 4. Koszt FFI: ile trwa utworzenie joba i przypisanie procesu (budżet na start serwisu).
  {
    const t = performance.now();
    for (let i = 0; i < 100; i++) new win.Job(true).close();
    out.push(check("100× CreateJobObject + Set + Close", true, "pomiar", false, Math.round(performance.now() - t)));
  }
  return out;
}

async function unixChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const { execFileSync } = await import("node:child_process");
  const pgid = (pid: number) =>
    Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)])
        .toString()
        .trim(),
    );

  // 1. setsid (detached) tworzy grupę, potomkowie ją dziedziczą.
  const dir = tmp();
  const root = spawnSelf(["tree", "0", dir], { detached: true });
  const ready = await waitUntil(() => readTreePids(dir).length === TREE_DEPTH, 10_000);
  const tree = readTreePids(dir);
  const groups = tree.map(pgid);
  out.push(
    check(
      "setsid: całe drzewo w jednej grupie",
      ready && groups.every((g) => g === root.pid),
      `drzewo ${tree.join(",")}; pgid ${groups.join(",")}`,
    ),
  );

  // 2. SIGTERM do grupy: drzewo ignoruje, więc musi przeżyć (sprawdza, że test jest uczciwy).
  process.kill(-(root.pid as number), "SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  out.push(check("SIGTERM do grupy ignorowany przez drzewo", tree.every(isAlive), "potrzebna eskalacja, jak w §4.1", false));

  // 3. Eskalacja: SIGKILL do grupy.
  const t = performance.now();
  process.kill(-(root.pid as number), "SIGKILL");
  const dead = await waitUntil(() => tree.every((p) => !isAlive(p)), 5000);
  out.push(
    check(
      "SIGKILL do -pgid zabija całe drzewo",
      dead,
      `żywe po: ${tree.filter(isAlive).join(",") || "brak"}`,
      true,
      Math.round(performance.now() - t),
    ),
  );
  return out;
}
