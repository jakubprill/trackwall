import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_BUFFER_RECORDS, type LogLevel } from "@trackwall/protocol";
import { fileName, LogFile, logFilePath, rotatedPath } from "../src/modules/logs/log-file.ts";
import { logLevel } from "../src/modules/logs/log-level.ts";
import { Logs } from "../src/modules/logs/logs.ts";
import { RunOutput } from "../src/modules/logs/run-output.ts";
import { secretValues } from "../src/modules/logs/secret-mask.ts";
import { ProcessGroups } from "../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../src/modules/procs/runtime-file.ts";
import { groupPlatform } from "../src/platform/group-platform.ts";
import { waitUntil } from "../src/platform/process-group.ts";

const DEV = { kind: "mise-task", repo: "web", miseTask: "dev" } as const;
const BUILD = { kind: "mise-task", repo: "web", miseTask: "build:ui" } as const;
const TIMEOUT = 30_000;

function newLogs(maxFileBytes = 1024 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), "trackwall-logs-"));
  const messages: string[] = [];
  return { dir, messages, logs: new Logs({ dir, maxFileBytes, log: (m) => messages.push(m) }) };
}

/** Wyjście uruchomienia z jednym kawałkiem stdout na linię. */
function write(output: RunOutput, ...lines: string[]): void {
  for (const line of lines) output.push("stdout", Buffer.from(`${line}\n`));
}

describe("logi procesu", () => {
  test(
    "wyjście taska trafia do logu jego źródła bez kolorów, z poziomem i zamaskowanym sekretem, także w pliku JSONL",
    async () => {
      const { dir, logs } = newLogs();
      const home = mkdtempSync(join(tmpdir(), "trackwall-logs-home-"));
      const groups = new ProcessGroups({
        runtime: new RuntimeFile(join(home, "runtime.json")),
        logs,
        platform: groupPlatform(),
        log: () => {},
      });
      const script = [
        'console.log("\\x1b[32mstart\\x1b[0m");',
        'console.log("token: " + process.env.GH_TOKEN);',
        'console.error("ERROR nie ma bazy");',
        'process.stdout.write("bez końca linii");',
      ].join("");
      const env = { ...process.env, GH_TOKEN: "ghp_bardzoTajnyToken123" };

      const started = await groups.start({ owner: "o", command: [process.execPath, "-e", script], cwd: home, env, logSource: DEV });
      expect(await waitUntil(() => groups.state("o")?.kind === "exited", 15_000)).toBe(true);
      // Ostatnia linia bez `\n` przychodzi z końcem strumienia, który może przyjść chwilę po końcu procesu.
      expect(await waitUntil(() => logs.tail({ source: DEV, limit: 10 }).records.length === 4, 5000)).toBe(true);

      const { records } = logs.tail({ source: DEV, limit: 10 });
      expect(records.map(({ stream, level, msg, runId }) => ({ stream, level, msg, runId }))).toEqual(
        expect.arrayContaining([
          { stream: "stdout", level: "info", msg: "start", runId: started.runId },
          { stream: "stdout", level: "info", msg: "token: ***", runId: started.runId },
          { stream: "stderr", level: "error", msg: "ERROR nie ma bazy", runId: started.runId },
          { stream: "stdout", level: "info", msg: "bez końca linii", runId: started.runId },
        ]),
      );
      expect(groups.state("o")).toMatchObject({ kind: "exited", lastLines: expect.arrayContaining(["token: ***"]) });

      logs.flush();
      const file = readFileSync(logFilePath(dir, DEV), "utf8");
      expect(file).not.toContain("bardzoTajny");
      expect(
        file
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l).msg),
      ).toContain("token: ***");
      expect(JSON.parse(file.split("\n")[0] ?? "")).toMatchObject({ source: DEV, runId: started.runId });
    },
    TIMEOUT,
  );
});

