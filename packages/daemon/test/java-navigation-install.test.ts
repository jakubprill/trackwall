import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaNavigationInstall } from "@trackwall/protocol";
import { createFacade, type Facade } from "../src/facade.ts";
import { tarProgram } from "../src/infra/tar.ts";
import type { JdtlsRelease } from "../src/modules/java-navigation/jdtls-release.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const fakeMise = join(import.meta.dir, "fixtures", "fake-mise-tools.ts");

/** A jdtls release as small as it gets: the launcher jar and a configuration folder for every system. */
function jdtlsArchive(): Buffer {
  const root = mkdtempSync(join(tmpdir(), "trackwall-jdtls-release-"));
  const release = join(root, "release");
  mkdirSync(join(release, "plugins"), { recursive: true });
  writeFileSync(join(release, "plugins", "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"), "jar");
  for (const config of ["config_linux", "config_linux_arm", "config_mac", "config_mac_arm", "config_win"]) mkdirSync(join(release, config));
  const archive = join(root, "jdtls.tar.gz");
  const tar = spawnSync(tarProgram(process.platform, process.env), [
    "-czf",
    archive,
    "-C",
    release,
    "plugins",
    "config_linux",
    "config_linux_arm",
    "config_mac",
    "config_mac_arm",
    "config_win",
  ]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return readFileSync(archive);
}

const archive = jdtlsArchive();
const sha256 = createHash("sha256").update(archive).digest("hex");
let downloads = 0;
const server = createServer((req, res) => {
  if (req.url !== "/jdtls.tar.gz") return void res.writeHead(404).end();
  downloads++;
  res.writeHead(200, { "content-type": "application/gzip" }).end(archive);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jdtls.tar.gz`;
afterAll(() => server.close());

/** A facade whose install downloads the local archive and installs Java with the fake mise. */
function installFacade(o: { release?: Partial<JdtlsRelease>; miseError?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-java-install-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-java-install-projects-"));
  const installs = mkdtempSync(join(tmpdir(), "trackwall-java-install-mise-"));
  const facade = createFacade({
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: [process.execPath, fakeMise],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => ({
      ...process.env,
      FAKE_MISE_INSTALLS: installs,
      ...(o.miseError === undefined ? {} : { FAKE_MISE_INSTALL_ERROR: o.miseError }),
    }),
    jdtlsRelease: { version: "1.63.0", url, sha256, ...o.release },
    log: () => {},
  });
  return { facade, projects, installs, lsp: join(projects, ".trackwall", "lsp") };
}

async function installed(facade: Facade): Promise<JavaNavigationInstall> {
  const until = Date.now() + 20_000;
  for (;;) {
    const install = facade.javaNavigation.state();
    if (install.step === null) return install;
    if (Date.now() > until) throw new Error(`the install did not end; last state ${JSON.stringify(install)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const javaName = process.platform === "win32" ? "java.exe" : "java";

describe("installing Java navigation from Settings (ADR-123)", () => {
  test("downloads jdtls into the projects folder, installs Java with mise and saves both paths, so tasks can get it", async () => {
    const { facade, projects, installs, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    expect(facade.javaNavigation.state()).toEqual({
      jdtls: "1.63.0",
      java: "temurin-25",
      step: null,
      error: null,
      readiness: null,
    });
    expect(facade.javaNavigation.startInstall().step).toBe("Starting");
    expect(await installed(facade)).toMatchObject({ step: null, error: null, readiness: { problem: null } });
    const jdtls = join(lsp, "jdtls-1.63.0");
    expect(facade.workspace.javaNavigation()).toEqual({
      jdtls,
      java: join(installs, "java@temurin-25", "bin", javaName),
      lombok: null,
    });
    expect(readdirSync(join(jdtls, "plugins"))).toEqual(["org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"]);
    expect(readdirSync(lsp)).toEqual(["jdtls-1.63.0"]);
    // mise runs in an empty folder of the install's own and looks for no config above it, so no mise config takes part.
    const mise = JSON.parse(readFileSync(join(installs, "calls.log"), "utf8"));
    expect(mise.ceiling).toBe(mise.cwd);
    expect(mise.cwd.startsWith(join(lsp, ".install-"))).toBe(true);
    expect(facade.agents.startOptions()).toEqual({ javaNavigation: { problem: null } });
  });

  test("installing again downloads and checks the release again, replaces what is there and keeps the Lombok jar the user named", async () => {
    const { facade, projects, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    await installed(facade);
    const before = downloads;
    const planted = join(lsp, "jdtls-1.63.0", "plugins", "planted.jar");
    writeFileSync(planted, "not from the release");
    const lombok = join(projects, "lombok.jar");
    writeFileSync(lombok, "jar");
    const settings = facade.workspace.javaNavigation();
    if (settings === null) throw new Error("the first install saved no settings");
    facade.workspace.setJavaNavigation({ ...settings, java: join(projects, "gone", "java"), lombok });
    facade.javaNavigation.startInstall();
    expect(await installed(facade)).toMatchObject({ error: null, readiness: { problem: null } });
    expect(downloads).toBe(before + 1);
    expect(existsSync(planted)).toBe(false);
    expect(readdirSync(lsp)).toEqual(["jdtls-1.63.0"]);
    expect(facade.workspace.javaNavigation()).toEqual({ ...settings, lombok });
  });

  test("a temporary folder left by a daemon that stopped mid-install is removed by the next install", async () => {
    const { facade, projects, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    mkdirSync(join(lsp, ".install-left"), { recursive: true });
    facade.javaNavigation.startInstall();
    await installed(facade);
    expect(readdirSync(lsp)).toEqual(["jdtls-1.63.0"]);
  });

  test("an archive whose SHA-256 differs from the pinned one fails the install and leaves nothing behind", async () => {
    const { facade, projects, lsp } = installFacade({ release: { sha256: "0".repeat(64) } });
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    const install = await installed(facade);
    expect(install.error).toBe(`${url} has SHA-256 ${sha256}, not the expected ${"0".repeat(64)}`);
    expect(install.readiness).toBeNull();
    expect(readdirSync(lsp)).toEqual([]);
    expect(facade.workspace.javaNavigation()).toBeNull();
  });

  test("a mise that cannot install Java fails the install with mise's message and changes no settings", async () => {
    const { facade, projects, lsp } = installFacade({ miseError: "temurin-25: HTTP 503 from api.adoptium.net" });
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    expect((await installed(facade)).error).toBe("mise ERROR temurin-25: HTTP 503 from api.adoptium.net");
    expect(existsSync(join(lsp, "jdtls-1.63.0", "plugins"))).toBe(true);
    expect(facade.workspace.javaNavigation()).toBeNull();
  });

  test("without a projects folder the install says where to set it", async () => {
    const { facade } = installFacade();
    facade.javaNavigation.startInstall();
    expect((await installed(facade)).error).toMatch(/projects folder/i);
  });
});
