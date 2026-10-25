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

/** A run's output with one stdout chunk per line. */
function write(output: RunOutput, ...lines: string[]): void {
  for (const line of lines) output.push("stdout", Buffer.from(`${line}\n`));
}

describe("process logs", () => {
  test(
    "a mise task's output goes to its source's log without colours, with a level and a masked secret, also in the JSONL file",
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
        'console.error("ERROR no database");',
        'process.stdout.write("no line end");',
      ].join("");
      const env = { ...process.env, GH_TOKEN: "ghp_veryS3cretToken123" };

      const started = await groups.start({ owner: "o", command: [process.execPath, "-e", script], cwd: home, env, logSource: DEV });
      expect(await waitUntil(() => groups.state("o")?.kind === "exited", 15_000)).toBe(true);
      // The last line without `\n` comes with the end of the stream, which may arrive a moment after the process ends.
      expect(await waitUntil(() => logs.tail({ source: DEV, limit: 10 }).records.length === 4, 5000)).toBe(true);

      const { records } = logs.tail({ source: DEV, limit: 10 });
      expect(records.map(({ stream, level, msg, runId }) => ({ stream, level, msg, runId }))).toEqual(
        expect.arrayContaining([
          { stream: "stdout", level: "info", msg: "start", runId: started.runId },
          { stream: "stdout", level: "info", msg: "token: ***", runId: started.runId },
          { stream: "stderr", level: "error", msg: "ERROR no database", runId: started.runId },
          { stream: "stdout", level: "info", msg: "no line end", runId: started.runId },
        ]),
      );
      expect(groups.state("o")).toMatchObject({ kind: "exited", lastLines: expect.arrayContaining(["token: ***"]) });

      logs.flush();
      const file = readFileSync(logFilePath(dir, DEV), "utf8");
      expect(file).not.toContain("veryS3cret");
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

describe("reading from a cursor", () => {
  test("seq is shared by all sources, and a cursor returns only newer records of its own source", () => {
    const { logs } = newLogs();
    // The cursor of an empty log is the last `seq` before the first record of this daemon run.
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

  test("a limit with a cursor gives the oldest records after it and a cursor on the last one returned, without a cursor the newest", () => {
    const { logs } = newLogs();
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    write(logs.open(DEV, "r", {}), "1", "2", "3", "4");

    expect(logs.tail({ source: DEV, sinceSeq: s, limit: 2 })).toMatchObject({ records: [{ msg: "1" }, { msg: "2" }], nextSeq: s + 2 });
    expect(logs.tail({ source: DEV, sinceSeq: s + 2, limit: 2 })).toMatchObject({ records: [{ msg: "3" }, { msg: "4" }], nextSeq: s + 4 });
    expect(logs.tail({ source: DEV, limit: 2 })).toMatchObject({ records: [{ msg: "3" }, { msg: "4" }], nextSeq: s + 4 });
  });

  test("a cursor older than the source's buffer reports dropped and returns records from the oldest in the buffer", () => {
    const { logs } = newLogs();
    const s = logs.tail({ source: DEV, limit: 1 }).nextSeq;
    const output = logs.open(DEV, "r", {});
    for (let i = 1; i <= LOG_BUFFER_RECORDS + 5; i++) write(output, `line ${i}`);

    expect(logs.tail({ source: DEV, sinceSeq: s + 2, limit: 1 })).toMatchObject({
      dropped: true,
      records: [{ seq: s + 6, msg: "line 6" }],
    });
    expect(logs.tail({ source: DEV, sinceSeq: s + 5, limit: 1 }).dropped).toBe(false);
  });

  test("a cursor from another daemon run, smaller or larger, reports dropped and returns the last records", () => {
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

  test("a source's buffer has a content limit: long lines push out older records before 2000", () => {
    const { logs } = newLogs();
    const output = logs.open(DEV, "r", {});
    for (let i = 0; i < 300; i++) write(output, "x".repeat(16 * 1024));

    const { records } = logs.tail({ source: DEV, limit: 1000 });
    expect(records.length).toBeLessThan(300);
    expect(records.reduce((sum, r) => sum + r.msg.length, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("a source that printed nothing has an empty log", () => {
    const { logs } = newLogs();
    const empty = logs.tail({ source: DEV, limit: 10 });
    expect(empty).toMatchObject({ records: [], dropped: false });

    write(logs.open(DEV, "r", {}), "first");
    expect(logs.tail({ source: DEV, sinceSeq: empty.nextSeq, limit: 10 }).records).toMatchObject([{ seq: empty.nextSeq + 1 }]);
  });
});

describe("output lines", () => {
  test("streams are assembled separately, without colours and overwritten progress, and empty lines stay in the log", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (stream, msg) => lines.push(`${stream}: ${msg}`));
    output.push("stdout", Buffer.from("\x1b[32mstart\x1b[0m\ndownloading 10%\rdownloading 100%\n"));
    output.push("stderr", Buffer.from("warn"));
    output.push("stdout", Buffer.from("done\n"));
    output.push("stderr", Buffer.from("ing\n\n"));

    expect(lines).toEqual(["stdout: start", "stdout: downloading 100%", "stdout: done", "stderr: warning", "stderr: "]);
    expect(output.lastLines()).toEqual(["start", "downloading 100%", "done", "warning"]);
  });

  test("a UTF-8 character split between chunks does not break the line", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    const bytes = Buffer.from("zażółć\n");
    output.push("stdout", bytes.subarray(0, 3));
    output.push("stdout", bytes.subarray(3));

    expect(lines).toEqual(["zażółć"]);
  });

  test("the last lines are the last 20, with the unfinished line at the end, and the end of the stream hands it to the log", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")));

    expect(output.lastLines()).toHaveLength(20);
    expect(output.lastLines()[0]).toBe("line 10");
    expect(output.lastLines().at(-1)).toBe("line 29");
    expect(lines.at(-1)).toBe("line 28");

    output.end("stdout");
    expect(lines.at(-1)).toBe("line 29");
  });

  test("a secret is masked even when it arrives in two chunks or between colours", () => {
    const lines: string[] = [];
    const output = new RunOutput(["secret-password-123"], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from("password: secret-pa"));
    output.push("stdout", Buffer.from("ssword-123\n\x1b[1msecret-password-123\x1b[0m\n"));
    output.push("stdout", Buffer.from("in progress: secret-p"));

    expect(lines).toEqual(["password: ***", "***"]);
    expect(output.lastLines()).toEqual(["password: ***", "***", "in progress: secret-p"]);
  });

  test("an unterminated line longer than 64 KB becomes a record instead of growing in memory", () => {
    const lines: string[] = [];
    const output = new RunOutput([], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from("x".repeat(70 * 1024)));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(16 * 1024 + 1);
  });
});

describe("secrets to mask", () => {
  test("they are the values of variables with secret names, without short ones and without PWD", () => {
    expect(
      secretValues({
        GH_TOKEN: "ghp_123456789",
        DB_PASSWORD: "a-long-database-password",
        JWT_SECRET: "short",
        STRIPE_API_KEY: "sk_test_abcdefgh",
        PWD: "/home/someone/projects",
        TOKENIZERS_PARALLELISM: "false-false",
        PATH: "/usr/bin:/bin",
      }),
    ).toEqual(["ghp_123456789", "a-long-database-password", "sk_test_abcdefgh"]);
  });

  test("a secret containing another one is masked entirely", () => {
    const secrets = secretValues({ A_TOKEN: "abcdefgh", B_TOKEN: "abcdefgh-ijkl" });
    const lines: string[] = [];
    write(new RunOutput(secrets, (_stream, msg) => lines.push(msg)), "x abcdefgh-ijkl y");

    expect(lines).toEqual(["x *** y"]);
  });
});

describe("a secret in hard places", () => {
  test("a forced split moved back before a secret does not cut an emoji in two halves", () => {
    const lines: string[] = [];
    const output = new RunOutput(["secret-12345"], (_stream, msg) => lines.push(msg));
    output.push("stdout", Buffer.from(`${"x".repeat(65_525)}${"😀".repeat(7)}`));
    output.end("stdout");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("😀".repeat(6));
  });

  test("a multi-line key is masked in every line", () => {
    const secrets = secretValues({ DEPLOY_PRIVATE_KEY: "-----BEGIN KEY-----\nMIIEabcdefgh\r\n-----END KEY-----" });
    const lines: string[] = [];
    write(new RunOutput(secrets, (_stream, msg) => lines.push(msg)), "-----BEGIN KEY-----", "MIIEabcdefgh", "-----END KEY-----");

    expect(lines).toEqual(["***", "***", "***"]);
  });

  test("overlapping secrets vanish entirely", () => {
    const lines: string[] = [];
    write(new RunOutput(["abcdefgh12", "12345678x"], (_stream, msg) => lines.push(msg)), "before abcdefgh12345678x after");

    expect(lines).toEqual(["before *** after"]);
  });

  test("a forced split of a long line does not cut a secret", () => {
    const secret = "ghp_SECRETVALUE1234567890";
    const lines: string[] = [];
    const output = new RunOutput([secret], (_stream, msg) => lines.push(msg));
    // Progress with `\r` without `\n` exceeds 64 KB at the moment the secret is cut at the chunk boundary.
    output.push("stdout", Buffer.from(`${"progress 50%\r".repeat(6000)}token=${secret.slice(0, 15)}`));
    output.push("stdout", Buffer.from(`${secret.slice(15)}\n`));

    expect(lines.join("\n")).not.toContain("ghp_");
    expect(lines.at(-1)).toBe("token=***");
  });
});

describe("record level", () => {
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
    ["/repo/src/main/java/a/Orders.java:12: error: cannot find symbol", "error"],
    ["src/app.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.", "error"],
    ["e: file:///repo/src/main/kotlin/App.kt:3:5 Unresolved reference: foo", "error"],
    ["npm error code ELIFECYCLE", "error"],
    ["[build] error: could not compile `app`", "error"],
    ["/repo/src/A.java:7: warning: [deprecation] Date(int,int,int) in Date has been deprecated", "warn"],
    ["npm warn deprecated inflight@1.0.6", "warn"],
    ["[INFO] Building orders-bff 1.0.0", "info"],
    ["[SEVERE] Database unreachable", "error"],
    ["[ERROR:main] boom", "error"],
    ["e: something happened", "info"],
    ["[debug-server] Error: boom", "error"],
    ["[info] compiling 3 Scala sources", "info"],
  ])("%s → %s", (msg, level) => {
    expect(logLevel(msg)).toBe(level);
  });
});

describe("log file", () => {
  test("the file name is safe on Windows and macOS and different for different names", () => {
    expect(fileName("build:ui")).toBe("build%3Aui");
    expect(fileName("Build")).toBe("%42uild");
    expect(fileName("con")).toBe("%con");
    expect(fileName("web.api")).toBe("web%2Eapi");
    const long = fileName("x".repeat(300));
    expect(long.length).toBe(60);
    expect(long).not.toBe(fileName(`${"x".repeat(299)}y`));
  });

  test("a source's file path contains the source kind, the repo and the mise task, and the mise install log is a repo file", () => {
    expect(logFilePath("/state/logs", BUILD)).toBe(join("/state/logs", "mise-task", "web", "build%3Aui.jsonl"));
    expect(logFilePath("/state/logs", { kind: "mise-install", repo: "Web" })).toBe(join("/state/logs", "mise-install", "%57eb.jsonl"));
  });

  test("a file past the limit becomes .1.jsonl, and a new one starts empty", () => {
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

  test("a failed rotation does not hold up writing: the file grows past the limit, and the error is reported once", () => {
    const dir = mkdtempSync(join(tmpdir(), "trackwall-logfile-"));
    const path = join(dir, "dev.jsonl");
    // A non-empty directory in place of `.1.jsonl`: the rename fails, as on Windows with a file open elsewhere.
    mkdirSync(join(rotatedPath(path), "taken"), { recursive: true });
    const errors: unknown[] = [];
    const file = new LogFile(path, 10, (err) => errors.push(err));
    for (const n of [1, 2, 3]) {
      file.append(`{"n":${n}}`);
      file.flush();
    }

    expect(readFileSync(path, "utf8")).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(errors).toHaveLength(1);
  });

  test("the size of a file from a previous daemon run counts towards the limit", () => {
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

  test("a failed write stays in the buffer and reaches the file on the next attempt, and the error is in the daemon log once", () => {
    const { dir, logs, messages } = newLogs();
    // A file in place of the source's directory: mkdir fails until we remove it.
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