describe("odczyt od kursora", () => {
  test("seq jest wspólny dla wszystkich źródeł, a kursor zwraca tylko nowsze rekordy swojego źródła", () => {
    const { logs } = newLogs();
    // Kursor pustego logu to ostatni `seq` przed pierwszym rekordem tego działania daemona.
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    const dev = logs.open(DEV, "run-1", {});
    const build = logs.open(BUILD, "run-2", {});
    write(dev, "a");
    write(build, "b");
    write(dev, "c");

    expect(logs.tail({ source: DEV, limit: 10 })).toMatchObject({
      records: [
        { seq: s + 1, msg: "a" },
        { seq: s + 3, msg: "c" },
      ],
      nextSeq: s + 3,
    });
    expect(logs.tail({ source: BUILD, limit: 10 }).records).toMatchObject([{ seq: s + 2, msg: "b" }]);
    expect(logs.tail({ source: DEV, sinceSeq: s + 1, limit: 10 })).toMatchObject({
      records: [{ seq: s + 3, msg: "c" }],
      nextSeq: s + 3,
      dropped: false,
    });
    expect(logs.tail({ source: DEV, sinceSeq: s + 3, limit: 10 })).toEqual({ records: [], nextSeq: s + 3, dropped: false });
  });

  test("limit z kursorem daje najstarsze rekordy po nim i kursor na ostatnim zwróconym, bez kursora najnowsze", () => {
    const { logs } = newLogs();
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    write(logs.open(DEV, "r", {}), "1", "2", "3", "4");

    expect(logs.tail({ source: DEV, sinceSeq: s, limit: 2 })).toMatchObject({ records: [{ msg: "1" }, { msg: "2" }], nextSeq: s + 2 });
    expect(logs.tail({ source: DEV, sinceSeq: s + 2, limit: 2 })).toMatchObject({ records: [{ msg: "3" }, { msg: "4" }], nextSeq: s + 4 });
    expect(logs.tail({ source: DEV, limit: 2 })).toMatchObject({ records: [{ msg: "3" }, { msg: "4" }], nextSeq: s + 4 });
  });

  test("kursor starszy niż bufor źródła zgłasza dropped i zwraca rekordy od najstarszego w buforze", () => {
    const { logs } = newLogs();
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    const output = logs.open(DEV, "r", {});
    for (let i = 1; i <= LOG_BUFFER_RECORDS + 5; i++) write(output, `linia ${i}`);

    expect(logs.tail({ source: DEV, sinceSeq: s + 2, limit: 1 })).toMatchObject({
      dropped: true,
      records: [{ seq: s + 6, msg: "linia 6" }],
    });
    expect(logs.tail({ source: DEV, sinceSeq: s + 5, limit: 1 }).dropped).toBe(false);
  });

  test("kursor z innego działania daemona, mniejszy albo większy, zgłasza dropped i zwraca ostatnie rekordy", () => {
    const { logs } = newLogs();
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    write(logs.open(DEV, "r", {}), "1", "2");

    for (const sinceSeq of [5, s + 1_000_000]) {
      expect(logs.tail({ source: DEV, sinceSeq, limit: 1 })).toEqual({
        dropped: true,
        nextSeq: s + 2,
        records: [expect.objectContaining({ msg: "2" })],
      });
    }
  });

  test("bufor źródła ma limit treści: długie linie wypychają starsze rekordy wcześniej niż po 2000", () => {
    const { logs } = newLogs();
    const output = logs.open(DEV, "r", {});
    for (let i = 0; i < 300; i++) write(output, "x".repeat(16 * 1024));

    const { records } = logs.tail({ source: DEV, limit: 1000 });
    expect(records.length).toBeLessThan(300);
    expect(records.reduce((sum, r) => sum + r.msg.length, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("źródło, które nic nie wypisało, ma pusty log", () => {
    const { logs } = newLogs();
    const empty = logs.tail({ source: DEV, limit: 10 });
    expect(empty).toMatchObject({ records: [], dropped: false });

    write(logs.open(DEV, "r", {}), "pierwsza");
    expect(logs.tail({ source: DEV, sinceSeq: empty.nextSeq, limit: 10 }).records).toMatchObject([{ seq: empty.nextSeq + 1 }]);
  });
});

describe("linie wyjścia", () => {
  test("strumienie są składane osobno, bez kolorów i nadpisanego postępu, a puste linie zostają w logu", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (stream, msg) => lines.push(`${stream}: ${msg}`));
    output.push("stdout", Buffer.from("\x1b[32mstart\x1b[0m\npobieranie 10%\rpobieranie 100%\n"));
    output.push("stderr", Buffer.from("ostrzeż"));
    output.push("stdout", Buffer.from("gotowe\n"));
    output.push("stderr", Buffer.from("enie\n\n"));

    expect(lines).toEqual(["stdout: start", "stdout: pobieranie 100%", "stdout: gotowe", "stderr: ostrzeżenie", "stderr: "]);
    expect(output.lastLines()).toEqual(["start", "pobieranie 100%", "gotowe", "ostrzeżenie"]);
  });

  test("znak UTF-8 rozcięty między kawałkami nie psuje linii", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    const bytes = Buffer.from("zażółć\n");
    output.push("stdout", bytes.subarray(0, 3));
    output.push("stdout", bytes.subarray(3));

    expect(lines).toEqual(["zażółć"]);
  });

  test("ostatnie linie to 20 ostatnich, z niedokończoną linią na końcu, a koniec strumienia oddaje ją do logu", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from(Array.from({ length: 30 }, (_, i) => `linia ${i}`).join("\n")));

    expect(output.lastLines()).toHaveLength(20);
    expect(output.lastLines()[0]).toBe("linia 10");
    expect(output.lastLines().at(-1)).toBe("linia 29");
    expect(lines.at(-1)).toBe("linia 28");

    output.end("stdout");
    expect(lines.at(-1)).toBe("linia 29");
  });

  test("sekret jest maskowany także wtedy, gdy przyszedł w dwóch kawałkach albo między kolorami", () => {
    const lines: string[] = [];
    const output = new RunOutput(["tajne-haslo-123"], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from("hasło: tajne-ha"));
    output.push("stdout", Buffer.from("slo-123\n\x1b[1mtajne-haslo-123\x1b[0m\n"));
    output.push("stdout", Buffer.from("w toku: tajne-h"));

    expect(lines).toEqual(["hasło: ***", "***"]);
    expect(output.lastLines()).toEqual(["hasło: ***", "***", "w toku: tajne-h"]);
  });

  test("linia bez końca dłuższa niż 64 KB staje się rekordem zamiast rosnąć w pamięci", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from("x".repeat(70 * 1024)));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(16 * 1024 + 1);
  });
});

