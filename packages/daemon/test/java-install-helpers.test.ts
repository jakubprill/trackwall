import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerified } from "../src/infra/download.ts";
import { tarProgram } from "../src/infra/tar.ts";
import { javaProgramIn } from "../src/modules/java-navigation/java-program.ts";

describe("the tar that unpacks jdtls", () => {
  test("is the system's tar by full path: /usr/bin/tar on macOS, System32's tar.exe on Windows", () => {
    expect(tarProgram("darwin", {})).toBe("/usr/bin/tar");
    expect(tarProgram("win32", { SystemRoot: "D:\\Windows" })).toBe("D:\\Windows\\System32\\tar.exe");
    expect(tarProgram("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  test("on Linux is /usr/bin/tar, else /bin/tar, else tar from PATH", () => {
    expect(tarProgram("linux", {}, (path) => path === "/usr/bin/tar")).toBe("/usr/bin/tar");
    expect(tarProgram("linux", {}, (path) => path === "/bin/tar")).toBe("/bin/tar");
    expect(tarProgram("linux", {}, () => false)).toBe("tar");
  });
});

describe("the java program in a folder mise installed", () => {
  test("is bin/java, java.exe on Windows", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-jdk-"));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "java"), "");
    writeFileSync(join(home, "bin", "java.exe"), "");
    expect(javaProgramIn(home, "linux")).toBe(join(home, "bin", "java"));
    expect(javaProgramIn(home, "win32")).toBe(join(home, "bin", "java.exe"));
  });

  test("is inside the bundle on macOS when the folder is one", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-jdk-"));
    mkdirSync(join(home, "Contents", "Home", "bin"), { recursive: true });
    writeFileSync(join(home, "Contents", "Home", "bin", "java"), "");
    expect(javaProgramIn(home, "darwin")).toBe(join(home, "Contents", "Home", "bin", "java"));
  });

  test("a folder without java says where it looked", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-jdk-"));
    expect(() => javaProgramIn(home, "linux")).toThrow(`no java in ${home}`);
  });
});

describe("a verified download", () => {
  test("stops at the size limit and leaves no file", async () => {
    const server = createServer((_req, res) => res.writeHead(200).end(Buffer.alloc(64 * 1024)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/big`;
    const file = join(mkdtempSync(join(tmpdir(), "trackwall-download-")), "big");
    try {
      await expect(downloadVerified(url, file, { sha256: "0".repeat(64), maxBytes: 1024, timeoutMs: 10_000 })).rejects.toThrow(
        `${url} is larger than 1024 bytes`,
      );
      expect(existsSync(file)).toBe(false);
    } finally {
      server.close();
    }
  });
});