describe("sekrety do maskowania", () => {
  test("to wartości zmiennych o nazwach sekretów, bez krótkich i bez PWD", () => {
    expect(
      secretValues({
        GH_TOKEN: "ghp_123456789",
        DB_PASSWORD: "haslo-do-bazy-dlugie",
        JWT_SECRET: "krotki",
        STRIPE_API_KEY: "sk_test_abcdefgh",
        PWD: "/home/ktos/projekty",
        TOKENIZERS_PARALLELISM: "false-false",
        PATH: "/usr/bin:/bin",
      }),
    ).toEqual(["ghp_123456789", "haslo-do-bazy-dlugie", "sk_test_abcdefgh"]);
  });

  test("sekret zawierający inny jest maskowany w całości", () => {
    const secrets = secretValues({ A_TOKEN: "abcdefgh", B_TOKEN: "abcdefgh-ijkl" });
    const lines: string[] = [];
    write(new RunOutput(secrets, (_stream, msg) => lines.push(msg)), "x abcdefgh-ijkl y");

    expect(lines).toEqual(["x *** y"]);
  });
});

describe("sekret w trudnych miejscach", () => {
  test("wymuszony podział cofnięty przed sekretem nie rozcina emoji na dwie połówki", () => {
    const lines: string[] = [];
    const output = new RunOutput(["sekret-12345"], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from(`${"x".repeat(65_525)}${"😀".repeat(7)}`));
    output.end("stdout");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("😀".repeat(6));
  });

  test("klucz wieloliniowy jest maskowany w każdej linii", () => {
    const secrets = secretValues({ DEPLOY_PRIVATE_KEY: "-----BEGIN KEY-----\nMIIEabcdefgh\r\n-----END KEY-----" });
    const lines: string[] = [];
    write(new RunOutput(secrets, (_stream, msg) => lines.push(msg)), "-----BEGIN KEY-----", "MIIEabcdefgh", "-----END KEY-----");

    expect(lines).toEqual(["***", "***", "***"]);
  });

  test("sekrety zachodzące na siebie znikają w całości", () => {
    const lines: string[] = [];
    write(new RunOutput(["abcdefgh12", "12345678x"], (_stream, msg) => lines.push(msg)), "przed abcdefgh12345678x po");

    expect(lines).toEqual(["przed *** po"]);
  });

  test("wymuszony podział długiej linii nie rozcina sekretu", () => {
    const secret = "ghp_SECRETVALUE1234567890";
    const lines: string[] = [];
    const output = new RunOutput([secret], (_stream, msg) => lines.push(msg));
    // Postęp z `\r` bez `\n` przekracza 64 KB w chwili, gdy sekret jest przecięty na granicy kawałków.
    output.push("stdout", Buffer.from(`${"postęp 50%\r".repeat(6000)}token=${secret.slice(0, 15)}`));
    output.push("stdout", Buffer.from(`${secret.slice(15)}\n`));

    expect(lines.join("\n")).not.toContain("ghp_");
    expect(lines.at(-1)).toBe("token=***");
  });
});

describe("poziom rekordu", () => {
  test.each<[string, LogLevel]>([
    ["2026-10-23 12:00:00.123 ERROR 1234 --- [main] o.s.boot.SpringApplication : Application run failed", "error"],
    ["[ERROR] Failed to execute goal", "error"],
    ["npm ERR! code ELIFECYCLE", "error"],
    ["error TS2322: Type 'string' is not assignable", "error"],
    ["Error: Cannot find module 'x'", "error"],
    ["[WARNING] Using platform encoding", "warn"],
    ["warning: unused variable", "warn"],
    ["12:00 DEBUG o.h.SQL : select 1", "debug"],
    ["Tests run: 3, Failures: 0, Errors: 0", "info"],
    ["no error handler registered", "info"],
  ])("%s → %s", (msg, level) => {
    expect(logLevel(msg)).toBe(level);
  });
});

describe("plik logu", () => {
  test("nazwa pliku jest bezpieczna na Windowsie i macOS i różna dla różnych nazw", () => {
    expect(fileName("build:ui")).toBe("build%3Aui");
    expect(fileName("Build")).toBe("%42uild");
    expect(fileName("con")).toBe("%con");
    expect(fileName("web.api")).toBe("web%2Eapi");
    const long = fileName("x".repeat(300));
    expect(long.length).toBe(60);
    expect(long).not.toBe(fileName(`${"x".repeat(299)}y`));
  });

  test("ścieżka pliku źródła zawiera rodzaj źródła, repo i task mise", () => {
    expect(logFilePath("/stan/logs", BUILD)).toBe(join("/stan/logs", "mise-task", "web", "build%3Aui.jsonl"));
  });

  test("plik po przekroczeniu limitu staje się .1.jsonl, a nowy zaczyna się od pustego", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-logfile-"));
    const path = join(dir, "a", "dev.jsonl");
    const file = new LogFile(path, 30, () => {});
    file.append('{"n":1,"pad":"xxxxxxxxxx"}');
    file.flush();
    file.append('{"n":2}');
    file.flush();

    expect(readFileSync(rotatedPath(path), "utf8")).toBe('{"n":1,"pad":"xxxxxxxxxx"}\n');
    expect(readFileSync(path, "utf8")).toBe('{"n":2}\n');
  });

  test("nieudana rotacja nie wstrzymuje zapisu: plik rośnie ponad limit, a błąd jest zgłoszony raz", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-logfile-"));
    const path = join(dir, "dev.jsonl");
    // Niepusty katalog w miejscu `.1.jsonl`: rename się nie uda, jak na Windowsie przy pliku otwartym gdzie indziej.
    mkdirSync(join(rotatedPath(path), "zajete"), { recursive: true });
    const errors: unknown[] = [];
    const file = new LogFile(path, 10, (err) => errors.push(err));
    for (const n of [1, 2, 3]) {
      file.append(`{"n":${n}}`);
      file.flush();
    }

    expect(readFileSync(path, "utf8")).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(errors).toHaveLength(1);
  });

  test("rozmiar pliku z poprzedniego działania daemona liczy się do limitu", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-logfile-"));
    mkdirSync(join(dir, "a"));
    const path = join(dir, "a", "dev.jsonl");
    writeFileSync(path, `${"x".repeat(25)}\n`);
    const file = new LogFile(path, 30, () => {});
    file.append('{"n":2}');
    file.flush();

    expect(existsSync(rotatedPath(path))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"n":2}\n');
  });

  test("nieudany zapis zostaje w buforze i trafia do pliku przy następnej próbie, a błąd jest w logu daemona raz", () => {
    const { dir, logs, messages } = newLogs();
    // Plik w miejscu katalogu źródła: mkdir się nie uda, dopóki go nie usuniemy.
    writeFileSync(join(dir, "mise-task"), "");
    write(logs.open(DEV, "r", {}), "a");
    logs.flush();
    write(logs.open(DEV, "r", {}), "b");
    logs.flush();
    expect(messages).toHaveLength(1);

    rmSync(join(dir, "mise-task"));
    logs.flush();

    expect(
      readFileSync(logFilePath(dir, DEV), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).msg),
    ).toEqual(["a", "b"]);
  });
});
